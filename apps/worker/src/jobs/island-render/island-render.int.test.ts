import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createOrganization,
  createStation,
  island,
  markIslandFailed,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { JobPublisher } from '@ondes/queue';
import {
  type Actor,
  ISLAND_FORMAT,
  ISLAND_SPEC_VERSION,
  type IslandSpec,
  islandHash,
  islandStorageKey,
  type RealtimeEvent,
} from '@ondes/shared';
import { createS3Storage, loadStorageConfig, type Storage } from '@ondes/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTools, readFlacStreamInfo } from '../ingest/ffmpeg.ts';
import { decodeRange } from './codec.ts';
import {
  type IslandRenderDeps,
  MAX_RENDER_ATTEMPTS,
  renderIsland,
  retryDelayMs,
} from './render.ts';
import { sweepIslandRenders } from './sweep.ts';

// The island-render job end to end: playout copies in Garage, island rows in a throwaway
// database, ffmpeg from the PATH (the worker image's: apps/worker/test/bin, as CI does). The
// output is decoded and nulled against a reference mixed here from the decoded inputs with a
// gain written out independently of the shared gain model (`referenceGain`): every sample
// within ½ LSB (24-bit).

const exec = promisify(execFile);
const enabled = Boolean(process.env.S3_ENDPOINT);
if (!enabled) {
  if (process.env.CI) throw new Error('island-render tests need S3_ENDPOINT (Garage) in CI');
  console.warn('island-render tests skipped: S3_ENDPOINT is not set (pnpm dev:up, .env.example)');
}
const system: Actor = { type: 'system', name: 'test' };
const tools = defaultTools();
const SR = 44_100;

let dir: string;

