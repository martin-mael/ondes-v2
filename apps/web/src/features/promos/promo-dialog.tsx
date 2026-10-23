import {
  type LocalDate,
  type LocalTime,
  PROMO_MAX_PLAYS_PER_DAY,
  PROMO_MAX_WEIGHT,
  type Promo,
  type PromoDaypart,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon, InfoIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
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
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { showsQuery } from '../shows/api.ts';
import { invalidatePromos, promosApi, vtPoolsQuery } from './api.ts';
import { VoiceTrackPicker } from './asset-picker.tsx';
import { type PromoT, usePromoError, usePromoT } from './messages.ts';

// Create or edit a promo (`voice_track:write`). Dates are typed in station time and sent as
// instants; start and kill are written to the voice track itself (its validity). Saving never
// waits on completeness: a promo in no pool, or a daypart without days, saves with a calm
// warning (the daypart is left out until it has days). Only the voice track is required.

interface DaypartDraft {
  key: number;
  weekdays: number[];
  startHour: number;
  endHour: number;
}

interface Draft {
  asset: { id: string; title: string } | null;
  startDate: string;
  startTime: string;
  killDate: string;
  killTime: string;
  showId: string;
  eventName: string;
  eventDate: string;
  eventTime: string;
  weight: string;
  maxPlaysPerDay: string;
  poolIds: string[];
  dayparts: DaypartDraft[];
  enabled: boolean;
}

let daypartKey = 0;

function parts(at: Date | null, timezone: string) {
  return at ? zonedParts(at, timezone) : { date: '', time: '' };
}

function draftOf(promo: Promo | undefined, timezone: string): Draft {
  const start = parts(promo?.startAt ?? null, timezone);
  const kill = parts(promo?.killAt ?? null, timezone);
  const event = parts(promo?.eventAt ?? null, timezone);
  return {
    asset: promo ? { id: promo.assetId, title: promo.title } : null,
    startDate: start.date,
    startTime: start.time,
    killDate: kill.date,
    killTime: kill.time,
    showId: promo?.showId ?? '',
    eventName: promo?.eventName ?? '',
    eventDate: event.date,
    eventTime: event.time,
    weight: String(promo?.weight ?? 1),
    maxPlaysPerDay: promo?.maxPlaysPerDay ? String(promo.maxPlaysPerDay) : '',
    poolIds: [...(promo?.poolIds ?? [])].sort(),
    dayparts: (promo?.dayparts ?? []).map((d, i) => ({ key: i, ...d })),
    enabled: promo?.enabled ?? true,
  };
}

/** What the dirty check compares: the draft without the dayparts' list keys. */
const comparable = (d: Draft) =>
  JSON.stringify({ ...d, dayparts: d.dayparts.map(({ key: _, ...p }) => p) });

/**
 * A station-local date and time as an instant; null when both are empty, 'partial' when only one
 * is filled (work in progress: left out of the save, never refused).
 */
function instant(date: string, time: string, timezone: string): Date | null | 'partial' {
  if (!date && !time) return null;
  if (!date || !time) return 'partial';
  return zonedInstant(date as LocalDate, time as LocalTime, timezone);
}

const isPartial = (date: string, time: string) => !date !== !time;

type Errors = Partial<Record<'asset' | 'killAt' | 'weight' | 'maxPlaysPerDay', string>>;

export function PromoDialog({
  stationId,
  timezone,
  promo,
  open,
  onOpenChange,
}: {
  stationId: string;
  timezone: string;
  /** Absent: a new promo. */
  promo?: Promo | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = usePromoT();
  const promoError = usePromoError();
  const queryClient = useQueryClient();
  // The promo as last read: the dirty check's reference and the version a save sends back.
  const [base, setBase] = useState<Promo | undefined>(promo);
  const [draft, setDraft] = useState<Draft>(() => draftOf(promo, timezone));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const pools = useQuery({ ...vtPoolsQuery(stationId), enabled: open });
  const shows = useQuery({ ...showsQuery(stationId), enabled: open });
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && comparable(draft) !== comparable(draftOf(base, timezone)),
  );

  // A fresh draft each time the dialog opens, or opens on another promo (not when the list
  // refetches meanwhile): state adjusted while rendering, when what it is open for changes.
  const openFor = open ? (promo?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openFor !== shownFor) {
    setShownFor(openFor);
    if (openFor !== null) {
      setBase(promo);
      setDraft(draftOf(promo, timezone));
      setErrors({});
      setFormError(null);
      setConflict(false);
    }
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setDaypart = (key: number, patch: Partial<DaypartDraft>) =>
    set(
      'dayparts',
      draft.dayparts.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Errors = {};
    if (!draft.asset) next.asset = t('form.assetMissing');
    const startAt = instant(draft.startDate, draft.startTime, timezone);
    const killAt = instant(draft.killDate, draft.killTime, timezone);
    const eventAt = instant(draft.eventDate, draft.eventTime, timezone);
    if (startAt instanceof Date && killAt instanceof Date && killAt <= startAt) {
      next.killAt = t('form.killBeforeStart');
    }
    const weight = Number(draft.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > PROMO_MAX_WEIGHT) {
      next.weight = t('form.invalid');
    }
    const max = draft.maxPlaysPerDay.trim() === '' ? null : Number(draft.maxPlaysPerDay);
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > PROMO_MAX_PLAYS_PER_DAY)) {
      next.maxPlaysPerDay = t('form.invalid');
    }
    setErrors(next);
    if (Object.keys(next).length || !draft.asset) return;
    const iso = (d: Date | null | 'partial') => (d instanceof Date ? d.toISOString() : null);
    // A half-filled date isn't sent: an edit keeps the saved one, a new promo has none yet.
    const dateField = <K extends string>(key: K, d: Date | null | 'partial') =>
      d === 'partial' ? {} : ({ [key]: iso(d) } as Record<K, string | null>);
    // A daypart without days is work in progress: left out, not refused.
    const dayparts: PromoDaypart[] = draft.dayparts
      .filter((d) => d.weekdays.length > 0)
      .map(({ weekdays, startHour, endHour }) => ({
        weekdays: [...weekdays].sort((a, b) => a - b),
        startHour,
        endHour,
      }));
    const fields = {
      showId: draft.showId || null,
      eventName: draft.eventName.trim() || null,
      ...dateField('eventAt', eventAt),
      weight,
      maxPlaysPerDay: max,
      dayparts,
      poolIds: draft.poolIds,
      enabled: draft.enabled,
      ...dateField('startAt', startAt),
      ...dateField('killAt', killAt),
    };
    setFormError(null);
    setConflict(false);
    setPending(true);
    try {
      if (base) {
        await promosApi.update(stationId, base.id, { ...fields, version: base.version });
      } else {
        await promosApi.create(stationId, { assetId: draft.asset.id, ...fields });
      }
      await invalidatePromos(queryClient, stationId);
      allowLeave();
      onOpenChange(false);
    } catch (error) {
      if (base && isApiError(error) && error.status === 409 && error.code === 'version_conflict') {
        // Someone saved meanwhile: theirs becomes the form, as other editors do.
        try {
          const fresh = await promosApi.get(stationId, base.id);
          setBase(fresh);
          setDraft(draftOf(fresh, timezone));
          setConflict(true);
          await invalidatePromos(queryClient, stationId);
        } catch (reloadError) {
          setFormError(reloadError);
        }
      } else {
        setFormError(error);
      }
    } finally {
      setPending(false);
    }
  };

  const poolList = pools.data?.items ?? [];
  const showList = shows.data?.items ?? [];
  const incompleteDayparts = draft.dayparts.some((d) => d.weekdays.length === 0);

  return (
    <>
      {guard}
      <Dialog
        open={open}
        onOpenChange={(next) =>
          next ? onOpenChange(true) : confirmDiscard(() => onOpenChange(false))
        }
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{base ? t('form.editTitle') : t('form.newTitle')}</DialogTitle>
            <DialogDescription>{t('form.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            {formError !== null && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{promoError(formError)}</AlertDescription>
              </Alert>
            )}
            {conflict && (
              <Alert>
                <InfoIcon />
                <AlertDescription>{t('form.conflict')}</AlertDescription>
              </Alert>
            )}
            <Field data-invalid={errors.asset ? true : undefined}>
              <FieldLabel>{t('form.asset')}</FieldLabel>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{draft.asset?.title ?? '–'}</span>
                {!base && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPicking(true)}
                  >
                    {draft.asset ? t('form.assetChange') : t('form.assetChoose')}
                  </Button>
                )}
              </div>
              <FieldError errors={errors.asset ? [{ message: errors.asset }] : undefined} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <DateTime
                id="promo-start"
                label={t('form.startAt')}
                date={draft.startDate}
                time={draft.startTime}
                partial={
                  isPartial(draft.startDate, draft.startTime) ? t('form.datePartial') : undefined
                }
                help={t('form.dateHelp')}
                onDate={(v) => set('startDate', v)}
                onTime={(v) => set('startTime', v)}
              />
              <DateTime
                id="promo-kill"
                label={t('form.killAt')}
                date={draft.killDate}
                time={draft.killTime}
                error={errors.killAt}
                partial={
                  isPartial(draft.killDate, draft.killTime) ? t('form.datePartial') : undefined
                }
                help={t('form.dateHelp')}
                onDate={(v) => set('killDate', v)}
                onTime={(v) => set('killTime', v)}
              />
            </div>

            <Field>
              <FieldLabel htmlFor="promo-show">{t('form.show')}</FieldLabel>
              <NativeSelect
                id="promo-show"
                value={draft.showId}
                onChange={(e) => set('showId', e.target.value)}
              >
                <NativeSelectOption value="">{t('form.showNone')}</NativeSelectOption>
                {showList.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="promo-event">{t('form.eventName')}</FieldLabel>
                <Input
                  id="promo-event"
                  maxLength={200}
                  placeholder={t('form.eventPlaceholder')}
                  value={draft.eventName}
                  onChange={(e) => set('eventName', e.target.value)}
                />
              </Field>
              <DateTime
                id="promo-event-at"
                label={t('form.eventAt')}
                date={draft.eventDate}
                time={draft.eventTime}
                partial={
                  isPartial(draft.eventDate, draft.eventTime) ? t('form.datePartial') : undefined
                }
                onDate={(v) => set('eventDate', v)}
                onTime={(v) => set('eventTime', v)}
              />
            </div>
            {draft.eventDate && draft.eventTime && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setDraft((d) => ({ ...d, killDate: d.eventDate, killTime: d.eventTime }))
                }
              >
                {t('form.useEventAsKill')}
              </Button>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={errors.weight ? true : undefined}>
                <FieldLabel htmlFor="promo-weight">{t('form.weight')}</FieldLabel>
                <Input
                  id="promo-weight"
                  type="number"
                  min={1}
                  max={PROMO_MAX_WEIGHT}
                  value={draft.weight}
                  aria-invalid={errors.weight ? true : undefined}
                  onChange={(e) => set('weight', e.target.value)}
                />
                <FieldDescription>{t('form.weightHelp')}</FieldDescription>
                <FieldError errors={errors.weight ? [{ message: errors.weight }] : undefined} />
              </Field>
              <Field data-invalid={errors.maxPlaysPerDay ? true : undefined}>
                <FieldLabel htmlFor="promo-max">{t('form.maxPlaysPerDay')}</FieldLabel>
                <Input
                  id="promo-max"
                  type="number"
                  min={1}
                  max={PROMO_MAX_PLAYS_PER_DAY}
                  value={draft.maxPlaysPerDay}
                  aria-invalid={errors.maxPlaysPerDay ? true : undefined}
                  onChange={(e) => set('maxPlaysPerDay', e.target.value)}
                />
                <FieldDescription>{t('form.maxHelp')}</FieldDescription>
                <FieldError
                  errors={errors.maxPlaysPerDay ? [{ message: errors.maxPlaysPerDay }] : undefined}
                />
              </Field>
            </div>

            <FieldSet>
              <FieldLegend variant="label">{t('form.pools')}</FieldLegend>
              {pools.isSuccess && poolList.length === 0 ? (
                <FieldDescription>{t('form.noPools')}</FieldDescription>
              ) : (
                <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                  {poolList.map((p) => (
                    <div key={p.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`promo-pool-${p.id}`}
                        checked={draft.poolIds.includes(p.id)}
                        onCheckedChange={(on) =>
                          set(
                            'poolIds',
                            on
                              ? [...draft.poolIds, p.id].sort()
                              : draft.poolIds.filter((id) => id !== p.id),
                          )
                        }
                      />
                      <Label htmlFor={`promo-pool-${p.id}`} className="font-normal">
                        {p.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
              {pools.isSuccess && poolList.length > 0 && draft.poolIds.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('form.noPoolWarning')}</p>
              )}
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">{t('form.dayparts')}</FieldLegend>
              <FieldDescription>{t('form.daypartsHelp')}</FieldDescription>
              <ul className="flex flex-col gap-3">
                {draft.dayparts.map((d, i) => (
                  <DaypartRow
                    key={d.key}
                    index={i}
                    daypart={d}
                    t={t}
                    onChange={(patch) => setDaypart(d.key, patch)}
                    onRemove={() =>
                      set(
                        'dayparts',
                        draft.dayparts.filter((x) => x.key !== d.key),
                      )
                    }
                  />
                ))}
              </ul>
              {incompleteDayparts && (
                <p className="text-sm text-muted-foreground">{t('form.daypartNoDay')}</p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  set('dayparts', [
                    ...draft.dayparts,
                    { key: 1000 + daypartKey++, weekdays: [], startHour: 6, endHour: 10 },
                  ])
                }
              >
                <PlusIcon data-icon="inline-start" />
                {t('form.daypartAdd')}
              </Button>
            </FieldSet>

            <div className="flex items-center gap-2">
              <Checkbox
                id="promo-enabled"
                checked={draft.enabled}
                onCheckedChange={(on) => set('enabled', on)}
              />
              <Label htmlFor="promo-enabled" className="font-normal">
                {t('form.enabled')}
              </Label>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {base ? t('form.save') : t('form.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <VoiceTrackPicker
        stationId={stationId}
        open={picking}
        onOpenChange={setPicking}
        onPick={(asset) => {
          set('asset', asset);
          setPicking(false);
        }}
      />
    </>
  );
}

function DateTime(props: {
  id: string;
  label: string;
  date: string;
  time: string;
  error?: string | undefined;
  /** A calm note: only one of date and time is filled, so it isn't saved yet. */
  partial?: string | undefined;
  help?: string;
  onDate(value: string): void;
  onTime(value: string): void;
}) {
  return (
    <Field data-invalid={props.error ? true : undefined}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={props.id}
          type="date"
          value={props.date}
          aria-invalid={props.error ? true : undefined}
          onChange={(e) => props.onDate(e.target.value)}
        />
        <Input
          type="time"
          aria-label={props.label}
          value={props.time}
          aria-invalid={props.error ? true : undefined}
          onChange={(e) => props.onTime(e.target.value)}
        />
      </div>
      {props.help && <FieldDescription>{props.help}</FieldDescription>}
      {props.partial && <p className="text-sm text-muted-foreground">{props.partial}</p>}
      <FieldError errors={props.error ? [{ message: props.error }] : undefined} />
    </Field>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const START_HOURS = Array.from({ length: 24 }, (_, h) => h);
const END_HOURS = Array.from({ length: 24 }, (_, h) => h + 1);
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

function DaypartRow({
  index,
  daypart,
  t,
  onChange,
  onRemove,
}: {
  index: number;
  daypart: DaypartDraft;
  t: PromoT;
  onChange(patch: Partial<DaypartDraft>): void;
  onRemove(): void;
}) {
  const id = (name: string) => `daypart-${index}-${name}`;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <div className="flex flex-wrap gap-1">
        {WEEKDAYS.map((day) => {
          const on = daypart.weekdays.includes(day);
          return (
            <Button
              key={day}
              type="button"
              size="sm"
              variant={on ? 'default' : 'outline'}
              aria-pressed={on}
              onClick={() =>
                onChange({
                  weekdays: on
                    ? daypart.weekdays.filter((d) => d !== day)
                    : [...daypart.weekdays, day],
                })
              }
            >
              {t(`weekday.${day}`)}
            </Button>
          );
        })}
      </div>
      <label htmlFor={id('from')} className="text-sm text-muted-foreground">
        {t('form.daypartFrom')}
      </label>
      <NativeSelect
        id={id('from')}
        size="sm"
        value={String(daypart.startHour)}
        onChange={(e) => onChange({ startHour: Number(e.target.value) })}
      >
        {START_HOURS.map((h) => (
          <NativeSelectOption key={h} value={String(h)}>
            {hour(h)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <label htmlFor={id('to')} className="text-sm text-muted-foreground">
        {t('form.daypartTo')}
      </label>
      <NativeSelect
        id={id('to')}
        size="sm"
        value={String(daypart.endHour)}
        onChange={(e) => onChange({ endHour: Number(e.target.value) })}
      >
        {END_HOURS.map((h) => (
          <NativeSelectOption key={h} value={String(h)}>
            {hour(h)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label={t('form.daypartRemove')}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}
