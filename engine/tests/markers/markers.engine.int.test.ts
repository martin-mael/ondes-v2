import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngineAdapter,
  type EngineAdapter,
  toRealtimeEvent,
} from '../../../apps/api/src/modules/engine/adapter/index.ts';
import { renderStationScript } from '../../../apps/api/src/modules/engine/config/index.ts';
import { createStationFeeder } from '../../../apps/api/src/modules/engine/feeder/feeder.ts';
import type { FeedMedia } from '../../../apps/api/src/modules/engine/feeder/push.ts';
import type { FeedWindow } from '../../../apps/api/src/modules/engine/feeder/repo.ts';
import {
  analyse,
  type Run,
  readWavChannel,
  toneRuns,
  writeTone,
} from '../../../apps/api/src/modules/live/testing/tones.ts';
import type { LogItem, LogItemKind, LogItemTiming } from '../../../packages/shared/src/index.ts';

// Fixed-time markers on the real engine (#52, ADR 0036): the real feeder plays a log with
// markers into the station template in the pinned Liquidsoap image, recorded on its final mix.
// Every item plays its own tone, so the recording says what aired when. The log (times after
// T, the first marker):
//   A (song) runs past M1 ─ M1 hard @0 ─ J1 ─ B (song) runs past M2's cap
//   ─ M2 soft @10, cap 4 s ─ J2 ─ C, D, E (songs) ─ M3 soft @24, cap 10 s ─ J3
//   ─ F (song, cut in the log, can stretch) ─ M4 not before @38 ─ J4
//   ─ G (song, can't stretch) ─ M5 not before @50 ─ J5
// What each marker must do to its item (the J after it):
// - M1 hard: J1 starts at T to the frame; A fades out under it and never comes back.
// - M2 soft, past the cap: B is still on air at 10 + 4 s, so the engine cuts it there.
// - M3 soft, in the cap: D (on air at 24) plays to its end, J3 follows it; E, which would
//   start after 24, is skipped.
// - M4 not before, stretched: F plays longer than its log slot, to just past 38 (the tail
//   aims half a second past T), and J4 starts there.
// - M5 not before, waiting: G ends 2.5 s early and can't stretch: safety plays, J5 starts at
//   50, not before.
// The recording has no wall clock: times are measured from J1, which the engine gates on its
// audio timeline (ADR 0003; two gated starts agree within ~0.1 s this early in an engine's
// life, while its clock origin settles). Own container, control port on a random 127.0.0.1 port:
// never the shared dev stack.

