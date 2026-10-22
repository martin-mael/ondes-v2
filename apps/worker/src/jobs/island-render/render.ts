import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  claimIslandRender,
  type Db,
  type IslandRow,
  markIslandFailed,
  markIslandRendered,
  NotFoundError,
  type PublishEvent,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import {
  ISLAND_FORMAT,
  type IslandFile,
  type IslandRenderJobPayload,
  type IslandSpec,
  islandFilesSchema,
  islandHash,
  islandSpecSchema,
  islandStorageKey,
  mixIsland,
  type RealtimeEvent,
  type SourcePcm,
} from '@ondes/shared';
import { ObjectNotFoundError, type Storage } from '@ondes/storage';
import { isFileError, readFlacStreamInfo, type Tools } from '../ingest/ffmpeg.ts';
import { decodeRange, encodeIsland } from './codec.ts';

// Island render (#56, ADR 0017 and 0018): one job per spec hash and station.
//
// 1. Claim the hash's `pending`/`failed` rows (compare-and-set on the hash, `rendering`, held
//    by this job's id). Nothing claimed: already rendered, or the spec moved on: done. A retry
//    of this job re-claims the rows it already holds.
// 2. If the content-addressed key `islandStorageKey(org, hash)` already holds a render (a
//    retry, or another station of the org), verify it and record it. Otherwise:
// 3. download each source's playout copy (the exact file the engine plays, checked against
//    the spec's sha256), decode the sample ranges, mix (`mixIsland`: shared gain model, no
//    micro-crossfade), encode 24-bit FLAC with 1024-sample blocks;
// 4. upload it, place it in this worker's playout cache when it keeps one, mark the rows
//    `ready` with the file's own hash.
//
// Failures. Bad input (a source that isn't the file the spec pins, isn't a 44.1 kHz FLAC or
// doesn't decode; a spec that fails its schema or hash) is final: `failed`, not retried until
// the spec changes. Anything else (S3, Postgres, local I/O, a killed ffmpeg, a source not found
// yet) marks this job's rows `failed` with a `retry_at` and throws: the queue retries the job,
// and once its retries are spent the sweep picks the island up again at `retry_at` (backoff,
// up to {@link MAX_RENDER_ATTEMPTS} claims of the hash).
//
// Events (`island.updated`) are published after each state change commits, best-effort like
// every event here: a failed publish is logged and never fails the render (the state is in the
// database; `GET …/islands` and the sweep don't depend on the event).

/** A `rendering` claim untouched this long belongs to a dead worker: taken over. */
export const STALE_RENDER_MS = 10 * 60 * 1000;

/** Claims of one hash before a transient failure stops being retried by the sweep. */
export const MAX_RENDER_ATTEMPTS = 8;

/** Sweep backoff after the `attempts`-th claim failed: 1, 2, 4, … minutes, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 60) * 60 * 1000;
}

export interface IslandRenderDeps {
  db: Db;
  storage: Storage;
  tools: Tools;
  tmpDir?: string;
  publish?: PublishEvent;
  /** Places the rendered file in the station's playout cache (cache-sync's layout). */
  cache?: (scope: StationScope, file: IslandFile & { storageKey: string }) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * `rendered`: mixed and stored now; `stored`: the render was already in storage, recorded;
 * `nothing`: no row to claim; `failed`: a final input error, recorded on the rows.
 */
export type IslandRenderOutcome =
  | { kind: 'rendered'; file: IslandFile; ms: number; clipped: number }
  | { kind: 'stored'; file: IslandFile }
  | { kind: 'nothing' }
  | { kind: 'failed'; error: string };

/** A problem with the inputs themselves: retrying won't fix it. */
export class IslandInputError extends Error {
  override name = 'IslandInputError';
}

