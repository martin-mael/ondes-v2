import {
  asRunEntry,
  type Executor,
  type StationScope,
  station,
  unsafeScope,
  whereStation,
} from '@ondes/db';
import {
  type AsRunEntry,
  type OnAir,
  PUBLIC_HISTORY_MAX,
  PUBLIC_NEXT_ITEMS,
  type PublicCurrent,
  type PublicHistoryItem,
  type PublicMode,
  type PublicNowPlaying,
  type PublicStation,
} from '@ondes/shared';
import { and, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { getOnAir as getOpenEntry, toEntry } from '../asrun/index.ts';
import { readOnAir } from '../onair/service.ts';

// Public now playing and history (#74, ADR 0041): the internal on-air snapshot (ADR 0034) and
// the as-run (ADR 0015), cut down to public fields. Everything here is built once per station
// and shared by every anonymous reader (snapshot.ts); nothing is read per request.

/** A station as the public API knows it: its tenant scope, and what it may show of it. */
export interface PublicStationRef {
  scope: StationScope;
  station: PublicStation;
}

/**
 * What the DJ on air is playing, from live metadata (#68): their encoder's metadata or a
 * manual update from the dashboard. Null when no live session is open or nothing was sent.
 */
export interface LiveNowPlaying {
  title: string | null;
  artist: string | null;
  source: 'default' | 'encoder' | 'manual';
  updatedAt: string;
}
export type LiveNowPlayingReader = (
  db: Executor,
  scope: StationScope,
) => Promise<LiveNowPlaying | null>;

/**
 * Until #68's reader (`getLiveNowPlaying`, `modules/live/metadata.ts`) is wired in: no live
 * metadata, the live item has no title and `liveInfo` shows the DJ and the show.
 */
export const noLiveNowPlaying: LiveNowPlayingReader = async () => null;

export async function findStationBySlug(
  db: Executor,
  slug: string,
): Promise<PublicStationRef | null> {
  const [row] = await db
    .select({
      id: station.id,
      orgId: station.orgId,
      slug: station.slug,
      name: station.name,
      timezone: station.timezone,
    })
    .from(station)
    .where(eq(station.slug, slug));
  if (!row) return null;
  return {
    // Ids just read from the station's own row.
    scope: unsafeScope(row.orgId, row.id),
    station: { slug: row.slug, name: row.name, timezone: row.timezone },
  };
}

export function publicModeOf(onAir: OnAir): PublicMode {
  switch (onAir.mode.kind) {
    case 'live':
      return 'live';
    case 'show':
      return 'show';
    case 'automation':
    case 'safety':
      return 'automation';
    default:
      // The emergency loop is the station's "we'll be back" file: off air for listeners.
      return 'off_air';
  }
}

export async function buildNowPlaying(
  db: Executor,
  ref: PublicStationRef,
  readLive: LiveNowPlayingReader,
  now = new Date(),
): Promise<PublicNowPlaying> {
  const onAir = await readOnAir(db, ref.scope, now);
  const [entry, metadata] =
    publicModeOf(onAir) === 'live'
      ? await Promise.all([getOpenEntry(db, ref.scope), readLive(db, ref.scope)])
      : [null, null];
  return toPublicNowPlaying(ref.station, onAir, entry, metadata);
}

/**
 * The public cut of the on-air snapshot. `entry` is the open as-run entry while live (the DJ
 * and the event's title it snapshotted), `metadata` what the DJ sent (#68).
 */
export function toPublicNowPlaying(
  station: PublicStation,
  onAir: OnAir,
  entry: AsRunEntry | null,
  metadata: LiveNowPlaying | null,
): PublicNowPlaying {
  const mode = publicModeOf(onAir);
  const live = mode === 'live';
  return {
    station,
    at: onAir.at,
    mode,
    live,
    current: mode === 'off_air' ? null : currentOf(onAir, metadata),
    show: onAir.show
      ? {
          name: onAir.show.name,
          colour: onAir.show.colour,
          artworkUrl: onAir.show.artworkUrl,
          startsAt: onAir.show.startsAt,
          endsAt: onAir.show.endsAt,
          episode: onAir.show.episode
            ? { number: onAir.show.episode.number, title: onAir.show.episode.title }
            : null,
          rerun: onAir.show.rerun,
        }
      : null,
    liveInfo: live
      ? {
          djName: entry?.live?.djName ?? onAir.mode.djName,
          title: entry?.live?.title ?? onAir.show?.name ?? null,
        }
      : null,
    // Only what a listener cares about: songs and episodes, never the jingles and VTs between.
    next: onAir.next
      .filter((item) => item.kind === 'song' || item.kind === 'episode')
      .slice(0, PUBLIC_NEXT_ITEMS)
      .map((item) => ({
        kind: item.kind === 'episode' ? ('episode' as const) : ('track' as const),
        title: item.title,
        artist: item.artists.length > 0 ? item.artists.join(', ') : null,
        startsAt: item.estimatedStart,
        durationMs: item.durationMs,
      })),
  };
}

function currentOf(onAir: OnAir, metadata: LiveNowPlaying | null): PublicCurrent | null {
  const current = onAir.current;
  if (!current) return null;
  const base = { startedAt: current.startedAt, durationMs: current.durationMs };
  if (current.source === 'live') {
    return {
      kind: 'live',
      title: metadata?.title ?? null,
      artist: metadata?.artist ?? null,
      ...base,
    };
  }
  const kind = publicKindOf(current.kind, current.source);
  // Jingles, VTs, beds, promos: their titles are the station's internal names.
  if (kind === 'interlude') return { kind, title: null, artist: null, ...base };
  return { kind, title: current.title, artist: current.artist, ...base };
}

function publicKindOf(
  kind: AsRunEntry['kind'],
  source: AsRunEntry['source'],
): 'track' | 'episode' | 'interlude' {
  if (kind === 'song') return 'track';
  if (kind === 'episode') return 'episode';
  // The safety playlist pushes songs with no log item, hence no kind.
  if (kind === null && source === 'safety') return 'track';
  return 'interlude';
}

/**
 * The last `PUBLIC_HISTORY_MAX` songs, episodes and live blocks that left the air, newest
 * first. Entries skipped within seconds (`skipped`) never really aired for a listener.
 */
export async function buildHistory(
  db: Executor,
  scope: StationScope,
): Promise<PublicHistoryItem[]> {
  const rows = await db
    .select()
    .from(asRunEntry)
    .where(
      and(
        whereStation(asRunEntry, scope),
        isNotNull(asRunEntry.endedAt),
        ne(asRunEntry.outcome, 'skipped'),
        or(
          inArray(asRunEntry.kind, ['song', 'episode']),
          inArray(asRunEntry.source, ['live', 'safety']),
        ),
      ),
    )
    .orderBy(desc(asRunEntry.startedAt), desc(asRunEntry.id))
    .limit(PUBLIC_HISTORY_MAX);
  return toPublicHistory(rows.map(toEntry));
}

/** Public history items of ended as-run entries, in the given order; others are dropped. */
export function toPublicHistory(entries: readonly AsRunEntry[]): PublicHistoryItem[] {
  const items: PublicHistoryItem[] = [];
  for (const entry of entries) {
    if (!entry.endedAt || entry.outcome === 'skipped') continue;
    const times = {
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationMs: entry.durationMs ?? Date.parse(entry.endedAt) - Date.parse(entry.startedAt),
    };
    if (entry.source === 'live') {
      items.push({
        kind: 'live',
        title: entry.live?.title ?? null,
        artist: entry.live?.djName ?? null,
        ...times,
      });
      continue;
    }
    const kind = publicKindOf(entry.kind, entry.source);
    if (kind === 'interlude') continue;
    items.push({ kind, title: entry.title, artist: entry.artist, ...times });
  }
  return items;
}
