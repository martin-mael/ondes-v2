// Control spike driver (#13). Plays the api's part against engine/templates/station.liq:
// pushes log items, skips, removes, gates live, receives as-run events, and checks every
// answer against the draft contract in packages/shared/src/contracts/engine.ts.
//
// Runs inside the spike compose project (see compose.yml and README.md). Exits 1 if a
// check fails. Prints a JSON report of measurements at the end.
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type EngineEvent,
  type EnginePushItem,
  engineErrorSchema,
  engineEventBatchSchema,
  engineHealthSchema,
  engineLiveAuthRequestSchema,
  engineQueuedRequestSchema,
  engineRemoveResultSchema,
  engineStateSchema,
} from '../../../packages/shared/src/contracts/engine.ts';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://engine:7000';
const EMERGENCY_URL = process.env.ENGINE_EMERGENCY_URL ?? 'http://engine-emergency:7000';
const BARE_URL = process.env.ENGINE_BARE_URL ?? 'http://engine-bare:7000';
const METRICS_URL = process.env.ENGINE_METRICS_URL ?? 'http://engine:9599/metrics';
const LIVE_URL = new URL(process.env.ENGINE_LIVE_URL ?? 'http://engine:8005/live');
const DJ_URL = process.env.DJ_URL ?? 'http://dj:7001';
const TOKEN = process.env.ENGINE_CONTROL_TOKEN ?? '';
const MEDIA = process.env.MEDIA_DIR ?? '/media';
// Must match dj.liq.
const LIVE_USER = 'dj1';
const LIVE_PASSWORD = 'secret';

// ---------------------------------------------------------------------------------------
// Report

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
const measurements: Record<string, unknown> = {};
const t0 = Date.now();

function log(msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
}

function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

// ---------------------------------------------------------------------------------------
// Fake adapter endpoints the engine calls: events and live auth.

type Received = { event: EngineEvent; receivedAt: number };
const received = new Map<number, Received>();
let duplicates = 0;
let invalidBatches = 0;
let failEvents = false;
let rejectedPosts = 0;
let liveAuthDelayMs = 0;
const liveAuthAttempts: Array<{ user: string; accepted: boolean }> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === 'POST' && req.url === '/events') {
    if (failEvents) {
      rejectedPosts++;
      res.writeHead(503).end();
      return;
    }
    const parsed = engineEventBatchSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      invalidBatches++;
      log(`invalid event batch: ${parsed.error.message} ${body}`);
      res.writeHead(400).end();
      return;
    }
    for (const event of parsed.data) {
      if (received.has(event.seq)) duplicates++;
      else received.set(event.seq, { event, receivedAt: Date.now() });
      log(`event #${event.seq} ${event.type} ${JSON.stringify(event.data)}`);
    }
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/live-auth') {
    const login = engineLiveAuthRequestSchema.parse(JSON.parse(body));
    if (liveAuthDelayMs) await sleep(liveAuthDelayMs);
    const accepted = login.user === LIVE_USER && login.password === LIVE_PASSWORD;
    liveAuthAttempts.push({ user: login.user, accepted });
    res.writeHead(accepted ? 200 : 403).end();
    return;
  }
  res.writeHead(404).end();
});

// ---------------------------------------------------------------------------------------
// Engine client

async function call(
  method: string,
  path: string,
  { body, base = ENGINE_URL, auth = true }: { body?: unknown; base?: string; auth?: boolean } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (auth && TOKEN && base === ENGINE_URL) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

async function state(base = ENGINE_URL) {
  const r = await call('GET', '/v1/state', { base });
  return engineStateSchema.parse(r.json);
}

async function push(item: EnginePushItem) {
  const r = await call('POST', '/v1/queue', { body: item });
  return { status: r.status, request: engineQueuedRequestSchema.safeParse(r.json) };
}

function events(): EngineEvent[] {
  return [...received.values()].map((r) => r.event).sort((a, b) => a.seq - b.seq);
}

async function waitForEvent(
  pred: (e: EngineEvent) => boolean,
  timeoutMs: number,
  afterSeq = 0,
): Promise<Received | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = [...received.values()]
      .filter((r) => r.event.seq > afterSeq && pred(r.event))
      .sort((a, b) => a.event.seq - b.event.seq)[0];
    if (hit) return hit;
    await sleep(50);
  }
  return undefined;
}