/** A playout-like FLAC (44.1 kHz, 1024-sample blocks, 24-bit), one expression per channel. */
async function flac(name: string, exprs: string[], seconds: number): Promise<string> {
  const path = join(dir, `${name}.flac`);
  await exec(tools.ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${exprs.join('|')}:s=${SR}:d=${seconds}`,
    '-c:a',
    'flac',
    '-frame_size',
    '1024',
    '-sample_fmt',
    's32',
    '-bits_per_raw_sample',
    '24',
    path,
  ]);
  return path;
}

/**
 * The ADR 0017 gain, written out here without the shared code under test: 10^(dB/20) (0 at or
 * below −90 dB) times, per envelope, a straight-line interpolation in amplitude between the
 * two points around `at`, holding outside them.
 */
function referenceGain(
  source: { gainDb: number; envelopes: { at: number; gainDb: number }[][] },
  at: number,
): number {
  const amp = (db: number) => (db <= -90 ? 0 : 10 ** (db / 20));
  let g = amp(source.gainDb);
  for (const points of source.envelopes) {
    if (!points.length) continue;
    const first = points[0] as { at: number; gainDb: number };
    const last = points[points.length - 1] as { at: number; gainDb: number };
    if (at <= first.at) g *= amp(first.gainDb);
    else if (at >= last.at) g *= amp(last.gainDb);
    else {
      const i = points.findIndex((p) => p.at >= at);
      const a = points[i - 1] as { at: number; gainDb: number };
      const b = points[i] as { at: number; gainDb: number };
      const t = (at - a.at) / (b.at - a.at);
      g *= amp(a.gainDb) * (1 - t) + amp(b.gainDb) * t;
    }
  }
  return g;
}

describe.runIf(enabled)('island-render job', () => {
  let tdb: TestDatabase;
  let storage: Storage;
  let scope: StationScope;
  const events: RealtimeEvent[] = [];
  const cached: string[] = [];
  let deps: IslandRenderDeps;
  const media: Record<string, { path: string; sha256: string; key: string }> = {};
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ondes-island-test-'));
    tdb = await createTestDatabase();
    storage = createS3Storage(loadStorageConfig());
    const org = await createOrganization(tdb.db, system, {
      slug: `island-${randomUUID().slice(0, 8)}`,
      name: 'Org',
    });
    const st = await createStation(
      tdb.db,
      { actor: system, scope: await resolveOrgScope(tdb.db, org.id) },
      { slug: 'island-fm', name: 'FM', timezone: 'Europe/Paris' },
    );
    scope = await resolveStationScope(tdb.db, org.id, st.id);
    const sources = {
      // A: 12 s of noise-like tones, B: 8 s, VT: 3 s mono.
      a: await flac('a', ['0.3*sin(2*PI*440*t)+0.1*sin(2*PI*1301*t)', '0.3*sin(2*PI*443*t)'], 12),
      b: await flac('b', ['0.35*sin(2*PI*660*t)', '0.2*sin(2*PI*661*t)+0.1*sin(2*PI*97*t)'], 8),
      vt: await flac('vt', ['0.4*sin(2*PI*1000*t)*sin(2*PI*3*t)'], 3),
    };
    for (const [name, path] of Object.entries(sources)) {
      const bytes = await readFile(path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const key = `org/${org.id}/sha256/${sha256}.flac`;
      await storage.put(key, bytes, { contentType: 'audio/flac' });
      media[name] = { path, sha256, key };
    }
    deps = {
      db: tdb.db,
      storage,
      tools,
      publish: async (e) => {
        events.push(e);
      },
      cache: async (_scope, file) => {
        cached.push(file.sha256);
      },
    };
  }, 120_000);

  afterAll(async () => {
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A voice-track island over A's end into B, at a given VT gain (so each test has its own hash). */
  function vtSpec(vtGainDb: number): IslandSpec {
    const a = media.a as { sha256: string };
    const b = media.b as { sha256: string };
    const vt = media.vt as { sha256: string };
    const L = 5 * SR + 337;
    return {
      version: ISLAND_SPEC_VERSION,
      format: ISLAND_FORMAT,
      lengthSamples: L,
      sources: [
        {
          sha256: a.sha256,
          from: 7 * SR + 11,
          to: 12 * SR,
          at: 0,
          gainDb: -3.5,
          envelopes: [
            [
              { at: 441, gainDb: 0 },
              { at: 0.6 * SR, gainDb: -12 },
              { at: 3.5 * SR, gainDb: -12 },
              { at: 4.5 * SR, gainDb: -90 },
            ],
          ],
        },
        { sha256: vt.sha256, from: 0, to: 3 * SR, at: SR, gainDb: vtGainDb, envelopes: [] },
        {
          sha256: b.sha256,
          from: 0,
          to: 2 * SR + 337,
          at: 3 * SR,
          gainDb: -1.5,
          envelopes: [
            [
              { at: 3 * SR, gainDb: -90 },
              { at: 4 * SR, gainDb: 0 },
            ],
          ],
        },
      ].sort((x, y) => x.at - y.at),
    };
  }

  async function insertIsland(spec: IslandSpec, extra: Partial<typeof island.$inferInsert> = {}) {
    const files = Object.fromEntries(
      Object.values(media).map((m) => [m.sha256, { storageKey: m.key, assetId: randomUUID() }]),
    );
    const hash = islandHash(spec);
    const [row] = await tdb.db
      .insert(island)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        headItemId: randomUUID(),
        headAssetId: randomUUID(),
        headJoinSample: 7 * SR + 11,
        headHasBody: true,
        tailItemId: randomUUID(),
        tailAssetId: randomUUID(),
        tailJoinSample: 2 * SR + 337,
        tailHasBody: true,
        itemIds: [randomUUID(), randomUUID()],
        segueIds: [randomUUID()],
        specVersion: spec.version,
        spec,
        files,
        hash,
        lengthSamples: spec.lengthSamples,
        ...extra,
      })
      .returning();
    return row as typeof island.$inferSelect;
  }

  const payload = (hash: string) => ({ orgId: scope.orgId, stationId: scope.stationId, hash });
  const rowOf = async (id: string) =>
    (await tdb.db.query.island.findFirst({
      where: (t, { eq }) => eq(t.id, id),
    })) as typeof island.$inferSelect;

  it('renders, stores and records an island that nulls against the reference mix', async () => {
    const spec = vtSpec(++n);
    const row = await insertIsland(spec);
    events.length = 0;
    const outcome = await renderIsland(deps, payload(row.hash));
    expect(outcome.kind).toBe('rendered');
    if (outcome.kind !== 'rendered') return;
    console.log(`island render: ${spec.lengthSamples} samples in ${outcome.ms} ms`);

    const after = await rowOf(row.id);
    const key = islandStorageKey(scope.orgId, row.hash);
    expect(after).toMatchObject({
      status: 'ready',
      storageKey: key,
      fileSha256: outcome.file.sha256,
      fileSizeBytes: outcome.file.sizeBytes,
      error: null,
    });
    expect(events.map((e) => e.type === 'island.updated' && e.data.status)).toEqual([
      'rendering',
      'ready',
    ]);
    expect(cached).toContain(outcome.file.sha256);

    // The stored object: its hash, the playout format, and the mix.
    const out = join(dir, 'out.flac');
    const { body } = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    await writeFile(out, Buffer.concat(chunks));
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(
      outcome.file.sha256,
    );
    const info = await readFlacStreamInfo(out);
    expect(info).toMatchObject({
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
      maxBlockSize: 1024,
      totalSamples: spec.lengthSamples,
    });

    const rendered = await decodeRange(tools, out, {
      from: 0,
      to: spec.lengthSamples,
      channels: 2,
    });
    const ref = [new Float64Array(spec.lengthSamples), new Float64Array(spec.lengthSamples)];
    for (const s of spec.sources) {
      const m = Object.values(media).find((x) => x.sha256 === s.sha256) as { path: string };
      const info = await readFlacStreamInfo(m.path);
      const pcm = await decodeRange(tools, m.path, { ...s, channels: info.channels });
      for (let k = 0; k < s.to - s.from; k++) {
        const g = referenceGain(s, s.at + k);
        for (let c = 0; c < 2; c++) {
          const x = (pcm[c] ?? pcm[0]) as Float32Array;
          const r = ref[c] as Float64Array;
          r[s.at + k] = (r[s.at + k] as number) + (x[k] as number) * g;
        }
      }
    }
    let worst = 0;
    for (let c = 0; c < 2; c++) {
      for (let k = 0; k < spec.lengthSamples; k++) {
        const got = (rendered[c] as Float32Array)[k] as number;
        const want = (ref[c] as Float64Array)[k] as number;
        worst = Math.max(worst, Math.abs(got - want));
      }
    }
    // Within half an LSB of 24 bits (rounding), plus float slack.
    expect(worst).toBeLessThanOrEqual(2 ** -24 + 1e-9);
  });

  it('is idempotent: nothing to claim once ready, and a stored render is recorded unread', async () => {
    const spec = vtSpec(++n);
    const row = await insertIsland(spec);
    const first = await renderIsland(deps, payload(row.hash));
    expect(first.kind).toBe('rendered');
    expect(await renderIsland(deps, payload(row.hash))).toEqual({ kind: 'nothing' });

    // Another island with the same audio (same org, so the same key): recorded, not rendered.
    const twin = await insertIsland(spec, { headItemId: randomUUID() });
    await tdb.sql`update island set status = 'pending' where id = ${twin.id}`;
    const again = await renderIsland(deps, payload(row.hash));
    expect(again.kind).toBe('stored');
    if (first.kind === 'rendered' && again.kind === 'stored') {
      expect(again.file).toEqual(first.file);
    }
    expect((await rowOf(twin.id)).status).toBe('ready');
  });

  it('does nothing for a hash that no row has any more (the spec moved on)', async () => {
    const row = await insertIsland(vtSpec(++n));
    const moved = islandHash(vtSpec(++n));
    expect(await renderIsland(deps, payload(moved))).toEqual({ kind: 'nothing' });
    expect((await rowOf(row.id)).status).toBe('pending');
  });

  it('fails for good when a source is not the playout copy the spec pins', async () => {
    const spec = vtSpec(++n);
    const bogus = `org/${scope.orgId}/sha256/bogus-${randomUUID()}.flac`;
    await storage.put(bogus, await readFile(media.b?.path as string), {
      contentType: 'audio/flac',
    });
    const files = Object.fromEntries(
      Object.values(media).map((m) => [
        m.sha256,
        { storageKey: m === media.a ? bogus : m.key, assetId: randomUUID() },
      ]),
    );
    const row = await insertIsland(spec, { files });
    const outcome = await renderIsland(deps, payload(row.hash));
    expect(outcome.kind).toBe('failed');
    const after = await rowOf(row.id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/stored object hashes to/);
  });

  it('takes over a stale rendering claim, and the sweep finds it and old pending ones', async () => {
    const stale = await insertIsland(vtSpec(++n), { status: 'rendering' });
    const fresh = await insertIsland(vtSpec(++n), { status: 'rendering' });
    const old = await insertIsland(vtSpec(++n));
    await tdb.sql`update island set updated_at = now() - interval '1 hour' where id in ${tdb.sql([stale.id, old.id])}`;
    const enqueued: unknown[] = [];
    const jobs = {
      enqueue: async (_job: unknown, p: unknown) => {
        enqueued.push(p);
      },
    } as unknown as JobPublisher;
    const counts = await sweepIslandRenders({ db: tdb.db, jobs });
    expect(counts[scope.stationId]).toBe(2);
    expect(enqueued).toEqual(expect.arrayContaining([payload(stale.hash), payload(old.hash)]));
    expect(enqueued).not.toContainEqual(payload(fresh.hash));

    expect((await renderIsland(deps, payload(fresh.hash))).kind).toBe('nothing');
    expect((await renderIsland(deps, payload(stale.hash))).kind).toBe('rendered');
  });

  /** Files map with source `name` read from `storageKey` instead. */
  const filesWith = (name: string, storageKey: string) =>
    Object.fromEntries(
      Object.entries(media).map(([k, m]) => [
        m.sha256,
        { storageKey: k === name ? storageKey : m.key, assetId: randomUUID() },
      ]),
    );
  const sweepOnce = async () => {
    const enqueued: { hash: string }[] = [];
    const jobs = {
      enqueue: async (_job: unknown, p: { hash: string }) => {
        enqueued.push(p);
      },
    } as unknown as JobPublisher;
    await sweepIslandRenders({ db: tdb.db, jobs });
    return enqueued.map((p) => p.hash);
  };

  it('retries a transient failure: the queue first, then the sweep at retry_at, up to a cap', async () => {
    const missing = `org/${scope.orgId}/sha256/not-yet-${randomUUID()}.flac`;
    const row = await insertIsland(vtSpec(++n), { files: filesWith('vt', missing) });
    await expect(renderIsland(deps, payload(row.hash))).rejects.toThrow(/missing from storage/);
    let after = await rowOf(row.id);
    expect(after).toMatchObject({ status: 'failed', renderAttempts: 1, renderClaim: null });
    expect(after.retryAt?.getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 10_000);
    expect(await sweepOnce()).not.toContain(row.hash);

    // Its time comes; meanwhile the object landed.
    await tdb.sql`update island set retry_at = now() - interval '1 second' where id = ${row.id}`;
    expect(await sweepOnce()).toContain(row.hash);
    await tdb.sql`update island set files = ${JSON.stringify(filesWith('vt', (media.vt as { key: string }).key))}::jsonb where id = ${row.id}`;
    expect((await renderIsland(deps, payload(row.hash))).kind).toBe('rendered');
    after = await rowOf(row.id);
    expect(after).toMatchObject({ status: 'ready', retryAt: null });

    // Out of attempts: failed for good (until the spec changes).
    const capped = await insertIsland(vtSpec(++n), {
      files: filesWith('vt', missing),
      renderAttempts: MAX_RENDER_ATTEMPTS - 1,
    });
    await expect(renderIsland(deps, payload(capped.hash))).rejects.toThrow();
    expect(await rowOf(capped.id)).toMatchObject({
      status: 'failed',
      renderAttempts: MAX_RENDER_ATTEMPTS,
      retryAt: null,
    });
  });

  it('a retry of the claiming job carries on; another job leaves a live claim alone', async () => {
    const jobId = randomUUID();
    const row = await insertIsland(vtSpec(++n), { status: 'rendering', renderClaim: jobId });
    expect(await renderIsland(deps, payload(row.hash), { jobId: randomUUID() })).toEqual({
      kind: 'nothing',
    });
    // A job taken over (it looked dead) can't fail the live render.
    expect(
      await markIslandFailed(tdb.db, scope, { hash: row.hash, error: 'late', claim: randomUUID() }),
    ).toEqual([]);
    expect((await renderIsland(deps, payload(row.hash), { jobId })).kind).toBe('rendered');
  });

  it('never fails a render on a failed event publish', async () => {
    const row = await insertIsland(vtSpec(++n));
    const logs: Record<string, unknown>[] = [];
    const outcome = await renderIsland(
      {
        ...deps,
        publish: async () => {
          throw new Error('broker down');
        },
        log: (e) => logs.push(e),
      },
      payload(row.hash),
    );
    expect(outcome.kind).toBe('rendered');
    expect((await rowOf(row.id)).status).toBe('ready');
    expect(logs.filter((l) => l.msg === 'event publish failed')).toHaveLength(2);
  });

  it('renders again over a stored object that does not match its recorded hash', async () => {
    const spec = vtSpec(++n);
    const row = await insertIsland(spec);
    const key = islandStorageKey(scope.orgId, row.hash);
    await storage.put(key, Buffer.from('fLaC, truncated'), {
      contentType: 'audio/flac',
      metadata: { sha256: 'a'.repeat(64) },
    });
    const outcome = await renderIsland(deps, payload(row.hash));
    expect(outcome.kind).toBe('rendered');
    const head = await storage.head(key);
    if (outcome.kind === 'rendered') expect(head?.metadata?.sha256).toBe(outcome.file.sha256);
  });
});
