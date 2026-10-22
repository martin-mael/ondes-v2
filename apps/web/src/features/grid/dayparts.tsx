import { createDaypartSchema, type Daypart } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { PaintbrushIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { gridApi, gridKeys } from './api.ts';
import { END_HOURS, formatHour, HOURS, useGridError, useGridT, weekdayNames } from './messages.ts';

// Dayparts (#40): named hour ranges that paint the grid in bulk. Painting one changes the
// grid's draft only; the daypart itself is saved on its own, from its dialog.

export function daypartSummary(
  part: Pick<Daypart, 'weekdays' | 'startHour' | 'endHour'>,
  days: string[],
) {
  const weekdays = part.weekdays.map((d) => days[d - 1]).join(', ');
  return `${weekdays} · ${formatHour(part.startHour)}–${formatHour(part.endHour % 24)}`;
}

export function DaypartsPanel({
  stationId,
  dayparts,
  canEdit,
  brushName,
  onApply,
}: {
  stationId: string;
  dayparts: Daypart[];
  canEdit: boolean;
  /** The selected brush's name, for the paint buttons. */
  brushName: string;
  onApply(part: Daypart): void;
}) {
  const t = useGridT();
  const { locale } = useI18n();
  const gridError = useGridError();
  const queryClient = useQueryClient();
  const days = weekdayNames(locale);
  const [editing, setEditing] = useState<Daypart | 'new' | null>(null);

  const remove = async (part: Daypart) => {
    if (!window.confirm(t('dayparts.deleteConfirm', { name: part.name }))) return;
    try {
      await gridApi.removeDaypart(stationId, part.id);
      toast.success(t('dayparts.deleted'));
    } catch (error) {
      toast.error(gridError(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: gridKeys.all(stationId) });
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{t('dayparts.title')}</h2>
        {canEdit && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            {t('dayparts.new')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('dayparts.help')}</p>
      {dayparts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dayparts.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {dayparts.map((part) => (
            <li key={part.id} className="flex items-center gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{part.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {daypartSummary(part, days)}
                </span>
              </div>
              {canEdit && (
                <div className="ml-auto flex shrink-0 items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onApply(part)}
                    aria-label={t('dayparts.applyTo', { daypart: part.name, clock: brushName })}
                    title={t('dayparts.applyTo', { daypart: part.name, clock: brushName })}
                  >
                    <PaintbrushIcon data-icon="inline-start" />
                    {t('dayparts.apply')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing(part)}
                    aria-label={`${t('dayparts.edit')} ${part.name}`}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(part)}
                    aria-label={`${t('dayparts.delete')} ${part.name}`}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <DaypartDialog stationId={stationId} editing={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

interface DaypartForm {
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
}

const blank: DaypartForm = { name: '', weekdays: [1, 2, 3, 4, 5], startHour: 6, endHour: 10 };

function DaypartDialog({
  stationId,
  editing,
  onClose,
}: {
  stationId: string;
  editing: Daypart | 'new' | null;
  onClose(): void;
}) {
  const t = useGridT();
  const { locale } = useI18n();
  const gridError = useGridError();
  const queryClient = useQueryClient();
  const days = weekdayNames(locale, 'long');
  const [initial, setInitial] = useState<DaypartForm>(blank);
  const [form, setForm] = useState<DaypartForm>(blank);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = editing !== null && JSON.stringify(form) !== JSON.stringify(initial);
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(dirty);

  useEffect(() => {
    if (editing === null) return;
    const start =
      editing === 'new'
        ? blank
        : {
            name: editing.name,
            weekdays: editing.weekdays,
            startHour: editing.startHour,
            endHour: editing.endHour,
          };
    setInitial(start);
    setForm(start);
    setError(null);
  }, [editing]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = createDaypartSchema.safeParse(form);
    if (!parsed.success) {
      setError(
        form.weekdays.length === 0 ? t('daypart.noDays') : (parsed.error.issues[0]?.message ?? ''),
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (editing === 'new') {
        await gridApi.createDaypart(stationId, parsed.data);
        toast.success(t('dayparts.created'));
      } else if (editing) {
        await gridApi.updateDaypart(stationId, editing.id, parsed.data);
        toast.success(t('dayparts.updated'));
      }
      allowLeave();
      await queryClient.invalidateQueries({ queryKey: gridKeys.all(stationId) });
      onClose();
    } catch (err) {
      setError(gridError(err));
    } finally {
      setPending(false);
    }
  };

  const toggleDay = (day: number, on: boolean) =>
    setForm((f) => ({
      ...f,
      weekdays: on
        ? [...f.weekdays, day].sort((a, b) => a - b)
        : f.weekdays.filter((d) => d !== day),
    }));
  const overnight = form.endHour % 24 <= form.startHour && form.endHour !== 24;

  return (
    <>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && confirmDiscard(onClose)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing === 'new' ? t('daypart.newTitle') : t('daypart.editTitle')}
            </DialogTitle>
            <DialogDescription>{t('dayparts.help')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor="daypart-name">{t('daypart.name')}</FieldLabel>
              <Input
                id="daypart-name"
                value={form.name}
                maxLength={100}
                required
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t('daypart.days')}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {days.map((name, i) => (
                  <div key={name} className="flex items-center gap-2">
                    <Checkbox
                      id={`daypart-day-${i + 1}`}
                      checked={form.weekdays.includes(i + 1)}
                      onCheckedChange={(on) => toggleDay(i + 1, on)}
                    />
                    <Label htmlFor={`daypart-day-${i + 1}`} className="font-normal">
                      {name}
                    </Label>
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="daypart-from">{t('daypart.from')}</FieldLabel>
                <NativeSelect
                  id="daypart-from"
                  value={String(form.startHour)}
                  onChange={(e) => setForm((f) => ({ ...f, startHour: Number(e.target.value) }))}
                >
                  {HOURS.map((h) => (
                    <NativeSelectOption key={h} value={h}>
                      {formatHour(h)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="daypart-to">{t('daypart.to')}</FieldLabel>
                <NativeSelect
                  id="daypart-to"
                  value={String(form.endHour)}
                  onChange={(e) => setForm((f) => ({ ...f, endHour: Number(e.target.value) }))}
                >
                  {END_HOURS.map((h) => (
                    <NativeSelectOption key={h} value={h}>
                      {formatHour(h % 24)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {overnight && <FieldDescription>{t('daypart.overnight')}</FieldDescription>}
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => confirmDiscard(onClose)}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {editing === 'new' ? t('create') : t('saveDialog')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {guard}
    </>
  );
}
