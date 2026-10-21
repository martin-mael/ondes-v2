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

export function hasTag(tags: readonly { key: TagKey; value: string }[], match: TagMatch): boolean {
  const wanted = tagKey(match);
  return tags.some((t) => tagKey(t) === wanted);
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

/** History of one slot: the items of the slot's type in air order, and lookups on them. */
export class SlotHistory {
  readonly items: PlayedItem[];
  /** Index of the first item at or after the slot: items before it precede the slot. */
  readonly insertAt: number;
  private readonly byAsset: KeyIndex = new Map();
  private readonly byTitle: KeyIndex = new Map();
  private readonly byAlbum: KeyIndex = new Map();
  private readonly byArtist: KeyIndex = new Map();
  private readonly byPrimaryArtist: KeyIndex = new Map();

  constructor(history: readonly PlayedItem[], type: AssetType, at: Date) {
    this.items = history
      .filter((item) => item.type === type)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const t = at.getTime();
    let insertAt = this.items.length;
    this.items.forEach((item, i) => {
      if (insertAt === this.items.length && item.at.getTime() >= t) insertAt = i;
      const keys = keysOf(item);
      if (item.assetId) push(this.byAsset, item.assetId, i);
      if (keys.title) push(this.byTitle, keys.title, i);
      if (keys.album) push(this.byAlbum, keys.album, i);
      for (const a of keys.artists) push(this.byArtist, a, i);
      for (const a of keys.primaryArtists) push(this.byPrimaryArtist, a, i);
    });
    this.insertAt = insertAt;
  }

  private index(kind: 'asset' | 'title' | 'album' | 'artist' | 'primaryArtist'): KeyIndex {
    switch (kind) {
      case 'asset':
        return this.byAsset;
      case 'title':
        return this.byTitle;
      case 'album':
        return this.byAlbum;
      case 'artist':
        return this.byArtist;
      case 'primaryArtist':
        return this.byPrimaryArtist;
    }
  }

  /** Positions of the items with this key, in air order. */
  positions(kind: Parameters<SlotHistory['index']>[0], key: string): readonly number[] {
    return this.index(kind).get(key) ?? [];
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
