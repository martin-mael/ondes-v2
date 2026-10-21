// Hard-start spike driver (#14). Plays the feeder's part against one engine per "lane"
// (a scenario × a correction strategy), all at once: feeds the hour in playlist.ts just in
// time, aims the episode at T, applies the lane's correction, records the output around T
// and measures when the episode actually started, from the as-run event and from the audio.
//
// Runs inside the spike compose project (compose.yml, README.md). Prints a table and
// writes a JSON report to RESULTS_DIR. Exits 1 if a lane failed to play its episode.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BED, EPISODE, fileName, MUSIC, SAMPLE_RATE } from './playlist.ts';

const MEDIA = process.env.MEDIA_DIR ?? '/media';
const REC = process.env.REC_DIR ?? '/rec';
const RESULTS_DIR = process.env.RESULTS_DIR ?? '/results';
const RUN = process.env.RUN_NAME ?? 'run';
/** Play only the last N music items (default: the whole hour). */
const ITEMS = Number(process.env.ITEMS ?? MUSIC.length);
/** Dev runs: cap every item to this many seconds. */
const MAX_ITEM = process.env.MAX_ITEM ? Number(process.env.MAX_ITEM) : undefined;
/** Compressed hour: play only the last TAIL seconds of every song (cue-in moved, ends kept). */
const TAIL = process.env.TAIL ? Number(process.env.TAIL) : undefined;
/** Planning model: seconds added per transition (the spike measured one 20 ms frame). */
const TRANSITION_LAG = Number(process.env.TRANSITION_LAG ?? 0);
/** A re-plan never shortens the last song below this, seconds. */
const MIN_SONG = Number(process.env.MIN_SONG ?? 10);
const LATE = Number(process.env.LATE ?? 45);
const EARLY = Number(process.env.EARLY ?? 95);
const STRETCH_EARLY = Number(process.env.STRETCH_EARLY ?? 6);
const SOFT_CAP = Number(process.env.SOFT_CAP ?? 30);
/** Node-side hard cut: fire the skip this many seconds before T (0 = at T). */
const SKIP_LEAD = Number(process.env.SKIP_LEAD ?? 0);
const CROSS_EPISODE = EPISODE.crossIn;

// ---------------------------------------------------------------------------------------
// Lanes

type Cut = 'none' | 'node' | 'soft' | 'engine';
type Lane = {
  name: string;
  /** T − natural episode start. Negative: the hour runs late; positive: early. */
  offset: number;
  replan: 'none' | 'cue' | 'tempo';
  /** fit: the re-plan sizes a bed when the last song can't cover the gap; long: a 5 min bed after the last song, cut at T. */
  bed: 'none' | 'fit' | 'long';
  cut: Cut;
  /** Items kept queued ahead of the one on air. */
  depth: number;
  /** Engine to drive (default: the lane's name). Lets a later run reuse an engine. */
  engine?: string;
  /** JIT deadline test: with depth 0, push each item only this many seconds before the end of the one on air. */
  pushLead?: number;
};

