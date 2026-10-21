// Dev seed audio: `pnpm dev:seed:audio` (reads the root .env if present), after `pnpm dev:seed`.
//
// The fixture assets of log-fixture.ts have titles and durations but no audio, so the audio
// route 404s and the timeline and VT previews fail. This synthesises a file for each fixture
// asset that has no playout copy, at the asset's duration, with ffmpeg (FFMPEG_PATH/FFPROBE_PATH
// or the PATH, as ingest; `apps/worker/test/bin` runs the worker image's):
//   - songs (and the episode): a chord of sine partials, each with its own tremolo and
//     stereo position, a different root and chord per title;
//   - VTs and jingles: a buzzy, vibrato'd voice-like tone with formants and syllables (jingles
//     higher, with a chime);
//   - the bed: a soft, low, slowly breathing pad.
// Each has a little silence at the head and tail, for autocue to find.
//
// The generated FLAC (48 kHz) is the master; the playout copy goes through ingest's own
// `transcodePlayout`, then both are registered (`putAssetFile`) and stored content-addressed
// like an ingest does. Loudness, autocue and peaks are then enqueued through their backfills
// (fixture assets have no upload, so no `asset.ingested`), with the triggers' idempotency keys:
// the running worker (`pnpm dev`) fills them in.
//
// Idempotent: assets whose playout copy is registered and in the bucket are skipped.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillAutocue } from '../../../apps/worker/src/jobs/autocue/backfill.ts';
import {
  audioStream,
  bitDepth,
  defaultTools,
  durationSamples,
  ffprobe,
  readFlacStreamInfo,
  run,
  type Tools,
  transcodePlayout,
  transcodeTimeoutMs,
} from '../../../apps/worker/src/jobs/ingest/ffmpeg.ts';
import { ensureObject, hashFile } from '../../../apps/worker/src/jobs/ingest/ingest.ts';
import { backfillLoudness } from '../../../apps/worker/src/jobs/loudness/backfill.ts';
import { backfillPeaks } from '../../../apps/worker/src/jobs/peaks/backfill.ts';
import {
  createDb,
  listAssetFiles,
  putAssetFile,
  resolveStationScope,
  type StationContext,
} from '../../../packages/db/src/index.ts';
import { connectQueue, createJobPublisher } from '../../../packages/queue/src/index.ts';
import {
  type Actor,
  type AssetType,
  PLAYOUT_FLAC_BLOCK_SIZE,
  PLAYOUT_SAMPLE_RATE,
} from '../../../packages/shared/src/index.ts';
import {
  contentKey,
  createS3Storage,
  loadStorageConfig,
  type Storage,
} from '../../../packages/storage/src/index.ts';
import { demo } from './index.ts';
import { FIXTURE_PREFIX } from './log-fixture.ts';

const actor: Actor = { type: 'system', name: 'dev-seed-audio' };

const MASTER_RATE = 48_000;
const HEAD_MS = 400;
const TAIL_MS = 800;

interface Fixture {
  id: string;
  type: AssetType;
  title: string;
  durationMs: number;
}

// --- Synthesis -----------------------------------------------------------------------------

/** Semitone offsets of the song roots from A2 (110 Hz), one per song, cycling. */
const ROOTS = [0, 5, 7, 3, 10, 2, 8, 0, 5, 9, 4, 7, 1, 6, 11, 3, 8, 2, 10, 5, 4];
/** Chord shapes in semitones above the root (major, minor, sus4, maj7, minor 7, add9). */
const CHORDS = [
  [0, 4, 7, 12],
  [0, 3, 7, 12],
  [0, 5, 7, 12],
  [0, 4, 7, 11],
  [0, 3, 7, 10],
  [0, 4, 7, 14],
];

const hz = (semitones: number, base = 110) => base * 2 ** (semitones / 12);
const fixed = (n: number) => n.toFixed(3);

