import { createHash } from 'node:crypto';
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
} from '@ondes/shared';
import { ObjectNotFoundError, type Storage } from '@ondes/storage';
import { z } from 'zod';
import { isFileError, readFlacStreamInfo, type Tools } from '../ingest/ffmpeg.ts';
import { decodeRange, encodeIsland } from './codec.ts';
import { mixIsland, type SourcePcm } from './mix.ts';

// Island render (#56, ADR 0017 and 0018): one job per spec hash and station.
//
// 1. Claim the hash's `pending`/`failed` rows (compare-and-set on the hash, `rendering`).
//    Nothing claimed: already rendered, or the spec moved on: done.
// 2. If the content-addressed key `islandStorageKey(org, hash)` already holds a render (a
//    retry, or another station of the org), record it. Otherwise:
// 3. download each source's playout copy (the exact file the engine plays, checked against
//    the spec's sha256), decode the sample ranges, mix (mix.ts: shared gain model, no
//    micro-crossfade), encode 24-bit FLAC with 1024-sample blocks;
// 4. upload it, place it in this worker's playout cache when it keeps one, mark the rows
//    `ready` with the file's own hash (each publishes `island.updated`).
//
// Failures: a source that doesn't match its hash, is missing from storage or doesn't decode
// is final (`failed`, not retried: a spec change renders it again). Anything else (S3,
// Postgres, a killed ffmpeg) marks the rows `failed` and throws, so the queue retries, and the
// retry claims the `failed` rows again.

export const ISLAND_RENDER_ACTOR = { type: 'system', name: 'island-render' } as const;

/** A `rendering` claim untouched this long belongs to a dead worker: taken over. */
export const STALE_RENDER_MS = 10 * 60 * 1000;

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
  run: { signal?: AbortSignal } = {},
): Promise<IslandRenderOutcome> {
  let scope: StationScope;
  try {
    scope = await resolveStationScope(deps.db, payload.orgId, payload.stationId);
  } catch (error) {
    if (error instanceof NotFoundError) return { kind: 'nothing' };
    throw error;
  }
  const rows = await claimIslandRender(deps.db, scope, payload.hash, deps.publish, {
    staleAfterMs: STALE_RENDER_MS,
  });
  const row = rows[0];
  if (!row) return { kind: 'nothing' };
  const started = performance.now();
  try {
    const key = islandStorageKey(scope.orgId, payload.hash, row.specVersion);
    const found = await findStored(deps.storage, key);
    if (found) {
      await finish(deps, scope, payload.hash, key, found);
      return { kind: 'stored', file: found };
    }
    const { file, clipped } = await render(deps, row, payload.hash, key, run.signal);
    await finish(deps, scope, payload.hash, key, file);
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
    await markIslandFailed(deps.db, scope, { hash: payload.hash, error: message }, deps.publish);
    if (error instanceof IslandInputError) {
      deps.log?.({ level: 'warn', msg: 'island render failed', hash: payload.hash, err: message });
      return { kind: 'failed', error: message };
    }
    throw error;
  }
}

async function finish(
  deps: IslandRenderDeps,
  scope: StationScope,
  hash: string,
  storageKey: string,
  file: IslandFile,
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
  await markIslandRendered(deps.db, scope, { hash, storageKey, file }, deps.publish);
}

/** Metadata on each island object, so a later run records it without reading it. */
const objectMetadataSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

async function findStored(storage: Storage, key: string): Promise<IslandFile | undefined> {
  const head = await storage.head(key);
  if (!head) return undefined;
  const parsed = objectMetadataSchema.safeParse(head.metadata);
  // Written without our metadata: render again and overwrite it.
  if (!parsed.success || head.size <= 0) return undefined;
  return { sha256: parsed.data.sha256, sizeBytes: head.size };
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
          throw new IslandInputError(`source ${sha256}: ${(error as Error).message}`);
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
  let body: Readable;
  try {
    body = (await storage.get(key)).body;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new IslandInputError(`source ${sha256} missing from storage (${key})`);
    }
    throw error;
  }
  const hash = createHash('sha256');
  await pipeline(
    body,
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    createWriteStream(path),
  );
  const actual = hash.digest('hex');
  if (actual !== sha256) {
    throw new IslandInputError(`source ${sha256}: stored object hashes to ${actual}`);
  }
}
