import {
  type CategoryListItem,
  CLOCK_DEFAULT_DURATION_MS,
  type ClockDetail,
  type ClockEstimate,
  type ClockPreview,
  type ClockSlot,
  type ClockSlotKind,
  type ClockWarning,
  clockSlotSchema,
  createClockSchema,
  type MarkerTiming,
  markerTimingSchema,
  slotCategoryId,
  vtSlotModeSchema,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  CopyIcon,
  DicesIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { cn } from '@/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Spinner } from '@/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Textarea } from '@/ui/textarea';
import { isApiError } from '../../app/api/client.ts';
import { type FieldErrors, FormAlert, fieldErrors } from '../../app/forms.tsx';
import { categoriesQuery } from '../rotation/categories/api.ts';
import {
  clockKeys,
  clockQuery,
  clocksApi,
  useAsset,
  useAssetSearch,
  useDraftEstimate,
} from './api.ts';
import { ClockTimeline } from './clock-timeline.tsx';
import { ColorDot } from './clocks-page.tsx';
import { formatMs, parseTime } from './format.ts';
import { type ClockT, useClockT } from './messages.ts';

// Create and edit a clock: its slots in play order (drag to reorder), each with its estimated
// start and length, the timeline and its warnings, and a sample hour from the real library.
// The same page serves `clocks/new` and `clocks/$clockId`.

const editRoute = getRouteApi('/_app/stations/$stationId/clocks/$clockId');
const newRoute = getRouteApi('/_app/stations/$stationId/clocks/new');

const DEFAULT_COLOR = '#3b82f6';
const ADDABLE: ClockSlotKind[] = ['category', 'jingle', 'vt', 'asset', 'marker', 'fill', 'live'];

/** A slot in the editor, with a key that survives reordering. */
interface Item {
  key: number;
  slot: ClockSlot;
}

interface Draft {
  name: string;
  description: string;
  color: string | null;
  lengthMinutes: string;
  items: Item[];
}

let nextKey = 0;
const itemOf = (slot: ClockSlot): Item => ({ key: nextKey++, slot });

function draftOf(clock: ClockDetail | null): Draft {
  return {
    name: clock?.name ?? '',
    description: clock?.description ?? '',
    color: clock?.color ?? null,
    lengthMinutes: String((clock?.targetDurationMs ?? CLOCK_DEFAULT_DURATION_MS) / 60_000),
    items: (clock?.slots ?? []).map(itemOf),
  };
}

function targetOf(draft: Draft): number | null {
  const minutes = Number(draft.lengthMinutes);
  if (draft.lengthMinutes.trim() === '' || !Number.isFinite(minutes)) return null;
  return Math.round(minutes * 60_000);
}

function newSlot(kind: ClockSlotKind, endMs: number): ClockSlot {
  const at = Math.round(endMs / 60_000) * 60_000;
  return clockSlotSchema.parse(kind === 'marker' ? { kind, offsetMs: at } : { kind });
}

export function NewClockPage() {
  const { stationId } = newRoute.useParams();
  return <ClockEditor stationId={stationId} clock={null} />;
}

export function EditClockPage() {
  const { stationId, clockId } = editRoute.useParams();
  const detail = useQuery(clockQuery(stationId, clockId));
  if (detail.isPending) return <Spinner className="m-6" />;
  if (detail.isError) {
    return (
      <div className="p-6">
        <FormAlert error={detail.error} />
      </div>
    );
  }
  return <ClockEditor key={detail.data.id} stationId={stationId} clock={detail.data} />;
}