/** Sine partials, each with a tremolo and a pan, mixed into `[<label>]`. */
function partials(
  parts: { freq: number; gain: number; rate: number; depth: number; pan: number }[],
  seconds: number,
  label = 'mix',
): string {
  const chains = parts.map(
    (p, i) =>
      `sine=f=${fixed(p.freq)}:r=${MASTER_RATE}:d=${fixed(seconds)},volume=${fixed(p.gain)},` +
      `tremolo=f=${fixed(p.rate)}:d=${fixed(p.depth)},` +
      `pan=stereo|c0=${fixed(1 - p.pan)}*c0|c1=${fixed(p.pan)}*c0[p${i}]`,
  );
  const inputs = parts.map((_, i) => `[p${i}]`).join('');
  return `${chains.join(';')};${inputs}amix=inputs=${parts.length}:normalize=0[${label}]`;
}

function song(index: number, seconds: number): string {
  const root = ROOTS[index % ROOTS.length] ?? 0;
  const chord = CHORDS[index % CHORDS.length] ?? [0, 4, 7, 12];
  const pulse = 1.5 + (index % 5) * 0.5; // tremolo rate of the top voice: the "tempo"
  return partials(
    [
      { freq: hz(root - 12), gain: 0.16, rate: pulse / 2, depth: 0.3, pan: 0.5 },
      ...chord.map((step, i) => ({
        freq: hz(root + step),
        gain: 0.11 - i * 0.015,
        rate: pulse * (1 + i * 0.37),
        depth: 0.35 + i * 0.1,
        pan: [0.3, 0.7, 0.45, 0.6][i] ?? 0.5,
      })),
    ],
    seconds,
  );
}

function bed(seconds: number): string {
  return `${partials(
    [55, 110, 164.81, 220, 277.18].map((freq, i) => ({
      freq,
      gain: [0.12, 0.1, 0.07, 0.05, 0.03][i] ?? 0.03,
      rate: 0.11 + i * 0.07,
      depth: 0.5,
      pan: [0.5, 0.35, 0.65, 0.4, 0.6][i] ?? 0.5,
    })),
    seconds,
    'pad',
  )};[pad]lowpass=f=900[mix]`;
}

/**
 * A voice-like tone: a harmonic buzz around `f0` with vibrato and intonation, cut into
 * syllables and words, shaped by vowel-ish formants.
 */
function voice(f0: number, seconds: number, label: string, seed: number): string {
  const phase = `(2*PI*${f0}*t+${fixed((f0 * 0.12) / 0.31)}*sin(2*PI*0.31*t+${seed})+0.8*sin(2*PI*5.5*t))`;
  const harmonics = [1, 0.7, 0.5, 0.35, 0.22, 0.14, 0.08]
    .map((g, i) => `${g}*sin(${i + 1}*${phase})`)
    .join('+');
  const syllables = `pow(max(0,sin(2*PI*${fixed(3.6 + (seed % 3) * 0.4)}*t)),0.7)`;
  const words = `gt(sin(2*PI*0.27*t+${seed})+0.45*sin(2*PI*0.71*t),-0.55)`;
  return (
    `aevalsrc=exprs='0.05*(${harmonics})*${syllables}*${words}':s=${MASTER_RATE}:d=${fixed(seconds)},` +
    'highpass=f=90,equalizer=f=650:t=q:w=2:g=9,equalizer=f=1150:t=q:w=2:g=7,' +
    `equalizer=f=2600:t=q:w=3:g=4,lowpass=f=4200,aformat=channel_layouts=stereo[${label}]`
  );
}

function jingle(index: number, seconds: number): string {
  const chime = [880, 1108.73, 1318.51].map(
    (freq, i) =>
      `sine=f=${freq}:r=${MASTER_RATE}:d=${fixed(seconds)},volume=${fixed(0.12 - i * 0.03)},` +
      `afade=t=out:st=${fixed(i * 0.15)}:d=1.6,adelay=${i * 150}:all=1,` +
      `atrim=end=${fixed(seconds)},aformat=channel_layouts=stereo[c${i}]`,
  );
  return (
    `${voice(190 + index * 15, Math.max(seconds - 0.9, 0.5), 'v0', index + 1)};` +
    '[v0]adelay=900:all=1[v];' +
    `${chime.join(';')};[v][c0][c1][c2]amix=inputs=4:normalize=0:duration=longest[mix]`
  );
}

/** Make-up gain per type: about -18 LUFS, the bed softer (-26). */
const GAIN_DB: Partial<Record<AssetType, number>> = { vt: 13, jingle: 11, bed: 18 };

