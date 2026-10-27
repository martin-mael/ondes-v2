import type { AssetType, TagKey, TagMatch } from '@ondes/shared';

// The play history a pick is checked against: as-run entries and already planned log items,
// indexed once per slot so each rule is a lookup instead of a scan.

/** Something that aired or is planned to air, as the rules see it. */
export interface PlayedItem {
  assetId: string | null;
  /** The asset's type; items of another type than the slot's category are ignored. */
  type: AssetType | null;
  title: string | null;
  artists: readonly string[];
  album: string | null;
  tags: readonly { key: TagKey; value: string }[];
  bpm?: number | null;
  energy?: number | null;
  /** When it started (as-run) or is planned to start (log). */
  at: Date;
}

/** Lower case, single spaces, accents kept: "Daft  Punk " and "daft punk" are one artist. */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A title without its trailing bracketed versions: "One More Time (Radio Edit)" → "one more time". */
export function normalizeTitle(value: string): string {
  let title = normalizeName(value);
  for (;;) {
    const stripped = title.replace(/\s*[([][^()[\]]*[)\]]$/, '').trim();
    if (stripped === title || stripped === '') return title;
    title = stripped;
  }
}

/**
 * An artist as separation compares it: no accents, no punctuation, no leading "the", lower
 * case. "Beyoncé", "BEYONCE" and "The Beyoncé" are one artist.
 */
