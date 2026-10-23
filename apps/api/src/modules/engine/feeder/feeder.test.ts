import { randomUUID } from 'node:crypto';
import type { StationScope } from '@ondes/db';
import {
  deriveIslands,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineQueuedRequest,
  type EngineState,
  type FeederItemPassedOverEvent,
  type IslandMedia,
  islandHash,
  type LogItem,
  type RaiseAlert,
} from '@ondes/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EngineUnresolvableError } from '../adapter/errors.ts';
import {
  createStationFeeder,
  type FeederEngine,
  FeederNotOwnerError,
  type FeederPushStore,
} from './feeder.ts';
import type { FeedMedia } from './push.ts';
import type { FeedIslands, FeedWindow } from './repo.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T10:00:00Z');
const scope = { orgId: randomUUID(), stationId: randomUUID() } as StationScope;

/** In-memory engine: a queue of entries and what's on air, driven by the test. */
class SimEngine implements FeederEngine {
  bootId = 'boot-1';
  onAir: { item_id: string; segment_id: string | null; startedAt: number } | null = null;
  queue: { id: string; body: EnginePushItem | EnginePushSegment; segment: boolean }[] = [];
  refuse = new Set<string>();
  calls: string[] = [];
  rid = 0;
  readonly clock: () => number;
  constructor(clock: () => number) {
    this.clock = clock;
  }

  async state(): Promise<EngineState> {
    const queue: EngineQueuedRequest[] = this.queue.flatMap((q): EngineQueuedRequest[] =>
      q.segment
        ? (q.body as EnginePushSegment).parts.map((p) => ({
            rid: this.rid++,
            item_id: p.item_id,
            segment_id: q.id,
            uri: p.uri,
            status: 'ready',
          }))
        : [
            {
              rid: this.rid++,
              item_id: q.id,
              segment_id: null,
              uri: (q.body as EnginePushItem).uri,
              status: 'ready',
            },
          ],
    );
    return {
      boot_id: this.bootId,
      station_id: scope.stationId,
      version: '2.4.6',
      uptime: 1,
      seq: 1,
      on_air: this.onAir
        ? {
            item_id: this.onAir.item_id,
            segment_id: this.onAir.segment_id,
            source: 'queue',
            elapsed: (this.clock() - this.onAir.startedAt) / 1000,
          }
        : { source: 'safety', item_id: null },
      queue,
      live: { enabled: false, connected: false, ready: false },
      blank: false,
      output_db: null,
    };
  }
  async push(item: EnginePushItem) {
    this.calls.push(`push ${item.item_id}`);
    if (this.refuse.has(item.uri))
      throw new EngineUnresolvableError('unresolvable', 'no', {
        stationId: 's',
        route: 'POST /v1/queue',
      });
    this.queue.push({ id: item.item_id, body: item, segment: false });
    return { rid: this.rid++, item_id: item.item_id, uri: item.uri, status: 'ready' };
  }
  async pushSegment(segment: EnginePushSegment) {
    this.calls.push(`segment ${segment.segment_id}`);
    this.queue.push({ id: segment.segment_id, body: segment, segment: true });
    return { segment_id: segment.segment_id, requests: [] };
  }
  async remove(id: string) {
    this.calls.push(`remove ${id}`);
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    return { removed: before - this.queue.length };
  }
  async clear() {
    this.calls.push('clear');
    const removed = this.queue.length;
    this.queue = [];
    return { removed };
  }
  /** The queue head goes on air. */
  next() {
    const head = this.queue.shift();
    this.onAir = head
      ? {
          item_id: head.segment
            ? ((head.body as EnginePushSegment).parts[0]?.item_id as string)
            : head.id,
          segment_id: head.segment ? head.id : null,
          startedAt: this.clock(),
        }
      : null;
    return head;
  }
  restart() {
    this.bootId = `boot-${Number(this.bootId.slice(5)) + 1}`;
    this.queue = [];
    this.onAir = null;
  }
}

