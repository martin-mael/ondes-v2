import { randomUUID } from 'node:crypto';
import type { StationScope } from '@ondes/db';
import {
  backTiming,
  type GeneratedDay,
  type GeneratorAsset,
  type GeneratorSnapshot,
  generateDays,
} from '@ondes/scheduling';
import {
  datesFrom,
  FIXTURE_TZ,
  HARD_START_SHOWS,
  type HardStartShow,
  hardStartSnapshot,
} from '@ondes/scheduling/testing';
import {
  type AsRunEntry,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineQueuedRequest,
  type EngineSchedule,
  type EngineState,
  type LocalDate,
  type LogItem,
  zonedInstant,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { createStationFeeder, type FeederEngine } from './feeder.ts';
import type { FeedMedia } from './push.ts';
import type { FeedWindow } from './repo.ts';

// Acceptance of #46 ("over 2 weeks of as-run data, pre-recorded episodes start within the
// spike's measured accuracy"), without two real weeks: two weeks of logs generated with
// back-timing, played by the real feeder (`createStationFeeder`) into a model of the engine,
// and the as-run it produces measured against ADR 0003's target: every hard start within one
// frame (20 ms) of its time, on the audio timeline.
//
// The engine model follows what spike #14 measured (ADR 0003):
// - an item lasts what was pushed (cue points, trim) minus its overlap plus one frame; the
//   transition lands on a frame boundary, a frame either way of the plan now and then;
// - durations are off by up to ~0.3 s (decoders, metadata), now and then by seconds (a wrong
//   cue), and a presenter sometimes skips an item;
// - Node sees each start through the as-run callback's `time()`: 45–60 ms late, up to 0.8 s;
// - a scheduled item starts on the frame nearest its time (the gate on the audio timeline);
//   whatever is on air fades out under it;
// - an empty queue airs the safety playlist until the next push;
// - the engine restarts once, losing its queue and its schedule.
// The as-run entries are the audio-timeline times (ADR 0003: the as-run `at` on the audio
// timeline matched the recorded audio to a frame).

const FRAME = 20;
const SR = 44_100;
const scope = { orgId: randomUUID(), stationId: randomUUID() } as StationScope;

/** mulberry32: a seeded, reproducible stream in [0, 1). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assetsOf(snapshot: GeneratorSnapshot): Map<string, GeneratorAsset> {
  const out = new Map(snapshot.assets);
  for (const c of snapshot.categories.values()) for (const m of c.members) out.set(m.id, m);
  for (const o of snapshot.occurrences)
    if (o.episode?.asset) out.set(o.episode.asset.id, o.episode.asset);
  return out;
}

function logOf(days: GeneratedDay[], assets: Map<string, GeneratorAsset>): LogItem[] {
  return days.flatMap((day) =>
    day.items.map((i): LogItem => {
      const asset = i.assetId ? assets.get(i.assetId) : undefined;
      return {
        id: `${day.localDate}#${i.position}`,
        logDayId: day.localDate,
        position: i.position,
        kind: i.kind,
        plannedStart: i.plannedStart.toISOString(),
        plannedDurationMs: i.plannedDurationMs,
        assetId: i.assetId,
        asset: null,
        episodeId: i.episodeId,
        liveSlotId: null,
        title: i.title,
        cueOverrides: asset ? { crossOutMs: asset.overlapMs } : null,
        timing: i.timing,
        anchorAt: i.anchorAt?.toISOString() ?? null,
        capMs: i.capMs,
        origin: i.origin,
        locked: false,
        relaxedRules: i.relaxedRules,
        segmentId: null,
        conflict: i.conflict,
        parts: [],
      };
    }),
  );
}

function mediaOf(asset: GeneratorAsset): FeedMedia {
  return {
    assetId: asset.id,
    fileId: `file-${asset.id}`,
    sha256: asset.id.replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
    ext: 'flac',
    flacBlockSize: 1024,
    durationSamples: Math.round(((asset.playMs ?? asset.durationMs ?? 0) * SR) / 1000),
    sampleRate: SR,
    cached: true,
    title: asset.title,
    artists: [...asset.artists],
    cues: null,
    gain: { normalizeLoudness: false, gainOverrideDb: null, loudness: null },
  };
}

type Playing = {
  /** Log item id; null for the safety playlist. */
  id: string | null;
  startMs: number;
  /** Where it ends if nothing interrupts it. */
  endMs: number;
  /** When Node thinks it started (the as-run callback's `time()`). */
  nodeStartMs: number;
};

type Disturbances = {
  /** Probability that an item's length is off by seconds. */
  bigError: number;
  /** Probability that a presenter skips an item half way. */
  skip: number;
};

