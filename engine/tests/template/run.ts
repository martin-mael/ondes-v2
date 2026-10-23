// Station template runtime test (#27): runs the rendered template in the pinned Liquidsoap
// image, drives its control API like the adapter (#28) does, and checks that an island
// chain pushed as one segment airs with no seam (spike #12) and is reported per request.
// The segment is the body the feeder builds (#57, `buildPushChain`), and the island fallback
// (a voice laid over an item, the music ducked) is checked on the same output.
//
//   node engine/tests/template/run.ts [--keep]
//
// Needs docker and ffmpeg. Runs its own container (own name, its control port published on
// a random 127.0.0.1 port), never the shared dev stack. Everything generated goes to
// engine/tests/template/.work/run. See README.md.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderStationScript } from '../../../apps/api/src/modules/engine/config/index.ts';
import {
  buildPushChain,
  buildPushItem,
  type FeedMedia,
} from '../../../apps/api/src/modules/engine/feeder/push.ts';
import {
  type EngineEvent,
  engineEventBatchSchema,
  engineHealthSchema,
  engineQueuedRequestSchema,
  engineStateSchema,
  playoutRelPath,
} from '../../../packages/shared/src/index.ts';
import { decode, mono, SAMPLE_RATE, writeWav } from '../splice/audio.ts';
import { FORMATS, makeMaterial } from '../splice/fixtures.ts';
import {
  bJoin,
  cues,
  joins,
  liqSeconds,
  makePlan,
  reference,
  renderIsland,
} from '../splice/island.ts';
import {
  compareJoins,
  detectDropouts,
  findLag,
  joinEvents,
  type SeamEvent,
  trackAlignment,
} from '../splice/seam-detector.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const TOKEN = 'template-test-token';
/** Same limit as the splice test: the 24-bit floor is around -110 dB. */
const MAX_RESIDUAL_DB = -70;
/** Seconds of B body after the island. */
const B_SECONDS = 5;

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

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Engine-side cache root of the test: files are placed as the playout cache places them. */
const CACHE = '/work/cache';

/** Copies a file into the test's playout cache layout; returns its sha256. */
function cacheFile(work: string, path: string, ext: string): string {
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const rel = playoutRelPath({ sha256, ext });
  mkdirSync(join(work, 'cache', dirname(rel)), { recursive: true });
  writeFileSync(join(work, 'cache', rel), bytes);
  return sha256;
}

/** Playout media as the feeder's repo loads it (no loudness: gains come from `gainOverrideDb`). */
function feedMedia(sha256: string, seconds: number, extra: Partial<FeedMedia> = {}): FeedMedia {
  return {
    assetId: sha256.slice(0, 8),
    fileId: sha256.slice(0, 8),
    sha256,
    ext: 'flac',
    flacBlockSize: 1024,
    durationSamples: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    cached: true,
    title: '',
    artists: [],
    cues: null,
    gain: { normalizeLoudness: false, gainOverrideDb: null, loudness: null },
    ...extra,
  };
}

/** A sine tone, stereo. */
function tone(hz: number, seconds: number, amplitude: number) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return { sampleRate: SAMPLE_RATE, channels: [c, c.slice()] };
}

/** Amplitude of `hz` in `x[from, from + length)` (single-bin DFT). */
function amplitudeAt(x: Float32Array, hz: number, from: number, length: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < length; i++) {
    const v = x[from + i] ?? 0;
    const w = (2 * Math.PI * hz * i) / SAMPLE_RATE;
    re += v * Math.cos(w);
    im += v * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / length;
}

const liqSecondsNum = (n: number, sr: number, hasCueIn: boolean) =>
  Number(liqSeconds(n, sr, hasCueIn));