const repo = resolve(import.meta.dirname, '../../..');
const TOKEN = `markers-test-${randomBytes(8).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const engineName = `ondes-markers-engine-${run}`;
const work = join(tmpdir(), `ondes-markers-${run}`);
const SR = 44_100;
/** The template's minimum crossfade (`crossfade.duration` ≥ 0.1 s): the overlap into each item. */
const CROSS_MS = 100;
/** ADR 0003's slot model: playable − overlap + one frame. */
const slotOf = (mediaMs: number) => mediaMs - CROSS_MS + 20;

const TONES = {
  S: 3600,
  A: 220,
  B: 330,
  C: 440,
  D: 550,
  E: 660,
  F: 770,
  G: 880,
  J1: 1000,
  J2: 1500,
  J3: 2000,
  J4: 2500,
  J5: 3000,
};
type Tone = keyof typeof TONES;

function liquidsoapImage(): string {
  if (process.env.LIQUIDSOAP_IMAGE) return process.env.LIQUIDSOAP_IMAGE;
  const compose = readFileSync(join(repo, 'deploy/compose.dev.yml'), 'utf8');
  const m = compose.match(/image:\s*(savonet\/liquidsoap:\S+)/);
  if (!m?.[1]) throw new Error('no Liquidsoap image in deploy/compose.dev.yml');
  return m[1];
}

function docker(args: string[], check = true): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (check && r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user =
  process.getuid && process.getgid
    ? ['--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp']
    : [];

let engine: EngineAdapter;

const shaOf = (id: string) => createHash('sha256').update(`markers:${id}`).digest('hex');

/** A tone file in the engine's cache, and the media the feeder knows it by. */
function media(id: Tone, mediaMs: number): FeedMedia {
  const sha256 = shaOf(id);
  const path = join(work, 'cache', 'media', sha256.slice(0, 2), `${sha256}.wav`);
  mkdirSync(dirname(path), { recursive: true });
  writeTone(path, TONES[id], mediaMs / 1000);
  return {
    assetId: `asset-${id}`,
    fileId: `file-${id}`,
    sha256,
    ext: 'wav',
    flacBlockSize: null,
    durationSamples: Math.round((mediaMs * SR) / 1000),
    sampleRate: SR,
    cached: true,
    title: id,
    artists: [],
    cues: null,
    gain: { normalizeLoudness: false, gainOverrideDb: null, loudness: null },
  };
}

function item(
  id: string,
  kind: LogItemKind,
  plannedStartMs: number,
  extra: Partial<LogItem> = {},
): LogItem {
  return {
    id,
    logDayId: 'day',
    position: 0,
    kind,
    plannedStart: new Date(plannedStartMs).toISOString(),
    plannedDurationMs: 0,
    assetId: kind === 'marker' ? null : `asset-${id}`,
    asset: null,
    episodeId: null,
    liveSlotId: null,
    title: id,
    cueOverrides: null,
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

function marker(id: string, atMs: number, timing: LogItemTiming, capMs: number | null = null) {
  return item(id, 'marker', atMs, { anchorAt: new Date(atMs).toISOString(), timing, capMs });
}

beforeAll(async () => {
  mkdirSync(join(work, 'safety'), { recursive: true });
  writeTone(join(work, 'safety', 'safety.wav'), TONES.S, 120);
  const rendered = renderStationScript({
    stationId: `markers-${run}`,
    name: 'Markers test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.wav' },
    crossfade: { duration: CROSS_MS / 1000 },
    processing: { compressor: { enabled: false }, limiter: { enabled: false } },
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
  });
  writeFileSync(
    join(work, 'station.liq'),
    `${rendered.script}\noutput.file(%wav(stereo=true, samplesize=16), "/work/output.wav", radio)\n`,
  );
  docker([
    'run',
    '-d',
    '--name',
    engineName,
    ...user,
    '-e',
    `ENGINE_CONTROL_TOKEN=${TOKEN}`,
    '-e',
    'ICECAST_SOURCE_PASSWORD=unused',
    '-p',
    '127.0.0.1::7000',
    '-v',
    `${work}:/work`,
    liquidsoapImage(),
    '/work/station.liq',
  ]);
  const port = docker(['port', engineName, '7000/tcp']).split('\n')[0]?.split(':').pop();
  engine = createEngineAdapter({
    stationId: `markers-${run}`,
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
  });
  for (let i = 0; i < 120; i++) {
    if (
      await engine.health().then(
        () => true,
        () => false,
      )
    )
      return;
    await sleep(500);
  }
  throw new Error(`engine did not start:\n${docker(['logs', engineName], false)}`);
}, 120_000);

afterAll(() => {
  docker(['rm', '-f', engineName], false);
  if (!process.env.KEEP_MARKERS_WORK) rmSync(work, { recursive: true, force: true });
});

describe('fixed-time markers on the real engine', () => {
  it('hard, soft and not-before markers time the item after them', async () => {
    // 20 s in, the engine's estimate of its audio clock origin has settled.
    const T = Date.now() + 20_000;
    const s = (seconds: number) => T + seconds * 1000;
    const files = new Map<string, FeedMedia>();
    const song = (id: Tone, at: number, mediaMs: number, slotMs = slotOf(mediaMs)) => {
      const m = media(id, mediaMs);
      files.set(m.assetId, m);
      // The overlap into the next item, as autocue's cues give it in production.
      return item(id, id.startsWith('J') ? 'jingle' : 'song', at, {
        plannedDurationMs: slotMs,
        cueOverrides: { crossOutMs: CROSS_MS },
      });
    };
    const items: LogItem[] = [
      // A runs well past M1: the engine cuts it at T.
      song('A', s(-20), 40_000),
      marker('M1', s(0), 'hard'),
      song('J1', s(0), 3_000),
      // B runs well past M2 + cap.
      song('B', s(3), 30_000),
      marker('M2', s(10), 'soft', 4_000),
      song('J2', s(10), 3_000),
      // After J2 (14–17): C 17–21, D 21–29 (on air at 24), E would start at 29.
      song('C', s(17), 4_000),
      song('D', s(21), 8_000),
      song('E', s(29), 5_000),
      marker('M3', s(24), 'soft', 10_000),
      song('J3', s(24), 3_000),
      // After J3 (29–32): F's log slot is 5 s of its 10 s; it stretches to 38.
      song('F', s(32), 10_000, 5_000),
      marker('M4', s(38), 'not_before'),
      song('J4', s(38), 3_000),
      // After J4 (38–41): G, 6 s whole, ends at 47; M5 is at 50.
      song('G', s(41), 6_000),
      marker('M5', s(50), 'not_before'),
      song('J5', s(50), 3_000),
      song('C', s(53), 4_000),
    ].map((i, position) => ({ ...i, id: i.id === 'C' && position > 10 ? 'C2' : i.id, position }));
    const station = { loudnessTargetLufs: -16, truePeakLimitDbtp: -1 };
    const feeder = createStationFeeder({
      scope: { orgId: 'org', stationId: `markers-${run}` } as never,
      engine: async () => engine,
      load: async (): Promise<FeedWindow> => ({ items, media: files, station }),
      cache: { requestUrgentFetch: async () => {}, requestSync: async () => {} },
      alerts: { raise: async () => {}, resolve: async () => {} },
      options: { engineRoot: '/work/cache' },
    });
    // As in the api: engine events reach the feeder (it notes what aired and re-syncs), and
    // it syncs on a tick, more often here than the api's 5 s.
    let seq = 0;
    let lastLine = '';
    while (Date.now() < s(58)) {
      for (const e of await engine.events(seq)) {
        seq = Math.max(seq, e.seq);
        feeder.onEvent(toRealtimeEvent(e));
      }
      const r = await feeder.sync();
      if (process.env.MARKERS_REPORT) {
        const st = await engine.state();
        const line = `${st.on_air.source}:${st.on_air.item_id} q=${st.queue.map((q) => q.item_id).join(',')} sch=${st.scheduled?.item_id ?? '-'} hold=${r.plan?.hold?.itemId ?? '-'} onAirIdx=${r.plan?.onAirIndex}`;
        if (line !== lastLine) console.log(((Date.now() - T) / 1000).toFixed(2), line);
        lastLine = line;
      }
      await sleep(100);
    }
    if (process.env.MARKERS_REPORT) {
      for (const e of await engine.events(0)) {
        if (e.type === 'track.started' || e.type === 'track.ended')
          console.log((e.at - T / 1000).toFixed(2), e.type, e.data.source, e.data.item_id);
      }
    }
    const started = (await engine.events(0)).flatMap((e) =>
      e.type === 'track.started' && e.data.source === 'queue' ? [e.data.item_id] : [],
    );
    docker(['stop', '-t', '10', engineName]);

    // E never airs: M3 skipped it. Each marker's item airs once. The item queued right after
    // an engine cut (B after J1, C after J2) may be taken by the automation under the
    // scheduled item and pushed again, so it can start twice (#46's template; ADR 0036,
    // "Known limits"): the order of first starts is what the markers decide.
    expect([...new Set(started)]).toEqual([
      'A',
      'J1',
      'B',
      'J2',
      'C',
      'D',
      'J3',
      'F',
      'J4',
      'G',
      'J5',
      'C2',
    ]);
    for (const j of ['J1', 'J2', 'J3', 'J4', 'J5']) {
      expect(started.filter((id) => id === j)).toHaveLength(1);
    }

    const { rate, samples } = readWavChannel(join(work, 'output.wav'));
    const runs = toneRuns(analyse(samples, rate, 0.02), TONES, 3);
    // Consecutive runs of one tone are one item (a re-push of the same item).
    const labels = runs.map((r) => r.label).filter((l, n, all) => l !== all[n - 1]);
    const at = (label: string): Run => {
      const found = runs.find((r) => r.label === label);
      if (!found) throw new Error(`${label} not in the recording: ${labels.join(' ')}`);
      return found;
    };
    const j1 = at('J1');
    /** Seconds after T, from the recording. */
    const t = (sec: number) => sec - j1.from;
    const report = runs.map((r) => `${r.label} ${t(r.from).toFixed(3)}–${t(r.to).toFixed(3)}`);
    if (process.env.MARKERS_REPORT) console.log(report.join('\n'));

    // What aired, in order (S: safety, before the first push and while J5 waits).
    expect(labels.filter((l) => l !== 'S')).toEqual([
      'A',
      'J1',
      'B',
      'J2',
      'C',
      'D',
      'J3',
      'F',
      'J4',
      'G',
      'J5',
      'C',
    ]);
    const index = (label: string) => labels.indexOf(label);

    // M1 hard: A is cut at T, J1 starts there, A never comes back.
    expect(t(at('A').to)).toBeGreaterThan(-0.15);
    expect(t(at('A').to)).toBeLessThan(0.05);
    expect(labels.lastIndexOf('A')).toBe(index('A'));

    // M2 soft, past its cap: J2 starts at 10 + 4 s, on the engine's clock, cutting B. Two
    // gated starts this early in the engine's life agree within ~0.1 s (its clock origin is
    // still settling), as in hardstart.engine.int.test.ts.
    expect(Math.abs(t(at('J2').from) - 14)).toBeLessThan(0.15);
    expect(at('B').to).toBeLessThan(at('J2').from + 0.05);

    // M3 soft, within its cap: D plays whole, J3 follows it, at most 10 s after 24.
    const d = at('D');
    expect(t(d.to)).toBeGreaterThan(24);
    const j3 = at('J3');
    expect(Math.abs(j3.from - d.to)).toBeLessThan(0.15);
    expect(t(j3.from)).toBeGreaterThan(24);
    expect(t(j3.from)).toBeLessThan(34);

    // M4 not before, stretched: F plays past its 5 s slot, J4 starts at 38 (never before).
    const f = at('F');
    expect(f.to - f.from).toBeGreaterThan(5.5);
    // (The tail aims half a second past T: the prediction is a frame or two off either way.)
    expect(t(at('J4').from)).toBeGreaterThan(38 - 0.02);
    expect(t(at('J4').from)).toBeLessThan(38 + 0.7);

    // M5 not before, waiting: safety airs between G and J5, J5 starts at 50, never before.
    const j5 = index('J5');
    expect(labels.slice(index('G') + 1, j5)).toEqual(['S']);
    expect(t(at('J5').from)).toBeGreaterThan(50 - 0.02);
    expect(t(at('J5').from)).toBeLessThan(50 + 0.5);
  }, 180_000);
});