/** The engine, on its audio timeline. Driven by `advance(to)`; Node reads it through the adapter calls. */
class ModelEngine implements FeederEngine {
  bootId = 'boot-1';
  queue: { id: string; body: EnginePushItem }[] = [];
  scheduledBody: EngineSchedule | null = null;
  /** The frame the gate opens on. */
  gateMs = Number.POSITIVE_INFINITY;
  /** Where the audio timeline's frames start against the wall clock (per boot). */
  phase: number;
  onAir: Playing | null = null;
  time: number;
  asRun: Pick<AsRunEntry, 'logItemId' | 'startedAt' | 'plannedStart' | 'driftMs'>[] = [];
  /** At each engine-timed cut: how much of the interrupted item's natural end was faded. */
  cuts: { itemId: string | null; atMs: number; residualMs: number }[] = [];
  /** Starts of the items that were skipped or far off their length. */
  disturbed: number[] = [];
  /** Safety airing between two log items, with when it started. */
  dry: { fromMs: number; toMs: number }[] = [];
  /** Node syncs due: one per as-run start, when Node hears of it. */
  wakeups: number[] = [];
  readonly items: Map<string, LogItem>;
  readonly assets: Map<string, GeneratorAsset>;
  readonly random: () => number;
  readonly disturb: Disturbances;
  schedule?: FeederEngine['schedule'];
  unschedule?: FeederEngine['unschedule'];

  constructor(
    start: number,
    items: Map<string, LogItem>,
    assets: Map<string, GeneratorAsset>,
    options: { engineCut: boolean; seed: number; disturb: Disturbances },
  ) {
    this.time = start;
    this.items = items;
    this.assets = assets;
    this.random = rng(options.seed);
    this.phase = Math.floor(this.random() * FRAME);
    this.disturb = options.disturb;
    this.startSafety(start);
    if (options.engineCut) {
      this.schedule = async (body) => {
        this.scheduledBody = body;
        // The frame nearest `at` on the audio timeline: frames start every 20 ms from the
        // boot's clock origin, which sits anywhere against the wall clock's seconds.
        const at = body.at * 1000;
        this.gateMs = this.phase + Math.round((at - this.phase) / FRAME) * FRAME;
        return { rid: 0, item_id: body.item_id, uri: body.uri, status: 'ready' };
      };
      this.unschedule = async () => {
        const cancelled = this.scheduledBody !== null;
        this.cancelSchedule();
        return { cancelled };
      };
    }
  }

  private cancelSchedule() {
    this.scheduledBody = null;
    this.gateMs = Number.POSITIVE_INFINITY;
  }

  /** Node's view of a start: the callback's `time()` lags the audio by 45–60 ms, rarely more. */
  private jitter(): number {
    const r = this.random();
    if (r < 0.001) return 200 + this.random() * 600;
    if (r < 0.01) return 100 + this.random() * 100;
    return 45 + this.random() * 15;
  }

  /** How long an item really occupies the air, from what was pushed. */
  private occupancy(
    id: string,
    body: { cue_in?: number; cue_out?: number; cross_out?: number },
    at: number,
  ) {
    const item = this.items.get(id) as LogItem;
    const asset = this.assets.get(item.assetId as string) as GeneratorAsset;
    const fileMs = asset.playMs ?? asset.durationMs ?? 0;
    const playedMs = (body.cue_out ?? fileMs / 1000) * 1000 - (body.cue_in ?? 0) * 1000;
    let ms = Math.round(playedMs - (body.cross_out ?? 0) * 1000 + FRAME);
    // The transition lands on a frame boundary: nearly always where planned, a frame off now
    // and then (ADR 0003 §2, with the +20 ms model).
    const f = this.random();
    if (f > 0.95) ms += FRAME;
    else if (f > 0.85) ms -= FRAME;
    // Decoder and metadata error: up to ~0.3 s.
    ms += Math.round((this.random() + this.random() + this.random() - 1.5) * 200);
    if (this.random() < this.disturb.bigError) {
      ms += Math.round((this.random() - 0.5) * 16_000);
      this.disturbed.push(at);
    }
    if (item.kind !== 'episode' && this.random() < this.disturb.skip) {
      ms = Math.round(ms * (0.2 + this.random() * 0.6));
      this.disturbed.push(at);
    }
    return Math.max(FRAME, ms);
  }