export async function renderIsland(
  deps: IslandRenderDeps,
  payload: IslandRenderJobPayload,
  run: { signal?: AbortSignal; jobId?: string } = {},
): Promise<IslandRenderOutcome> {
  let scope: StationScope;
  try {
    scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  } catch (error) {
    if (error instanceof NotFoundError) return { kind: 'nothing' };
    throw error;
  }
  const publish = safePublish(deps);
  // The job id is the same for every attempt of one enqueue: a retry finds its own claim.
  const claim = run.jobId ?? randomUUID();
  const rows = await claimIslandRender(deps.db, scope, payload.hash, publish, {
    staleAfterMs: STALE_RENDER_MS,
    claim,
  });
  const row = rows[0];
  if (!row) return { kind: 'nothing' };
  const attempts = Math.max(...rows.map((r) => r.renderAttempts));
  const started = performance.now();
  try {
    const key = islandStorageKey(scope.orgId, payload.hash, row.specVersion);
    const found = await findStored(deps.storage, key);
    if (found) {
      await finish(deps, scope, payload.hash, key, found, publish);
      return { kind: 'stored', file: found };
    }
    const { file, clipped } = await render(deps, row, payload.hash, key, run.signal);
    await finish(deps, scope, payload.hash, key, file, publish);
    const ms = Math.round(performance.now() - started);
    deps.log?.({
      level: clipped ? 'warn' : 'info',
      msg: 'island rendered',
      stationId: scope.stationId,
      hash: payload.hash,
      lengthSamples: row.lengthSamples,
      ms,
      clipped,
    });
    return { kind: 'rendered', file, ms, clipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = error instanceof IslandInputError;
    const retryAt =
      final || attempts >= MAX_RENDER_ATTEMPTS
        ? null
        : new Date(Date.now() + retryDelayMs(attempts));
    await markIslandFailed(
      deps.db,
      scope,
      { hash: payload.hash, error: message, claim, retryAt },
      publish,
    );
    deps.log?.({
      level: final ? 'warn' : 'error',
      msg: 'island render failed',
      hash: payload.hash,
      attempts,
      retryAt,
      err: message,
    });
    if (final) return { kind: 'failed', error: message };
    throw error;
  }
}

/** The deps' publisher, made best-effort: a failed publish is logged, never thrown. */
function safePublish(deps: IslandRenderDeps): PublishEvent | undefined {
  const publish = deps.publish;
  if (!publish) return undefined;
  return async (event: RealtimeEvent) => {
    try {
      await publish(event);
    } catch (error) {
      deps.log?.({
        level: 'error',
        msg: 'event publish failed',
        type: event.type,
        err: String(error),
      });
    }
  };
}

async function finish(
  deps: IslandRenderDeps,
  scope: StationScope,
  hash: string,
  storageKey: string,
  file: IslandFile,
  publish: PublishEvent | undefined,
) {
  // The cache is a head start for the engine, not a condition of `ready`: cache-sync and the
  // feeder's urgent fetch place it otherwise.
  if (deps.cache) {
    try {
      await deps.cache(scope, { ...file, storageKey });
    } catch (error) {
      deps.log?.({ level: 'warn', msg: 'island cache placement failed', hash, err: String(error) });
    }
  }
  await markIslandRendered(deps.db, scope, { hash, storageKey, file }, publish);
}

/**
 * A render already stored at `key` (a retry, or the same audio for another station of the
 * org): read back and hashed, so a truncated or foreign object is never recorded as the file.
 * Undefined when there is none or it doesn't check out: render again and overwrite it.
 */
async function findStored(storage: Storage, key: string): Promise<IslandFile | undefined> {
  const head = await storage.head(key);
  if (!head || head.size <= 0) return undefined;
  const claimed = head.metadata?.sha256;
  if (!claimed || !/^[0-9a-f]{64}$/.test(claimed)) return undefined;
  const { body } = await storage.get(key);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  if (size !== head.size || hash.digest('hex') !== claimed) return undefined;
  return { sha256: claimed, sizeBytes: size };
}

async function render(
  deps: IslandRenderDeps,
  row: IslandRow,
  hash: string,
  key: string,
  signal: AbortSignal | undefined,
): Promise<{ file: IslandFile; clipped: number }> {
  const spec = parseSpec(row, hash);
  const files = islandFilesSchema.parse(row.files);
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'ondes-island-'));
  try {
    // Each playout copy once, verified against the hash the spec pins.
    const paths = new Map<string, { path: string; channels: number }>();
    await Promise.all(
      [...new Set(spec.sources.map((s) => s.sha256))].map(async (sha256) => {
        const where = files[sha256];
        if (!where) throw new IslandInputError(`no file for source ${sha256}`);
        const path = join(work, `${sha256}.flac`);
        await download(deps.storage, where.storageKey, sha256, path);
        const info = await readFlacStreamInfo(path).catch((error: unknown) => {
          // Only a file that isn't FLAC is the input's fault; local I/O errors are retried.
          const message = error instanceof Error ? error.message : '';
          if (FLAC_FORMAT_ERRORS.some((re) => re.test(message))) {
            throw new IslandInputError(`source ${sha256}: ${message}`);
          }
          throw error;
        });
        if (info.sampleRate !== ISLAND_FORMAT.sampleRate || info.channels > 2) {
          throw new IslandInputError(
            `source ${sha256}: ${info.sampleRate} Hz, ${info.channels} channels`,
          );
        }
        paths.set(sha256, { path, channels: info.channels });
      }),
    );
    const pcm: SourcePcm[] = await Promise.all(
      spec.sources.map(async (s) => {
        const { path, channels } = paths.get(s.sha256) as { path: string; channels: number };
        try {
          return await decodeRange(deps.tools, path, { from: s.from, to: s.to, channels }, signal);
        } catch (error) {
          if (isFileError(error)) {
            throw new IslandInputError(`source ${s.sha256}: ${error.stderr || error.message}`);
          }
          throw error;
        }
      }),
    );
    const mix = mixIsland(spec, pcm);
    const output = join(work, 'island.flac');
    await encodeIsland(deps.tools, mix.samples, output, signal);
    const info = await readFlacStreamInfo(output);
    if (info.totalSamples !== spec.lengthSamples || info.maxBlockSize !== ISLAND_FORMAT.blockSize) {
      throw new Error(
        `encoded ${info.totalSamples} samples in ${info.maxBlockSize}-sample blocks, ` +
          `expected ${spec.lengthSamples} in ${ISLAND_FORMAT.blockSize}`,
      );
    }
    const bytes = await readFile(output);
    const file = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    };
    await deps.storage.put(key, bytes, {
      contentType: 'audio/flac',
      metadata: { sha256: file.sha256 },
    });
    return { file, clipped: mix.clipped };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Errors `parseFlacStreamInfo` throws for a file that isn't a FLAC stream: final. */