async function main() {
  const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
  const work = join(here, '.work/run');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'safety'), { recursive: true });
  const inContainer = (p: string) => `/work/${relative(work, p)}`;

  // Material and island, exactly as the splice test's recommended FLAC case.
  const mat = await makeMaterial('noise', join(here, '.work/material'));
  const plan = makePlan({ splice: 'butt', grid: FORMATS.flac.grid });
  const island = join(work, 'island.flac');
  renderIsland(plan, mat.masters, island);
  const cue = cues(plan, 'butt');
  const bCueIn = Math.round(Number(cue.b.cueIn) * SAMPLE_RATE + 0.5);
  const bCueOut = bCueIn + B_SECONDS * SAMPLE_RATE;
  for (const f of ['a', 'b'] as const)
    writeFileSync(join(work, `${f}.flac`), readFileSync(mat.masters[f]));

  // The station template, with processing off so the output can be compared sample by
  // sample, nothing to fall back to (silence before and after the segment) and a short
  // blank detection to tell when the segment is over.
  const rendered = renderStationScript({
    stationId: 'template-test',
    name: 'Template test',
    paths: { safetyDir: '/work/safety', emergencyFile: '/work/missing.flac' },
    blank: { maxSeconds: 1 },
    processing: { compressor: { enabled: false }, limiter: { enabled: false } },
    // Nothing listens there: the outputs keep retrying, the recorder below is what we check.
    icecast: { host: '127.0.0.1', port: 9 },
    outputs: [{ mount: 'test.mp3', format: 'mp3', bitrate: 128 }],
  });
  // Test-only recorder of the final mix, appended after the outputs.
  const script = `${rendered.script}\noutput.file(%wav(stereo=true, samplesize=24), "/work/output.wav", radio)\n`;
  writeFileSync(join(work, 'station.liq'), script);

  const name = `ondes-template-test-${randomBytes(4).toString('hex')}`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    ...(process.getuid && process.getgid
      ? ['--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp']
      : []),
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
  try {
    const hostPort = docker(['port', name, '7000/tcp']).split('\n')[0]?.split(':').pop();
    const base = `http://127.0.0.1:${hostPort}/v1`;
    const auth = { authorization: `Bearer ${TOKEN}` };
    const call = (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = auth,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

    let health: unknown;
    for (let i = 0; i < 60 && !health; i++) {
      health = await fetch(`${base}/health`)
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined);
      if (!health) await sleep(500);
    }
    if (!health) throw new Error(`engine did not start:\n${docker(['logs', name], false)}`);
    check(engineHealthSchema.safeParse(health).success, 'GET /v1/health matches the contract');
    check(
      (health as { config_version?: string }).config_version === rendered.version,
      `engine reports config_version ${rendered.version}`,
    );

    // Control API basics.
    check((await call('GET', '/state', undefined, {})).status === 401, 'no token: 401');
    const missing = await call('POST', '/queue', { item_id: 'x', uri: '/work/nope.flac' });
    check(missing.status === 422, 'push of a missing file: 422');
    check((await call('POST', '/queue', { uri: 1 })).status === 400, 'push of a bad body: 400');
    check(
      (await call('POST', '/segment', { segment_id: 'S0', parts: [] })).status === 400,
      'empty segment: 400',
    );
    const partial = await call('POST', '/segment', {
      segment_id: 'S0',
      parts: [
        { item_id: 'p1', uri: inContainer(join(work, 'a.flac')) },
        { item_id: 'p2', uri: '/work/nope.flac' },
      ],
    });
    check(partial.status === 422, 'segment with a missing file: 422');
    const afterPartial = engineStateSchema.parse(await (await call('GET', '/state')).json());
    check(afterPartial.queue.length === 0, 'a refused segment queues nothing');

    // The island chain, pushed as one segment, built by the feeder (#57) from the media as
    // its repo loads them. A's cue-in is the splice test's odd position, before snapping: the
    // feeder moves it up to the FLAC grid (ADR 0018) and biases every cue by half a sample.
    const shaA = cacheFile(work, join(work, 'a.flac'), 'flac');
    const shaB = cacheFile(work, join(work, 'b.flac'), 'flac');
    const shaIsland = cacheFile(work, island, 'flac');
    const sr = SAMPLE_RATE;
    const chainCues = (cueIn: number | null, cueOut: number | null) => ({
      sampleRate: sr,
      cueIn,
      cueOut,
      fadeIn: null,
      fadeOut: null,
      crossStartNext: null,
    });
    const gain = (db: number) => ({ normalizeLoudness: true, gainOverrideDb: db, loudness: null });
    const body = buildPushChain(
      {
        segmentId: 'S1',
        steps: [
          {
            kind: 'body',
            source: {
              itemId: 'A',
              title: 'A body',
              cueOverrides: null,
              media: feedMedia(shaA, 30, {
                cues: chainCues(88_211, null),
                gain: gain(plan.gainA),
              }),
            },
            from: null,
            to: plan.aJoin,
          },
          {
            kind: 'island',
            itemId: 'VT',
            sha256: shaIsland,
            lengthSamples: plan.length,
            title: 'island',
            artist: null,
          },
          {
            kind: 'body',
            source: {
              itemId: 'B',
              title: 'B body',
              cueOverrides: { crossOutMs: 0 },
              media: feedMedia(shaB, 30, {
                cues: chainCues(null, bCueOut),
                gain: gain(plan.gainB),
              }),
            },
            from: bJoin(plan) + plan.handle,
            to: null,
          },
        ],
      },
      {
        station: { loudnessTargetLufs: -16, truePeakLimitDbtp: 24 },
        crossInMs: 0,
        engineRoot: CACHE,
      },
    );
    // Straight into A from silence, so the output starts with A's first sample, and no fade at
    // the end of B.
    body.fade_in = 0;
    body.fade_out = 0;
    const [pA, pVT, pB] = body.parts;
    const sameSample = (x: number | undefined, y: string) =>
      x !== undefined && Math.ceil(x * sr) === Math.ceil(Number(y) * sr);
    check(
      sameSample(pA?.cue_in, cue.a.cueIn) &&
        sameSample(pA?.cue_out, cue.a.cueOut) &&
        sameSample(pB?.cue_in, cue.b.cueIn) &&
        sameSample(pB?.cue_out, liqSeconds(bCueOut, sr, true)) &&
        pA?.amplify_db === plan.gainA &&
        pB?.amplify_db === plan.gainB &&
        pVT?.amplify_db === 0 &&
        pVT.cue_in === undefined &&
        body.cross_in === 0 &&
        body.cross_out === 0,
      'feeder chain body: snapped, biased cues, per-part gains, island at 0 dB',
    );
    const seg = await call('POST', '/segment', body);
    check(seg.status === 201, `POST /v1/segment: 201 (got ${seg.status})`);
    const segBody = (await seg.json()) as { segment_id: string; requests: unknown[] };
    check(
      segBody.segment_id === 'S1' &&
        segBody.requests.length === 3 &&
        segBody.requests.every(
          (r) =>
            engineQueuedRequestSchema.safeParse(r).success &&
            (r as { segment_id?: string }).segment_id === 'S1',
        ),
      'segment answer: segment_id and its 3 requests',
    );

    // Queue a normal item behind it, then take it back.
    await sleep(2000);
    const d = await call('POST', '/queue', {
      item_id: 'D',
      uri: inContainer(join(work, 'b.flac')),
    });
    check(d.status === 201, 'push of a normal item: 201');
    const st = engineStateSchema.parse(await (await call('GET', '/state')).json());
    check(
      st.queue.length === 1 && st.queue[0]?.item_id === 'D' && st.on_air.item_id === 'A',
      'state: A on air, D queued',
    );
    const rm = await call('DELETE', '/queue/D');
    check(
      rm.status === 200 && ((await rm.json()) as { removed: number }).removed === 1,
      'DELETE /v1/queue/D removes it',
    );
    check((await call('DELETE', '/queue/D')).status === 404, 'removing it again: 404');
    const s2 = await call('POST', '/segment', {
      segment_id: 'S2',
      parts: ['E1', 'E2'].map((item_id) => ({ item_id, uri: inContainer(join(work, 'b.flac')) })),
    });
    check(s2.status === 201, 'second segment queued behind');
    const rmPart = await call('DELETE', '/queue/E2');
    check(
      rmPart.status === 200 && ((await rmPart.json()) as { removed: number }).removed === 2,
      'naming one part of a segment removes the whole segment',
    );

    // Wait for the end of the segment: silence again, then blank.detected.
    let events: EngineEvent[] = [];
    const deadline = Date.now() + 60_000;
    const started = (id: string) =>
      events.findIndex((e) => e.type === 'track.started' && e.data.item_id === id);
    while (Date.now() < deadline) {
      const r = await call('GET', '/events?after=0');
      events = engineEventBatchSchema.parse(await r.json());
      const b = started('B');
      if (b >= 0 && events.slice(b).some((e) => e.type === 'blank.detected')) break;
      await sleep(500);
    }
    const plays = events.filter((e) => e.type === 'track.started').map((e) => e.data.item_id);
    check(
      JSON.stringify(plays) === JSON.stringify(['A', 'VT', 'B']),
      `as-run: track.started A, VT, B (got ${JSON.stringify(plays)})`,
    );
    // segment_id is not in the contract on main yet (#28 adds it): read it from the raw JSON.
    const raw = (await (await call('GET', '/events?after=0')).json()) as {
      type: string;
      data: { item_id?: string; segment_id?: string | null };
    }[];
    check(
      raw
        .filter((e) => e.type === 'track.started' && e.data.item_id !== 'x')
        .every((e) => e.data.segment_id === 'S1'),
      'as-run: every part reports segment_id S1',
    );
    check(
      events.every((e, i) => e.seq === i + 1),
      'events: seq 1, 2, 3, … with no gap',
    );
    const ended = events.filter((e) => e.type === 'track.ended');
    const playedA = ended.find((e) => e.data.item_id === 'A')?.data.played ?? 0;
    const expectA = (plan.aJoin - plan.aCueIn) / SAMPLE_RATE;
    check(
      Math.abs(playedA - expectA) < 0.2,
      `A played ${playedA.toFixed(2)} s (≈ ${expectA.toFixed(2)})`,
    );

    // Skipping a segment ends it as a whole: neither its island nor its B body airs.
    const again = await call('POST', '/segment', {
      segment_id: 'S3',
      parts: ['A2', 'VT2', 'B2'].map((item_id) => ({
        item_id,
        uri: inContainer(join(work, 'a.flac')),
      })),
    });
    check(again.status === 201, 'second segment queued');
    await sleep(2000);
    check((await call('POST', '/skip')).status === 200, 'POST /v1/skip during the segment');
    await sleep(3000);
    const afterSkip = engineEventBatchSchema
      .parse(await (await call('GET', `/events?after=${events.length}`)).json())
      .filter((e) => e.type === 'track.started')
      .map((e) => e.data.item_id);
    check(
      JSON.stringify(afterSkip) === JSON.stringify(['A2']),
      `after the skip nothing of the segment airs (got ${JSON.stringify(afterSkip)})`,
    );

    // The island fallback (#57): F plays 6 s of a 220 Hz tone with a 2 s voice (1 kHz) laid over
    // it from 3 s before its end, the music ducked to -12 dB meanwhile. Built by the feeder.
    await sleep(2500);
    writeWav(join(work, 'f.wav'), tone(220, 6, 0.3));
    writeWav(join(work, 'voice.wav'), tone(1000, 2, 0.2));
    const shaF = cacheFile(work, join(work, 'f.wav'), 'wav');
    const shaVoice = cacheFile(work, join(work, 'voice.wav'), 'wav');
    const before = engineEventBatchSchema.parse(
      await (await call('GET', '/events?after=0')).json(),
    ).length;
    const f = buildPushItem(
      {
        itemId: 'F',
        title: 'fallback',
        cueOverrides: { crossInMs: 0, crossOutMs: 0 },
        media: feedMedia(shaF, 6, { ext: 'wav' }),
      },
      {
        station: { loudnessTargetLufs: -16, truePeakLimitDbtp: 24 },
        engineRoot: CACHE,
        overlay: [
          {
            uri: `${CACHE}/${playoutRelPath({ sha256: shaVoice, ext: 'wav' })}`,
            start: -3,
            duration: 2,
            cueOut: liqSecondsNum(2 * sr, sr, false),
            duckDb: -12,
          },
        ],
      },
    );
    f.fade_in = 0;
    f.fade_out = 0;
    check(
      f.overlay?.[0]?.at === 3 && f.overlay?.[0]?.duck_db === -12,
      'fallback body: the voice starts 3 s into F, ducking to -12 dB',
    );
    check((await call('POST', '/queue', f)).status === 201, 'push with a voice overlay: 201');
    await sleep(9000);
    const afterF = engineEventBatchSchema
      .parse(await (await call('GET', `/events?after=${before}`)).json())
      .filter((e) => e.type === 'track.started')
      .map((e) => e.data.item_id);
    check(
      JSON.stringify(afterF) === JSON.stringify(['F']),
      `the voice is no item on air: as-run sees F only (got ${JSON.stringify(afterF)})`,
    );

    // Hard start (#46, ADR 0031): G (440 Hz) plays from the queue; H (660 Hz) is scheduled 4 s
    // later. The engine starts H on its own audio timeline, fades G out under it and skips G,
    // so G doesn't come back after H.
    writeWav(join(work, 'g.wav'), tone(440, 12, 0.3));
    writeWav(join(work, 'h.wav'), tone(660, 4, 0.3));
    const hardBefore = engineEventBatchSchema.parse(
      await (await call('GET', '/events?after=0')).json(),
    ).length;
    check(
      (await call('POST', '/queue', { item_id: 'G', uri: inContainer(join(work, 'g.wav')) }))
        .status === 201,
      'hard start: G queued',
    );
    await sleep(1000);
    const hAt = Date.now() / 1000 + 4;
    check(
      (await call('POST', '/schedule', { item_id: 'H', at: hAt })).status === 400,
      'schedule of a bad body: 400',
    );
    check(
      (await call('POST', '/schedule', { item_id: 'H', uri: '/work/nope.wav', at: hAt })).status ===
        422,
      'schedule of a missing file: 422',
    );
    const scheduledH = await call('POST', '/schedule', {
      item_id: 'H',
      uri: inContainer(join(work, 'h.wav')),
      at: hAt,
      fade_in: 0,
    });
    check(scheduledH.status === 201, `POST /v1/schedule: 201 (got ${scheduledH.status})`);
    const waiting = engineStateSchema.parse(await (await call('GET', '/state')).json());
    check(
      waiting.scheduled?.item_id === 'H' &&
        // The engine prints epoch floats to 10 ms (ADR 0003).
        Math.abs((waiting.scheduled?.at ?? 0) - hAt) < 0.011 &&
        waiting.on_air.item_id === 'G',
      'state: G on air, H scheduled at its time',
    );
    // Once H is on air, as the feeder does: queue what follows it (K), and post the next hard
    // start (I), then cancel it. Neither may disturb H.
    let onAirH = false;
    for (let i = 0; i < 100 && !onAirH; i++) {
      await sleep(100);
      onAirH =
        engineStateSchema.parse(await (await call('GET', '/state')).json()).on_air.item_id === 'H';
    }
    check(onAirH, 'H goes on air');
    writeWav(join(work, 'k.wav'), tone(330, 8, 0.3));
    await call('POST', '/queue', { item_id: 'K', uri: inContainer(join(work, 'k.wav')) });
    const afterH = engineStateSchema.parse(await (await call('GET', '/state')).json());
    check(afterH.scheduled === null, 'state: nothing scheduled once H has started');
    const cancel = await call('POST', '/schedule', {
      item_id: 'I',
      uri: inContainer(join(work, 'h.wav')),
      at: Date.now() / 1000 + 60,
    });
    const duringH = engineStateSchema.parse(await (await call('GET', '/state')).json());
    check(
      cancel.status === 201 && duringH.on_air.item_id === 'H' && duringH.scheduled?.item_id === 'I',
      'the next hard start, posted while H plays, waits: H stays on air',
    );
    const cancelled = (await (await call('DELETE', '/schedule')).json()) as { cancelled: boolean };
    await sleep(8000);
    const hardEvents = engineEventBatchSchema
      .parse(await (await call('GET', `/events?after=${hardBefore}`)).json())
      .filter((e) => e.type === 'track.started');
    const hEvent = hardEvents.find((e) => e.data.item_id === 'H');
    check(
      JSON.stringify(hardEvents.map((e) => e.data.item_id)) === JSON.stringify(['G', 'H', 'K']) &&
        hEvent?.data.source === 'queue',
      `as-run: G, H as a log item, then K; G doesn't resume (got ${JSON.stringify(
        hardEvents.map((e) => [e.data.item_id, e.data.rid, (e.at - hAt).toFixed(2)]),
      )})`,
    );
    // The callback's time() lags the audio by tens of ms (ADR 0003): a loose bound here; the
    // gate's own accuracy was measured on the audio by the spike (≤ 1 ms).
    check(
      hEvent !== undefined && Math.abs(hEvent.at - hAt) < 0.3,
      `H reported on air at its time (${hEvent ? (hEvent.at - hAt).toFixed(3) : '?'} s)`,
    );
    check(
      cancelled.cancelled &&
        engineStateSchema.parse(await (await call('GET', '/state')).json()).scheduled === null,
      'DELETE /v1/schedule cancels it, and H played on',
    );

    docker(['stop', '-t', '10', name]);

    // Seam check, as in the splice test: the output from A's first sample against the ideal
    // splice of the same files.
    const output = mono(decode(join(work, 'output.wav')));
    const full = reference(plan, decode(mat.masters.a), decode(island), decode(mat.masters.b));
    const refLength =
      plan.aJoin - plan.aCueIn + plan.length - plan.handle + B_SECONDS * SAMPLE_RATE;
    const ref = mono(full).slice(0, refLength);
    writeWav(join(work, 'reference.wav'), {
      sampleRate: SAMPLE_RATE,
      channels: full.channels.map((c) => c.slice(0, refLength)),
    });
    // First loud sample, refined by cross-correlation: output[onset + n] ≈ ref[n].
    const rough = output.findIndex((v) => Math.abs(v) > 1e-3);
    const onset = findLag(output, ref, 0, 4096, 64, rough).lag;
    const y = output.slice(onset, onset + refLength + SAMPLE_RATE);
    const events2: SeamEvent[] = [
      ...trackAlignment(y, ref).events,
      ...detectDropouts(y.slice(0, refLength)),
    ];
    const reports = compareJoins(y, ref, joins(plan, 'butt'));
    events2.push(...joinEvents(reports, MAX_RESIDUAL_DB));
    for (const j of reports) {
      console.log(
        `     ${j.label}: shift ${j.shift}, residual ${j.residualDb.toFixed(1)} dB (floor ${j.baselineDb.toFixed(1)} dB)`,
      );
    }
    for (const e of events2.slice(0, 6)) console.log(`     ! ${e.kind} @${e.offset}: ${e.detail}`);
    check(events2.length === 0, 'island segment airs with no seam (FLAC, noise)');
    // B ends at its cue-out, give or take a frame: the end of a segment is a normal
    // crossfade boundary, which Liquidsoap 2.4 handles in whole frames (spike #12). We
    // measured 440 extra samples of B; anything up to one 20 ms frame is accepted.
    const frame = 0.02 * SAMPLE_RATE;
    let lastLoud = -1;
    for (let i = refLength; i < y.length; i++) if (Math.abs(y[i] ?? 0) > 1e-4) lastLoud = i;
    const overrun = lastLoud < 0 ? 0 : lastLoud + 1 - refLength;
    check(
      overrun <= frame && y.slice(refLength + frame).every((v) => Math.abs(v) < 1e-4),
      `B body stops at its cue-out (+${overrun} samples, ≤ one frame), then silence`,
    );

    // The fallback, at the end of the output: find F's onset (the 220 Hz tone), then measure.
    const win = Math.round(0.05 * SAMPLE_RATE);
    let fStart = -1;
    for (let i = output.length - win; i >= 0; i -= win) {
      // Above the noise of the earlier segments, below F ducked by 12 dB (0.075).
      if (amplitudeAt(output, 220, i, win) > 0.03) fStart = i;
      else if (fStart >= 0) break;
    }
    // F starts from silence: its first loud sample is its onset, to the sample.
    for (let i = Math.max(0, fStart - win); i < fStart + win; i++) {
      if (Math.abs(output[i] ?? 0) > 0.02) {
        fStart = i;
        break;
      }
    }
    const at = (seconds: number) => fStart + Math.round(seconds * SAMPLE_RATE);
    const span = Math.round(0.5 * SAMPLE_RATE);
    const music = (t: number) => amplitudeAt(output, 220, at(t), span);
    const voice = (t: number) => amplitudeAt(output, 1000, at(t), span);
    // The voice's onset: first 10 ms window past half its level.
    let vOnset = -1;
    const step = Math.round(0.005 * SAMPLE_RATE);
    for (let i = at(2); i < at(4.5); i += step) {
      if (amplitudeAt(output, 1000, i, 2 * step) > 0.1) {
        vOnset = (i - fStart) / SAMPLE_RATE;
        break;
      }
    }
    const duck = 20 * Math.log10(music(3.8) / music(1.2));
    console.log(
      `     fallback: voice at ${vOnset.toFixed(3)} s, voice ${voice(3.8).toFixed(3)}, duck ${duck.toFixed(1)} dB`,
    );
    check(fStart >= 0, 'fallback: F airs');
    check(
      // Degraded timing (ADR 0024): usually within a 40 ms frame, sometimes up to about 160 ms
      // late, when the item's metadata reaches the as-run callback late.
      Math.abs(vOnset - 3) <= 0.2,
      `fallback: the voice starts 3 s into F, within 200 ms (${vOnset.toFixed(3)} s)`,
    );
    check(
      voice(1.2) < 0.01 && Math.abs(voice(3.8) - 0.2) < 0.03 && voice(5.4) < 0.01,
      'fallback: the voice plays for its 2 s at its own gain, and only then',
    );
    check(Math.abs(duck + 12) <= 1.5, `fallback: music ducked by -12 dB (${duck.toFixed(1)} dB)`);
    check(
      Math.abs(20 * Math.log10(music(5.4) / music(1.2))) <= 1,
      'fallback: the music comes back to full level after the voice',
    );

    // The hard start in the audio: H's onset (660 Hz, from the end), G faded out under it
    // within its 1 s cut fade, and never back.
    let hStart = -1;
    for (let i = output.length - win; i >= 0; i -= win) {
      if (amplitudeAt(output, 660, i, win) > 0.1) hStart = i;
      else if (hStart >= 0) break;
    }
    const tAt = (seconds: number) => hStart + Math.round(seconds * SAMPLE_RATE);
    const g = (t: number) => amplitudeAt(output, 440, tAt(t), span);
    const h = (t: number) => amplitudeAt(output, 660, tAt(t), span);
    const k = (t: number) => amplitudeAt(output, 330, tAt(t), span);
    console.log(
      `     hard start: G ${g(-0.6).toFixed(3)} before, ${g(1.5).toFixed(3)} after; H ${h(1).toFixed(3)}`,
    );
    check(hStart >= 0 && g(-0.6) > 0.2, 'hard start: G on air until H');
    check(
      h(1) > 0.2 && h(3) > 0.2 && h(3.4) > 0.2,
      'hard start: H at full level from its start to its end',
    );
    check(g(1.5) < 0.01 && g(5) < 0.01, 'hard start: G faded out under H, and does not resume');
    console.log(
      `     K/G/H: ${[-2, 0, 2, 4, 4.5, 5, 6, 7, 8, 9].map((t) => `${t}:${k(t).toFixed(2)}/${g(t).toFixed(2)}/${h(t).toFixed(2)}`).join(' ')} len ${(output.length - hStart) / SAMPLE_RATE}`,
    );
    const kMax = Math.max(...[4.2, 4.6, 5, 5.4, 5.8, 6.2].map(k));
    check(kMax > 0.2, `hard start: K, queued after H, airs after it (${kMax.toFixed(3)})`);
  } finally {
    if (failures.length) console.log(docker(['logs', '--tail', '40', name], false));
    docker(['rm', '-f', name], false);
    if (!values.keep && !failures.length) rmSync(join(work, 'output.wav'), { force: true });
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall checks passed');
  if (failures.length) process.exit(1);
}

await main();
