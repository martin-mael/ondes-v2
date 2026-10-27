import { type LogItem, type MarkerTiming, markerTimingSchema } from '@ondes/shared';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { formatMinSec, markerAnchor } from './markers.ts';
import type { TimelineMessageKey, TimelineT } from './messages.ts';
import type { HourSlot } from './time.ts';

// Add or edit a fixed-time marker on the log timeline (#52, ADR 0036). The time is one of the
// day's real hours (a DST day lists 02:00 twice, told apart by their offset) plus minutes and
// seconds, all in station time.

export interface MarkerValue {
  anchorMs: number;
  timing: MarkerTiming;
  capMs: number | null;
  label: string;
}

interface Draft {
  hour: string;
  minSec: string;
  timing: MarkerTiming;
  capSeconds: string;
  label: string;
}

/** Soft markers without a cap wait this long by default (the feeder's soft cap, ADR 0031). */
const DEFAULT_CAP_SECONDS = 30;
const MAX_CAP_SECONDS = 600;

function draftOf(marker: LogItem | null, hours: readonly HourSlot[], now: number): Draft {
  const at = marker?.anchorAt ? Date.parse(marker.anchorAt) : null;
  // A new marker: the next top of the hour.
  const hour =
    at !== null
      ? hours.find((h) => at >= h.start && at < h.end)
      : (hours.find((h) => h.start > now) ?? hours.at(-1));
  return {
    hour: hour ? String(hour.start) : '',
    minSec: at !== null && hour ? formatMinSec(at - hour.start) : '00:00',
    timing: marker && marker.timing !== 'flow' ? marker.timing : 'hard',
    capSeconds:
      marker?.capMs !== null && marker?.capMs !== undefined
        ? String(Math.round(marker.capMs / 1000))
        : String(DEFAULT_CAP_SECONDS),
    label: marker?.title ?? '',
  };
}

export function MarkerDialog({
  t,
  open,
  marker,
  hours,
  now,
  pending,
  onOpenChange,
  onSave,
}: {
  t: TimelineT;
  open: boolean;
  /** Null: a new marker. */
  marker: LogItem | null;
  hours: readonly HourSlot[];
  now: number;
  pending: boolean;
  onOpenChange(open: boolean): void;
  onSave(value: MarkerValue): Promise<unknown>;
}) {
  const [initial, setInitial] = useState(() => draftOf(marker, hours, now));
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<'time' | 'cap', TimelineMessageKey>>>({});
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(initial),
  );

  // `now` ticks: only a newly opened dialog takes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  useEffect(() => {
    if (!open) return;
    const fresh = draftOf(marker, hours, now);
    setInitial(fresh);
    setDraft(fresh);
    setErrors({});
  }, [open, marker, hours]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    const anchorMs = markerAnchor(
      hours.find((h) => String(h.start) === draft.hour),
      draft.minSec,
    );
    if (anchorMs === null) next.time = 'marker.error.time';
    else if (anchorMs <= Date.now()) next.time = 'marker.error.past';
    const cap = Number(draft.capSeconds);
    const capInvalid =
      draft.capSeconds.trim() === '' || !Number.isInteger(cap) || cap < 0 || cap > MAX_CAP_SECONDS;
    if (draft.timing === 'soft' && capInvalid) next.cap = 'marker.error.cap';
    setErrors(next);
    if (anchorMs === null || Object.keys(next).length > 0) return;
    try {
      await onSave({
        anchorMs,
        timing: draft.timing,
        capMs: draft.timing === 'soft' ? cap * 1000 : null,
        label: draft.label,
      });
      allowLeave();
    } catch {
      // The page's mutation reports the error; the dialog stays open with the draft.
    }
  };

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
            <DialogTitle>{t(marker ? 'marker.editTitle' : 'marker.addTitle')}</DialogTitle>
            <DialogDescription>{t('marker.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <div className="flex gap-3">
              <Field className="flex-1" data-invalid={errors.time ? true : undefined}>
                <FieldLabel htmlFor="marker-hour">{t('marker.hour')}</FieldLabel>
                <NativeSelect
                  id="marker-hour"
                  value={draft.hour}
                  onChange={(e) => set('hour', e.target.value)}
                >
                  {hours.map((h) => (
                    <NativeSelectOption key={h.start} value={String(h.start)}>
                      {h.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field className="w-36" data-invalid={errors.time ? true : undefined}>
                <FieldLabel htmlFor="marker-minsec">{t('marker.minSec')}</FieldLabel>
                <Input
                  id="marker-minsec"
                  inputMode="numeric"
                  className="tabular-nums"
                  placeholder="00:00"
                  value={draft.minSec}
                  aria-invalid={errors.time ? true : undefined}
                  onChange={(e) => set('minSec', e.target.value)}
                />
              </Field>
            </div>
            {errors.time && <FieldError errors={[{ message: t(errors.time) }]} />}
            <Field>
              <FieldLabel htmlFor="marker-timing">{t('marker.timing')}</FieldLabel>
              <NativeSelect
                id="marker-timing"
                value={draft.timing}
                onChange={(e) => set('timing', e.target.value as MarkerTiming)}
              >
                {markerTimingSchema.options.map((timing) => (
                  <NativeSelectOption key={timing} value={timing}>
                    {t(`marker.timing.${timing}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{t(`marker.help.${draft.timing}`)}</FieldDescription>
            </Field>
            {draft.timing === 'soft' && (
              <Field className="w-44" data-invalid={errors.cap ? true : undefined}>
                <FieldLabel htmlFor="marker-cap">{t('marker.cap')}</FieldLabel>
                <Input
                  id="marker-cap"
                  type="number"
                  min={0}
                  max={MAX_CAP_SECONDS}
                  value={draft.capSeconds}
                  aria-invalid={errors.cap ? true : undefined}
                  onChange={(e) => set('capSeconds', e.target.value)}
                />
                <FieldError errors={errors.cap && [{ message: t(errors.cap) }]} />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="marker-label">{t('marker.label')}</FieldLabel>
              <Input
                id="marker-label"
                maxLength={300}
                placeholder={t('marker.labelPlaceholder')}
                value={draft.label}
                onChange={(e) => set('label', e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {t('marker.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