  private start(id: string, at: number, lengthMs: number) {
    if (this.onAir?.id === null) this.dry.push({ fromMs: this.onAir.startMs, toMs: at });
    const nodeStartMs = at + this.jitter();
    this.onAir = { id, startMs: at, endMs: at + lengthMs, nodeStartMs };
    const item = this.items.get(id) as LogItem;
    this.asRun.push({
      logItemId: id,
      startedAt: new Date(at).toISOString(),
      plannedStart: item.plannedStart,
      driftMs: at - Date.parse(item.plannedStart),
    });
    this.wakeups.push(nodeStartMs);
  }

  private startSafety(at: number) {
    this.onAir = { id: null, startMs: at, endMs: Number.POSITIVE_INFINITY, nodeStartMs: at };
  }

  /** Plays the audio up to `to`. */
  advance(to: number) {
    for (let guard = 0; ; guard++) {
      if (guard > 100_000)
        throw new Error(`engine model stuck at ${new Date(this.time).toISOString()}`);
      const playing = this.onAir as Playing;
      const next = Math.min(playing.endMs, this.gateMs);
      if (next > to) break;
      if (this.gateMs <= playing.endMs) {
        // The gate opens: the scheduled item starts, what's on air fades out under it.
        const body = this.scheduledBody as EngineSchedule;
        const at = this.gateMs;
        if (playing.id !== null)
          this.cuts.push({ itemId: playing.id, atMs: at, residualMs: playing.endMs - at });
        else this.cuts.push({ itemId: null, atMs: at, residualMs: playing.startMs - at });
        this.cancelSchedule();
        this.start(body.item_id, at, this.occupancy(body.item_id, body, at));
        continue;
      }
      const head = this.queue.shift();
      if (head) {
        this.start(head.id, playing.endMs, this.occupancy(head.id, head.body, playing.endMs));
      } else this.startSafety(playing.endMs);
    }
    this.time = to;
  }

  restart() {
    this.bootId = `boot-${Number(this.bootId.slice(5)) + 1}`;
    this.phase = Math.floor(this.random() * FRAME);
    this.disturbed.push(this.time);
    this.queue = [];
    this.cancelSchedule();
    this.startSafety(this.time);
  }

  async state(): Promise<EngineState> {
    const playing = this.onAir as Playing;
    const queue: EngineQueuedRequest[] = this.queue.map((q, rid) => ({
      rid,
      item_id: q.id,
      segment_id: null,
      uri: q.body.uri,
      status: 'ready',
    }));
    return {
      boot_id: this.bootId,
      station_id: scope.stationId,
      version: '2.4.6',
      uptime: 1,
      seq: 1,
      on_air:
        playing.id === null
          ? { source: 'safety', item_id: null }
          : {
              item_id: playing.id,
              segment_id: null,
              source: 'queue',
              elapsed: Math.max(0, this.time - playing.nodeStartMs) / 1000,
            },
      queue,
      scheduled: this.scheduledBody
        ? { item_id: this.scheduledBody.item_id, at: this.scheduledBody.at }
        : null,
      live: { enabled: false, connected: false, ready: false },
      blank: false,
      output_db: null,
    };
  }

  async push(body: EnginePushItem) {
    this.queue.push({ id: body.item_id, body });
    // A dry queue: the log takes the air back from safety right away.
    if (this.onAir?.id === null) {
      const head = this.queue.shift() as { id: string; body: EnginePushItem };
      this.start(head.id, this.time, this.occupancy(head.id, head.body, this.time));
    }
    return { rid: 0, item_id: body.item_id, uri: body.uri, status: 'ready' };
  }

  async pushSegment(_segment: EnginePushSegment): Promise<never> {
    throw new Error('no segments in this log');
  }

  async remove(id: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    return { removed: before - this.queue.length };
  }

  async clear() {
    const removed = this.queue.length;
    this.queue = [];
    return { removed };
  }
}

type SimResult = {
  hard: number[];
  soft: { driftMs: number; capMs: number; anchorMs: number }[];
  missing: string[];
  engine: ModelEngine;
  hardAnchors: number;
};