function ClockEditor({ stationId, clock }: { stationId: string; clock: ClockDetail | null }) {
  const t = useClockT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const categories = useQuery(categoriesQuery(stationId));
  const [draft, setDraft] = useState(() => draftOf(clock));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setItems = (fn: (items: Item[]) => Item[]) =>
    setDraft((d) => ({ ...d, items: fn(d.items) }));

  const target = targetOf(draft);
  const slots = useMemo(() => draft.items.map((i) => i.slot), [draft.items]);
  const estimateQuery = useDraftEstimate(
    stationId,
    target !== null && target >= 60_000 ? { targetDurationMs: target, slots } : null,
  );
  // Until the first estimate arrives, the saved one (or nothing).
  const estimate: ClockEstimate | undefined =
    estimateQuery.data ??
    (clock && clock.slots.length === slots.length ? clock.estimate : undefined);

  const categoryList = categories.data?.items ?? [];
  const byId = useMemo(() => new Map(categoryList.map((c) => [c.id, c])), [categoryList]);
  const colors = useMemo(() => new Map(categoryList.map((c) => [c.id, c.color])), [categoryList]);
  const slotName = (slot: ClockSlot) => {
    const id = slotCategoryId(slot);
    const name = id ? byId.get(id)?.name : undefined;
    return slot.label ?? name ?? t(`kind.${slot.kind}`);
  };

  const setSlot = (index: number, slot: ClockSlot) =>
    setItems((items) => items.map((it, i) => (i === index ? { ...it, slot } : it)));
  const move = (from: number, to: number) =>
    setItems((items) => {
      if (to < 0 || to >= items.length || from === to) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });
  const add = (kind: ClockSlotKind) =>
    setItems((items) => [...items, itemOf(newSlot(kind, estimate?.totalMs ?? 0))]);

  const save = async () => {
    const parsed = createClockSchema.safeParse({
      name: draft.name,
      description: draft.description.trim() === '' ? null : draft.description,
      color: draft.color,
      targetDurationMs: target ?? Number.NaN,
      slots,
    });
    setFormError(null);
    if (!parsed.success) {
      const found = fieldErrors(parsed.error);
      setErrors({
        ...found,
        ...(found.targetDurationMs ? { lengthMinutes: found.targetDurationMs } : {}),
      });
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const saved = clock
        ? await clocksApi.update(stationId, clock.id, parsed.data)
        : await clocksApi.create(stationId, parsed.data);
      queryClient.setQueryData(clockKeys.one(stationId, saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: clockKeys.all(stationId) });
      toast.success(clock ? t('editor.saved') : t('editor.created'));
      if (!clock) {
        await navigate({
          to: '/stations/$stationId/clocks/$clockId',
          params: { stationId, clockId: saved.id },
        });
      }
    } catch (error) {
      if (isApiError(error, 'clock_name_taken')) {
        setErrors({ name: [{ message: t('editor.nameTaken') }] });
      } else if (isApiError(error, 'unknown_category') || isApiError(error, 'unknown_asset')) {
        setFormError(t('editor.unknownReference'));
      } else {
        setFormError(error);
      }
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!clock || !window.confirm(t('editor.deleteConfirm'))) return;
    try {
      await clocksApi.remove(stationId, clock.id);
      queryClient.removeQueries({ queryKey: clockKeys.one(stationId, clock.id) });
      await queryClient.invalidateQueries({ queryKey: clockKeys.all(stationId) });
      toast.success(t('editor.deleted'));
      await navigate({ to: '/stations/$stationId/clocks', params: { stationId } });
    } catch (error) {
      setFormError(error);
    }
  };

  const duplicate = async () => {
    if (!clock) return;
    try {
      const copy = await clocksApi.duplicate(stationId, clock.id);
      await queryClient.invalidateQueries({ queryKey: clockKeys.all(stationId) });
      toast.success(t('duplicated'));
      await navigate({
        to: '/stations/$stationId/clocks/$clockId',
        params: { stationId, clockId: copy.id },
      });
    } catch (error) {
      setFormError(error);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/stations/$stationId/clocks" params={{ stationId }} />}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {t('editor.back')}
        </Button>
        <h1 className="font-heading text-xl font-semibold">
          {clock ? t('editor.editTitle') : t('editor.newTitle')}
        </h1>
        <div className="ml-auto flex gap-2">
          {clock && (
            <>
              <Button variant="outline" onClick={duplicate}>
                <CopyIcon data-icon="inline-start" />
                {t('duplicate')}
              </Button>
              <Button variant="destructive" onClick={remove}>
                <Trash2Icon data-icon="inline-start" />
                {t('editor.delete')}
              </Button>
            </>
          )}
          <Button onClick={save} disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            {clock ? t('editor.save') : t('editor.create')}
          </Button>
        </div>
      </div>
      {typeof formError === 'string' ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : formError ? (
        <FormAlert error={formError} />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('editor.general')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <div className="flex flex-wrap gap-3">
                  <Field className="min-w-48 flex-1" data-invalid={errors.name ? true : undefined}>
                    <FieldLabel htmlFor="clock-name">{t('field.name')}</FieldLabel>
                    <Input
                      id="clock-name"
                      aria-invalid={errors.name ? true : undefined}
                      value={draft.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                    <FieldError errors={errors.name} />
                  </Field>
                  <Field className="w-40" data-invalid={errors.lengthMinutes ? true : undefined}>
                    <FieldLabel htmlFor="clock-length">{t('field.length')}</FieldLabel>
                    <Input
                      id="clock-length"
                      type="number"
                      min={1}
                      max={360}
                      aria-invalid={errors.lengthMinutes ? true : undefined}
                      value={draft.lengthMinutes}
                      onChange={(e) => update({ lengthMinutes: e.target.value })}
                    />
                    <FieldError errors={errors.lengthMinutes} />
                  </Field>
                  <Field className="w-auto shrink-0">
                    <FieldLabel htmlFor="clock-color">{t('field.color')}</FieldLabel>
                    {draft.color === null ? (
                      <Button
                        id="clock-color"
                        variant="outline"
                        onClick={() => update({ color: DEFAULT_COLOR })}
                      >
                        {t('field.colorNone')}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Input
                          id="clock-color"
                          type="color"
                          className="w-12 p-0.5"
                          value={draft.color}
                          onChange={(e) => update({ color: e.target.value })}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('field.colorClear')}
                          onClick={() => update({ color: null })}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    )}
                  </Field>
                </div>
                <FieldDescription>{t('field.lengthHelp')}</FieldDescription>
                <Field>
                  <FieldLabel htmlFor="clock-description">{t('field.description')}</FieldLabel>
                  <Textarea
                    id="clock-description"
                    rows={2}
                    value={draft.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('slots.title')}</CardTitle>
              <CardDescription>{t('slots.dragHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {errors.slots && <FieldError errors={errors.slots} />}
              {draft.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('slots.empty')}</p>
              ) : (
                <SlotList
                  stationId={stationId}
                  items={draft.items}
                  estimate={estimate}
                  categories={categoryList}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={setSlot}
                  onMove={move}
                  onDuplicate={(i) =>
                    setItems((items) => {
                      const source = items[i];
                      if (!source) return items;
                      const next = [...items];
                      next.splice(i + 1, 0, itemOf(source.slot));
                      return next;
                    })
                  }
                  onRemove={(i) => setItems((items) => items.filter((_, j) => j !== i))}
                />
              )}
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <span className="text-sm text-muted-foreground">{t('slots.add')}</span>
                {ADDABLE.map((kind) => (
                  <Button key={kind} variant="outline" size="sm" onClick={() => add(kind)}>
                    <PlusIcon data-icon="inline-start" />
                    {t(`kind.${kind}`)}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{t('timeline.title')}</CardTitle>
              {estimate && (
                <CardDescription className="tabular-nums">
                  {t('timeline.total', {
                    total: formatMs(estimate.totalMs),
                    target: formatMs(estimate.targetMs),
                  })}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {estimate ? (
                <>
                  <ClockTimeline
                    slots={slots}
                    estimate={estimate}
                    colors={colors}
                    names={slotName}
                    highlight={selected}
                  />
                  <Warnings t={t} warnings={estimate.warnings} onSelect={setSelected} />
                </>
              ) : (
                <Spinner />
              )}
            </CardContent>
          </Card>
          <PreviewCard stationId={stationId} slots={slots} target={target} categories={byId} />
        </div>
      </div>
    </div>
  );
}

function warningText(t: ClockT, w: ClockWarning) {
  return t(`warning.${w.code}`, {
    ms: formatMs(w.ms ?? 0),
    slot: (w.slotIndex ?? 0) + 1,
  });
}

function Warnings({
  t,
  warnings,
  onSelect,
}: {
  t: ClockT;
  warnings: ClockWarning[];
  onSelect(index: number | null): void;
}) {
  if (warnings.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('warnings.none')}</p>;
  }
  return (
    <ul aria-label="warnings" className="flex flex-col gap-1 text-sm">
      {warnings.map((w, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: warnings are recomputed whole.
          key={i}
          className="flex items-start gap-2 text-destructive"
          onMouseEnter={() => onSelect(w.slotIndex ?? null)}
          onMouseLeave={() => onSelect(null)}
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {warningText(t, w)}
        </li>
      ))}
    </ul>
  );
}

// --- Slots -------------------------------------------------------------------------------

function SlotList({
  stationId,
  items,
  estimate,
  categories,
  selected,
  onSelect,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  stationId: string;
  items: Item[];
  estimate: ClockEstimate | undefined;
  categories: CategoryListItem[];
  selected: number | null;
  onSelect(index: number | null): void;
  onChange(index: number, slot: ClockSlot): void;
  onMove(from: number, to: number): void;
  onDuplicate(index: number): void;
  onRemove(index: number): void;
}) {
  const t = useClockT();
  // Native drag and drop, armed from the handle only so text fields stay selectable.
  const [armed, setArmed] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragging = useRef<number | null>(null);
  const warned = new Set((estimate?.warnings ?? []).map((w) => w.slotIndex));

  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, index) => {
        const est = estimate?.slots[index];
        return (
          <li
            key={item.key}
            aria-label={`${index + 1}. ${t(`kind.${item.slot.kind}`)}`}
            draggable={armed === index}
            onDragStart={(e) => {
              dragging.current = index;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(index));
            }}
            onDragOver={(e) => {
              if (dragging.current === null) return;
              e.preventDefault();
              setOver(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging.current !== null) onMove(dragging.current, index);
              dragging.current = null;
              setOver(null);
              setArmed(null);
            }}
            onDragEnd={() => {
              dragging.current = null;
              setOver(null);
              setArmed(null);
            }}
            onFocus={() => onSelect(index)}
            className={cn(
              'flex items-start gap-2 rounded-md border bg-card p-2',
              over === index && 'border-primary',
              selected === index && 'ring-2 ring-ring/50',
              warned.has(index) && 'border-destructive/60',
            )}
          >
            <button
              type="button"
              aria-label={t('slot.drag')}
              className="mt-1.5 cursor-grab text-muted-foreground active:cursor-grabbing"
              onPointerDown={() => setArmed(index)}
              onPointerUp={() => setArmed(null)}
            >
              <GripVerticalIcon className="size-4" />
            </button>
            <div className="w-14 shrink-0 pt-1.5 text-right text-xs tabular-nums text-muted-foreground">
              <div className="font-medium text-foreground">{est ? formatMs(est.startMs) : '–'}</div>
              {est && item.slot.kind !== 'marker' && (
                <div title={t(`source.${est.source}`)}>{formatMs(est.durationMs)}</div>
              )}
            </div>
            <SlotFields
              stationId={stationId}
              index={index}
              slot={item.slot}
              categories={categories}
              onChange={(slot) => onChange(index, slot)}
            />
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('slot.moveUp')}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('slot.moveDown')}
                disabled={index === items.length - 1}
                onClick={() => onMove(index, index + 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('slot.duplicate')}
                onClick={() => onDuplicate(index)}
              >
                <CopyIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('slot.remove')}
                onClick={() => onRemove(index)}
              >
                <Trash2Icon />
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function SlotFields({
  stationId,
  index,
  slot,
  categories,
  onChange,
}: {
  stationId: string;
  index: number;
  slot: ClockSlot;
  categories: CategoryListItem[];
  onChange(slot: ClockSlot): void;
}) {
  const t = useClockT();
  const id = (name: string) => `slot-${index}-${name}`;
  const categoryId = 'categoryId' in slot ? slot.categoryId : null;
  const category = categoryId ? categories.find((c) => c.id === categoryId) : undefined;
  const showCategory =
    slot.kind === 'category' ||
    slot.kind === 'jingle' ||
    slot.kind === 'fill' ||
    (slot.kind === 'vt' && slot.mode === 'promo');

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
      <div className="flex w-full items-center gap-2">
        <ColorDot color={category?.color ?? null} />
        <Badge variant="secondary">{t(`kind.${slot.kind}`)}</Badge>
        <Input
          aria-label={t('slot.label')}
          placeholder={t('slot.labelPlaceholder')}
          className="h-7 flex-1"
          value={slot.label ?? ''}
          onChange={(e) =>
            onChange({ ...slot, label: e.target.value === '' ? null : e.target.value })
          }
        />
      </div>
      {slot.kind === 'vt' && (
        <Mini label={t('slot.vtMode')} htmlFor={id('mode')}>
          <NativeSelect
            id={id('mode')}
            size="sm"
            value={slot.mode}
            onChange={(e) => onChange({ ...slot, mode: vtSlotModeSchema.parse(e.target.value) })}
          >
            {vtSlotModeSchema.options.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {t(`slot.vtMode.${mode}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Mini>
      )}
      {showCategory && 'categoryId' in slot && (
        <Mini label={t('slot.category')} htmlFor={id('category')}>
          <NativeSelect
            id={id('category')}
            size="sm"
            aria-invalid={slot.kind !== 'fill' && !category ? true : undefined}
            value={category ? (slot.categoryId ?? '') : ''}
            onChange={(e) => onChange({ ...slot, categoryId: e.target.value || null })}
          >
            <NativeSelectOption value="">{t('slot.categoryNone')}</NativeSelectOption>
            {categories.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Mini>
      )}
      {slot.kind === 'asset' && (
        <AssetChooser
          stationId={stationId}
          id={id('asset')}
          assetId={slot.assetId}
          onChange={(assetId) => onChange({ ...slot, assetId })}
        />
      )}
      {slot.kind === 'marker' && (
        <>
          <Mini label={t('slot.timing')} htmlFor={id('timing')}>
            <NativeSelect
              id={id('timing')}
              size="sm"
              value={slot.timing}
              onChange={(e) =>
                onChange({ ...slot, timing: e.target.value as MarkerTiming, capMs: null })
              }
            >
              {markerTimingSchema.options.map((timing) => (
                <NativeSelectOption key={timing} value={timing}>
                  {t(`slot.timing.${timing}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Mini>
          <Mini label={t('slot.offset')} htmlFor={id('offset')}>
            <TimeInput
              id={id('offset')}
              value={slot.offsetMs}
              onChange={(ms) => onChange({ ...slot, offsetMs: ms ?? 0 })}
            />
          </Mini>
          {slot.timing === 'soft' && (
            <Mini label={t('slot.cap')} htmlFor={id('cap')}>
              <TimeInput
                id={id('cap')}
                value={slot.capMs}
                placeholder="0:00"
                onChange={(capMs) => onChange({ ...slot, capMs })}
              />
            </Mini>
          )}
        </>
      )}
      {slot.kind !== 'marker' && (
        <Mini label={t('slot.duration')} htmlFor={id('duration')}>
          <TimeInput
            id={id('duration')}
            value={slot.durationMs}
            placeholder={t('slot.durationAuto')}
            onChange={(durationMs) => onChange({ ...slot, durationMs })}
          />
        </Mini>
      )}
    </div>
  );
}

function Mini({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/** `m:ss` input. Commits valid values only; an invalid entry stays local, flagged. */
function TimeInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: number | null;
  placeholder?: string;
  onChange(ms: number | null): void;
}) {
  const t = useClockT();
  const [text, setText] = useState(() => (value === null ? '' : formatMs(value)));
  const parsed = parseTime(text);
  // Follow outside changes (another slot moved here, a duplicate) unless being edited.
  if (parsed !== undefined && parsed !== value) {
    const next = value === null ? '' : formatMs(value);
    if (next !== text) setText(next);
  }
  const invalid = parsed === undefined;
  return (
    <Input
      id={id}
      className="h-7 w-20 tabular-nums"
      inputMode="numeric"
      placeholder={placeholder}
      title={invalid ? t('slot.invalidTime') : undefined}
      aria-invalid={invalid ? true : undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const ms = parseTime(e.target.value);
        if (ms !== undefined) onChange(ms);
      }}
    />
  );
}

function AssetChooser({
  stationId,
  id,
  assetId,
  onChange,
}: {
  stationId: string;
  id: string;
  assetId: string | null;
  onChange(assetId: string | null): void;
}) {
  const t = useClockT();
  const current = useAsset(stationId, assetId);
  const [open, setOpen] = useState(assetId === null);
  const [q, setQ] = useState('');
  const results = useAssetSearch(stationId, q);
  const title = current.data
    ? [current.data.artists.join(', '), current.data.title].filter(Boolean).join(' – ')
    : current.isError
      ? t('slot.assetMissing')
      : null;

  return (
    <div className="flex min-w-48 flex-1 flex-col gap-0.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {t('slot.asset')}
      </label>
      {!open && assetId ? (
        <Button
          id={id}
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => setOpen(true)}
        >
          <span className="truncate">{title ?? '…'}</span>
        </Button>
      ) : (
        <div className="relative">
          <Input
            id={id}
            className="h-7"
            placeholder={t('slot.assetSearch')}
            aria-invalid={assetId === null ? true : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q.trim() !== '' && results.data && (
            <ul className="absolute z-10 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
              {results.data.items.length === 0 ? (
                <li className="px-2 py-1 text-sm text-muted-foreground">{t('slot.assetNone')}</li>
              ) : (
                results.data.items.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        onChange(a.id);
                        setQ('');
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {[a.artists.join(', '), a.title].filter(Boolean).join(' – ')}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatMs(a.durationMs)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- Preview -----------------------------------------------------------------------------

function PreviewCard({
  stationId,
  slots,
  target,
  categories,
}: {
  stationId: string;
  slots: ClockSlot[];
  target: number | null;
  categories: ReadonlyMap<string, CategoryListItem>;
}) {
  const t = useClockT();
  const [preview, setPreview] = useState<ClockPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const generate = async () => {
    if (target === null) return;
    setPending(true);
    setError(null);
    try {
      setPreview(await clocksApi.preview(stationId, { targetDurationMs: target, slots }));
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const byRules = preview?.items.some((i) => i.source === 'rules') ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preview.title')}</CardTitle>
        <CardDescription>{t('preview.help')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button
          variant="outline"
          className="self-start"
          onClick={generate}
          disabled={pending || slots.length === 0 || target === null}
        >
          {pending ? <Spinner data-icon="inline-start" /> : <DicesIcon data-icon="inline-start" />}
          {preview ? t('preview.again') : t('preview.generate')}
        </Button>
        {error ? <FormAlert error={error} /> : null}
        {preview && (
          <>
            <p className="text-xs text-muted-foreground">
              {byRules ? t('preview.picker.rules') : t('preview.picker.random')}
            </p>
            <Table aria-label={t('preview.title')}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">{t('slot.offset')}</TableHead>
                  <TableHead>{t('slot.asset')}</TableHead>
                  <TableHead className="text-right">{t('slot.duration')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.items.map((item) => {
                  const slot = slots[item.slotIndex];
                  const categoryId = slot ? slotCategoryId(slot) : null;
                  const category = categoryId ? categories.get(categoryId) : undefined;
                  return (
                    <TableRow key={item.slotIndex}>
                      <TableCell className="tabular-nums">{formatMs(item.startMs)}</TableCell>
                      <TableCell className="max-w-0">
                        <div className="flex items-center gap-2">
                          <ColorDot color={category?.color ?? null} />
                          <span className="truncate">
                            {item.asset
                              ? [item.asset.artists.join(', '), item.asset.title]
                                  .filter(Boolean)
                                  .join(' – ')
                              : item.problem === 'empty_category'
                                ? t('preview.emptyCategory')
                                : (slot?.label ?? t(`kind.${item.kind}`))}
                          </span>
                        </div>
                        {item.relaxedRules.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {t('preview.relaxed', { rules: item.relaxedRules.join(', ') })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.kind === 'marker' ? '' : formatMs(item.durationMs)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="text-sm tabular-nums text-muted-foreground">
              {t('timeline.total', {
                total: formatMs(preview.estimate.totalMs),
                target: formatMs(preview.estimate.targetMs),
              })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