const ALL_LANES: Lane[] = [
  { name: 'ontime-none', offset: 0, replan: 'none', bed: 'none', cut: 'none', depth: 3 },
  { name: 'ontime-depth1', offset: 0, replan: 'none', bed: 'none', cut: 'none', depth: 1 },
  { name: 'late-none', offset: -LATE, replan: 'none', bed: 'none', cut: 'none', depth: 3 },
  { name: 'late-replan', offset: -LATE, replan: 'cue', bed: 'none', cut: 'none', depth: 3 },
  { name: 'late-node', offset: -LATE, replan: 'none', bed: 'none', cut: 'node', depth: 3 },
  { name: 'late-soft', offset: -LATE, replan: 'none', bed: 'none', cut: 'soft', depth: 3 },
  { name: 'late-engine', offset: -LATE, replan: 'none', bed: 'none', cut: 'engine', depth: 3 },
  // Same as late-engine, gating on time() at frame computation instead of the audio timeline.
  { name: 'late-engine-wall', offset: -LATE, replan: 'none', bed: 'none', cut: 'engine', depth: 3 },
  { name: 'late-combined', offset: -LATE, replan: 'cue', bed: 'fit', cut: 'engine', depth: 3 },
  { name: 'early-none', offset: EARLY, replan: 'none', bed: 'none', cut: 'none', depth: 3 },
  { name: 'early-replan', offset: EARLY, replan: 'cue', bed: 'fit', cut: 'none', depth: 3 },
  { name: 'early-bed-engine', offset: EARLY, replan: 'none', bed: 'long', cut: 'engine', depth: 3 },
  { name: 'early-combined', offset: EARLY, replan: 'cue', bed: 'fit', cut: 'engine', depth: 3 },
  {
    name: 'early-stretch',
    offset: STRETCH_EARLY,
    replan: 'tempo',
    bed: 'none',
    cut: 'none',
    depth: 3,
  },
  // Push deadline (run separately, LANES=jit-…): how late can the feeder push the next item?
  ...(
    [
      ['jit-5', 5, 'ontime-none'],
      ['jit-2.5', 2.5, 'ontime-depth1'],
      ['jit-1', 1, 'late-none'],
      ['jit-0.3', 0.3, 'late-replan'],
    ] as const
  ).map(
    ([name, pushLead, engine]): Lane => ({
      name,
      offset: 0,
      replan: 'none',
      bed: 'none',
      cut: 'none',
      depth: 0,
      engine,
      pushLead,
    }),
  ),
];

const wanted = process.env.LANES ? process.env.LANES.split(',').map((s) => s.trim()) : undefined;
const LANES = wanted
  ? ALL_LANES.filter((l) => wanted.includes(l.name))
  : ALL_LANES.filter((l) => l.pushLead === undefined);

// ---------------------------------------------------------------------------------------
// Items

type Item = {
  id: string;
  kind: 'music' | 'bed' | 'episode';
  uri: string;
  cueIn: number;
  cueOut?: number;
  /** Seconds of audio in the file after cue-in (the most a cue-out can give). */
  maxLen: number;
  /** Planned audio length: cueOut − cueIn, or the catalog duration − cueIn. */
  len: number;
  crossIn: number;
  crossOut: number;
  fadeIn: number;
  fadeOut: number;
  tempo: number;
  state: 'planned' | 'queued' | 'aired';
  startedAt?: number;
  audioPos?: number;
};

const catalog = JSON.parse(readFileSync(join(MEDIA, 'catalog.json'), 'utf8')) as {
  durations: Record<string, number>;
};

function musicItems(): Item[] {
  const tracks = MUSIC.slice(MUSIC.length - ITEMS);
  return tracks.map((t, i) => {
    const prev = tracks[i - 1];
    const catalogLen = catalog.durations[t.id] ?? t.length;
    let cueIn = t.cueIn ?? 0;
    let cueOut = t.cueOut;
    if (TAIL !== undefined) cueIn = Math.max(cueIn, (cueOut ?? catalogLen) - TAIL);
    if (MAX_ITEM !== undefined) cueOut = Math.min(cueOut ?? catalogLen, cueIn + MAX_ITEM);
    const crossIn = prev ? prev.cross : 2;
    return {
      id: t.id,
      kind: 'music',
      uri: join(MEDIA, fileName(t.id, t.format)),
      cueIn,
      cueOut,
      maxLen: catalogLen - cueIn,
      len: (cueOut ?? catalogLen) - cueIn,
      crossIn,
      crossOut: t.cross,
      fadeIn: crossIn,
      fadeOut: t.cross,
      tempo: 1,
      state: 'planned',
    };
  });
}

function bedItem(len: number): Item {
  return {
    id: BED.id,
    kind: 'bed',
    uri: join(MEDIA, 'bed.flac'),
    cueIn: 0,
    cueOut: len,
    maxLen: catalog.durations[BED.id] ?? BED.length,
    len,
    crossIn: 2,
    crossOut: 2,
    fadeIn: 2,
    fadeOut: 2,
    tempo: 1,
    state: 'planned',
  };
}