function media(assetId: string, extra: Partial<FeedMedia> = {}): FeedMedia {
  return {
    assetId,
    fileId: `file-${assetId}`,
    sha256: assetId.replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
    ext: 'flac',
    flacBlockSize: 1024,
    durationSamples: 180 * 44_100,
    sampleRate: 44_100,
    cached: true,
    title: `Title ${assetId.slice(0, 4)}`,
    artists: ['Artist'],
    cues: null,
    gain: { normalizeLoudness: true, gainOverrideDb: null, loudness: null },
    ...extra,
  };
}

function item(startMs: number, extra: Partial<LogItem> = {}): LogItem {
  return {
    id: randomUUID(),
    logDayId: 'day',
    position: 0,
    kind: 'song',
    plannedStart: new Date(startMs).toISOString(),
    plannedDurationMs: 3 * MIN,
    assetId: randomUUID(),
    asset: null,
    episodeId: null,
    liveSlotId: null,
    title: null,
    cueOverrides: { crossOutMs: 2000 },
    timing: 'flow',
    anchorAt: null,
    capMs: null,
    origin: { type: 'manual' },
    locked: false,
    relaxedRules: [],
    segmentId: null,
    conflict: null,
    parts: [],
    ...extra,
  };
}

let now: number;
let engine: SimEngine;
let window: FeedWindow;
let fetches: string[];
let syncs: number;
let raised: RaiseAlert[];
let resolved: string[];
let published: FeederItemPassedOverEvent[];
let owner: boolean;

function setLog(
  items: LogItem[],
  mediaFor: (i: LogItem) => FeedMedia | null = (i) => media(i.assetId as string),
) {
  const map = new Map<string, FeedMedia>();
  for (const i of [...items, ...items.flatMap((x) => x.parts)]) {
    const m = i.assetId ? mediaFor(i as LogItem) : null;
    if (m) map.set(i.assetId as string, m);
  }
  window = { items, media: map, station: { loudnessTargetLufs: -16, truePeakLimitDbtp: -1 } };
}

/** `feeder_push` in memory, shared by the feeders of one test (two replicas). */
function memoryStore(): FeederPushStore & {
  rows: Map<string, { entryId: string; fingerprint: string; trimMs: number; aired: boolean }>;
} {
  const rows = new Map<
    string,
    { entryId: string; fingerprint: string; trimMs: number; aired: boolean }
  >();
  const key = (boot: string, id: string) => `${boot}/${id}`;
  return {
    rows,
    async load(boot) {
      return [...rows.entries()].filter(([k]) => k.startsWith(`${boot}/`)).map(([, v]) => v);
    },
    async save(boot, entryId, push) {
      const prev = rows.get(key(boot, entryId));
      rows.set(key(boot, entryId), { entryId, ...push, aired: prev?.aired ?? false });
    },
    async remove(boot, ids) {
      for (const id of ids) if (!rows.get(key(boot, id))?.aired) rows.delete(key(boot, id));
    },
    async markAired(boot, ids) {
      for (const entryId of ids) {
        const prev = rows.get(key(boot, entryId));
        rows.set(key(boot, entryId), {
          entryId,
          fingerprint: prev?.fingerprint ?? '',
          trimMs: prev?.trimMs ?? 0,
          aired: true,
        });
      }
    },
    async prune(boot) {
      for (const k of [...rows.keys()]) if (!k.startsWith(`${boot}/`)) rows.delete(k);
    },
  };
}

let store: ReturnType<typeof memoryStore> | undefined;
let islands: FeedIslands | undefined;