/**
 * The asset's sound, as a `-filter_complex` graph ending in `[out]`: 48 kHz stereo, exactly
 * `durationMs` long, silent for the first `HEAD_MS` and the last `TAIL_MS`.
 */
export function synthGraph(asset: Fixture, index: number): string {
  const total = Math.round((asset.durationMs * MASTER_RATE) / 1000);
  const seconds = Math.max((asset.durationMs - HEAD_MS - TAIL_MS) / 1000, 0.5);
  const fadeIn = Math.min(asset.type === 'bed' ? 3 : 1.5, seconds / 4);
  const fadeOut = Math.min(asset.type === 'bed' ? 4 : 2.5, seconds / 4);
  let body: string;
  switch (asset.type) {
    case 'vt':
      body = voice(120 + index * 12, seconds, 'mix', index + 1);
      break;
    case 'jingle':
      body = jingle(index, seconds);
      break;
    case 'bed':
      body = bed(seconds);
      break;
    default:
      body = song(asset.type === 'episode' ? index + 20 : index, seconds);
  }
  return (
    `${body};[mix]aformat=sample_fmts=fltp:sample_rates=${MASTER_RATE}:channel_layouts=stereo,` +
    `volume=${GAIN_DB[asset.type] ?? 22}dB,` +
    `afade=t=in:d=${fixed(fadeIn)},afade=t=out:st=${fixed(seconds - fadeOut)}:d=${fixed(fadeOut)},` +
    `adelay=${HEAD_MS}:all=1,apad=whole_len=${total},atrim=end_sample=${total}[out]`
  );
}

async function synthesize(tools: Tools, asset: Fixture, index: number, output: string) {
  await run(
    tools.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-filter_complex',
      synthGraph(asset, index),
      '-map',
      '[out]',
      '-map_metadata',
      '-1',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-flags',
      '+bitexact',
      '-fflags',
      '+bitexact',
      output,
    ],
    { timeoutMs: transcodeTimeoutMs(asset.durationMs / 1000) },
  );
}

// --- Store and register, as ingest does ------------------------------------------------------

async function addAudio(
  deps: { db: ReturnType<typeof createDb>['db']; storage: Storage; tools: Tools },
  ctx: StationContext,
  asset: Fixture,
  index: number,
  work: string,
): Promise<void> {
  const masterPath = join(work, `${asset.id}.master.flac`);
  const playoutPath = join(work, `${asset.id}.playout.flac`);
  await synthesize(deps.tools, asset, index, masterPath);

  const probe = await ffprobe(deps.tools, masterPath);
  const stream = audioStream(probe);
  if (!stream?.sample_rate) throw new Error(`${asset.title}: generated master has no audio`);
  await transcodePlayout(deps.tools, masterPath, playoutPath, stream, {
    durationSeconds: asset.durationMs / 1000,
  });
  const info = await readFlacStreamInfo(playoutPath);
  if (
    info.minBlockSize !== PLAYOUT_FLAC_BLOCK_SIZE ||
    info.maxBlockSize !== PLAYOUT_FLAC_BLOCK_SIZE ||
    info.sampleRate !== PLAYOUT_SAMPLE_RATE
  ) {
    throw new Error(
      `playout encoding is ${info.minBlockSize}-${info.maxBlockSize} samples at ${info.sampleRate} Hz`,
    );
  }

  const master = await hashFile(masterPath);
  const playout = await hashFile(playoutPath);
  const orgId = ctx.scope.orgId;
  const masterKey = contentKey({ orgId, sha256: master.sha256, ext: 'flac' });
  const playoutKey = contentKey({ orgId, sha256: playout.sha256, ext: 'flac' });

  // Charge the keys, then make sure the objects are there (ingest's order).
  await deps.db.transaction(async (tx) => {
    await putAssetFile(tx, ctx, asset.id, {
      role: 'master',
      storageKey: masterKey,
      sha256: master.sha256,
      sizeBytes: master.sizeBytes,
      codec: stream.codec_name ?? 'flac',
      mimeType: 'audio/flac',
      sampleRate: stream.sample_rate,
      channels: stream.channels ?? null,
      bitDepth: bitDepth(stream),
      durationSamples: durationSamples(stream, probe),
    });
    await putAssetFile(tx, ctx, asset.id, {
      role: 'playout',
      storageKey: playoutKey,
      sha256: playout.sha256,
      sizeBytes: playout.sizeBytes,
      codec: 'flac',
      mimeType: 'audio/flac',
      sampleRate: info.sampleRate,
      channels: info.channels,
      bitDepth: info.bitsPerSample,
      durationSamples: info.totalSamples,
      flacBlockSize: info.minBlockSize,
    });
  });
  await ensureObject(deps.storage, masterKey, masterPath, master.sizeBytes, 'audio/flac');
  await ensureObject(deps.storage, playoutKey, playoutPath, playout.sizeBytes, 'audio/flac');
}

