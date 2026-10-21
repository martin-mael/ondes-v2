import {
  analysisStateSchema,
  assetTypeSchema,
  type LibraryFilter,
  librarySortSchema,
  sortDirectionSchema,
  type tagInputSchema,
  tagKeySchema,
  uuidSchema,
  validitySchema,
} from '@ondes/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { z } from 'zod';

// The library screen's state lives in the URL (shareable, back button friendly): search
// params validated here and turned into the api's `LibraryFilter`. Saved filters are named
// copies of those params, kept in this browser.

type TagInput = z.infer<typeof tagInputSchema>;

const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const list = <T extends z.ZodType>(schema: T) => opt(z.array(schema).max(50));
const num = opt(z.number().min(0).max(1_000_000));

/** `key:value`, as in `tag=genre:jazz`. */
const tagParam = z.string().regex(/^[a-z]+:.+$/);

export const librarySearchParamsSchema = z.object({
  q: opt(z.string().max(200)),
  type: list(assetTypeSchema),
  tag: list(tagParam),
  analysis: list(analysisStateSchema),
  validity: list(validitySchema),
  explicit: opt(z.boolean()),
  /** Seconds. */
  durMin: num,
  durMax: num,
  bpmMin: num,
  bpmMax: num,
  yearMin: num,
  yearMax: num,
  /** `YYYY-MM-DD`, local days. */
  addedFrom: opt(z.iso.date()),
  addedTo: opt(z.iso.date()),
  notPlayedDays: opt(z.int().min(1).max(3650)),
  never: opt(z.boolean()),
  sort: opt(librarySortSchema),
  dir: opt(sortDirectionSchema),
  /** The asset open in the drawer. */
  asset: opt(uuidSchema),
});
export type LibrarySearchParams = z.infer<typeof librarySearchParamsSchema>;

/** Params that are filters (not the sort, not the drawer). */
export const FILTER_PARAMS = [
  'q',
  'type',
  'tag',
  'analysis',
  'validity',
  'explicit',
  'durMin',
  'durMax',
  'bpmMin',
  'bpmMax',
  'yearMin',
  'yearMax',
  'addedFrom',
  'addedTo',
  'notPlayedDays',
  'never',
] as const satisfies readonly (keyof LibrarySearchParams)[];

export function parseTagParam(value: string): TagInput | null {
  const at = value.indexOf(':');
  const key = tagKeySchema.safeParse(value.slice(0, at));
  return key.success ? { key: key.data, value: value.slice(at + 1) } : null;
}

export const tagParamOf = (tag: TagInput) => `${tag.key}:${tag.value}`;

const range = <T>(min: T | undefined, max: T | undefined) =>
  min === undefined && max === undefined ? undefined : { min, max };

/** Local midnight of a `YYYY-MM-DD` day, `days` later. */
function localDay(day: string, days = 0): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + days);
}

/**
 * The api filter for these params. "Not played for N days" counts from the start of today,
 * so the filter (and its query key) stays the same all day.
 */
export function filterOf(params: LibrarySearchParams, today = new Date()): LibraryFilter {
  const tags = (params.tag ?? []).flatMap((t) => parseTagParam(t) ?? []);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const filter: LibraryFilter = {
    q: params.q?.trim() || undefined,
    types: params.type?.length ? params.type : undefined,
    tags: tags.length ? tags : undefined,
    analysis: params.analysis?.length ? params.analysis : undefined,
    validity: params.validity?.length ? params.validity : undefined,
    explicit: params.explicit,
    durationMs: range(
      params.durMin === undefined ? undefined : Math.round(params.durMin * 1000),
      params.durMax === undefined ? undefined : Math.round(params.durMax * 1000),
    ),
    bpm: range(params.bpmMin, params.bpmMax),
    year: range(
      params.yearMin === undefined ? undefined : Math.round(params.yearMin),
      params.yearMax === undefined ? undefined : Math.round(params.yearMax),
    ),
    addedAt: range(
      params.addedFrom ? localDay(params.addedFrom) : undefined,
      // Inclusive: up to the end of that day.
      params.addedTo ? new Date(localDay(params.addedTo, 1).getTime() - 1) : undefined,
    ),
    notPlayedSince: params.notPlayedDays
      ? new Date(startOfToday.getTime() - params.notPlayedDays * 86_400_000)
      : undefined,
    neverPlayed: params.never || undefined,
  };
  return Object.fromEntries(
    Object.entries(filter).filter(([, v]) => v !== undefined),
  ) as LibraryFilter;
}

