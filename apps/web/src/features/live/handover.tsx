import {
  LIVE_HANDOVER_FADE_MS_DEFAULT,
  type LiveHandover,
  type LiveStatus,
  type LocalDate,
  type LocalTime,
  rolePermissions,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MicIcon, MicOffIcon, PlugZapIcon, PlusIcon, RadioIcon, UndoIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner, ListSkeleton } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { handoversQuery, liveApi, liveKeys, streamersQuery } from './api.ts';
import { type LiveT, useLiveError, useLiveT } from './messages.ts';

// DJ handover controls (#66, ADR 0038), self-contained so any page can mount them with the
// station id and the live status it already has: the dashboard's live sources panel does, and
// the dashboard's quick actions (#72) can.
// - `LiveInputActions`: for one connected input, put it on air (a handover with the chosen
//   crossfade if another DJ is on), back to automation, mute or unmute, disconnect.
// - `HandoverFadeSelect`: the crossfade those use, one per panel.
// - `ScheduledHandovers`: the scheduled handovers (pending and of the last 24 h, station time)
//   with a dialog to schedule one, kept fresh by `live.handover.changed`.
// All need `engine:control`; they render nothing without it (`useCanControlLive`). Errors
// are toasts; the live status refetches on the `live.*` and `engine.live.*` events.

const FADES_MS = [0, 1000, 2000, 3000, 5000, 8000];

/** Whether the member may act on the air of this station (`engine:control`). */
export function useCanControlLive(stationId: string): boolean {
  const found = findStation(useOrgs(), stationId);
  return !!found && rolePermissions[found.station.role].includes('engine:control');
}

function fadeLabel(t: LiveT, ms: number) {
  return ms === 0 ? t('handover.fadeCut') : t('handover.fadeSeconds', { seconds: ms / 1000 });
}

