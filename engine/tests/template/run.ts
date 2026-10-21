// Station template runtime test (#27): runs the rendered template in the pinned Liquidsoap
// image, drives its control API like the adapter (#28) does, and checks that an island
// chain pushed as one segment airs with no seam (spike #12) and is reported per request.
//
//   node engine/tests/template/run.ts [--keep]
//
// Needs docker and ffmpeg. Runs its own container (own name, its control port published on
// a random 127.0.0.1 port), never the shared dev stack. Everything generated goes to
// engine/tests/template/.work/run. See README.md.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderStationScript } from '../../../apps/api/src/modules/engine/config/index.ts';
import {
  type EngineEvent,
  engineEventBatchSchema,
  engineHealthSchema,
  engineQueuedRequestSchema,
  engineStateSchema,
} from '../../../packages/shared/src/index.ts';
import { decode, mono, SAMPLE_RATE, writeWav } from '../splice/audio.ts';
import { FORMATS, makeMaterial } from '../splice/fixtures.ts';
import { cues, joins, liqSeconds, makePlan, reference, renderIsland } from '../splice/island.ts';
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

    // The island chain, pushed as one segment. Cue points come from the splice test's
    // renderer model: snapped to the FLAC block grid and biased by half a sample.
    const seg = await call('POST', '/segment', {
      segment_id: 'S1',
      // Straight into A from silence, so the output starts with A's first sample, and no
      // fade at the end of B.
      cross_in: 0,
      fade_in: 0,
      cross_out: 0,
      fade_out: 0,
      parts: [
        {
          item_id: 'A',
          uri: inContainer(join(work, 'a.flac')),
          cue_in: Number(cue.a.cueIn),
          cue_out: Number(cue.a.cueOut),
          amplify_db: plan.gainA,
          title: 'A body',
        },
        { item_id: 'VT', uri: inContainer(island), amplify_db: 0, title: 'island' },
        {
          item_id: 'B',
          uri: inContainer(join(work, 'b.flac')),
          cue_in: Number(cue.b.cueIn),
          cue_out: Number(liqSeconds(bCueOut, SAMPLE_RATE, true)),
          amplify_db: plan.gainB,
          title: 'B body',
        },
      ],
    });
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
  } finally {
    if (failures.length) console.log(docker(['logs', '--tail', '40', name], false));
    docker(['rm', '-f', name], false);
    if (!values.keep && !failures.length) rmSync(join(work, 'output.wav'), { force: true });
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall checks passed');
  if (failures.length) process.exit(1);
}

await main();