/** Only the filter params of `params`. */
export function filterParamsOf(params: LibrarySearchParams): Partial<LibrarySearchParams> {
  return Object.fromEntries(
    FILTER_PARAMS.flatMap((k) => (params[k] === undefined ? [] : [[k, params[k]]])),
  );
}

export const hasFilters = (params: LibrarySearchParams) =>
  Object.keys(filterParamsOf(params)).length > 0;

/** Toggles `value` in a list param; an emptied list is dropped. */
export function toggled<T>(list: readonly T[] | undefined, value: T): T[] | undefined {
  const next = list?.includes(value) ? list.filter((v) => v !== value) : [...(list ?? []), value];
  return next.length ? next : undefined;
}

// --- Browser storage ---------------------------------------------------------------------

/** Reads and writes JSON in localStorage, tolerating private mode and garbage. */
function stored<T>(key: string, schema: z.ZodType<T>, fallback: T) {
  const listeners = new Set<() => void>();
  let cache: { raw: string | null; value: T } | null = null;
  const read = (): T => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return fallback;
    }
    if (cache && cache.raw === raw) return cache.value;
    let value = fallback;
    try {
      const parsed = schema.safeParse(raw === null ? undefined : JSON.parse(raw));
      if (parsed.success) value = parsed.data;
    } catch {
      // Not JSON: keep the fallback.
    }
    cache = { raw, value };
    return value;
  };
  const write = (value: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the setting lasts until reload.
      cache = { raw: null, value };
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { read, write, subscribe };
}

const stores = new Map<string, ReturnType<typeof stored<unknown>>>();
function useStored<T>(key: string, schema: z.ZodType<T>, fallback: T): [T, (value: T) => void] {
  let store = stores.get(key) as ReturnType<typeof stored<T>> | undefined;
  if (!store) {
    store = stored(key, schema, fallback);
    stores.set(key, store as ReturnType<typeof stored<unknown>>);
  }
  const value = useSyncExternalStore(store.subscribe, store.read, () => fallback);
  return [value, store.write];
}

export const savedFilterSchema = z.object({
  name: z.string().min(1).max(100),
  params: librarySearchParamsSchema.omit({ asset: true }),
});
export type SavedFilter = z.infer<typeof savedFilterSchema>;
const savedFiltersSchema = z.array(savedFilterSchema).max(100);
const NO_SAVED: SavedFilter[] = [];

/** Named filters of this station, in this browser. */
export function useSavedFilters(stationId: string) {
  const [saved, write] = useStored(
    `ondes.library.savedFilters.${stationId}`,
    savedFiltersSchema,
    NO_SAVED,
  );
  const save = useCallback(
    (name: string, params: LibrarySearchParams) => {
      const { asset: _asset, ...rest } = params;
      write([...saved.filter((s) => s.name !== name), { name, params: rest }]);
    },
    [saved, write],
  );
  const remove = useCallback(
    (name: string) => write(saved.filter((s) => s.name !== name)),
    [saved, write],
  );
  return { saved, save, remove };
}

/** Visible table columns, in this browser. `null`: the defaults. */
export function useColumnPrefs() {
  return useStored<string[] | null>(
    'ondes.library.columns',
    z.array(z.string()).max(50).nullable(),
    null,
  );
}