function episodeItem(): Item {
  const len = catalog.durations[EPISODE.id] ?? EPISODE.length;
  return {
    id: EPISODE.id,
    kind: 'episode',
    uri: join(MEDIA, 'episode.flac'),
    cueIn: 0,
    maxLen: len,
    len,
    crossIn: CROSS_EPISODE,
    crossOut: 2,
    // Full level from the first sample: the song before fades out under it.
    fadeIn: 0,
    fadeOut: 2,
    tempo: 1,
    state: 'planned',
  };
}

const overlap = (a: Item, b: Item) => Math.min(a.crossOut, b.crossIn);

// ---------------------------------------------------------------------------------------
// Engine client and event intake

type EngineEvent = {
  seq: number;
  at: number;
  at_us?: string;
  at_nominal?: string;
  audio_pos?: number;
  /** time() when the engine emitted it (at_us). `at` is replaced by at_nominal. */
  wall: number;
  station_id: string;
  type: string;
  data: Record<string, unknown>;
};

async function call(lane: string, method: string, path: string, body?: unknown) {
  const sent = Date.now();
  const res = await fetch(`http://${lane}:7000${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, sent: sent / 1000, ms: Date.now() - sent };
}

const listeners = new Map<string, (e: EngineEvent) => void>();

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === 'POST' && req.url === '/events') {
    for (const e of JSON.parse(body) as EngineEvent[]) {
      // `at` is rounded to 10 ms by Liquidsoap's JSON printer; at_us is exact. at_nominal
      // is the same instant on the audio timeline, which is what the driver works with.
      e.wall = Number(e.at_us ?? e.at);
      e.at = Number(e.at_nominal ?? e.wall);
      listeners.get(e.station_id)?.(e);
    }
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end();
});

const t0 = Date.now();
function log(lane: string, msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${lane.padEnd(16)} ${msg}`);
}

const now = () => Date.now() / 1000;

function at(when: number, fn: () => unknown) {
  setTimeout(
    () => {
      Promise.resolve()
        .then(fn)
        .catch((err: Error) => console.error(`timer failed: ${err.message}`));
    },
    Math.max(0, when * 1000 - Date.now()),
  );
}

// ---------------------------------------------------------------------------------------
// One lane

type LaneResult = {
  lane: Lane;
  T?: number;
  naturalStart?: number;
  anchor?: number;
  episode?: {
    asRunAt: number;
    asRunErr: number;
    asRunWallErr: number;
    audioAt?: number;
    audioErr?: number;
    corr?: number;
  };
  items: Array<{ id: string; plannedStart: number; startedAt?: number; err?: number }>;
  replans: Array<{ at: number; onAir: string; err: number; change: string }>;
  commands: Array<{ what: string; sent: number; ms: number; status: number }>;
  clock: Array<{ wall: number; nominal: number; audioPos: number }>;
  /** How late frames were computed vs the audio timeline, ms (after the first 30 s). */
  timing?: { originWall: number; delayP50Ms: number; delayP99Ms: number; delayMaxMs: number };
  rec?: { at: number; wall: number; audioPos: number };
  notes: string[];
};

