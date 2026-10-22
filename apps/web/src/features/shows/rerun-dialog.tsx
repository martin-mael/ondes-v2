import { type Episode, localDateOf, type ShowOccurrence, scheduleRerunSchema } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { invalidateShows, showsApi } from './api.ts';
import { formatDay } from './format.ts';
import { useShowError, useShowT } from './messages.ts';

// "Schedule a rerun" (#48): an episode with audio airs again once, at a station-local date and
// time. The api makes it a one-off rerun slot on that episode, which then shows in the slots,
// the upcoming airings and the calendar like any other.

interface Draft {
  date: string;
  time: string;
  durationMin: string;
}

const draftOf = (today: string): Draft => ({ date: today, time: '10:00', durationMin: '' });

export function RerunDialog({
  stationId,
  showId,
  episode,
  timezone,
  onClose,
}: {
  stationId: string;
  showId: string;
  /** Null: closed. */
  episode: Episode | null;
  timezone: string;
  onClose(): void;
}) {
  const t = useShowT();
  const showError = useShowError();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const open = episode !== null;
  const today = localDateOf(new Date(), timezone);
  const [draft, setDraft] = useState<Draft>(() => draftOf(today));
  const { guard, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(today)),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (open) {
      setDraft(draftOf(today));
      setError(null);
    }
  }, [open]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const premiere = episode?.occurrenceDate ?? null;
  const beforePremiere = premiere !== null && draft.date !== '' && draft.date < premiere;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!episode || beforePremiere) return;
    const minutes = Number(draft.durationMin);
    const body = {
      date: draft.date,
      time: draft.time,
      ...(draft.durationMin.trim() && minutes > 0
        ? { durationMs: Math.round(minutes * 60_000) }
        : {}),
    };
    if (!scheduleRerunSchema.safeParse(body).success) {
      setError(t('field.required'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await showsApi.scheduleRerun(stationId, showId, episode.id, body);
      await invalidateShows(queryClient, stationId);
      toast.success(
        t('rerun.done', {
          number: episode.number,
          when: `${formatDay(draft.date, locale)} ${draft.time}`,
        }),
      );
      onClose();
    } catch (e) {
      setError(showError(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {guard}
      <Dialog open={open} onOpenChange={(next) => !next && confirmDiscard(onClose)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rerun.dialogTitle', { number: episode?.number ?? '' })}</DialogTitle>
            <DialogDescription>{t('rerun.dialogDescription', { timezone })}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={beforePremiere ? true : undefined}>
                <FieldLabel htmlFor="rerun-date">{t('rerun.date')}</FieldLabel>
                <Input
                  id="rerun-date"
                  type="date"
                  required
                  value={draft.date}
                  onChange={(e) => set('date', e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="rerun-time">{t('rerun.time')}</FieldLabel>
                <Input
                  id="rerun-time"
                  type="time"
                  required
                  value={draft.time}
                  onChange={(e) => set('time', e.target.value)}
                />
              </Field>
            </div>
            {beforePremiere && premiere && (
              <FieldError
                errors={[
                  { message: t('rerun.beforePremiere', { date: formatDay(premiere, locale) }) },
                ]}
              />
            )}
            <Field>
              <FieldLabel htmlFor="rerun-duration">{t('rerun.duration')}</FieldLabel>
              <Input
                id="rerun-duration"
                type="number"
                min={1}
                max={1440}
                inputMode="numeric"
                value={draft.durationMin}
                onChange={(e) => set('durationMin', e.target.value)}
              />
              <FieldDescription>{t('rerun.durationHelp')}</FieldDescription>
            </Field>
            <FieldError errors={error ? [{ message: error }] : undefined} />
            <DialogFooter>
              <Button type="submit" disabled={pending || beforePremiere}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {t('rerun.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What a rerun airing plays again, as resolved now; a calm note when there's nothing yet. */
export function RerunOf({ occurrence }: { occurrence: ShowOccurrence }) {
  const t = useShowT();
  const episode = occurrence.rerunOf;
  if (episode === undefined) {
    return <span className="text-muted-foreground">{t('upcoming.rerun')}</span>;
  }
  if (episode === null) {
    return <span className="text-muted-foreground">{t('upcoming.rerunNothing')}</span>;
  }
  return (
    <span className="truncate">
      {t('upcoming.rerunOf', { number: episode.number })}
      {episode.title ? ` · ${episode.title}` : ''}
    </span>
  );
}
