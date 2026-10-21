import {
  type AssetUsage,
  assetTypeSchema,
  type BulkAction,
  type BulkAssetPatch,
  type BulkSelection,
  MAX_BULK_ASSETS,
  type TagKey,
  tagKeySchema,
} from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListMusicIcon, PencilIcon, PlusIcon, TagsIcon, Trash2Icon, XIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
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
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { FormAlert } from '../../app/forms.tsx';
import { categoriesQuery } from '../rotation/categories/api.ts';
import { invalidateLibrary, libraryApi, tagsQuery } from './api.ts';
import { type LibraryT, useLibraryT } from './messages.ts';

// Bulk edits on the selection (#23): tags, shared fields, delete. The api audits each asset
// it changes; a selection made with "all matching" carries the count the person saw and is
// refused when the library changed meanwhile.

export interface BulkTarget {
  selection: BulkSelection;
  count: number;
}

type Dialogs = 'tags' | 'edit' | 'category' | 'delete' | null;

export function BulkBar({
  stationId,
  target,
  label,
  onClear,
  onDone,
}: {
  stationId: string;
  target: BulkTarget;
  label: string;
  onClear: () => void;
  onDone: () => void;
}) {
  const t = useLibraryT();
  const [open, setOpen] = useState<Dialogs>(null);
  const tooMany = target.count > MAX_BULK_ASSETS;
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5"
    >
      <span className="font-medium">{label}</span>
      <Button variant="ghost" size="sm" onClick={onClear}>
        <XIcon data-icon="inline-start" />
        {t('select.clear')}
      </Button>
      <div className="ml-auto flex gap-1">
        {tooMany && (
          <span className="self-center text-destructive">
            {t('bulk.tooMany', { max: MAX_BULK_ASSETS.toLocaleString() })}
          </span>
        )}
        <Button variant="outline" size="sm" disabled={tooMany} onClick={() => setOpen('tags')}>
          <TagsIcon data-icon="inline-start" />
          {t('bulk.tags')}
        </Button>
        <Button variant="outline" size="sm" disabled={tooMany} onClick={() => setOpen('edit')}>
          <PencilIcon data-icon="inline-start" />
          {t('bulk.edit')}
        </Button>
        <Button variant="outline" size="sm" disabled={tooMany} onClick={() => setOpen('category')}>
          <ListMusicIcon data-icon="inline-start" />
          {t('bulk.category')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={tooMany}
          onClick={() => setOpen('delete')}
        >
          <Trash2Icon data-icon="inline-start" />
          {t('bulk.delete')}
        </Button>
      </div>
      <BulkDialog
        stationId={stationId}
        target={target}
        open={open}
        onClose={() => setOpen(null)}
        onDone={() => {
          setOpen(null);
          onDone();
        }}
      />
    </div>
  );
}

function bulkErrorMessage(t: LibraryT, error: unknown): string | null {
  const count = (error as { details?: { count?: number } }).details?.count ?? 0;
  if (isApiError(error, 'selection_changed')) return t('bulk.changed', { count });
  if (isApiError(error, 'kill_before_start')) return t('bulk.killBeforeStart', { count });
  if (isApiError(error, 'asset_in_use')) {
    const usages =
      (error as { details?: { usages?: AssetUsage[] } }).details?.usages ?? ([] as AssetUsage[]);
    const kinds = [...new Set(usages.map((u) => t(`bulk.inUse.${u.kind}`)))].join(', ');
    return t('bulk.inUse', { count: new Set(usages.map((u) => u.assetId)).size, kinds });
  }
  if (isApiError(error, 'too_many_assets')) {
    return t('bulk.tooMany', { max: MAX_BULK_ASSETS.toLocaleString() });
  }
  return null;
}