async function runLane(lane: Lane): Promise<LaneResult> {
  const name = lane.name;
  const host = lane.engine ?? lane.name;
  const result: LaneResult = { lane, items: [], replans: [], commands: [], clock: [], notes: [] };
  const seq: Item[] = musicItems();
  if (lane.bed === 'long') seq.push(bedItem(BED.length - 1));
  const episode = episodeItem();
  const queuedEpisode = lane.cut !== 'engine';
  if (queuedEpisode) seq.push(episode);
  const lastMusic = seq.findLastIndex((i) => i.kind === 'music');

  let T = Number.NaN;
  let anchor = Number.NaN;
  let onAir = -1;
  let episodeStarted: ((e: EngineEvent) => void) | undefined;
  const episodeEvent = new Promise<EngineEvent>((r) => {
    episodeStarted = r;
  });

  // Every queue mutation goes through one chain, so pushes stay in log order.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  async function command(what: string, method: string, path: string, body?: unknown) {
    const r = await call(host, method, path, body);
    result.commands.push({ what, sent: r.sent, ms: r.ms, status: r.status });
    if (r.status >= 300) log(name, `${what} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  }

  async function push(item: Item) {
    const body = {
      item_id: item.id,
      uri: item.uri,
      title: item.id,
      cue_in: item.cueIn > 0 ? item.cueIn : undefined,
      cue_out: item.cueOut,
      cross_in: item.crossIn,
      cross_out: item.crossOut,
      fade_in: item.fadeIn,
      fade_out: item.fadeOut,
      tempo: item.tempo !== 1 ? item.tempo : undefined,
    };
    const r = await command(`push ${item.id}`, 'POST', '/v1/queue', body);
    if (r.status === 201) item.state = 'queued';
  }

  /** Keep `depth` items queued ahead of the one on air. */
  const feed = () =>
    serial(async () => {
      for (let i = 0; i < seq.length && i <= onAir + lane.depth; i++) {
        if (seq[i]?.state === 'planned') await push(seq[i] as Item);
      }
    });

  /** Remove queued items from index `from` on, so they can be re-pushed in order. */
  async function unqueueFrom(from: number) {
    for (let i = from; i < seq.length; i++) {
      const item = seq[i] as Item;
      if (item.state !== 'queued') continue;
      await command(`remove ${item.id}`, 'DELETE', `/v1/queue/${item.id}`);
      item.state = 'planned';
    }
  }

  const slot = (i: number) => {
    const item = seq[i] as Item;
    const next = seq[i + 1] ?? episode;
    return item.len / item.tempo - overlap(item, next) + TRANSITION_LAG;
  };

  /** Predicted episode start from the as-run start of item k and the current plan. */
  function predict(k: number, startedAt: number) {
    let t = startedAt;
    for (let i = k; i < seq.length && seq[i]?.kind !== 'episode'; i++) t += slot(i);
    return t;
  }

  function setLen(item: Item, len: number) {
    item.len = len;
    item.cueOut = item.cueIn + len;
  }

  /** Re-plan the tail: resize the last song (or its tempo) and the bed so the episode lands on T. */
  async function replan(k: number, startedAt: number) {
    const err = predict(k, startedAt) - T;
    if (Math.abs(err) < 0.003) return;
    const music = seq[lastMusic] as Item;
    let bedIdx = seq.findIndex((i) => i.kind === 'bed');
    const musicFree = lastMusic > k;
    const bedFree = bedIdx > k;
    if (!musicFree && !(lane.bed === 'fit' && (bedFree || bedIdx === -1))) return;
    let firstChanged = Number.POSITIVE_INFINITY;
    let change = '';

    if (musicFree && lane.replan === 'tempo') {
      const target =
        slot(lastMusic) - err + overlap(music, seq[lastMusic + 1] ?? episode) - TRANSITION_LAG;
      const tempo = Math.min(1.04, Math.max(0.96, music.len / target));
      change = `tempo ${music.id} ${music.tempo.toFixed(5)} -> ${tempo.toFixed(5)}`;
      music.tempo = tempo;
      firstChanged = lastMusic;
    } else {
      // Seconds the adjustable tail (last song if not on air, plus the bed) must last. Each
      // item in the new tail costs TRANSITION_LAG on top of its audio.
      const bed = bedIdx === -1 ? undefined : (seq[bedIdx] as Item);
      const tail = (musicFree ? slot(lastMusic) : 0) + (bed ? slot(bedIdx) : 0) - err;
      if (musicFree) {
        const withoutBed = tail + overlap(music, episode) - TRANSITION_LAG;
        if (withoutBed <= music.maxLen || lane.bed !== 'fit') {
          const len = Math.min(music.maxLen, Math.max(MIN_SONG, withoutBed));
          change = `${music.id} ${music.len.toFixed(3)} -> ${len.toFixed(3)} s`;
          setLen(music, len);
          if (bed) {
            seq.splice(bedIdx, 1);
            if (bed.state === 'queued') {
              await command(`remove ${bed.id}`, 'DELETE', `/v1/queue/${bed.id}`);
            }
            change += ', bed dropped';
            bedIdx = -1;
          }
          firstChanged = lastMusic;
        } else {
          // The song can't cover the gap alone: play it to its end, then a bed.
          setLen(music, music.maxLen);
          const b = bed ?? bedItem(0);
          const bedLen =
            tail - 2 * TRANSITION_LAG - (music.maxLen - overlap(music, b)) + overlap(b, episode);
          setLen(b, Math.max(5, bedLen));
          if (!bed) seq.splice(lastMusic + 1, 0, b);
          change = `${music.id} -> ${music.len.toFixed(3)} s, bed ${b.len.toFixed(3)} s`;
          firstChanged = lastMusic;
        }
      } else {
        const b = bed ?? bedItem(0);
        const prev = seq[lastMusic] as Item;
        const bedLen =
          tail +
          overlap(b, episode) -
          TRANSITION_LAG +
          (bed ? 0 : overlap(prev, b) - overlap(prev, episode));
        if (bedLen < 2) return;
        setLen(b, bedLen);
        if (!bed) seq.splice(lastMusic + 1, 0, b);
        change = `bed ${b.len.toFixed(3)} s`;
        firstChanged = seq.indexOf(b);
      }
    }
    result.replans.push({ at: now(), onAir: (seq[k] as Item).id, err, change });
    log(name, `re-plan on ${(seq[k] as Item).id}: ${err.toFixed(3)} s off, ${change}`);
    await serial(() => unqueueFrom(firstChanged));
  }

  function onAnchor(startedAt: number) {
    anchor = startedAt;
    // Natural start: the music alone, straight into the episode (no long bed).
    let natural = startedAt;
    for (let i = 0; i <= lastMusic; i++) {
      const it = seq[i] as Item;
      const next = i === lastMusic ? episode : (seq[i + 1] as Item);
      natural += it.len / it.tempo - overlap(it, next) + TRANSITION_LAG;
    }
    T = natural + lane.offset;
    result.anchor = anchor;
    result.naturalStart = natural;
    result.T = T;
    log(
      name,
      `anchor; T in ${(T - now()).toFixed(1)} s (natural start ${lane.offset >= 0 ? '' : '+'}${(-lane.offset).toFixed(1)} s from T)`,
    );

    const recFrom = Math.max(now() + 1, Math.min(T, natural) - 40);
    const recTo = Math.max(T, natural) + 20;
    at(recFrom, () => command('record on', 'POST', '/spike/record', { on: true }));
    at(recTo, () => command('record off', 'POST', '/spike/record', { on: false }));

    if (lane.cut === 'engine') {
      void command('schedule', 'POST', '/v1/schedule', {
        item_id: episode.id,
        uri: episode.uri,
        at: T,
        title: 'episode',
      });
    }
    if (lane.cut === 'node' || lane.cut === 'soft') {
      // Clear what's left between the item on air and the episode, then cut (node) or let
      // the item on air finish, cut after the cap (soft).
      const lead = lane.cut === 'node' ? 1.5 : 0;
      at(T - lead, () =>
        serial(async () => {
          const ep = seq.indexOf(episode);
          for (let i = onAir + 1; i < ep; i++) {
            const it = seq[i] as Item;
            if (it.state === 'queued')
              await command(`remove ${it.id}`, 'DELETE', `/v1/queue/${it.id}`);
            it.state = 'aired';
          }
          if (episode.state === 'planned') await push(episode);
        }),
      );
      if (lane.cut === 'node') {
        at(T - SKIP_LEAD, () => command('skip', 'POST', '/v1/skip'));
      } else {
        at(T, () => {
          const cur = seq[onAir] as Item;
          const naturalEnd = (cur.startedAt ?? 0) + cur.len / cur.tempo - overlap(cur, episode);
          if (naturalEnd > T + SOFT_CAP) {
            result.notes.push(
              `soft: item on air ends ${(naturalEnd - T).toFixed(1)} s after T, cut at the cap`,
            );
            at(T + SOFT_CAP, () => command('skip', 'POST', '/v1/skip'));
          } else {
            result.notes.push(
              `soft: waiting ${(naturalEnd - T).toFixed(1)} s for ${cur.id} to end`,
            );
          }
        });
      }
    }
  }

  const offsets: Array<[number, number]> = [];
  const done = new Promise<void>((resolve) => {
    listeners.set(host, (e) => {
      if (e.audio_pos !== undefined) offsets.push([e.audio_pos, e.wall - e.audio_pos]);
      if (e.type === 'clock.sample') {
        result.clock.push({ wall: e.wall, nominal: e.at, audioPos: e.audio_pos ?? Number.NaN });
      } else if (e.type === 'rec.started') {
        result.rec = { at: e.at, wall: e.wall, audioPos: e.audio_pos ?? Number.NaN };
      } else if (e.type === 'rec.stopped') {
        resolve();
      } else if (e.type === 'track.started') {
        const id = e.data.item_id as string | null;
        if (id === EPISODE.id) {
          log(name, `episode on air, ${(e.at - T).toFixed(3)} s from T`);
          episodeStarted?.(e);
          if (lane.cut === 'engine') void serial(() => command('clear', 'DELETE', '/v1/queue'));
          return;
        }
        const k = seq.findIndex((i) => i.id === id);
        if (k === -1) {
          log(name, `on air: ${e.data.source} ${id ?? ''}`);
          if (!Number.isNaN(anchor))
            result.notes.push(`${e.data.source} on air at ${(e.at - anchor).toFixed(2)} s`);
          return;
        }
        const item = seq[k] as Item;
        item.state = 'aired';
        item.startedAt = e.at;
        item.audioPos = e.audio_pos;
        onAir = k;
        log(name, `${item.id} on air`);
        if (k === 0) onAnchor(e.at);
        void (async () => {
          if (lane.replan !== 'none') await replan(k, e.at);
          await feed();
        })();
        const next = seq[k + 1];
        if (lane.pushLead !== undefined && next) {
          at(e.at + item.len / item.tempo - lane.pushLead, () => serial(() => push(next)));
        }
      }
    });
  });

  // Wait for the engine, let the safety playlist settle, then start the hour.
  for (;;) {
    try {
      if ((await call(host, 'GET', '/v1/health')).status === 200) break;
    } catch {}
    await sleep(500);
  }
  await sleep(3000);
  if (lane.depth === 0) await serial(() => push(seq[0] as Item));
  else await feed();

  const ep = await episodeEvent;
  await done;
  await sleep(500);

  // Planned start of every item, from the anchor and the final plan.
  let t = anchor;
  for (let i = 0; i < seq.length && seq[i]?.kind !== 'episode'; i++) {
    const it = seq[i] as Item;
    result.items.push({
      id: it.id,
      plannedStart: t,
      startedAt: it.startedAt,
      err: it.startedAt === undefined ? undefined : it.startedAt - t,
    });
    t += slot(i);
  }
  result.episode = { asRunAt: ep.at, asRunErr: ep.at - T, asRunWallErr: ep.wall - T };
  // Ground truth: the episode's first sample on the audio timeline, mapped to wall time
  // through the least delayed frame seen in the whole run.
  const origin = Math.min(...offsets.map(([, o]) => o));
  const delays = offsets
    .filter(([pos]) => pos > 30)
    .map(([, o]) => (o - origin) * 1000)
    .sort((a, b) => a - b);
  const pct = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))];
  result.timing = {
    originWall: origin,
    delayP50Ms: pct(0.5) ?? Number.NaN,
    delayP99Ms: pct(0.99) ?? Number.NaN,
    delayMaxMs: delays.at(-1) ?? Number.NaN,
  };
  try {
    const rec = result.rec;
    if (!rec) throw new Error('no rec.started event');
    const audio = locateEpisode(join(REC, `${host}.wav`), (ep.audio_pos ?? 0) - rec.audioPos);
    result.episode.audioAt = origin + rec.audioPos + audio.firstSample / SAMPLE_RATE;
    result.episode.audioErr = result.episode.audioAt - T;
    result.episode.corr = audio.corr;
  } catch (err) {
    result.notes.push(`audio analysis failed: ${(err as Error).message}`);
  }
  log(
    name,
    `done: as-run ${result.episode.asRunErr.toFixed(3)} s, audio ${result.episode.audioErr?.toFixed(4) ?? '?'} s`,
  );
  return result;
}

// ---------------------------------------------------------------------------------------
// Audio: find the episode's first sample in the recording by cross-correlation.

/** Left channel of the recorder's 16-bit stereo WAV (the fixtures are dual mono). */
function wavSamples(path: string): Int16Array {
  const buf = readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      // The size may still be a placeholder; read to the end of the file.
      const start = off + 8;
      const n = Math.floor((buf.length - start) / 4);
      const left = new Int16Array(n);
      for (let i = 0; i < n; i++) left[i] = buf.readInt16LE(start + i * 4);
      return left;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

const episodeHead = (() => {
  try {
    const b = readFileSync(join(MEDIA, 'episode-head.s16'));
    return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  } catch {
    return new Int16Array(0);
  }
})();

function correlate(rec: Int16Array, tplStart: number, tplLen: number, from: number, to: number) {
  const tpl = episodeHead.subarray(tplStart, tplStart + tplLen);
  let tplNorm = 0;
  for (const v of tpl) tplNorm += v * v;
  let best = { lag: -1, corr: -1 };
  for (let lag = Math.max(0, from); lag <= Math.min(to, rec.length - tplLen); lag++) {
    let dot = 0;
    let norm = 0;
    for (let j = 0; j < tplLen; j++) {
      const r = rec[lag + j] as number;
      dot += r * (tpl[j] as number);
      norm += r * r;
    }
    const c = norm > 0 ? dot / Math.sqrt(norm * tplNorm) : 0;
    if (c > best.corr) best = { lag, corr: c };
  }
  return best;
}

/** The episode's first sample in the recording; `around` is the as-run guess, in seconds. */
function locateEpisode(path: string, around: number) {
  const rec = wavSamples(path);
  // Template 3 s into the episode, clear of the outgoing song's 2 s fade-out.
  const tplStart = 3 * SAMPLE_RATE;
  const guess = Math.round(around * SAMPLE_RATE) + tplStart;
  const coarse = correlate(rec, tplStart, 1024, guess - 3 * SAMPLE_RATE, guess + 3 * SAMPLE_RATE);
  const fine = correlate(rec, tplStart, 8192, coarse.lag - 64, coarse.lag + 64);
  return { firstSample: fine.lag - tplStart, corr: fine.corr };
}

// ---------------------------------------------------------------------------------------
// Main

const fmt = (x: number | undefined, d = 3) => (x === undefined ? '–' : x.toFixed(d));

if (import.meta.main) {
  server.listen(8080);
  console.log(
    `lanes: ${LANES.map((l) => l.name).join(', ')}; ${ITEMS} items${MAX_ITEM ? ` capped at ${MAX_ITEM} s` : ''}${TAIL ? `, last ${TAIL} s of each` : ''}, transition lag ${TRANSITION_LAG} s`,
  );
  const results = await Promise.all(LANES.map(runLane));
  server.close();

  console.log(
    '\nlane                offset  as-run err  wall err   audio err  corr  max drift  replans  cmds  delay p50/p99/max ms',
  );
  for (const r of results) {
    const drifts = r.items.map((i) => Math.abs(i.err ?? 0));
    console.log(
      [
        r.lane.name.padEnd(19),
        fmt(r.lane.offset, 0).padStart(6),
        fmt(r.episode?.asRunErr).padStart(11),
        fmt(r.episode?.asRunWallErr).padStart(9),
        fmt(r.episode?.audioErr, 4).padStart(11),
        fmt(r.episode?.corr, 2).padStart(5),
        fmt(Math.max(0, ...drifts)).padStart(10),
        String(r.replans.length).padStart(8),
        String(r.commands.length).padStart(5),
        `${fmt(r.timing?.delayP50Ms, 0)}/${fmt(r.timing?.delayP99Ms, 0)}/${fmt(r.timing?.delayMaxMs, 0)}`.padStart(
          13,
        ),
      ].join(' '),
    );
    for (const n of r.notes) console.log(`    ${n}`);
  }
  const path = join(RESULTS_DIR, `${RUN}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        run: RUN,
        items: ITEMS,
        maxItem: MAX_ITEM,
        tail: TAIL,
        transitionLag: TRANSITION_LAG,
        late: LATE,
        early: EARLY,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nreport: ${path}`);
  process.exit(results.every((r) => r.episode?.audioErr !== undefined) ? 0 : 1);
}