export function normalizeArtist(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * Joiners inside one credit: "A feat. B", "A ft B", "A featuring B", "A & B", "A x B",
 * "A vs. B", "A, B", "A / B", "A with B", "A avec B" (word-bounded, any case).
 */
const ARTIST_JOINERS =
  /\s+(?:feat\.?|ft\.?|featuring|with|avec|vs\.?|x)\s+|\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+|\s*[&,/;+]\s*/iu;

/** Every artist named by the credits, split on the joiners, normalized, first one first. */
export function splitArtists(artists: readonly string[]): string[] {
  const keys: string[] = [];
  for (const credit of artists) {
    for (const part of credit.split(ARTIST_JOINERS)) {
      const key = normalizeArtist(part);
      if (key !== '' && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * The artists a separation rule compares: every credited one (primary and featured), or only
 * the primary one, the first name of the first credit.
 */
export function artistKeys(artists: readonly string[], includeFeatured: boolean): string[] {
  const keys = splitArtists(artists);
  return includeFeatured ? keys : keys.slice(0, 1);
}

export function tagKey(tag: { key: string; value: string }): string {
  return `${tag.key}=${normalizeName(tag.value)}`;
}

/** Normalized tag keys per tag list, computed once per list (items and members are reused). */
const tagSets = new WeakMap<readonly { key: TagKey; value: string }[], Set<string>>();

export function hasTag(tags: readonly { key: TagKey; value: string }[], match: TagMatch): boolean {
  let set = tagSets.get(tags);
  if (!set) {
    set = new Set(tags.map(tagKey));
    tagSets.set(tags, set);
  }
  return set.has(tagKey(match));
}

/** The lookup keys of an item, computed once per item (a sequence reuses the same items). */
interface ItemKeys {
  title: string | null;
  album: string | null;
  artists: string[];
  primaryArtists: string[];
}
const keysCache = new WeakMap<PlayedItem, ItemKeys>();

function keysOf(item: PlayedItem): ItemKeys {
  let keys = keysCache.get(item);
  if (!keys) {
    keys = {
      title: item.title ? normalizeTitle(item.title) : null,
      album: item.album?.trim() ? normalizeName(item.album) : null,
      artists: artistKeys(item.artists, true),
      primaryArtists: artistKeys(item.artists, false),
    };
    keysCache.set(item, keys);
  }
  return keys;
}

/** Positions (in history order) of the items carrying each key. */
type KeyIndex = Map<string, number[]>;

function push(index: KeyIndex, key: string, position: number) {
  const list = index.get(key);
  if (list) list.push(position);
  else index.set(key, [position]);
}

type IndexKind = 'asset' | 'title' | 'album' | 'artist' | 'primaryArtist';

/** The items of one asset type in air order, with their lookup keys indexed. */
class TypeIndex {
  readonly items: PlayedItem[] = [];
  readonly byKind: Record<IndexKind, KeyIndex> = {
    asset: new Map(),
    title: new Map(),
    album: new Map(),
    artist: new Map(),
    primaryArtist: new Map(),
  };
  /** The last item per asset (the latest one, in air order). */
  readonly lastByAsset = new Map<string, PlayedItem>();
  /** How many items of the source array it has read. */
  consumed = 0;
  /**
   * The assets whose latest item may have changed, in the order it happened (added, or taken
   * out by `removeFromHistory`). Append-only: a reader remembers how far it got.
   */
  readonly changes: string[] = [];

  add(item: PlayedItem) {
    const i = this.items.length;
    this.items.push(item);
    if (item.assetId) {
      this.lastByAsset.set(item.assetId, item);
      this.changes.push(item.assetId);
    }
    const keys = keysOf(item);
    if (item.assetId) push(this.byKind.asset, item.assetId, i);
    if (keys.title) push(this.byKind.title, keys.title, i);
    if (keys.album) push(this.byKind.album, keys.album, i);
    for (const a of keys.artists) push(this.byKind.artist, a, i);
    for (const a of keys.primaryArtists) push(this.byKind.primaryArtist, a, i);
  }

  /**
   * Re-reads the type's items of `history` in place, keeping its identity: `changes` gets the
   * assets whose latest item is no longer the same (taken out, or added since it last read).
   */
  rebuild(history: readonly PlayedItem[], type: AssetType) {
    const changes = this.changes.length;
    const before = new Map(this.lastByAsset);
    this.items.length = 0;
    this.lastByAsset.clear();
    for (const index of Object.values(this.byKind)) index.clear();
    for (const item of sortedOfType(history, type)) this.add(item);
    this.changes.length = changes;
    this.consumed = history.length;
    for (const [assetId, item] of before) {
      if (this.lastByAsset.get(assetId) !== item) this.changes.push(assetId);
    }
    for (const assetId of this.lastByAsset.keys()) {
      if (!before.has(assetId)) this.changes.push(assetId);
    }
  }
}

function sortedOfType(history: readonly PlayedItem[], type: AssetType): PlayedItem[] {
  return history
    .filter((item) => item.type === type)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Indexes per history array and type. A sequence of picks (`pickSequence`, the log generator)
 * appends each pick to the same array: when the new items come after every indexed one, the
 * index is extended instead of rebuilt. Anything else rebuilds it, so the result is always the
 * items of the type sorted by time (stable), as a fresh index would have them. History arrays
 * are treated as append-only: an item is never changed or removed in place.
 */
const indexes = new WeakMap<readonly PlayedItem[], Map<AssetType, TypeIndex>>();

/**
 * Takes items out of a history array in place, for a planner that changes its mind (the
 * generator's back-timing dropping a pick, #46). The indexes built on the array are rebuilt in
 * place and list the assets whose latest play changed in their `changes`, so the picker's rotation order is
 * brought up to date rather than recomputed. Returns how many items went.
 */
export function removeFromHistory(
  history: PlayedItem[],
  remove: (item: PlayedItem) => boolean,
): number {
  let removed = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!remove(history[i] as PlayedItem)) continue;
    history.splice(i, 1);
    removed++;
  }
  if (removed === 0) return 0;
  for (const [type, index] of indexes.get(history) ?? []) index.rebuild(history, type);
  return removed;
}

function indexFor(history: readonly PlayedItem[], type: AssetType): TypeIndex {
  let byType = indexes.get(history);
  if (!byType) {
    byType = new Map();
    indexes.set(history, byType);
  }
  const cached = byType.get(type);
  if (cached && cached.consumed <= history.length) {
    let last = cached.items.at(-1)?.at.getTime() ?? Number.NEGATIVE_INFINITY;
    let appendable = true;
    for (let i = cached.consumed; i < history.length; i++) {
      const item = history[i] as PlayedItem;
      if (item.type !== type) continue;
      const t = item.at.getTime();
      if (t < last) {
        appendable = false;
        break;
      }
      last = t;
    }
    if (appendable) {
      for (let i = cached.consumed; i < history.length; i++) {
        const item = history[i] as PlayedItem;
        if (item.type === type) cached.add(item);
      }
      cached.consumed = history.length;
      return cached;
    }
  }
  const index = new TypeIndex();
  for (const item of sortedOfType(history, type)) index.add(item);
  index.consumed = history.length;
  byType.set(type, index);
  return index;
}

const NONE: readonly number[] = [];

/** History of one slot: the items of the slot's type in air order, and lookups on them. */
export class SlotHistory {
  readonly items: readonly PlayedItem[];
  /** Index of the first item at or after the slot: items before it precede the slot. */
  readonly insertAt: number;
  private readonly index: TypeIndex;
  /** The slot's time, in ms. */
  private readonly at: number;

  constructor(history: readonly PlayedItem[], type: AssetType, at: Date) {
    this.index = indexFor(history, type);
    this.items = this.index.items;
    // The first item at or after the slot (binary search: items are in air order).
    const t = at.getTime();
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.items[mid] as PlayedItem).at.getTime() < t) lo = mid + 1;
      else hi = mid;
    }
    this.insertAt = lo;
    this.at = t;
  }

  /**
   * The index behind this history: the same object for every slot of one history array and
   * type while it only grows (see `indexFor`). Lets a sequence of picks reuse work.
   */
  get source(): object {
    return this.index;
  }

  /** The assets whose latest item may have changed, in order (append-only, see `TypeIndex`). */
  get changes(): readonly string[] {
    return this.index.changes;
  }

  /** Every item precedes the slot (a sequence planning forward in time). */
  get allPrecede(): boolean {
    return this.insertAt === this.items.length;
  }

  /** The last item with this asset before the slot, if any. */
  lastBefore(assetId: string): PlayedItem | undefined {
    // The asset's latest item, when it precedes the slot, is it (a sequence planning forward
    // has every item before the slot); never played, there is none.
    const latest = this.index.lastByAsset.get(assetId);
    if (!latest || this.insertAt === this.items.length) return latest;
    if (latest.at.getTime() < this.at) return latest;
    const positions = this.positions('asset', assetId);
    let lo = 0;
    let hi = positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((positions[mid] as number) < this.insertAt) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? this.items[positions[lo - 1] as number] : undefined;
  }

  /** Positions of the items with this key, in air order. */
  positions(kind: IndexKind, key: string): readonly number[] {
    return this.index.byKind[kind].get(key) ?? NONE;
  }

  /** The `count` items right before the slot, nearest last. */
  preceding(count: number): PlayedItem[] {
    return this.items.slice(Math.max(0, this.insertAt - count), this.insertAt);
  }
}

/**
 * The closest clash with the slot among `positions`: in minutes either side of `at`, or in
 * items between it and the slot (0: right next to it). `null` when none.
 */
export function nearest(
  history: SlotHistory,
  positions: readonly number[],
  at: Date,
): { minutes: number; items: number } | null {
  if (positions.length === 0) return null;
  let minutes = Number.POSITIVE_INFINITY;
  let items = Number.POSITIVE_INFINITY;
  const t = at.getTime();
  for (const p of positions) {
    const item = history.items[p] as PlayedItem;
    minutes = Math.min(minutes, Math.abs(item.at.getTime() - t) / 60_000);
    items = Math.min(items, p < history.insertAt ? history.insertAt - p - 1 : p - history.insertAt);
  }
  return { minutes, items };
}