function BulkDialog({
  stationId,
  target,
  open,
  onClose,
  onDone,
}: {
  stationId: string;
  target: BulkTarget;
  open: Dialogs;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useLibraryT();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: BulkAction) =>
      libraryApi.bulk(stationId, { selection: target.selection, action }),
    onSuccess: async (result, action) => {
      await invalidateLibrary(queryClient, stationId);
      toast.success(
        action.kind === 'delete'
          ? t('bulk.deleted', { changed: result.changed })
          : t('bulk.done', { changed: result.changed, matched: result.matched }),
      );
      onDone();
    },
    onError: async (error) => {
      if (isApiError(error, 'selection_changed')) await invalidateLibrary(queryClient, stationId);
    },
  });
  const known = mutation.error ? bulkErrorMessage(t, mutation.error) : null;
  const error = mutation.error ? (
    known ? (
      <p role="alert" className="text-destructive">
        {known}
      </p>
    ) : (
      <FormAlert error={mutation.error} />
    )
  ) : null;
  const count = target.count.toLocaleString();
  const close = () => {
    mutation.reset();
    onClose();
  };

  return (
    <Dialog open={open !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        {open === 'tags' && (
          <TagsForm
            stationId={stationId}
            title={t('bulk.tags.title', { count })}
            pending={mutation.isPending}
            error={error}
            onSubmit={(add, remove) => mutation.mutate({ kind: 'tags', add, remove })}
            onCancel={close}
          />
        )}
        {open === 'edit' && (
          <EditForm
            title={t('bulk.edit.title', { count })}
            pending={mutation.isPending}
            error={error}
            onSubmit={(patch) => mutation.mutate({ kind: 'update', patch })}
            onCancel={close}
          />
        )}
        {open === 'category' && (
          <CategoryForm
            stationId={stationId}
            title={t('bulk.category.title', { count })}
            pending={mutation.isPending}
            error={error}
            onSubmit={(categoryId, mode) => mutation.mutate({ kind: 'category', categoryId, mode })}
            onCancel={close}
          />
        )}
        {open === 'delete' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('bulk.delete.title', { count })}</DialogTitle>
              <DialogDescription>{t('bulk.delete.help')}</DialogDescription>
            </DialogHeader>
            {error}
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {t('upload.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ kind: 'delete' })}
              >
                {t('bulk.delete.confirm', { count })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Tags --------------------------------------------------------------------------------

interface TagRow {
  key: TagKey;
  value: string;
}

function TagsForm({
  stationId,
  title,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  stationId: string;
  title: string;
  pending: boolean;
  error: ReactNode;
  onSubmit: (add: TagRow[], remove: TagRow[]) => void;
  onCancel: () => void;
}) {
  const t = useLibraryT();
  const vocabulary = useQuery(tagsQuery(stationId)).data?.tags ?? [];
  const [add, setAdd] = useState<TagRow[]>([{ key: 'genre', value: '' }]);
  const [remove, setRemove] = useState<TagRow[]>([]);
  const listId = useId();
  const clean = (rows: TagRow[]) =>
    rows.map((r) => ({ ...r, value: r.value.trim() })).filter((r) => r.value !== '');
  const ready = clean(add).length + clean(remove).length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(clean(add), clean(remove));
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <datalist id={listId}>
        {[...new Set(vocabulary.map((v) => v.value))].map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <TagRows label={t('bulk.tags.add')} rows={add} onChange={setAdd} listId={listId} t={t} />
      <TagRows
        label={t('bulk.tags.remove')}
        rows={remove}
        onChange={setRemove}
        listId={listId}
        t={t}
      />
      {error}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('upload.cancel')}
        </Button>
        <Button type="submit" disabled={!ready || pending}>
          {t('bulk.apply')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TagRows({
  label,
  rows,
  onChange,
  listId,
  t,
}: {
  label: string;
  rows: TagRow[];
  onChange: (rows: TagRow[]) => void;
  listId: string;
  t: LibraryT;
}) {
  const set = (i: number, patch: Partial<TagRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium">{label}</legend>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
        <div key={i} className="flex gap-2">
          <NativeSelect
            aria-label={`${label}: ${t('col.tags')}`}
            value={row.key}
            onChange={(e) => set(i, { key: e.target.value as TagKey })}
          >
            {tagKeySchema.options.map((key) => (
              <NativeSelectOption key={key} value={key}>
                {t(`tagKey.${key}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            aria-label={`${label}: ${t('bulk.tags.value')}`}
            placeholder={t('bulk.tags.value')}
            list={listId}
            value={row.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('bulk.tags.removeRow')}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, { key: rows.at(-1)?.key ?? 'genre', value: '' }])}
      >
        <PlusIcon data-icon="inline-start" />
        {t('bulk.tags.addRow')}
      </Button>
    </fieldset>
  );
}

// --- Fields ------------------------------------------------------------------------------

type FieldName = keyof BulkAssetPatch;
type Draft = Partial<Record<FieldName, string>>;

/** The patch for the fields ticked in `enabled`: empty text clears a nullable field. */
export function patchOf(draft: Draft, enabled: ReadonlySet<FieldName>): BulkAssetPatch {
  const patch: BulkAssetPatch = {};
  const text = (name: FieldName) => draft[name]?.trim() ?? '';
  for (const name of enabled) {
    const value = text(name);
    switch (name) {
      case 'type':
        patch.type = assetTypeSchema.parse(value || 'song');
        break;
      case 'album':
      case 'version':
        patch[name] = value || null;
        break;
      case 'year':
        patch.year = value ? Number(value) : null;
        break;
      case 'gainOverrideDb':
        patch.gainOverrideDb = value ? Number(value) : null;
        break;
      case 'explicit':
      case 'normalizeLoudness':
        patch[name] = value !== 'false';
        break;
      case 'startAt':
      case 'killAt':
        // datetime-local: the browser's time zone.
        patch[name] = value ? new Date(value).toISOString() : null;
        break;
    }
  }
  return patch;
}

const FIELDS: {
  name: FieldName;
  label: Parameters<LibraryT>[0];
  input: 'text' | 'number' | 'type' | 'bool' | 'datetime';
}[] = [
  { name: 'type', label: 'field.type', input: 'type' },
  { name: 'album', label: 'field.album', input: 'text' },
  { name: 'year', label: 'field.year', input: 'number' },
  { name: 'version', label: 'field.version', input: 'text' },
  { name: 'explicit', label: 'field.explicit', input: 'bool' },
  { name: 'startAt', label: 'field.startAt', input: 'datetime' },
  { name: 'killAt', label: 'field.killAt', input: 'datetime' },
  { name: 'normalizeLoudness', label: 'field.normalizeLoudness', input: 'bool' },
  { name: 'gainOverrideDb', label: 'field.gainOverrideDb', input: 'number' },
];

function EditForm({
  title,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  title: string;
  pending: boolean;
  error: ReactNode;
  onSubmit: (patch: BulkAssetPatch) => void;
  onCancel: () => void;
}) {
  const t = useLibraryT();
  const [enabled, setEnabled] = useState<Set<FieldName>>(new Set());
  const [draft, setDraft] = useState<Draft>({
    type: 'song',
    explicit: 'true',
    normalizeLoudness: 'true',
  });
  const toggle = (name: FieldName) => {
    const next = new Set(enabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setEnabled(next);
  };
  const set = (name: FieldName, value: string) => setDraft({ ...draft, [name]: value });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (enabled.size > 0) onSubmit(patchOf(draft, enabled));
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t('bulk.edit.help')}</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-[auto_9rem_1fr] items-center gap-x-3 gap-y-2">
        {FIELDS.map(({ name, label, input }) => {
          const on = enabled.has(name);
          const fieldLabel = t(label);
          const inputId = `bulk-field-${name}`;
          return (
            <div key={name} className="contents">
              <Checkbox aria-label={fieldLabel} checked={on} onCheckedChange={() => toggle(name)} />
              <Label htmlFor={inputId} className="font-normal">
                {fieldLabel}
              </Label>
              {input === 'type' || input === 'bool' ? (
                <NativeSelect
                  id={inputId}
                  disabled={!on}
                  value={draft[name] ?? ''}
                  onChange={(e) => set(name, e.target.value)}
                >
                  {input === 'type'
                    ? assetTypeSchema.options.map((type) => (
                        <NativeSelectOption key={type} value={type}>
                          {t(`type.${type}`)}
                        </NativeSelectOption>
                      ))
                    : [
                        <NativeSelectOption key="true" value="true">
                          {t('bulk.edit.yes')}
                        </NativeSelectOption>,
                        <NativeSelectOption key="false" value="false">
                          {t('bulk.edit.no')}
                        </NativeSelectOption>,
                      ]}
                </NativeSelect>
              ) : (
                <Input
                  id={inputId}
                  disabled={!on}
                  type={
                    input === 'datetime' ? 'datetime-local' : input === 'number' ? 'number' : 'text'
                  }
                  step={name === 'gainOverrideDb' ? '0.1' : undefined}
                  placeholder={on ? t('bulk.edit.clear') : t('bulk.edit.unchanged')}
                  value={draft[name] ?? ''}
                  onChange={(e) => set(name, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {enabled.size === 0 && <p className="text-muted-foreground">{t('bulk.edit.empty')}</p>}
      {error}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('upload.cancel')}
        </Button>
        <Button type="submit" disabled={enabled.size === 0 || pending}>
          {t('bulk.apply')}
        </Button>
      </DialogFooter>
    </form>
  );
}

// --- Category ----------------------------------------------------------------------------

type CategoryMode = 'include' | 'exclude' | 'remove';

function CategoryForm({
  stationId,
  title,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  stationId: string;
  title: string;
  pending: boolean;
  error: ReactNode;
  onSubmit: (categoryId: string, mode: CategoryMode) => void;
  onCancel: () => void;
}) {
  const t = useLibraryT();
  const categories = useQuery(categoriesQuery(stationId)).data?.items ?? [];
  const [categoryId, setCategoryId] = useState('');
  const [mode, setMode] = useState<CategoryMode>('include');
  const chosen = categoryId || categories[0]?.id || '';
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen) onSubmit(chosen, mode);
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t('bulk.category.help')}</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-[9rem_1fr] items-center gap-2">
        <Label htmlFor="bulk-category">{t('bulk.category.category')}</Label>
        <NativeSelect
          id="bulk-category"
          value={chosen}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          {categories.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor="bulk-category-mode">{t('bulk.category.mode')}</Label>
        <NativeSelect
          id="bulk-category-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as CategoryMode)}
        >
          {(['include', 'exclude', 'remove'] as const).map((m) => (
            <NativeSelectOption key={m} value={m}>
              {t(`bulk.category.${m}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {categories.length === 0 && (
        <p className="text-muted-foreground">{t('bulk.category.none')}</p>
      )}
      {error}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('upload.cancel')}
        </Button>
        <Button type="submit" disabled={!chosen || pending}>
          {t('bulk.apply')}
        </Button>
      </DialogFooter>
    </form>
  );
}