const lastSeq = () => Math.max(0, ...received.keys());

const started = (itemOrSource: string) => (e: EngineEvent) =>
  e.type === 'track.started' &&
  (e.data.item_id === itemOrSource || (e.data.item_id === null && e.data.source === itemOrSource));

// Output level sampler: GET /v1/state every 250 ms, tagged with what is on air.
const levels: Array<{ t: number; item: string | null; source: string; db: number }> = [];
let sampling = true;
async function sampleLevels() {
  while (sampling) {
    try {
      const s = await state();
      const db = s.output_db?.[0];
      if (db !== undefined && s.on_air.source) {
        levels.push({ t: Date.now(), item: s.on_air.item_id ?? null, source: s.on_air.source, db });
      }
    } catch {}
    await sleep(250);
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

/** Median level for an item, skipping the first and last `trim` ms (fades, crossfades). */
function itemLevel(item: string, trimMs = 2500): number | null {
  const xs = levels.filter((l) => l.item === item);
  if (xs.length === 0) return null;
  const from = (xs[0]?.t ?? 0) + trimMs;
  const to = (xs.at(-1)?.t ?? 0) - trimMs;
  return median(xs.filter((l) => l.t >= from && l.t <= to).map((l) => l.db));
}

// ---------------------------------------------------------------------------------------
// Live sources. The real DJ is the `dj` container (dj.liq: MP3 over the Icecast protocol),
// started and stopped over HTTP. A bad login only needs the request headers, so it's a
// raw PUT from here.

async function dj(action: 'start' | 'stop') {
  await fetch(`${DJ_URL}/${action}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
}

function badLogin(user: string, password: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(Number(LIVE_URL.port), LIVE_URL.hostname);
    let response = '';
    socket.on('data', (d) => {
      response += d.toString('latin1');
    });
    socket.on('error', () => resolve(response));
    socket.on('close', () => resolve(response));
    socket.on('connect', () => {
      const auth = Buffer.from(`${user}:${password}`).toString('base64');
      socket.write(
        `PUT ${LIVE_URL.pathname} HTTP/1.1\r\nHost: ${LIVE_URL.host}\r\n` +
          `Authorization: Basic ${auth}\r\nContent-Type: audio/mpeg\r\n\r\n`,
      );
    });
    setTimeout(() => socket.destroy(), 5000);
  });
}

// ---------------------------------------------------------------------------------------
// Scenarios

async function waitForEngine(base: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await call('GET', '/v1/health', { base, auth: false });
      if (r.status === 200) return engineHealthSchema.parse(r.json);
    } catch {}
    await sleep(500);
  }
  throw new Error(`engine at ${base} never became healthy`);
}

async function main() {
  await new Promise<void>((resolve) => server.listen(8080, resolve));
  log('driver listening on :8080');

  const health = await waitForEngine(ENGINE_URL);
  check('health answers without a token', true, health);
  measurements.version = health.version;

  // --- Transport and auth
  const noToken = await call('GET', '/v1/state', { auth: false });
  check('control API refuses a missing token', noToken.status === 401, noToken.status);
  const s0 = await state();
  check('state matches the contract', true);

  // --- Queue empty at boot: safety playlist
  const firstTrack = await waitForEvent(started('safety'), 15000);
  check('empty queue at boot plays the safety playlist', !!firstTrack, s0.on_air);
  const boot = await waitForEvent((e) => e.type === 'engine.started', 5000);
  check('engine.started is event #1', boot?.event.seq === 1, boot?.event);

  void sampleLevels();

  // --- Push validation
  const missing = await call('POST', '/v1/queue', {
    body: { item_id: 'missing', uri: `${MEDIA}/nope.wav` },
  });
  check(
    'push of a missing file is refused with 422',
    missing.status === 422 && engineErrorSchema.safeParse(missing.json).success,
    missing,
  );
  const invalid = await call('POST', '/v1/queue', { body: '{"uri": 1}' });
  check('push of an invalid body is refused with 400', invalid.status === 400, invalid);

  // --- Push the log: A (cued, -6 dB, butt splice into B), B (fades), C, D (to remove)
  const items: EnginePushItem[] = [
    {
      item_id: 'A',
      uri: `${MEDIA}/tone-a.wav`,
      cue_in: 2,
      cue_out: 12,
      amplify_db: -6,
      cross_out: 0,
      title: 'Say "hi", Lyon: a title with quotes, commas & colons',
      artist: 'Vandale',
    },
    { item_id: 'B', uri: `${MEDIA}/tone-b.wav`, cross_in: 0, fade_out: 2, title: 'B' },
    { item_id: 'C', uri: `${MEDIA}/tone-c.wav`, title: 'C' },
    { item_id: 'D', uri: `${MEDIA}/tone-d.wav`, title: 'D' },
  ];
  const seqBeforePush = lastSeq();
  const pushStart = Date.now();
  for (const item of items) {
    const r = await push(item);
    check(
      `push ${item.item_id} answers 201 with a request`,
      r.status === 201 && r.request.success,
      {
        status: r.status,
        request: r.request.data,
      },
    );
  }
  measurements.push_ms_per_item = (Date.now() - pushStart) / items.length;
  const afterPush = await state();
  measurements.queue_after_push = afterPush.queue.map((q) => `${q.item_id}:${q.status}`);
  check(
    'state lists the pushed items in order (A may already be on air)',
    ['A,B,C,D', 'B,C,D'].includes(afterPush.queue.map((q) => q.item_id).join()),
    measurements.queue_after_push,
  );

  // --- Remove by item id
  const rm = await call('DELETE', '/v1/queue/D');
  check(
    'remove D answers removed=1',
    rm.status === 200 && engineRemoveResultSchema.parse(rm.json).removed === 1,
    rm,
  );
  const rm404 = await call('DELETE', '/v1/queue/D');
  check('removing it again answers 404', rm404.status === 404, rm404.status);

  // --- A dry queue that gets refilled takes the air back at once (track_sensitive=false)
  const seqBeforeSkip = seqBeforePush;
  const aStarted = await waitForEvent(started('A'), 10000, seqBeforePush);
  measurements.push_to_on_air_ms = aStarted ? aStarted.receivedAt - pushStart : null;
  check(
    'pushing to a dry queue takes over from safety',
    !!aStarted,
    measurements.push_to_on_air_ms,
  );
  if (aStarted?.event.type === 'track.started') {
    check(
      'title with quotes/commas/colons survives annotate',
      aStarted.event.data.title === items[0]?.title,
      aStarted.event.data.title,
    );
  }
  const whilePlayingA = await state();
  measurements.queue_while_a_on_air = whilePlayingA.queue.map((q) => `${q.item_id}:${q.status}`);

  // --- As-run for A, B, C
  const bStarted = await waitForEvent(started('B'), 20000, seqBeforeSkip);
  const cStarted = await waitForEvent(started('C'), 25000, seqBeforeSkip);
  const aEnded = await waitForEvent(
    (e) => e.type === 'track.ended' && e.data.item_id === 'A',
    1000,
    seqBeforeSkip,
  );
  const aAir = aStarted && bStarted ? bStarted.event.at - aStarted.event.at : null;
  measurements.a_on_air_seconds = aAir;
  measurements.a_track_ended = aEnded?.event.data;
  check(
    'cue_in/cue_out honoured: A airs 10 s (2 to 12) with no crossfade',
    aAir !== null && Math.abs(aAir - 10) < 0.5,
    aAir,
  );
  const bAir = bStarted && cStarted ? cStarted.event.at - bStarted.event.at : null;
  measurements.b_on_air_seconds = bAir;
  check(
    'default crossfade (2 s) shortens B to about 12 s on air',
    bAir !== null && Math.abs(bAir - 12) < 1,
    bAir,
  );

  // --- Skip the last queued item: nothing left, so safety
  await sleep(3000);
  const skipAt = Date.now();
  const skip = await call('POST', '/v1/skip');
  const dry = await waitForEvent(started('safety'), 10000, cStarted?.event.seq ?? seqBeforeSkip);
  measurements.skip_to_track_started_ms = dry ? dry.receivedAt - skipAt : null;
  check(
    'skip on the last item falls back to the safety playlist',
    skip.status === 200 && !!dry,
    measurements.skip_to_track_started_ms,
  );

  const levelA = itemLevel('A');
  const levelB = itemLevel('B');
  measurements.level_db = { A: levelA, B: levelB, C: itemLevel('C') };
  check(
    'liq_amplify -6 dB honoured (A about 6 dB below B)',
    levelA !== null && levelB !== null && Math.abs(levelB - levelA - 6) < 1.5,
    measurements.level_db,
  );
  const bLevels = levels.filter((l) => l.item === 'B').map((l) => Math.round(l.db));
  measurements.b_levels_db = bLevels;

  // --- Blank detection: 12 s of silence, ENGINE_BLANK_MAX=4
  const seqBeforeBlank = lastSeq();
  await push({ item_id: 'SILENCE', uri: `${MEDIA}/silence.wav` });
  await push({ item_id: 'E', uri: `${MEDIA}/tone-e.wav` });
  const silenceOn = await waitForEvent(started('SILENCE'), 10000, seqBeforeBlank);
  const blank = await waitForEvent((e) => e.type === 'blank.detected', 12000, seqBeforeBlank);
  measurements.blank_detected_after_s =
    blank && silenceOn ? blank.event.at - silenceOn.event.at : null;
  check('blank.detect fires on a silent item', !!blank, measurements.blank_detected_after_s);
  const recovered = await waitForEvent((e) => e.type === 'blank.recovered', 15000, seqBeforeBlank);
  check('blank.recovered fires when sound comes back', !!recovered);
  const eStarted = await waitForEvent(started('E'), 5000, seqBeforeBlank);
  const dryAgain = await waitForEvent(started('safety'), 15000, eStarted?.event.seq ?? 0);
  check('queue running dry falls back to the safety playlist', !!dryAgain);

  // --- Live: wrong password, gate closed, gate open, disconnect
  const refused = await badLogin('dj2', 'wrong');
  check(
    'live auth webhook refuses a bad login',
    liveAuthAttempts.some((a) => a.user === 'dj2' && !a.accepted),
    { response: refused.split('\r\n')[0], attempts: liveAuthAttempts },
  );

  liveAuthDelayMs = 2000; // a slow webhook must not stall the audio
  const seqBeforeLive = lastSeq();
  const djAt = Date.now();
  await dj('start');
  const connected = await waitForEvent((e) => e.type === 'live.connected', 15000, seqBeforeLive);
  const headers = connected?.event.type === 'live.connected' ? connected.event.data.headers : [];
  check(
    'live.connected after a good login, without the Authorization header',
    !!connected && !headers.some(([k]) => k.toLowerCase() === 'authorization'),
    headers,
  );
  const during = levels.filter((l) => l.t >= djAt && l.t <= Date.now());
  const maxGap = Math.max(0, ...during.slice(1).map((l, i) => l.t - (during[i]?.t ?? l.t)));
  check(
    'a 2 s live-auth webhook does not stall the engine',
    during.length > 0 && maxGap < 1000 && during.every((l) => l.db > -60),
    { samples: during.length, max_gap_ms: maxGap },
  );
  let gated = await state();
  for (let i = 0; i < 40 && !gated.live.ready; i++) {
    await sleep(250);
    gated = await state();
  }
  measurements.live_connect_to_ready_ms = connected ? Date.now() - connected.receivedAt : null;
  check(
    'connected DJ stays off air while the gate is closed',
    gated.live.connected && gated.live.ready && gated.on_air.source !== 'live',
    { live: gated.live, on_air: gated.on_air.source },
  );
  const gateAt = Date.now();
  await call('POST', '/v1/live', { body: { enabled: true } });
  const liveOn = await waitForEvent(started('live'), 5000, seqBeforeLive);
  measurements.live_takeover_ms = liveOn ? liveOn.receivedAt - gateAt : null;
  check('opening the gate puts live on air at once', !!liveOn, measurements.live_takeover_ms);
  await sleep(3000);
  measurements.live_level_db = (await state()).output_db;

  // --- Event outage while live: Node answers 503 for 4 s, the engine must redeliver
  failEvents = true;
  const seqBeforeOutage = lastSeq();
  await call('POST', '/v1/live', { body: { enabled: false } }); // live.gate + track.started
  await sleep(4000);
  failEvents = false;
  const afterOutage = await waitForEvent((e) => e.type === 'live.gate', 8000, seqBeforeOutage);
  check('events are redelivered after a Node outage', !!afterOutage, { rejectedPosts });

  await call('POST', '/v1/live', { body: { enabled: true } });
  await sleep(1500);
  const seqBeforeDisconnect = lastSeq();
  await dj('stop');
  const disconnected = await waitForEvent(
    (e) => e.type === 'live.disconnected',
    10000,
    seqBeforeDisconnect,
  );
  const backToAuto = await waitForEvent(
    (e) => e.type === 'track.started' && e.data.source !== 'live',
    10000,
    seqBeforeDisconnect,
  );
  check('DJ disconnect hands back to automation', !!disconnected && !!backToAuto, {
    source: backToAuto?.event.type === 'track.started' ? backToAuto.event.data.source : null,
  });
  await call('POST', '/v1/live', { body: { enabled: false } });

  // --- Clear
  await push({ item_id: 'X1', uri: `${MEDIA}/tone-a.wav` });
  await push({ item_id: 'X2', uri: `${MEDIA}/tone-b.wav` });
  const clear = await call('DELETE', '/v1/queue');
  check(
    'clear empties the queue',
    clear.status === 200 && (await state()).queue.length === 0,
    clear,
  );

  // --- Event stream integrity and pull backfill
  await sleep(1500);
  const seqs = events().map((e) => e.seq);
  const gaps = seqs.filter((s, i) => i > 0 && s !== (seqs[i - 1] ?? 0) + 1);
  check('pushed events have no gaps', seqs[0] === 1 && gaps.length === 0, {
    count: seqs.length,
    gaps,
    duplicates,
    invalidBatches,
  });
  const pulled = engineEventBatchSchema.parse((await call('GET', '/v1/events?after=0')).json);
  check('GET /v1/events returns the same log', pulled.map((e) => e.seq).join() === seqs.join(), {
    pulled: pulled.length,
    pushed: seqs.length,
  });
  const latency = [...received.values()].map((r) => r.receivedAt - r.event.at * 1000);
  measurements.event_delivery_ms = {
    median: median(latency),
    max: Math.max(...latency),
  };

  // --- Emergency single() and mksafe, on the other two engines (pull only)
  await waitForEngine(EMERGENCY_URL);
  const em = await state(EMERGENCY_URL);
  check(
    'no safety files: emergency single() is on air',
    em.on_air.source === 'emergency',
    em.on_air,
  );
  await waitForEngine(BARE_URL);
  await sleep(4000);
  const bare = await state(BARE_URL);
  const bareEvents = engineEventBatchSchema.parse(
    (await call('GET', '/v1/events?after=0', { base: BARE_URL })).json,
  );
  check('nothing to play: mksafe keeps streaming silence and blank fires', bare.blank, {
    on_air: bare.on_air,
    events: bareEvents.map((e) => e.type),
  });

  // --- Prometheus
  const metrics = await (await fetch(METRICS_URL)).text();
  const names = [...new Set([...metrics.matchAll(/^([a-z_]+)[{ ]/gm)].map((m) => m[1]))];
  measurements.metric_names = names;
  check(
    'Prometheus exposes station gauges and latency metrics',
    names.includes('ondes_engine_queue_length') &&
      names.includes('ondes_engine_on_air_source') &&
      names.some((n) => n?.startsWith('liquidsoap_')),
    names,
  );

  sampling = false;
  server.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ measurements, failed: failed.map((c) => c.name) }, null, 2));
  log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
