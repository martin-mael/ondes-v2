import {
  createShowSlotSchema,
  isoWeekday,
  localDateOf,
  type RerunStrategy,
  type Show,
  type ShowSlot,
  type SlotRule,
  type SlotStartMode,
  type SlotType,
  type Weekday,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
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
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { episodesQuery, invalidateShows, showsApi } from './api.ts';
import { formatDay, formatDuration, weekdayName, weekdays } from './format.ts';
import { useShowT } from './messages.ts';
import { rerunnable } from './rerun-dialog.tsx';

// Create or edit a slot: when the show airs (weekly, every N weeks, or once) and its
// exceptions. Changing the rule or the type can detach the episodes planned in occurrences that
// no longer exist: the api returns them and `onDetached` reports them.

interface Draft {
  type: SlotType;
  freq: 'weekly' | 'once';
  interval: string;
  byDay: Weekday[];
  startDate: string;
  until: string;
  date: string;
  time: string;
  durationMin: string;
  /** Rerun slots (#48): which episode airs again. */
  rerunStrategy: RerunStrategy;
  rerunEpisodeId: string;
  /** Hard or soft start (#46); a soft start's cap in seconds, empty for the default. */
  startMode: SlotStartMode;
  startCapS: string;
}

function draftOf(show: Show, slot: ShowSlot | undefined, today: string): Draft {
  const rule = slot?.rule;
  const durationMs = slot?.durationMs ?? show.defaultDurationMs ?? 3_600_000;
  return {
    type: slot?.type ?? show.defaultSlotType,
    freq: rule?.freq ?? 'weekly',
    interval: rule?.freq === 'weekly' ? String(rule.interval) : '1',
    byDay: rule?.freq === 'weekly' ? rule.byDay : [weekdays[isoWeekday(today) - 1] as Weekday],
    startDate: rule?.freq === 'weekly' ? rule.startDate : today,
    until: rule?.freq === 'weekly' ? (rule.until ?? '') : '',
    date: rule?.freq === 'once' ? rule.date : today,
    time: rule?.time ?? '20:00',
    durationMin: String(Math.round(durationMs / 60_000)),
    rerunStrategy: slot?.rerun?.strategy ?? 'latest_episode',
    rerunEpisodeId: (slot?.rerun?.strategy === 'episode' && slot.rerun.episodeId) || '',
    startMode: slot?.startMode ?? 'hard',
    startCapS: slot?.startCapMs == null ? '' : String(Math.round(slot.startCapMs / 1000)),
  };
}

/** The start policy sent: a cap only with a soft start. */
function startOf(draft: Draft) {
  if (draft.startMode === 'hard') return { startMode: 'hard' as const, startCapMs: null };
  const cap = draft.startCapS.trim();
  return {
    startMode: 'soft' as const,
    startCapMs: cap === '' ? null : Math.round(Number(cap) * 1000),
  };
}

/** What the api is sent for the slot's type: a strategy goes with rerun slots only. */
function rerunOf(draft: Draft) {
  if (draft.type !== 'rerun') return {};
  // A chosen-episode strategy is kept even before an episode is picked (saved incomplete).
  return draft.rerunStrategy === 'episode'
    ? { rerun: { strategy: 'episode' as const, episodeId: draft.rerunEpisodeId || null } }
    : { rerun: { strategy: 'latest_episode' as const } };
}

function ruleOf(draft: Draft): SlotRule {
  return draft.freq === 'once'
    ? { freq: 'once', date: draft.date, time: draft.time }
    : {
        freq: 'weekly',
        startDate: draft.startDate,
        until: draft.until || null,
        interval: Number(draft.interval),
        byDay: draft.byDay,
        time: draft.time,
      };
}

export function SlotEditorDialog({
  stationId,
  show,
  slot,
  timezone,
  open,
  onOpenChange,
  onDetached,
}: {
  stationId: string;
  show: Show;
  /** Absent: a new slot. */
  slot?: ShowSlot;
  timezone: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onDetached(episodeIds: string[]): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const today = localDateOf(new Date(), timezone);
  const [draft, setDraft] = useState<Draft>(() => draftOf(show, slot, today));
  // Closing the dialog, or leaving the page, with changes asks first.
  const { guard, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(show, slot, today)),
  );
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  // Episodes a rerun slot can air again: those with audio.
  const episodes = useQuery({
    ...episodesQuery(stationId, show.id),
    enabled: open && draft.type === 'rerun' && draft.rerunStrategy === 'episode',
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (open) {
      setDraft(draftOf(show, slot, today));
      setInvalid(new Set());
      setFormError(null);
    }
  }, [open]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const run = async (action: () => Promise<{ detachedEpisodeIds: string[] } | unknown>) => {
    setFormError(null);
    setPending(true);
    try {
      const result = await action();
      await invalidateShows(queryClient, stationId);
      const detached =
        result && typeof result === 'object' && 'detachedEpisodeIds' in result
          ? (result.detachedEpisodeIds as string[])
          : [];
      if (detached.length > 0) onDetached(detached);
      return true;
    } catch (error) {
      setFormError(error);
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = {
      type: draft.type,
      rule: ruleOf(draft),
      durationMs: Math.round(Number(draft.durationMin) * 60_000),
      ...rerunOf(draft),
      ...startOf(draft),
    };
    const parsed = createShowSlotSchema.safeParse(body);
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((i) => String(i.path.at(-1) ?? i.path[0]))));
      return;
    }
    setInvalid(new Set());
    const ok = await run(() =>
      slot
        ? showsApi.updateSlot(stationId, show.id, slot.id, body)
        : showsApi.createSlot(stationId, show.id, body),
    );
    if (ok) onOpenChange(false);
  };

  const toggleDay = (day: Weekday) =>
    set(
      'byDay',
      draft.byDay.includes(day) ? draft.byDay.filter((d) => d !== day) : [...draft.byDay, day],
    );

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
            <DialogTitle>{slot ? t('slot.editTitle') : t('slot.newTitle')}</DialogTitle>
            <DialogDescription>{t('slot.timezone', { timezone })}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <FormAlert error={formError} />
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="slot-type">{t('slot.type')}</FieldLabel>
                <NativeSelect
                  id="slot-type"
                  value={draft.type}
                  onChange={(e) => set('type', e.target.value as SlotType)}
                >
                  <NativeSelectOption value="prerecorded">
                    {t('type.prerecorded')}
                  </NativeSelectOption>
                  <NativeSelectOption value="live">{t('type.live')}</NativeSelectOption>
                  <NativeSelectOption value="rerun">{t('type.rerun')}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="slot-freq">{t('slot.repeat')}</FieldLabel>
                <NativeSelect
                  id="slot-freq"
                  value={draft.freq}
                  onChange={(e) => set('freq', e.target.value as Draft['freq'])}
                >
                  <NativeSelectOption value="weekly">{t('slot.freq.weekly')}</NativeSelectOption>
                  <NativeSelectOption value="once">{t('slot.freq.once')}</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>

            {draft.type === 'rerun' && (
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="slot-rerun">{t('rerun.strategy')}</FieldLabel>
                  <NativeSelect
                    id="slot-rerun"
                    value={draft.rerunStrategy}
                    onChange={(e) => set('rerunStrategy', e.target.value as RerunStrategy)}
                  >
                    <NativeSelectOption value="latest_episode">
                      {t('rerun.latest_episode')}
                    </NativeSelectOption>
                    <NativeSelectOption value="episode">{t('rerun.episode')}</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {draft.rerunStrategy === 'episode' && (
                  <Field>
                    <FieldLabel htmlFor="slot-rerun-episode">{t('rerun.episodeField')}</FieldLabel>
                    <NativeSelect
                      id="slot-rerun-episode"
                      value={draft.rerunEpisodeId}
                      onChange={(e) => set('rerunEpisodeId', e.target.value)}
                    >
                      <NativeSelectOption value="">{t('rerun.episodeNone')}</NativeSelectOption>
                      {episodes.data?.items
                        .filter((e) => rerunnable(e) || e.id === draft.rerunEpisodeId)
                        .map((e) => (
                          <NativeSelectOption key={e.id} value={e.id}>
                            {`#${e.number}${e.title ? ` · ${e.title}` : ''}`}
                            {e.status !== 'aired' && e.occurrenceDate && e.occurrenceDate >= today
                              ? ` (${t('rerun.premieres', { date: formatDay(e.occurrenceDate, locale) })})`
                              : ''}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                  </Field>
                )}
                <FieldDescription className="col-span-2">
                  {draft.rerunStrategy === 'episode' && !draft.rerunEpisodeId
                    ? t('rerun.episodeMissing')
                    : t('rerun.help')}
                </FieldDescription>
              </div>
            )}

            {draft.freq === 'weekly' ? (
              <>
                <FieldSet>
                  <FieldLegend variant="label">{t('slot.days')}</FieldLegend>
                  <div className="flex flex-wrap gap-1">
                    {weekdays.map((day) => (
                      <Button
                        key={day}
                        type="button"
                        size="sm"
                        variant={draft.byDay.includes(day) ? 'default' : 'outline'}
                        aria-pressed={draft.byDay.includes(day)}
                        aria-label={weekdayName(day, locale, 'long')}
                        onClick={() => toggleDay(day)}
                      >
                        {weekdayName(day, locale)}
                      </Button>
                    ))}
                  </div>
                  <FieldError
                    errors={
                      invalid.has('byDay') ? [{ message: t('slot.daysRequired') }] : undefined
                    }
                  />
                </FieldSet>
                <Field data-invalid={invalid.has('interval') ? true : undefined}>
                  <FieldLabel htmlFor="slot-interval">{t('slot.interval')}</FieldLabel>
                  <Input
                    id="slot-interval"
                    type="number"
                    min={1}
                    max={52}
                    inputMode="numeric"
                    value={draft.interval}
                    onChange={(e) => set('interval', e.target.value)}
                  />
                  <FieldDescription>{t('slot.intervalHelp')}</FieldDescription>
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="slot-start">{t('slot.startDate')}</FieldLabel>
                    <Input
                      id="slot-start"
                      type="date"
                      value={draft.startDate}
                      onChange={(e) => set('startDate', e.target.value)}
                    />
                  </Field>
                  <Field data-invalid={invalid.has('until') ? true : undefined}>
                    <FieldLabel htmlFor="slot-until">{t('slot.until')}</FieldLabel>
                    <Input
                      id="slot-until"
                      type="date"
                      value={draft.until}
                      onChange={(e) => set('until', e.target.value)}
                    />
                    <FieldError
                      errors={
                        invalid.has('until') ? [{ message: t('slot.untilInvalid') }] : undefined
                      }
                    />
                  </Field>
                </div>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="slot-date">{t('slot.date')}</FieldLabel>
                <Input
                  id="slot-date"
                  type="date"
                  value={draft.date}
                  onChange={(e) => set('date', e.target.value)}
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={invalid.has('time') ? true : undefined}>
                <FieldLabel htmlFor="slot-time">{t('slot.time')}</FieldLabel>
                <Input
                  id="slot-time"
                  type="time"
                  value={draft.time}
                  onChange={(e) => set('time', e.target.value)}
                />
              </Field>
              <Field data-invalid={invalid.has('durationMs') ? true : undefined}>
                <FieldLabel htmlFor="slot-duration">{t('slot.duration')}</FieldLabel>
                <Input
                  id="slot-duration"
                  type="number"
                  min={1}
                  max={1440}
                  inputMode="numeric"
                  value={draft.durationMin}
                  onChange={(e) => set('durationMin', e.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="slot-start-mode">{t('slot.start')}</FieldLabel>
                <NativeSelect
                  id="slot-start-mode"
                  value={draft.startMode}
                  onChange={(e) => set('startMode', e.target.value as SlotStartMode)}
                >
                  <NativeSelectOption value="hard">{t('slot.start.hard')}</NativeSelectOption>
                  <NativeSelectOption value="soft">{t('slot.start.soft')}</NativeSelectOption>
                </NativeSelect>
              </Field>
              {draft.startMode === 'soft' && (
                <Field data-invalid={invalid.has('startCapMs') ? true : undefined}>
                  <FieldLabel htmlFor="slot-start-cap">{t('slot.startCap')}</FieldLabel>
                  <Input
                    id="slot-start-cap"
                    type="number"
                    min={0}
                    max={600}
                    inputMode="numeric"
                    placeholder="30"
                    value={draft.startCapS}
                    onChange={(e) => set('startCapS', e.target.value)}
                  />
                </Field>
              )}
              <FieldDescription className="col-span-2">
                {t(draft.startMode === 'soft' ? 'slot.startHelp.soft' : 'slot.startHelp.hard')}
              </FieldDescription>
            </div>
            {slot && <FieldDescription>{t('slot.detachWarning')}</FieldDescription>}

            {slot && slot.exceptions.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">{t('slot.exceptions')}</h3>
                <ul className="flex flex-col gap-1">
                  {slot.exceptions.map((ex) => (
                    <li key={ex.date} className="flex items-center gap-2">
                      <span className="flex-1">
                        {ex.kind === 'cancelled'
                          ? t('exception.cancelled', { date: formatDay(ex.date, locale) })
                          : t('exception.moved', {
                              date: formatDay(ex.date, locale),
                              to: `${formatDay(ex.startDate, locale)} ${ex.startTime}`,
                            }) + (ex.durationMs ? ` (${formatDuration(ex.durationMs)})` : '')}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          run(() => showsApi.removeException(stationId, show.id, slot.id, ex.date))
                        }
                      >
                        {t('exception.restore')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <DialogFooter>
              {slot && (
                <Button
                  type="button"
                  variant="destructive"
                  className="sm:mr-auto"
                  disabled={pending}
                  onClick={async () => {
                    if (!window.confirm(t('slot.deleteConfirm'))) return;
                    const ok = await run(() => showsApi.removeSlot(stationId, show.id, slot.id));
                    if (ok) onOpenChange(false);
                  }}
                >
                  {t('slot.delete')}
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {slot ? t('form.save') : t('slot.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