async function seedAudio(env = process.env): Promise<void> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  const rabbitUrl = env.RABBITMQ_URL || 'amqp://ondes:ondes@127.0.0.1:5672/ondes';
  const database = createDb(databaseUrl, { max: 2, applicationName: 'dev-seed-audio' });
  const storage = createS3Storage(loadStorageConfig(env));
  const tools = defaultTools(env);
  const db = database.db;
  const work = await mkdtemp(join(tmpdir(), 'ondes-seed-audio-'));
  try {
    const st = await db.query.station.findFirst({
      where: (t, { eq }) => eq(t.slug, demo.station.slug),
    });
    if (!st) throw new Error(`no station "${demo.station.slug}": run \`pnpm dev:seed\` first`);
    const scope = await resolveStationScope(db, st.orgId, st.id);
    const ctx: StationContext = { actor, scope };
    const assets = await db.query.asset.findMany({
      where: (t, { and, eq, like }) =>
        and(eq(t.stationId, scope.stationId), like(t.sourceFilename, `${FIXTURE_PREFIX}%`)),
      columns: { id: true, type: true, title: true, durationMs: true },
      orderBy: (t, { asc }) => [asc(t.type), asc(t.sourceFilename)],
    });

    const perType = new Map<string, number>();
    let added = 0;
    let skipped = 0;
    for (const a of assets) {
      const index = perType.get(a.type) ?? 0;
      perType.set(a.type, index + 1);
      const playout = (await listAssetFiles(db, scope, a.id)).find((f) => f.role === 'playout');
      if (playout && (await storage.head(playout.storageKey))) {
        skipped++;
        continue;
      }
      if (!a.durationMs) {
        console.warn(`dev:seed:audio: "${a.title}" has no duration, skipped`);
        continue;
      }
      const started = Date.now();
      await addAudio({ db, storage, tools }, ctx, { ...a, durationMs: a.durationMs }, index, work);
      added++;
      console.log(
        `dev:seed:audio: ${a.type} "${a.title}" (${(a.durationMs / 1000).toFixed(1)} s) ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );
    }

    // Analysis: the backfills enqueue whatever this station still lacks, with the same keys
    // as the `asset.ingested` triggers, so already measured or queued assets run nothing.
    const queue = await connectQueue(rabbitUrl, { connectionName: 'dev-seed-audio' });
    const jobs = createJobPublisher(queue.rabbit, queue.topology);
    const enqueued: Record<string, number> = {};
    try {
      const deps = { db, jobs };
      const options = { stationIds: [scope.stationId] };
      enqueued.loudness = (await backfillLoudness(deps, options))[scope.stationId] ?? 0;
      enqueued.autocue = (await backfillAutocue(deps, options))[scope.stationId] ?? 0;
      enqueued.peaks = (await backfillPeaks(deps, options))[scope.stationId] ?? 0;
    } finally {
      await jobs.close();
      await queue.close();
    }
    console.log(
      `dev:seed:audio: ${added} asset(s) given audio, ${skipped} already had it; enqueued ` +
        `loudness ${enqueued.loudness}, autocue ${enqueued.autocue}, peaks ${enqueued.peaks} ` +
        '(the worker of `pnpm dev` runs them).',
    );
  } finally {
    await rm(work, { recursive: true, force: true });
    await database.close();
  }
}

if (import.meta.main) await seedAudio();