export function HandoverFadeSelect({
  value,
  onChange,
  id,
}: {
  value: number;
  onChange(ms: number): void;
  id?: string;
}) {
  const t = useLiveT();
  return (
    <NativeSelect
      id={id}
      size="sm"
      aria-label={id ? undefined : t('handover.fade')}
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {FADES_MS.map((ms) => (
        <NativeSelectOption key={ms} value={ms}>
          {fadeLabel(t, ms)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

type LiveInput = LiveStatus['inputs'][number];
type Action = 'air' | 'back' | 'mute' | 'kick';

/** The buttons for one connected input. Renders nothing without `engine:control`. */
export function LiveInputActions({
  stationId,
  status,
  input,
  fadeMs = LIVE_HANDOVER_FADE_MS_DEFAULT,
}: {
  stationId: string;
  status: LiveStatus;
  input: LiveInput;
  fadeMs?: number;
}) {
  const t = useLiveT();
  const liveError = useLiveError();
  const canControl = useCanControlLive(stationId);
  const [busy, setBusy] = useState<Action | null>(null);
  const [kicking, setKicking] = useState(false);
  if (!canControl || !input.connected) return null;
  const onAir = status.onAir === input.input;
  const name = input.streamer?.displayName ?? t('handover.unknownDj');
  const someoneElseOnAir = status.onAir !== null && !onAir;

  const act = async (action: Action, run: () => Promise<unknown>, done: string) => {
    setBusy(action);
    try {
      await run();
      toast.success(done);
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex w-full flex-wrap gap-2" data-testid="live-input-actions">
      {onAir ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            act('back', () => liveApi.returnToAutomation(stationId), t('handover.backDone'))
          }
        >
          <DelayedSpinner when={busy === 'back'} data-icon="inline-start" />
          {busy !== 'back' && <UndoIcon data-icon="inline-start" />}
          {t('handover.back')}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={busy !== null || !input.ready}
          onClick={() =>
            act(
              'air',
              () => liveApi.goLive(stationId, input.input, fadeMs),
              t('handover.onAir', { name }),
            )
          }
        >
          <DelayedSpinner when={busy === 'air'} data-icon="inline-start" />
          {busy !== 'air' && <RadioIcon data-icon="inline-start" />}
          {someoneElseOnAir ? t('handover.handOver') : t('handover.goLive')}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        aria-pressed={input.muted === true}
        disabled={busy !== null}
        onClick={() =>
          act(
            'mute',
            () => liveApi.mute(stationId, input.input, !input.muted),
            input.muted
              ? t('handover.unmutedDone', { input: input.input })
              : t('handover.mutedDone', { input: input.input }),
          )
        }
      >
        <DelayedSpinner when={busy === 'mute'} data-icon="inline-start" />
        {busy !== 'mute' &&
          (input.muted ? (
            <MicIcon data-icon="inline-start" />
          ) : (
            <MicOffIcon data-icon="inline-start" />
          ))}
        {input.muted ? t('handover.unmute') : t('handover.mute')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setKicking(true)}>
        <PlugZapIcon data-icon="inline-start" />
        {t('handover.kick')}
      </Button>
      <Dialog open={kicking} onOpenChange={setKicking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('handover.kickTitle', { name })}</DialogTitle>
            <DialogDescription>{t('handover.kickDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={async () => {
                await act(
                  'kick',
                  () => liveApi.disconnect(stationId, input.input),
                  t('handover.kicked', { name }),
                );
                setKicking(false);
              }}
            >
              <DelayedSpinner when={busy === 'kick'} data-icon="inline-start" />
              {t('handover.kickConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The scheduled handovers and a button to schedule one. Nothing without `engine:control`. */
export function ScheduledHandovers({ stationId }: { stationId: string }) {
  const t = useLiveT();
  const liveError = useLiveError();
  const { locale } = useI18n();
  const canControl = useCanControlLive(stationId);
  const timezone = findStation(useOrgs(), stationId)?.station.timezone ?? 'UTC';
  const queryClient = useQueryClient();
  const handovers = useQuery({ ...handoversQuery(stationId), enabled: canControl });
  useSseEvent('live.handover.changed', () =>
    queryClient.invalidateQueries({ queryKey: liveKeys.handovers(stationId) }),
  );
  const [scheduling, setScheduling] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  if (!canControl) return null;

  // Station time only (CLAUDE.md "Web app"), with the day: the list spans up to 48 h.
  const time = (at: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  const cancel = async (handover: LiveHandover) => {
    setCancelling(handover.id);
    try {
      await liveApi.cancelHandover(stationId, handover.id);
      toast.success(t('handover.cancelled'));
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: liveKeys.handovers(stationId) });
    }
  };

  const list = handovers.data?.handovers ?? [];
  return (
    <section className="flex flex-col gap-2" data-testid="scheduled-handovers">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('handover.scheduled')}</h3>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setScheduling(true)}>
          <PlusIcon data-icon="inline-start" />
          {t('handover.schedule')}
        </Button>
      </div>
      {handovers.isPending ? (
        <ListSkeleton rows={1} className="[&>*]:h-8" />
      ) : list.length === 0 ? (
        <p className="text-muted-foreground">{t('handover.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2" data-testid="handover">
              <span>
                {t('handover.item', {
                  time: time(h.at),
                  name: h.streamer?.displayName ?? '?',
                  fade: fadeLabel(t, h.fadeMs),
                })}
              </span>
              <Badge variant={h.status === 'failed' ? 'destructive' : 'outline'}>
                {t(`handover.status.${h.status}`)}
                {h.reason ? ` (${t(`handover.reason.${h.reason}`)})` : ''}
              </Badge>
              {h.status === 'pending' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={cancelling !== null}
                  onClick={() => cancel(h)}
                >
                  <DelayedSpinner when={cancelling === h.id} data-icon="inline-start" />
                  {t('handover.cancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ScheduleDialog
        stationId={stationId}
        timezone={timezone}
        open={scheduling}
        onOpenChange={setScheduling}
      />
    </section>
  );
}

interface Draft {
  streamerId: string;
  date: string;
  time: string;
  fadeMs: number;
}

const emptyDraft = (timezone: string): Draft => ({
  streamerId: '',
  date: zonedParts(new Date(), timezone).date,
  time: '',
  fadeMs: LIVE_HANDOVER_FADE_MS_DEFAULT,
});

function ScheduleDialog({
  stationId,
  timezone,
  open,
  onOpenChange,
}: {
  stationId: string;
  timezone: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useLiveT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(timezone));
  const [initial, setInitial] = useState<Draft>(draft);
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(initial),
  );
  const [errors, setErrors] = useState<{ dj?: boolean; at?: boolean }>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const streamers = useQuery({ ...streamersQuery(stationId), enabled: open });

  useEffect(() => {
    if (open) {
      const fresh = emptyDraft(timezone);
      setDraft(fresh);
      setInitial(fresh);
      setErrors({});
      setFormError(null);
    }
  }, [open, timezone]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const at =
      draft.date && draft.time
        ? zonedInstant(draft.date as LocalDate, draft.time as LocalTime, timezone)
        : null;
    const ahead = at ? at.getTime() - Date.now() : -1;
    const next = { dj: draft.streamerId === '', at: !at || ahead <= 0 || ahead > 24 * 3600_000 };
    setErrors(next);
    if (next.dj || next.at || !at) return;
    setFormError(null);
    setPending(true);
    try {
      await liveApi.scheduleHandover(stationId, {
        streamerId: draft.streamerId,
        at: at.toISOString(),
        fadeMs: draft.fadeMs,
      });
      await queryClient.invalidateQueries({ queryKey: liveKeys.handovers(stationId) });
      toast.success(t('handover.form.done'));
      allowLeave();
      onOpenChange(false);
    } catch (error) {
      setFormError(error);
    } finally {
      setPending(false);
    }
  };

  const list = (streamers.data?.streamers ?? []).filter((s) => s.status === 'active');
  return (
    <>
      {guard}
      <Dialog
        open={open}
        onOpenChange={(next) =>
          next ? onOpenChange(true) : confirmDiscard(() => onOpenChange(false))
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('handover.schedule')}</DialogTitle>
            <DialogDescription>{t('handover.form.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <FormAlert error={formError} />
            <Field data-invalid={errors.dj ? true : undefined}>
              <FieldLabel htmlFor="handover-dj">{t('handover.form.dj')}</FieldLabel>
              <NativeSelect
                id="handover-dj"
                value={draft.streamerId}
                onChange={(e) => set('streamerId', e.target.value)}
                aria-invalid={errors.dj ? true : undefined}
              >
                <NativeSelectOption value="">{t('handover.form.pickDj')}</NativeSelectOption>
                {list.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.displayName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldError
                errors={errors.dj ? [{ message: t('handover.form.djRequired') }] : undefined}
              />
            </Field>
            <Field data-invalid={errors.at ? true : undefined}>
              <FieldLabel htmlFor="handover-at">{t('handover.form.at')}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="handover-at"
                  type="date"
                  value={draft.date}
                  onChange={(e) => set('date', e.target.value)}
                  aria-invalid={errors.at ? true : undefined}
                />
                <Input
                  type="time"
                  aria-label={t('handover.form.at')}
                  value={draft.time}
                  onChange={(e) => set('time', e.target.value)}
                  aria-invalid={errors.at ? true : undefined}
                />
              </div>
              <FieldError
                errors={errors.at ? [{ message: t('handover.form.atInvalid') }] : undefined}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="handover-fade">{t('handover.fade')}</FieldLabel>
              <HandoverFadeSelect
                id="handover-fade"
                value={draft.fadeMs}
                onChange={(ms) => set('fadeMs', ms)}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {t('handover.form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
