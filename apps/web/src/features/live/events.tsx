import {
  LIVE_EARLY_CONNECT_MS,
  LIVE_EVENT_MAX_MS,
  type LiveEvent,
  type LocalDate,
  type LocalTime,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@/ui/field';
import { Input } from '@/ui/input';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner, ListSkeleton } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { eventsQuery, invalidateLive, liveApi, streamersQuery } from './api.ts';
import { useLiveError, useLiveT } from './messages.ts';

// Live events (#65, ADR 0033): one-off live blocks with a title, outside the shows. Their DJs
// connect up to 15 min before and go on air at the start, like a live slot. Managers
// (`live:manage`) write them; times are typed and shown in station time.

interface Draft {
  title: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  streamerIds: string[];
}

function draftOf(event: LiveEvent | undefined, timezone: string): Draft {
  const start = event ? zonedParts(event.startsAt, timezone) : null;
  const end = event ? zonedParts(event.endsAt, timezone) : null;
  return {
    title: event?.title ?? '',
    startDate: start?.date ?? '',
    startTime: start?.time ?? '',
    endDate: end?.date ?? '',
    endTime: end?.time ?? '',
    streamerIds: event?.streamers.map((s) => s.id) ?? [],
  };
}

function EventDialog({
  stationId,
  timezone,
  event,
  open,
  onOpenChange,
}: {
  stationId: string;
  timezone: string;
  /** Absent: a new event. */
  event?: LiveEvent;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useLiveT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(event, timezone));
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(event, timezone)),
  );
  const [errors, setErrors] = useState<{ title?: boolean; span?: boolean }>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const streamers = useQuery({ ...streamersQuery(stationId), enabled: open });

  useEffect(() => {
    if (open) {
      setDraft(draftOf(event, timezone));
      setErrors({});
      setFormError(null);
    }
  }, [open, event, timezone]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const complete = draft.startDate && draft.startTime && draft.endDate && draft.endTime;
    const startsAt = complete
      ? zonedInstant(draft.startDate as LocalDate, draft.startTime as LocalTime, timezone)
      : null;
    const endsAt = complete
      ? zonedInstant(draft.endDate as LocalDate, draft.endTime as LocalTime, timezone)
      : null;
    const next = {
      title: draft.title.trim() === '',
      span:
        !startsAt ||
        !endsAt ||
        endsAt <= startsAt ||
        endsAt.getTime() - startsAt.getTime() > LIVE_EVENT_MAX_MS,
    };
    setErrors(next);
    if (next.title || next.span || !startsAt || !endsAt) return;
    setFormError(null);
    setPending(true);
    try {
      const body = {
        title: draft.title.trim(),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        streamerIds: draft.streamerIds,
      };
      if (event) await liveApi.updateEvent(stationId, event.id, body);
      else await liveApi.createEvent(stationId, body);
      await invalidateLive(queryClient, stationId);
      allowLeave();
      onOpenChange(false);
    } catch (error) {
      setFormError(error);
    } finally {
      setPending(false);
    }
  };

  const list = streamers.data?.streamers ?? [];
  return (
    <>
      {guard}
      <Dialog
        open={open}
        onOpenChange={(next) =>
          next ? onOpenChange(true) : confirmDiscard(() => onOpenChange(false))
        }
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{event ? t('eventForm.editTitle') : t('eventForm.newTitle')}</DialogTitle>
            <DialogDescription>{t('eventForm.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <FormAlert error={formError} />
            <Field data-invalid={errors.title ? true : undefined}>
              <FieldLabel htmlFor="event-title">{t('eventForm.title')}</FieldLabel>
              <Input
                id="event-title"
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
                aria-invalid={errors.title ? true : undefined}
                autoFocus
              />
              <FieldError errors={errors.title ? [{ message: t('field.required') }] : undefined} />
            </Field>
            <Field data-invalid={errors.span ? true : undefined}>
              <FieldLabel htmlFor="event-start">{t('eventForm.starts')}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="event-start"
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => set('startDate', e.target.value)}
                />
                <Input
                  type="time"
                  aria-label={t('eventForm.starts')}
                  value={draft.startTime}
                  onChange={(e) => set('startTime', e.target.value)}
                />
              </div>
            </Field>
            <Field data-invalid={errors.span ? true : undefined}>
              <FieldLabel htmlFor="event-end">{t('eventForm.ends')}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="event-end"
                  type="date"
                  value={draft.endDate}
                  onChange={(e) => set('endDate', e.target.value)}
                  aria-invalid={errors.span ? true : undefined}
                />
                <Input
                  type="time"
                  aria-label={t('eventForm.ends')}
                  value={draft.endTime}
                  onChange={(e) => set('endTime', e.target.value)}
                  aria-invalid={errors.span ? true : undefined}
                />
              </div>
              <FieldError
                errors={errors.span ? [{ message: t('eventForm.spanInvalid') }] : undefined}
              />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t('eventForm.streamers')}</FieldLegend>
              {streamers.isSuccess && list.length === 0 ? (
                <FieldDescription>{t('eventForm.noStreamers')}</FieldDescription>
              ) : (
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {list.map((s) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control.
                    <label key={s.id} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={draft.streamerIds.includes(s.id)}
                        onCheckedChange={(on) =>
                          set(
                            'streamerIds',
                            on
                              ? [...draft.streamerIds, s.id]
                              : draft.streamerIds.filter((id) => id !== s.id),
                          )
                        }
                      />
                      {s.displayName}
                    </label>
                  ))}
                </div>
              )}
              <FieldDescription>{t('eventForm.streamersHelp')}</FieldDescription>
            </FieldSet>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {event ? t('form.save') : t('form.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The Live page's events section. */
export function LiveEvents({
  stationId,
  timezone,
  canManage,
}: {
  stationId: string;
  timezone: string;
  canManage: boolean;
}) {
  const t = useLiveT();
  const liveError = useLiveError();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const events = useQuery(eventsQuery(stationId));
  const [editing, setEditing] = useState<LiveEvent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Station time only (CLAUDE.md "Web app").
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  const remove = async (e: LiveEvent) => {
    if (!window.confirm(t('events.deleteConfirm', { title: e.title }))) return;
    setDeleting(e.id);
    try {
      await liveApi.removeEvent(stationId, e.id);
      await invalidateLive(queryClient, stationId);
      toast.success(t('events.deleted'));
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setDeleting(null);
    }
  };
  const list = events.data?.events ?? [];
  const now = Date.now();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{t('events.title')}</h2>
        {canManage && (
          <Button className="ml-auto" size="sm" variant="outline" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            {t('events.new')}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('events.description', { minutes: LIVE_EARLY_CONNECT_MS / 60_000 })}
      </p>
      {events.isPending ? (
        <ListSkeleton rows={2} />
      ) : events.isError ? (
        <FormAlert error={events.error} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('events.empty')}</p>
      ) : (
        <Card size="sm">
          <CardContent>
            <ul className="divide-y">
              {list.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{e.title}</span>
                      {e.startsAt.getTime() <= now && <Badge>{t('events.now')}</Badge>}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {when(e.startsAt)} – {when(e.endsAt)} ·{' '}
                      {e.streamers.length
                        ? e.streamers.map((s) => s.displayName).join(', ')
                        : t('events.anyStreamer')}
                    </span>
                  </div>
                  {canManage && (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                        {t('events.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deleting !== null}
                        onClick={() => remove(e)}
                      >
                        <DelayedSpinner when={deleting === e.id} data-icon="inline-start" />
                        {t('events.delete')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {canManage && (
        <EventDialog
          stationId={stationId}
          timezone={timezone}
          event={editing && editing !== 'new' ? editing : undefined}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </section>
  );
}