function feeder() {
  return createStationFeeder({
    store,
    islands: async () => islands ?? { islands: [], media: new Map() },
    scope,
    engine: async () => engine,
    load: async () => window,
    cache: {
      requestUrgentFetch: async (_s, fileId) => {
        fetches.push(fileId);
      },
      requestSync: async () => {
        syncs++;
      },
    },
    alerts: {
      raise: async (_s, input) => {
        raised.push(input);
      },
      resolve: async (_s, key) => {
        resolved.push(key);
      },
    },
    publish: async (e) => {
      published.push(e);
    },
    owns: async () => owner,
    now: () => now,
  });
}

const queuedIds = () => engine.queue.map((q) => q.id);

beforeEach(() => {
  store = undefined;
  islands = undefined;
  now = T0;
  engine = new SimEngine(() => now);
  fetches = [];
  syncs = 0;
  raised = [];
  resolved = [];
  published = [];
  owner = true;
});

describe('station feeder', () => {
  it('fills the queue from the log with cache paths, gains and chained crossfades', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items, (i) =>
      media(i.assetId as string, {
        gain: {
          normalizeLoudness: true,
          gainOverrideDb: null,
          loudness: { integratedLufs: -12, truePeakDbtp: -6 },
        },
      }),
    );
    const f = feeder();
    // Nothing on air at boot: the item that should be on air now goes first.
    await f.sync();
    expect(queuedIds()).toEqual(items.slice(0, 4).map((i) => i.id));
    const first = engine.queue[0]?.body as EnginePushItem;
    expect(first).toMatchObject({
      uri: expect.stringMatching(/^\/cache\/media\/[0-9a-f]{2}\/[0-9a-f]{64}\.flac$/),
      amplify_db: -4,
      cross_out: 2,
      artist: 'Artist',
    });
    expect(first).not.toHaveProperty('cross_in');
    expect(engine.queue[1]?.body).toMatchObject({ cross_in: 2, cross_out: 2 });

    // The head airs; the next sync tops up without touching the rest.
    engine.next();
    engine.calls = [];
    now += 1000;
    await f.sync();
    expect(engine.calls).toEqual([]);
    now += 3 * MIN;
    engine.next();
    await f.sync();
    expect(engine.calls).toEqual([`push ${items[4]?.id}`]);
  });

  it('replaces the item after next when it is edited, never the one on air', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const f = feeder();
    await f.sync();
    engine.next(); // items[0] on air
    const onAir = engine.onAir;
    engine.calls = [];

    const replaced = { ...(items[2] as LogItem), id: randomUUID(), assetId: randomUUID() };
    setLog(items.map((i) => (i === items[2] ? replaced : i)));
    f.onEvent({
      id: randomUUID(),
      stationId: scope.stationId,
      at: new Date(now).toISOString(),
      type: 'log.updated',
      data: {
        from: new Date(now).toISOString(),
        to: new Date(now).toISOString(),
        days: [],
        cause: 'edit',
      },
    });
    await f.sync();
    expect(engine.onAir).toBe(onAir);
    expect(queuedIds()).toEqual([items[1]?.id, replaced.id, items[3]?.id]);
    expect(engine.calls).toEqual([
      `remove ${items[2]?.id}`,
      `remove ${items[3]?.id}`,
      `push ${replaced.id}`,
      `push ${items[3]?.id}`,
    ]);
  });

  it('skips uncached items, fetches them urgently, alerts, and pushes them once cached', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(T0 + i * 3 * MIN));
    const missing = items[2] as LogItem;
    setLog(items, (i) => media(i.assetId as string, { cached: i !== missing }));
    const f = feeder();
    await f.sync();
    expect(queuedIds()).not.toContain(missing.id);
    expect(queuedIds()).toContain(items[3]?.id);
    expect(fetches).toEqual([`file-${missing.assetId}`]);
    expect(raised).toMatchObject([{ type: 'feeder.items_skipped', severity: 'warning' }]);

    // Requests are not repeated on every tick.
    await f.sync();
    expect(fetches).toHaveLength(1);

    // Fetched in time: it's back in the queue, in its place, and the alert resolves.
    setLog(items);
    await f.sync();
    expect(queuedIds().slice(0, 3)).toEqual([items[0]?.id, items[1]?.id, missing.id]);
    expect(resolved).toContain('feeder.items_skipped');
  });

  it('reports a skipped item to as-run once a later item airs', async () => {
    const items = Array.from({ length: 6 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items, (i) => media(i.assetId as string, { cached: i !== items[1] }));
    const f = feeder();
    await f.sync();
    engine.next(); // items[0]
    await f.sync();
    expect(published).toEqual([]);
    now += 3 * MIN;
    engine.next(); // items[2]: items[1] was passed over
    await f.sync();
    expect(published).toMatchObject([
      {
        type: 'feeder.item.passed_over',
        data: { itemId: items[1]?.id, reason: 'not_cached', bootId: 'boot-1' },
      },
    ]);
    await f.sync();
    expect(published).toHaveLength(1);
  });

  it('treats a 422 as a miss: skips the file, fetches it, asks for a cache pass', async () => {
    const items = Array.from({ length: 6 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const refused = window.media.get(items[1]?.assetId as string) as FeedMedia;
    engine.refuse.add(`/cache/media/${refused.sha256.slice(0, 2)}/${refused.sha256}.flac`);
    const f = feeder();
    await f.sync();
    expect(queuedIds()).toEqual([items[0]?.id, items[2]?.id, items[3]?.id, items[4]?.id]);
    expect(syncs).toBe(1);
    expect(fetches).toEqual([refused.fileId]);
  });

  it('re-pushes after an engine restart (new boot, empty queue)', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const f = feeder();
    await f.sync();
    engine.next();
    now += MIN;
    engine.restart();
    await f.sync();
    // items[0] aired during the old boot but is planned until 10:03: a new boot starts over
    // from what's planned now.
    expect(queuedIds()[0]).toBe(items[0]?.id);
    expect(queuedIds()).toHaveLength(4);
  });

  it('pushes an island chain as one segment', async () => {
    const parts = [0, 1, 2].map((i) =>
      item(T0 + i * MIN, {
        kind: i === 1 ? 'vt' : 'song',
        plannedDurationMs: MIN,
        cueOverrides: null,
      }),
    );
    const segment = item(T0, {
      kind: 'segment',
      assetId: null,
      plannedDurationMs: 3 * MIN + 20,
      parts: parts.map((p) => ({ ...p, segmentId: 'x' })),
    });
    const after = item(T0 + 3 * MIN + 20);
    setLog([segment, after]);
    const f = feeder();
    await f.sync();
    expect(engine.calls).toEqual([`segment ${segment.id}`, `push ${after.id}`]);
    const body = engine.queue[0]?.body as EnginePushSegment;
    expect(body.parts.map((p) => p.item_id)).toEqual(parts.map((p) => p.id));
    engine.next();
    now += 30_000;
    engine.calls = [];
    await f.sync();
    expect(engine.calls).toEqual([]);
  });

  it('raises log_empty when nothing is coming, resolves it when the log is back', async () => {
    setLog([]);
    const f = feeder();
    await f.sync();
    expect(raised).toMatchObject([{ type: 'feeder.log_empty', escalate: { to: 'critical' } }]);
    setLog([item(T0 + 1000)]);
    await f.sync();
    expect(resolved).toContain('feeder.log_empty');
    expect(queuedIds()).toHaveLength(1);
  });

  it('never touches the engine once another replica owns the station', async () => {
    setLog(Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN)));
    owner = false;
    await expect(feeder().sync()).rejects.toBeInstanceOf(FeederNotOwnerError);
    expect(engine.calls).toEqual([]);
  });

  it('shares one run between concurrent syncs, then runs once more', async () => {
    setLog(Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN)));
    const f = feeder();
    const [a, b] = [f.sync(), f.sync()];
    expect(a).toBe(b);
    await a;
    // Each item pushed once: the second run found the queue already right.
    const pushes = engine.calls.filter((c) => c.startsWith('push'));
    expect(pushes).toHaveLength(4);
    expect(new Set(pushes).size).toBe(4);
  });

  it('resumes after a lease handover: same trims, nothing re-pushed', async () => {
    store = memoryStore();
    // Running 40 s late into a hard start at 10:12: the last song before it is trimmed.
    const items = Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN));
    const episode = item(T0 + 12 * MIN, {
      kind: 'episode',
      timing: 'hard',
      anchorAt: new Date(T0 + 12 * MIN).toISOString(),
      plannedDurationMs: 30 * MIN,
      cueOverrides: null,
    });
    setLog([...items, episode]);
    now = T0 + 40_000;
    const a = feeder();
    await a.sync();
    engine.next(); // items[0] on air, 40 s late
    now += 1000;
    await a.sync();
    const trimmed = [...store.rows.values()].find((r) => r.trimMs > 0);
    expect(trimmed?.entryId).toBe(items[3]?.id);
    expect(trimmed?.trimMs).toBeGreaterThanOrEqual(39_000);

    // Replica A goes away; replica B takes the station over with the same engine state.
    a.stop();
    engine.calls = [];
    const b = feeder();
    now += 1000;
    await b.sync();
    expect(engine.calls).toEqual([]);
    // The item on air is known as aired: never planned again in this boot.
    expect(store.rows.get(`boot-1/${items[0]?.id}`)?.aired).toBe(true);
  });

  it('a feeder stopped mid-run makes no more engine calls', async () => {
    setLog(Array.from({ length: 8 }, (_, i) => item(T0 + i * 3 * MIN)));
    const f = feeder();
    const push = engine.push.bind(engine);
    engine.push = async (body) => {
      const out = await push(body);
      f.stop();
      return out;
    };
    await expect(f.sync()).rejects.toBeInstanceOf(FeederNotOwnerError);
    expect(engine.calls.filter((c) => c.startsWith('push'))).toHaveLength(1);
  });

  it('resolves nothing at boot when no feeder alert is open', async () => {
    setLog(Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN)));
    const f = createStationFeeder({
      scope,
      engine: async () => engine,
      load: async () => window,
      cache: { requestUrgentFetch: async () => {}, requestSync: async () => {} },
      alerts: {
        raise: async (_s, input) => {
          raised.push(input);
        },
        resolve: async (_s, key) => {
          resolved.push(key);
        },
        openKeys: async () => new Set(['feeder.log_empty']),
      },
      now: () => now,
    });
    await f.sync();
    // log_empty was open (an earlier feeder): resolved. items_skipped wasn't: left alone.
    expect(resolved).toEqual(['feeder.log_empty']);
    expect(raised).toEqual([]);
  });
});

