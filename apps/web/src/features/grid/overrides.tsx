import { createGridOverrideSchema, type GridOverride, type LocalDate } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
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
import { Field, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { gridApi, gridKeys } from './api.ts';
import { END_HOURS, formatHour, HOURS, useGridError, useGridT } from './messages.ts';
import { clockColor } from './paint.ts';
import type { GridClock } from './week-grid.tsx';

// Date-range overrides (#40): each one replaces the weekly grid on its dates and hours. Saved
// one by one from their dialog. `today` is the station-local date, to mark past overrides.

function formatDate(date: LocalDate, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function OverridesPanel({
  stationId,
  overrides,
  clocks,
  today,
  canEdit,
}: {
  stationId: string;
  overrides: GridOverride[];
  clocks: GridClock[];
  today: LocalDate;
  canEdit: boolean;
}) {
  const t = useGridT();
  const { locale } = useI18n();
  const gridError = useGridError();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<GridOverride | 'new' | null>(null);
  const byId = new Map(clocks.map((c) => [c.id, c]));

  const remove = async (o: GridOverride) => {
    if (!window.confirm(t('overrides.deleteConfirm', { name: o.name }))) return;
    try {
      await gridApi.removeOverride(stationId, o.id);
      toast.success(t('overrides.deleted'));
    } catch (error) {
      toast.error(gridError(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: gridKeys.all(stationId) });
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{t('overrides.title')}</h2>
        {canEdit && clocks.length > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            {t('overrides.new')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('overrides.help')}</p>
      {overrides.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('overrides.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {overrides.map((o) => {
            const clock = byId.get(o.clockId);
            const past = o.endsOn < today;
            const dates =
              o.startsOn === o.endsOn
                ? formatDate(o.startsOn, locale)
                : `${formatDate(o.startsOn, locale)} – ${formatDate(o.endsOn, locale)}`;
            const hours =
              o.startHour === 0 && o.endHour === 24
                ? t('overrides.allDay')
                : `${formatHour(o.startHour)}–${formatHour(o.endHour % 24)}`;
            return (
              <li
                key={o.id}
                className={cn(
                  'relative flex items-center gap-2 overflow-hidden rounded-[4px] bg-muted/50 py-2 pr-2 pl-4',
                  past && 'opacity-60',
                )}
              >
                {clock && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1"
                    style={{ backgroundColor: clockColor(clock) }}
                  />
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{o.name}</span>
                    {past && <Badge variant="outline">{t('overrides.past')}</Badge>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {dates} · {hours}
                    {clock && ` · ${clock.name}`}
                  </span>
                </div>
                {canEdit && (
                  <div className="ml-auto flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditing(o)}
                      aria-label={`${t('overrides.edit')} ${o.name}`}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(o)}
                      aria-label={`${t('overrides.delete')} ${o.name}`}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <OverrideDialog
        stationId={stationId}
        editing={editing}
        clocks={clocks}
        today={today}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

interface OverrideForm {
  name: string;
  startsOn: string;
  endsOn: string;
  allDay: boolean;
  startHour: number;
  endHour: number;
  clockId: string;
}

function OverrideDialog({
  stationId,
  editing,
  clocks,
  today,
  onClose,
}: {
  stationId: string;
  editing: GridOverride | 'new' | null;
  clocks: GridClock[];
  today: LocalDate;
  onClose(): void;
}) {
  const t = useGridT();
  const gridError = useGridError();
  const queryClient = useQueryClient();
  const blank: OverrideForm = {
    name: '',
    startsOn: today,
    endsOn: today,
    allDay: true,
    startHour: 18,
    endHour: 24,
    clockId: '',
  };
  const [initial, setInitial] = useState<OverrideForm>(blank);
  const [form, setForm] = useState<OverrideForm>(blank);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = editing !== null && JSON.stringify(form) !== JSON.stringify(initial);
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(dirty);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (editing === null) return;
    const start =
      editing === 'new'
        ? blank
        : {
            name: editing.name,
            startsOn: editing.startsOn,
            endsOn: editing.endsOn,
            allDay: editing.startHour === 0 && editing.endHour === 24,
            startHour: editing.startHour,
            endHour: editing.endHour,
            clockId: editing.clockId,
          };
    setInitial(start);
    setForm(start);
    setError(null);
  }, [editing]);

  const set = <K extends keyof OverrideForm>(key: K, value: OverrideForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.clockId) {
      setError(t('override.chooseClock'));
      return;
    }
    const parsed = createGridOverrideSchema.safeParse({
      name: form.name,
      startsOn: form.startsOn,
      endsOn: form.endsOn,
      startHour: form.allDay ? 0 : form.startHour,
      endHour: form.allDay ? 24 : form.endHour,
      clockId: form.clockId,
    });
    if (!parsed.success) {
      setError(t('override.invalidRange'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (editing === 'new') {
        await gridApi.createOverride(stationId, parsed.data);
        toast.success(t('overrides.created'));
      } else if (editing) {
        await gridApi.updateOverride(stationId, editing.id, parsed.data);
        toast.success(t('overrides.updated'));
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

  return (
    <>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && confirmDiscard(onClose)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing === 'new' ? t('override.newTitle') : t('override.editTitle')}
            </DialogTitle>
            <DialogDescription>{t('overrides.help')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor="override-name">{t('override.name')}</FieldLabel>
              <Input
                id="override-name"
                value={form.name}
                maxLength={100}
                required
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="override-from">{t('override.from')}</FieldLabel>
                <Input
                  id="override-from"
                  type="date"
                  required
                  value={form.startsOn}
                  onChange={(e) => {
                    const startsOn = e.target.value;
                    setForm((f) => ({
                      ...f,
                      startsOn,
                      endsOn: f.endsOn < startsOn ? startsOn : f.endsOn,
                    }));
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="override-to">{t('override.to')}</FieldLabel>
                <Input
                  id="override-to"
                  type="date"
                  required
                  min={form.startsOn}
                  value={form.endsOn}
                  onChange={(e) => set('endsOn', e.target.value)}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="override-all-day"
                checked={form.allDay}
                onCheckedChange={(on) => set('allDay', on)}
              />
              <Label htmlFor="override-all-day" className="font-normal">
                {t('override.allDay')}
              </Label>
            </div>
            {!form.allDay && (
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="override-start">{t('override.startHour')}</FieldLabel>
                  <NativeSelect
                    id="override-start"
                    value={String(form.startHour)}
                    onChange={(e) => set('startHour', Number(e.target.value))}
                  >
                    {HOURS.map((h) => (
                      <NativeSelectOption key={h} value={h}>
                        {formatHour(h)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="override-end">{t('override.endHour')}</FieldLabel>
                  <NativeSelect
                    id="override-end"
                    value={String(form.endHour)}
                    onChange={(e) => set('endHour', Number(e.target.value))}
                  >
                    {END_HOURS.map((h) => (
                      <NativeSelectOption key={h} value={h}>
                        {formatHour(h % 24)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="override-clock">{t('override.clock')}</FieldLabel>
              <NativeSelect
                id="override-clock"
                value={form.clockId}
                onChange={(e) => set('clockId', e.target.value)}
              >
                <NativeSelectOption value="">{t('override.chooseClock')}</NativeSelectOption>
                {clocks.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
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