/** Two weeks from `first`, played through the feeder. */
async function simulate(
  first: LocalDate,
  options: {
    engineCut: boolean;
    seed: number;
    disturb?: Disturbances;
    shows?: readonly HardStartShow[];
    days?: number;
  },
): Promise<SimResult> {
  const dates = datesFrom(first, options.days ?? 14);
  const snapshot = hardStartSnapshot(dates, options.shows ? { shows: options.shows } : {});
  const days = generateDays(snapshot, dates, { extensions: backTiming(snapshot) });
  const assets = assetsOf(snapshot);
  const items = logOf(days, assets);
  const byId = new Map(items.map((i) => [i.id, i]));
  const media = new Map([...assets.values()].map((a) => [a.id, mediaOf(a)]));
  const starts = items.map((i) => Date.parse(i.plannedStart));

  const begin = (days[0] as GeneratedDay).startsAt.getTime();
  const end = (days.at(-1) as GeneratedDay).endsAt.getTime() - 3 * 3_600_000;
  const engine = new ModelEngine(begin, byId, assets, {
    engineCut: options.engineCut,
    seed: options.seed,
    disturb: options.disturb ?? { bigError: 0.003, skip: 0.002 },
  });
  const station = { loudnessTargetLufs: -16, truePeakLimitDbtp: -1 };
  let now = begin;
  const lowerBound = (ms: number) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((starts[mid] as number) < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const feeder = createStationFeeder({
    scope,
    engine: async () => engine,
    load: async ({ from, to }): Promise<FeedWindow> => ({
      items: items.slice(Math.max(0, lowerBound(from.getTime()) - 1), lowerBound(to.getTime())),
      media,
      station,
    }),
    cache: { requestUrgentFetch: async () => {}, requestSync: async () => {} },
    alerts: { raise: async () => {}, resolve: async () => {} },
    now: () => now,
  });

  // Node syncs: on every as-run start it hears of, every 30 s, and every 5 s in the two
  // minutes before an anchor (the real feeder ticks every 5 s throughout).
  const anchors = items
    .filter((i) => i.timing === 'hard' || (i.timing === 'soft' && i.kind === 'episode'))
    .map((i) => Date.parse(i.anchorAt as string));
  // An engine restart 18 min before an evening show, which it had scheduled: the new boot
  // has lost the schedule and the queue.
  const restartAt = dates[7]
    ? zonedInstant(dates[7], '18:12', FIXTURE_TZ).getTime()
    : Number.POSITIVE_INFINITY;
  let restarted = false;
  let tick = begin;
  let anchor = 0;
  for (let guard = 0; now < end; guard++) {
    if (guard > 2_000_000) throw new Error(`simulation stuck at ${new Date(now).toISOString()}`);
    const wake = engine.wakeups.length ? Math.min(...engine.wakeups) : Number.POSITIVE_INFINITY;
    while ((anchors[anchor] ?? Number.POSITIVE_INFINITY) < now) anchor++;
    const near = (anchors[anchor] ?? Number.POSITIVE_INFINITY) - now <= 120_000;
    const nextTick = tick + (near ? 5_000 : 30_000);
    let next = Math.min(wake, nextTick);
    if (!restarted && restartAt <= next) next = restartAt;
    engine.advance(next);
    now = next;
    if (now === nextTick) tick = nextTick;
    engine.wakeups = engine.wakeups.filter((w) => w > now);
    if (!restarted && now >= restartAt) {
      engine.restart();
      restarted = true;
    }
    await feeder.sync();
  }

  const aired = new Map(engine.asRun.map((e) => [e.logItemId, e]));
  const hard: number[] = [];
  const soft: SimResult['soft'] = [];
  const missing: string[] = [];
  let hardAnchors = 0;
  for (const i of items) {
    if (i.kind !== 'episode' || Date.parse(i.plannedStart) >= end) continue;
    const entry = aired.get(i.id);
    if (i.timing === 'hard') hardAnchors++;
    if (!entry) {
      missing.push(i.id);
      continue;
    }
    const drift = Date.parse(entry.startedAt) - Date.parse(i.anchorAt as string);
    if (i.timing === 'hard') hard.push(drift);
    else
      soft.push({
        driftMs: drift,
        capMs: i.capMs ?? 0,
        anchorMs: Date.parse(i.anchorAt as string),
      });
  }
  return { hard, soft, missing, engine, hardAnchors };
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
};

/** `SIM_REPORT=1`: prints the distributions (the figures in ADR 0031). */
function report(label: string, result: SimResult) {
  if (!process.env.SIM_REPORT) return;
  const { hard, soft, engine } = result;
  const residuals = engine.cuts.filter((c) => c.itemId !== null).map((c) => c.residualMs);
  const q = (v: number[]) => [5, 50, 95].map((p) => (v.length ? percentile(v, p) : null));
  console.info(
    label,
    JSON.stringify({
      hard: { n: hard.length, p5_50_95: q(hard), maxAbs: Math.max(...hard.map(Math.abs)) },
      soft: { n: soft.length, p5_50_95: q(soft.map((x) => x.driftMs)) },
      cutResidual: { n: residuals.length, p5_50_95: q(residuals) },
      safetyBeforeStart: engine.cuts.filter((c) => c.itemId === null).length,
      disturbances: engine.disturbed.length,
    }),
  );
}

describe('hard starts over two weeks of as-run (simulation)', () => {
  // Both weeks contain a DST change (last Sunday of March and of October, Europe/Paris).
  for (const first of ['2026-10-19', '2026-03-23'] as const) {
    it(`starts every episode on time, ${first}`, { timeout: 120_000 }, async () => {
      const { hard, soft, missing, engine, hardAnchors } = await simulate(first, {
        engineCut: true,
        seed: 46,
      });
      report(first, { hard, soft, missing, engine, hardAnchors });
      const shows = HARD_START_SHOWS.length;
      /**
       * A skip or a far-off length since the previous hard start (which put the music back on
       * time): music cut short leaves less audio than time, and each hour's fill only stretches
       * by its headroom, so the deficit can reach the next start.
       */
      const disturbed = (atMs: number) => {
        const since = Math.max(0, ...engine.cuts.map((c) => c.atMs).filter((t) => t < atMs));
        return engine.disturbed.some((d) => d <= atMs && d >= since);
      };
      expect(missing).toEqual([]);
      // The last day's evening show is past the simulated range.
      expect(hard.length + soft.length).toBe(14 * shows - 1);
      expect(hard).toHaveLength(hardAnchors);
      // The acceptance: every hard start within one frame of its time.
      for (const drift of hard) expect(Math.abs(drift)).toBeLessThanOrEqual(FRAME);
      // A soft start waits for the music to end: at most its cap late, and early only when the
      // music before it was cut short (a skip, a wrong length).
      for (const { driftMs, capMs, anchorMs } of soft) {
        expect(driftMs).toBeLessThanOrEqual(capMs + FRAME);
        if (driftMs < -FRAME) expect(disturbed(anchorMs)).toBe(true);
      }
      // The music arrives on its own: the cut fades out about the half second the tail aims
      // past the anchor.
      const residuals = engine.cuts.filter((c) => c.itemId !== null).map((c) => c.residualMs);
      expect(percentile(residuals, 10)).toBeGreaterThan(0);
      expect(percentile(residuals, 90)).toBeLessThanOrEqual(1_500);
      // The safety playlist airs before a hard start for more than a moment only after a
      // disturbance (the tail aims half a second late; noise can still end it a hair early).
      for (const cut of engine.cuts.filter((c) => c.itemId === null)) {
        if (!disturbed(cut.atMs)) expect(cut.residualMs).toBeGreaterThan(-1_000);
      }
    });
  }

  it('lands close without the engine cut, by re-planning the tail alone', {
    timeout: 120_000,
  }, async () => {
    // An engine rendered before #46: no POST /v1/schedule. The tail is re-planned on every
    // as-run start, and the hard item is queued after it.
    const result = await simulate('2026-10-19', { engineCut: false, seed: 46 });
    report('re-plan only', result);
    const { hard, missing } = result;
    expect(missing).toEqual([]);
    const abs = hard.map(Math.abs);
    // Mostly within a few hundred ms; the rest is ADR 0012's rule: a hard item up to
    // `holdGapMs` (5 s) early is queued rather than held behind the safety playlist.
    expect(percentile(abs, 50)).toBeLessThanOrEqual(500);
    expect(percentile(abs, 75)).toBeLessThanOrEqual(5_000);
  });

  it('starts back-to-back hard items on time, the one on air untouched', {
    timeout: 120_000,
  }, async () => {
    // 07:00 then 08:00 and 09:00, each episode filling its hour: the next one is scheduled
    // with the engine while the one before it plays.
    const hour = (n: number, time: string, episodeMs: number): HardStartShow => ({
      slotId: `00000000-0000-7000-8552-00000000000${n}`,
      time,
      durationMs: 3_600_000,
      episodeMs,
    });
    const shows = [
      hour(1, '07:00', 3_540_000),
      hour(2, '08:00', 3_599_980),
      hour(3, '09:00', 1_800_000),
    ];
    const { hard, missing, engine } = await simulate('2026-10-24', {
      engineCut: true,
      seed: 7,
      shows,
      days: 3,
    });
    expect(missing).toEqual([]);
    expect(hard).toHaveLength(3 * shows.length);
    for (const drift of hard) expect(Math.abs(drift)).toBeLessThanOrEqual(FRAME);
    // The 08:00 episode plays whole: the 09:00 one, scheduled 45 min ahead during it, only cuts
    // what it overruns its hour by (the model's length noise, under a second), never earlier.
    const cutEpisodes = engine.cuts.filter((c) => c.itemId !== null && c.residualMs > 1_000);
    expect(
      cutEpisodes.filter((c) => engine.items.get(c.itemId as string)?.kind === 'episode'),
    ).toEqual([]);
  });
});
