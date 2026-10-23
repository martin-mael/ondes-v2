import {
  assetCues,
  type Executor,
  liveSession,
  type StationScope,
  show,
  streamer,
  whereStation,
} from '@ondes/db';
import {
  type AsRunEntry,
  type LogItem,
  ON_AIR_NEXT_ITEMS,
  type OnAir,
  type OnAirCurrent,
  type OnAirHardEvent,
  type OnAirModeKind,
  type OnAirShow,
  type ShowOccurrence,
} from '@ondes/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getOnAir as getOpenEntry } from '../asrun/index.ts';
import { getLogRange } from '../log/repo.ts';
import { getOccurrences } from '../shows/repo.ts';
import { estimateNext } from './estimate.ts';

// On air (#70): one snapshot of what the station plays now, for the dashboard. Read from the
// as-run (what is really on air, on the engine's clock), the published log around now (what
// comes next), the show calendar (the block and the next show) and the open live session (the
// DJ's name). ADR 0034.

const HOUR = 3_600_000;
/** How far back the log is read: the item on air started before now. */
const LOG_BEHIND_MS = 6 * HOUR;
/** How far ahead the log and the calendar are read for the next items and the next event. */
const AHEAD_MS = 24 * HOUR;

export async function readOnAir(
  db: Executor,
  scope: StationScope,
  now = new Date(),
): Promise<OnAir> {
  const at = now.getTime();
  const [entry, log, calendar] = await Promise.all([
    getOpenEntry(db, scope),
    getLogRange(db, scope, {
      from: new Date(at - LOG_BEHIND_MS).toISOString(),
      to: new Date(at + AHEAD_MS).toISOString(),
    }),
    getOccurrences(db, scope, { from: new Date(at - 25 * HOUR), to: new Date(at + AHEAD_MS) }),
  ]);

  // Only published days go on air (the feeder skips drafts, ADR 0012).
  const published = new Set(log.days.filter((d) => d.status === 'published').map((d) => d.id));
  const items: LogItem[] = log.items.filter((item) => published.has(item.logDayId));
  const estimate = estimateNext(
    items,
    entry
      ? {
          logItemId: entry.logItemId,
          segmentId: entry.segmentId,
          startedAt: Date.parse(entry.startedAt),
        }
      : null,
    at,
    ON_AIR_NEXT_ITEMS,
  );

  const occurrences = calendar.occurrences;
  const block = currentOccurrence(occurrences, at);
  const nextShow = occurrences.find((o) => o.startsAt.getTime() > at) ?? null;

  const [current, djName, showBlock] = await Promise.all([
    entry ? currentOf(db, scope, entry) : null,
    entry?.source === 'live' ? liveDjName(db, scope, entry.liveSessionId) : null,
    block ? showOf(db, scope, block) : null,
  ]);

  return {
    at: now.toISOString(),
    mode: { kind: modeOf(entry), djName },
    current,
    next: estimate.next,
    nextHardEvent: earliest(estimate.hardEvent, nextShow),
    show: showBlock,
  };
}

export function modeOf(entry: AsRunEntry | null): OnAirModeKind {
  if (!entry) return 'off_air';
  switch (entry.source) {
    case 'live':
      return 'live';
    case 'safety':
      return 'safety';
    case 'emergency':
      return 'emergency';
    default:
      return entry.episode || entry.kind === 'episode' ? 'show' : 'automation';
  }
}

/** The occurrence `at` falls in; the latest-starting one when two overlap. */
function currentOccurrence(occurrences: readonly ShowOccurrence[], at: number) {
  let found: ShowOccurrence | null = null;
  for (const o of occurrences) {
    if (o.startsAt.getTime() <= at && o.endsAt.getTime() > at) found = o;
  }
  return found;
}

function earliest(fromLog: OnAirHardEvent | null, show: ShowOccurrence | null) {
  const fromShow: OnAirHardEvent | null = show
    ? {
        kind: 'show',
        at: show.startsAt.toISOString(),
        title: show.show.name,
        logItemId: null,
        showId: show.show.id,
      }
    : null;
  if (!fromLog) return fromShow;
  if (!fromShow) return fromLog;
  return Date.parse(fromShow.at) <= Date.parse(fromLog.at) ? fromShow : fromLog;
}

async function currentOf(
  db: Executor,
  scope: StationScope,
  entry: AsRunEntry,
): Promise<OnAirCurrent> {
  const [cues] = entry.assetId
    ? await db
        .select({
          sampleRate: assetCues.sampleRate,
          cueIn: assetCues.cueIn,
          cueOut: assetCues.cueOut,
          introEnd: assetCues.introEnd,
          outroStart: assetCues.outroStart,
        })
        .from(assetCues)
        .where(and(whereStation(assetCues, scope), eq(assetCues.assetId, entry.assetId)))
    : [];
  // Cue points are sample positions in the file; on air, time 0 is the cue-in.
  const fromCueIn = (samples: number | null | undefined) =>
    cues && samples != null
      ? Math.max(0, Math.round(((samples - (cues.cueIn ?? 0)) / cues.sampleRate) * 1000))
      : null;
  return {
    asRunId: entry.id,
    source: entry.source,
    kind: entry.kind,
    logItemId: entry.logItemId,
    title: entry.title,
    artist: entry.artist,
    startedAt: entry.startedAt,
    durationMs: entry.plannedDurationMs ?? fromCueIn(cues?.cueOut),
    introMs: fromCueIn(cues?.introEnd),
    outroMs: fromCueIn(cues?.outroStart),
  };
}

/** The DJ of the live session on air: the entry's, else the station's open one. */
async function liveDjName(
  db: Executor,
  scope: StationScope,
  sessionId: string | null,
): Promise<string | null> {
  const [row] = await db
    .select({ name: streamer.displayName })
    .from(liveSession)
    .innerJoin(streamer, eq(streamer.id, liveSession.streamerId))
    .where(
      and(
        whereStation(liveSession, scope),
        sessionId ? eq(liveSession.id, sessionId) : isNull(liveSession.endedAt),
      ),
    )
    .orderBy(desc(liveSession.startedAt))
    .limit(1);
  return row?.name ?? null;
}

async function showOf(db: Executor, scope: StationScope, o: ShowOccurrence): Promise<OnAirShow> {
  const [row] = await db
    .select({ artworkUrl: show.artworkUrl })
    .from(show)
    .where(and(whereStation(show, scope), eq(show.id, o.show.id)));
  const episode = o.type === 'rerun' ? (o.rerunOf ?? null) : o.episode;
  return {
    showId: o.show.id,
    name: o.show.name,
    colour: o.show.colour,
    artworkUrl: row?.artworkUrl ?? null,
    type: o.type,
    startsAt: o.startsAt.toISOString(),
    endsAt: o.endsAt.toISOString(),
    episode: episode ? { id: episode.id, number: episode.number, title: episode.title } : null,
    rerun: o.type === 'rerun',
  };
}