describe('station feeder: islands (#57)', () => {
  const SR = 44_100;
  const voiceAsset = randomUUID();

  const islandMedia = (m: FeedMedia): IslandMedia => ({
    assetId: m.assetId,
    sha256: m.sha256,
    storageKey: `org/o/sha256/${m.sha256}.flac`,
    sampleRate: SR,
    durationSamples: m.durationSamples as number,
    flacBlockSize: 1024,
    gainDb: 0,
    cueIn: 0,
    cueOut: m.durationSamples as number,
  });

  /** A → B with a 5 s voice 3 s before A's end; the render cached or not. */
  function withIsland(a: LogItem, b: LogItem, cached: boolean | 'none') {
    const voice = media(voiceAsset, { durationSamples: 5 * SR });
    const [plan] = deriveIslands([
      {
        segueId: randomUUID(),
        fromItemId: a.id,
        toItemId: b.id,
        from: islandMedia(window.media.get(a.assetId as string) as FeedMedia),
        to: islandMedia(window.media.get(b.assetId as string) as FeedMedia),
        out: {
          envelope: [
            { at: -3.5 * SR, gainDb: 0 },
            { at: -3 * SR, gainDb: -12 },
          ],
        },
        in: { start: -SR, envelope: [] },
        voices: [
          {
            assetId: voiceAsset,
            start: -3 * SR,
            gainDb: 0,
            envelope: [],
            media: islandMedia(voice),
          },
        ],
      },
    ]);
    if (!plan) throw new Error('no island');
    const hash = islandHash(plan.spec);
    islands = {
      islands: [
        {
          hash,
          plan,
          rendered:
            cached === 'none' ? null : { islandId: randomUUID(), sha256: 'f'.repeat(64), cached },
        },
      ],
      media: new Map([[voiceAsset, voice]]),
    };
    return `island:${hash}`;
  }

  it('pushes A and B as one chain under A, and never B on its own', async () => {
    store = memoryStore();
    const items = Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const [a, b, c] = items as [LogItem, LogItem, LogItem];
    const islandId = withIsland(a, b, true);
    const f = feeder();
    await f.sync();
    expect(queuedIds()).toEqual([a.id, items[2]?.id, items[3]?.id]);
    expect(engine.calls).toContain(`segment ${a.id}`);
    const chain = engine.queue[0]?.body as EnginePushSegment;
    expect(chain.parts.map((p) => p.item_id)).toEqual([a.id, islandId, b.id]);
    expect(chain.parts[1]).toMatchObject({ amplify_db: 0 });
    // The next entry crosses in with B's crossfade out.
    expect((engine.queue[1]?.body as EnginePushItem | undefined)?.cross_in).toBe(2);
    // What the as-run needs: each body's length and the island's transition.
    const parts = (store.rows.get(`boot-1/${a.id}`) as { parts?: unknown }).parts;
    expect(parts).toMatchObject([
      { itemId: a.id, expectedMs: expect.any(Number), transition: null },
      { itemId: islandId, transition: { rendered: true, voices: [{ assetId: voiceAsset }] } },
      { itemId: b.id, expectedMs: expect.any(Number), transition: null },
    ]);

    // The island goes on air; then the render disappears (an edit): the chain on air keeps
    // its shape and B is not pushed again.
    engine.next();
    now += 175_000;
    (engine.onAir as { item_id: string }).item_id = islandId;
    withIsland(a, b, 'none');
    const r = await f.sync();
    expect(r.removed).toEqual([]);
    expect(r.pushed).toEqual([]);
    expect(engine.calls.filter((call) => call === `push ${b.id}`)).toEqual([]);
    expect(queuedIds()).toEqual([c.id, items[3]?.id]);
  });

  it('falls back to a crossfade with the voice laid over it when the render isn’t cached', async () => {
    const items = Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const [a, b] = items as [LogItem, LogItem];
    withIsland(a, b, false);
    await feeder().sync();
    expect(queuedIds()).toEqual(items.map((i) => i.id).slice(0, 4));
    const pushedA = engine.queue[0]?.body as EnginePushItem;
    expect(pushedA.overlay).toEqual([
      {
        uri: expect.stringContaining('/cache/media/'),
        at: 177,
        duration: 5,
        cue_out: expect.any(Number),
        duck_db: -12,
      },
    ]);
    expect((engine.queue[1]?.body as EnginePushItem | undefined)?.overlay).toBeUndefined();
  });

  it('turns a queued fallback into the chain once the island is ready', async () => {
    const items = Array.from({ length: 4 }, (_, i) => item(T0 + i * 3 * MIN));
    setLog(items);
    const [a, b] = items as [LogItem, LogItem];
    // Something else is on air, so A is queued, not on air.
    const f = feeder();
    withIsland(a, b, false);
    await f.sync();
    engine.next();
    withIsland(items[1] as LogItem, items[2] as LogItem, true);
    const r = await f.sync();
    expect(r.removed).toContain(b.id);
    expect(engine.queue[0]?.segment).toBe(true);
    expect(engine.queue[0]?.id).toBe(b.id);
  });
});