const FLAC_FORMAT_ERRORS = [/^not a FLAC stream$/, /^first FLAC metadata block is not STREAMINFO$/];

function parseSpec(row: IslandRow, hash: string): IslandSpec {
  const parsed = islandSpecSchema.safeParse(row.spec);
  if (!parsed.success)
    throw new IslandInputError(`unsupported island spec: ${parsed.error.message}`);
  // The row's hash is the spec's: a mismatch is a bug upstream, never render it under that key.
  if (islandHash(parsed.data) !== hash) throw new IslandInputError('spec does not match its hash');
  return parsed.data;
}

/** Downloads `key` to `path`, hashing it on the way: it must be the playout copy the spec pins. */
async function download(storage: Storage, key: string, sha256: string, path: string) {
  let object: { body: Readable; contentLength: number };
  try {
    object = await storage.get(key);
  } catch (error) {
    // Transient as far as we can tell (an ingest or a replication still landing): retried, then
    // swept with a backoff, and given up after the attempt cap.
    if (error instanceof ObjectNotFoundError) {
      throw new Error(`source ${sha256} missing from storage (${key})`);
    }
    throw error;
  }
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    object.body,
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    }),
    createWriteStream(path),
  );
  // A short read is the network's fault: retried. A whole object with another hash is not the
  // playout copy the spec pins: final.
  if (size !== object.contentLength) {
    throw new Error(`source ${sha256}: downloaded ${size} of ${object.contentLength} bytes`);
  }
  const actual = hash.digest('hex');
  if (actual !== sha256) {
    throw new IslandInputError(`source ${sha256}: stored object hashes to ${actual}`);
  }
}
