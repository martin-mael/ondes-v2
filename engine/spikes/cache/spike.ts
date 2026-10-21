// Playout cache spike (#15). Runs against the shared dev Garage (`pnpm dev:up`) under a
// random org id, plus throwaway Liquidsoap containers on the dev network for the engine
// side. Cleans up its objects at the end. See README.md.
//
//   node --env-file=.env engine/spikes/cache/spike.ts [--keep] [--work <dir>]
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { type AddressInfo, connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  contentKey,
  createS3Storage,
  loadStorageConfig,
  orgPrefix,
} from '../../../packages/storage/src/index.ts';
import {
  ChecksumMismatchError,
  enginePath,
  fetchToCache,
  listPartials,
  playoutRelPath,
  scanCache,
  Throttle,
} from './layout.ts';
import { cacheAlerts, HOUR, type HorizonItem, plan, readiness } from './planner.ts';
import { syncOnce } from './sync.ts';

const here = dirname(fileURLToPath(import.meta.url));
const LIQ_IMAGE = 'savonet/liquidsoap:v2.4.6';
const DEV_NETWORK = 'ondes-dev_default';
const MB = 1024 * 1024;
const HTTPS_FLAC =
  'https://raw.githubusercontent.com/ietf-wg-cellar/flac-test-files/main/subset/01%20-%20blocksize%204096.flac';
const HTTPS_REDIRECT_FLAC =
  'https://github.com/ietf-wg-cellar/flac-test-files/raw/main/subset/01%20-%20blocksize%204096.flac';

const { values: args } = parseArgs({
  options: { keep: { type: 'boolean' }, work: { type: 'string' } },
});

let failures = 0;
const results: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const log = (msg: string) => console.log(`   ${msg}`);
const mb = (b: number) => `${(b / MB).toFixed(1)} MB`;

// --- fixtures -------------------------------------------------------------------------
type Fixture = {
  name: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
};

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

/** FLAC 24-bit, 1024-sample frames like the playout copies (spike #12). Pink noise + tone. */
async function makeFixture(
  dir: string,
  name: string,
  seconds: number,
  freq: number,
): Promise<Fixture> {
  const file = join(dir, `${name}.flac`);
  if (!existsSync(file)) {
    await promisify(execFile)('ffmpeg', [
      ...['-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.25:d=${seconds}:seed=${freq}`],
      ...['-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}`],
      ...['-filter_complex', '[0][1]amix=inputs=2,aformat=channel_layouts=stereo'],
      ...['-ar', '44100', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'],
      ...['-frame_size', '1024', file],
    ]);
  }
  const st = await stat(file);
  return {
    name,
    file,
    sha256: await sha256File(file),
    sizeBytes: st.size,
    durationMs: seconds * 1000,
  };
}

// --- main -----------------------------------------------------------------------------
const storage = createS3Storage(loadStorageConfig());
const inner = createS3Storage({ ...loadStorageConfig(), endpoint: 'http://garage:3900' });
const orgId = `spike-cache-${randomBytes(4).toString('hex')}`;
const work = args.work ? resolve(args.work) : await mkdtemp(join(tmpdir(), 'ondes-cache-spike-'));
const fixturesDir = join(work, 'fixtures');
await mkdir(fixturesDir, { recursive: true });
console.log(`org ${orgId}, work dir ${work}`);

try {
  // 1. Fixtures and upload ----------------------------------------------------------------
  const t0 = performance.now();
  const specs: Array<[string, number]> = [];
  for (let i = 0; i < 20; i++) specs.push([`t${i}`, 120 + ((i * 37) % 121)]);
  for (let i = 0; i < 5; i++) specs.push([`e${i}`, 150 + i * 20]);
  specs.push(['show', 1800]);
  const fx = new Map<string, Fixture>();
  await Promise.all(
    specs.map(async ([name, secs], i) =>
      fx.set(name, await makeFixture(fixturesDir, name, secs, 110 + i * 23)),
    ),
  );
  const f = (n: string) => fx.get(n) as Fixture;
  const nameOf = (sha: string) =>
    [...fx.values()].find((x) => x.sha256 === sha)?.name ?? sha.slice(0, 8);
  const tracks = Array.from({ length: 20 }, (_, i) => f(`t${i}`));
  const extras = Array.from({ length: 5 }, (_, i) => f(`e${i}`));
  const show = f('show');
  await Promise.all(
    [...fx.values()].map(async (x) => {
      await storage.put(
        contentKey({ orgId, sha256: x.sha256, ext: 'flac' }),
        await readFile(x.file),
        {
          contentType: 'audio/flac',
        },
      );
    }),
  );
  // A corrupt object (key says one hash, bytes are another file) and a missing one.
  const corruptSha = randomBytes(32).toString('hex');
  const missingSha = randomBytes(32).toString('hex');
  await storage.put(
    contentKey({ orgId, sha256: corruptSha, ext: 'flac' }),
    await readFile(f('t0').file),
  );
  const totalBytes = [...fx.values()].reduce((s, x) => s + x.sizeBytes, 0);
  log(
    `${fx.size} fixtures, ${mb(totalBytes)} (${mb(show.sizeBytes)} for a 30 min show) uploaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
  results.fixtures = { files: fx.size, bytes: totalBytes, showBytes: show.sizeBytes };

  // 2. A 48 h log: tracks back to back, a show at +2 h, +26 h (and +50 h on day 2). T0–T4 retire after 24 h.
  const now = Date.now();
  function buildLog(start: number, end: number, pool: (at: number) => Fixture[]): HorizonItem[] {
    const out: HorizonItem[] = [];
    let at = start;
    let n = 0;
    const shows = [now + 2 * HOUR, now + 26 * HOUR, now + 50 * HOUR].filter((t) => t >= start);
    while (at < end) {
      let x: Fixture;
      if (shows[0] !== undefined && at >= shows[0]) {
        shows.shift();
        x = show;
      } else {
        const p = pool(at);
        x = p[n++ % p.length] as Fixture;
      }
      out.push({
        itemId: `i${at}`,
        sha256: x.sha256,
        ext: 'flac',
        sizeBytes: x.sizeBytes,
        airAt: at,
        durationMs: x.durationMs,
      });
      at += x.durationMs;
    }
    return out;
  }
  const day1Pool = (at: number) => (at - now < 24 * HOUR ? tracks : tracks.slice(5));
  const log1 = buildLog(now, now + 48 * HOUR, day1Pool);
  // Corrupt object at +30 min, missing object at +3 h (replacing whatever was planned).
  const corruptItem = log1.find((i) => i.airAt >= now + 30 * 60_000) as HorizonItem;
  Object.assign(corruptItem, { sha256: corruptSha, sizeBytes: f('t0').sizeBytes });
  const missingItem = log1.find((i) => i.airAt >= now + 3 * HOUR) as HorizonItem;
  Object.assign(missingItem, { sha256: missingSha, sizeBytes: 1000 });
  const p1 = plan({ now, items: log1, cached: [], budgetBytes: 10 * 1024 * MB });
  log(
    `log: ${log1.length} items, ${p1.fetch.length} distinct files, ${mb(p1.usage.horizonBytes)} in the 48 h horizon`,
  );
  results.log = { items: log1.length, files: p1.fetch.length, horizonBytes: p1.usage.horizonBytes };

  const cacheRoot = (name: string) => join(work, 'cache', name);
  const opts = (root: string, extra: Partial<Parameters<typeof syncOnce>[0]> = {}) => ({
    storage,
    orgId,
    root,
    budgetBytes: 10 * 1024 * MB,
    concurrency: 4,
    ...extra,
  });

  // 3. Readiness on a cold cache --------------------------------------------------------
  const r0 = readiness(log1, () => false, now);
  check('cold cache readiness is 0 %', r0.pctItems === 0 && r0.pctAirTime === 0);

  // 4. Cold sync at several concurrencies, with an atomicity watcher on the final paths ----
  const expected = new Map(
    [...fx.values()].map((x) => [playoutRelPath({ sha256: x.sha256, ext: 'flac' }), x.sizeBytes]),
  );
  const cold: Array<{ concurrency: number; s: number; mbps: number }> = [];
  let firstRoot = '';
  for (const concurrency of [1, 2, 4, 8]) {
    const root = cacheRoot(`cold-${concurrency}`);
    await rm(root, { recursive: true, force: true });
    let watching = true;
    let observed = 0;
    let partialSeen = 0;
    const watcher = (async () => {
      while (watching) {
        for (const file of await scanCache(root)) {
          observed++;
          const rel = playoutRelPath(file);
          if (expected.get(rel) !== file.sizeBytes) partialSeen++;
        }
        await sleep(2);
      }
    })();
    const rep = await syncOnce(opts(root, { concurrency }), log1, now);
    watching = false;
    await watcher;
    const s = rep.ms / 1000;
    cold.push({ concurrency, s, mbps: rep.bytes / MB / s });
    log(
      `concurrency ${concurrency}: ${rep.fetched.length} files, ${mb(rep.bytes)} in ${s.toFixed(1)} s (${(rep.bytes / MB / s).toFixed(0)} MB/s), ${rep.failed.length} failed`,
    );
    check(
      `concurrency ${concurrency}: watcher never saw a partial file under media/`,
      partialSeen === 0,
      `${observed} observations`,
    );
    if (concurrency === 4) {
      firstRoot = root;
      const corrupt = rep.failed.find((x) => x.sha256 === corruptSha);
      const missing = rep.failed.find((x) => x.sha256 === missingSha);
      check(
        'corrupt object is rejected (sha256 mismatch)',
        !!corrupt && /mismatch/.test(corrupt.error),
        corrupt?.error.slice(0, 60),
      );
      check('missing object is reported as source missing', !!missing?.sourceMissing);
      check(
        'nothing left behind for failed downloads',
        !existsSync(join(root, playoutRelPath({ sha256: corruptSha, ext: 'flac' }))) &&
          (await listPartials(root)).length === 0,
      );
      let ok = true;
      for (const file of await scanCache(root)) {
        if ((await sha256File(join(root, playoutRelPath(file)))) !== file.sha256) ok = false;
        if (((await stat(join(root, playoutRelPath(file)))).mode & 0o777) !== 0o444) ok = false;
      }
      check('every cached file re-hashes to its name and is 0444', ok);
      const cachedSet = new Set((await scanCache(root)).map((c) => c.sha256));
      const r1 = readiness(log1, (h) => cachedSet.has(h), now);
      results.readinessAfterSync = { pctItems: r1.pctItems, pctAirTime: r1.pctAirTime };
      log(
        `readiness after sync: ${r1.pctItems.toFixed(2)} % of items, ${r1.pctAirTime.toFixed(2)} % of air time`,
      );
      const alerts = cacheAlerts(log1, (h) => cachedSet.has(h), now, rep.plan);
      check(
        'corrupt item at +30 min raises cache.item_missing (critical)',
        alerts.some((a) => a.type === 'cache.item_missing' && a.itemId === corruptItem.itemId),
      );
      check(
        'missing item at +3 h raises cache.horizon_degraded (warning)',
        alerts.some((a) => a.type === 'cache.horizon_degraded'),
      );
      results.alerts = alerts;
    }
  }
  results.cold = cold;

  // 5. Restart: a new run on a full cache downloads nothing ------------------------------
  const again = await syncOnce(opts(firstRoot), log1, now);
  check(
    'restart: second sync downloads nothing',
    again.bytes === 0 && again.fetched.length === 0,
    `${again.failed.length} known failures retried`,
  );
  results.resyncMs = again.ms;

  // 6. Priority under a bandwidth cap: the next hour is ready first ----------------------
  {
    const root = cacheRoot('throttled');
    await rm(root, { recursive: true, force: true });
    const bytesPerSec = 40 * MB;
    const rep = await syncOnce(opts(root, { concurrency: 4, bytesPerSec }), log1, now);
    const readyBy = (h: number) => {
      const inWin = rep.fetched.filter((x) => x.firstAirAt < now + h);
      return inWin.length ? Math.max(...inWin.map((x) => x.readyAt)) / 1000 : 0;
    };
    const t1h = readyBy(HOUR);
    const t6h = readyBy(6 * HOUR);
    const tAll = rep.ms / 1000;
    log(
      `40 MB/s cap: next hour ready after ${t1h.toFixed(1)} s, 6 h after ${t6h.toFixed(1)} s, 48 h after ${tAll.toFixed(1)} s (${(rep.bytes / MB / tAll).toFixed(1)} MB/s)`,
    );
    // Completion order follows air time (4 parallel downloads allow some overlap).
    const order = [...rep.fetched].sort((a, b) => a.readyAt - b.readyAt);
    let inversions = 0;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        if (
          (order[i] as { firstAirAt: number }).firstAirAt >
          (order[j] as { firstAirAt: number }).firstAirAt + HOUR
        )
          inversions++;
      }
    }
    // The test library is small (20 tracks), so the first hour already needs most of it. What
    // matters is that the next hour is ready as soon as its own bytes can arrive.
    const bytes1h = rep.fetched
      .filter((x) => x.firstAirAt < now + HOUR)
      .reduce((s, x) => s + x.sizeBytes, 0);
    const ideal1h = bytes1h / bytesPerSec;
    check(
      'throttled: next hour ready as soon as its bytes can arrive',
      t1h <= ideal1h * 1.15 + 1,
      `${t1h.toFixed(1)} s for ${mb(bytes1h)}, ideal ${ideal1h.toFixed(1)} s`,
    );
    check(
      'throttled: no file completes after one airing more than 1 h later',
      inversions === 0,
      `${inversions} inversions`,
    );
    results.throttled = { bytesPerSec, nextHourS: t1h, sixHoursS: t6h, allS: tAll };
  }

  // 7. Interrupted download resumes with a Range request ---------------------------------
  {
    const root = cacheRoot('resume');
    await rm(root, { recursive: true, force: true });
    const key = contentKey({ orgId, sha256: show.sha256, ext: 'flac' });
    const ac = new AbortController();
    let aborted = false;
    try {
      await fetchToCache(
        storage,
        root,
        key,
        { sha256: show.sha256, ext: 'flac', sizeBytes: show.sizeBytes },
        {
          signal: ac.signal,
          onProgress: (b) => {
            if (b > show.sizeBytes * 0.4 && !ac.signal.aborted) ac.abort();
          },
        },
      );
    } catch {
      aborted = true;
    }
    const final = join(root, playoutRelPath({ sha256: show.sha256, ext: 'flac' }));
    const parts = await listPartials(root);
    const partSize = parts[0] ? (await stat(join(root, '.partial', parts[0]))).size : 0;
    check(
      'aborted download: no final file, partial kept',
      aborted && !existsSync(final) && partSize > 0,
      `${mb(partSize)} on disk`,
    );
    const r = await fetchToCache(storage, root, key, {
      sha256: show.sha256,
      ext: 'flac',
      sizeBytes: show.sizeBytes,
    });
    check(
      'resume: Range request completes and verifies',
      r.resumedFrom === partSize && r.bytes === show.sizeBytes - partSize && existsSync(final),
      `resumed from ${mb(r.resumedFrom)}`,
    );
    // A wrong hash on resume (simulate a changed object) is caught too.
    await rm(final, { force: true });
    let mismatch = false;
    try {
      await fetchToCache(storage, root, contentKey({ orgId, sha256: corruptSha, ext: 'flac' }), {
        sha256: corruptSha,
        ext: 'flac',
        sizeBytes: f('t0').sizeBytes,
      });
    } catch (e) {
      mismatch = e instanceof ChecksumMismatchError;
    }
    check(
      'mismatch throws ChecksumMismatchError and removes the partial',
      mismatch && (await listPartials(root)).length === 0,
    );
  }

  // 8. Eviction: day 2, budget fits the horizon plus ~2 tracks -------------------------
  {
    const root = cacheRoot('evict');
    await rm(root, { recursive: true, force: true });
    const clean = log1.filter((i) => i !== corruptItem && i !== missingItem);
    await syncOnce(opts(root), clean, now);
    const now2 = now + 24 * HOUR;
    const day2Pool = () => [...tracks.slice(5), ...extras];
    const log2 = [
      ...clean.filter((i) => i.airAt >= now2),
      ...buildLog(now + 48 * HOUR, now + 72 * HOUR, day2Pool),
    ];
    const need = plan({ now: now2, items: log2, cached: [], budgetBytes: Number.MAX_SAFE_INTEGER });
    const avg = tracks.reduce((s, x) => s + x.sizeBytes, 0) / tracks.length;
    const budgetBytes = Math.ceil(need.usage.horizonBytes + 2 * avg);
    const rep = await syncOnce(opts(root, { budgetBytes }), log2, now2);
    const retired = new Set(tracks.slice(0, 5).map((x) => x.sha256));
    const inHorizon = new Set(log2.map((i) => i.sha256));
    const evictedRetired = rep.evicted.every(
      (e) => retired.has(e.sha256) && !inHorizon.has(e.sha256),
    );
    const lruOrder = rep.evicted.every(
      (e, i, a) => i === 0 || (a[i - 1] as { lastNeededAt: number }).lastNeededAt <= e.lastNeededAt,
    );
    const after = await scanCache(root);
    const used = after.reduce((s, c) => s + c.sizeBytes, 0);
    check(
      'eviction: only files outside the horizon are evicted, LRU first',
      rep.evicted.length > 0 && evictedRetired && lruOrder,
      `${rep.evicted.length} of 5 retired tracks evicted, ${5 - rep.evicted.length} kept warm`,
    );
    log(
      `evicted: ${rep.evicted.map((e) => `${nameOf(e.sha256)}${inHorizon.has(e.sha256) ? ' (IN HORIZON)' : ''}`).join(', ')}`,
    );
    check(
      'eviction: new day-2 files fetched, usage within budget',
      rep.fetched.length === extras.length && used <= budgetBytes,
      `${mb(used)} / ${mb(budgetBytes)}`,
    );
    check(
      'eviction: everything in the horizon is on disk',
      readiness(log2, (h) => after.some((c) => c.sha256 === h), now2).pctItems === 100,
    );
    results.eviction = { budgetBytes, used, evicted: rep.evicted.length };
  }

  // 9. Budget smaller than the horizon -------------------------------------------------
  {
    const root = cacheRoot('budget');
    await rm(root, { recursive: true, force: true });
    const clean = log1.filter((i) => i !== corruptItem && i !== missingItem);
    const horizon = plan({ now, items: clean, cached: [], budgetBytes: Number.MAX_SAFE_INTEGER })
      .usage.horizonBytes;
    const budgetBytes = Math.floor(horizon * 0.6);
    const rep = await syncOnce(opts(root, { budgetBytes }), clean, now);
    const lastFetched = Math.max(...rep.fetched.map((x) => x.firstAirAt));
    const firstDeferred = Math.min(...rep.plan.deferred.map((x) => x.firstAirAt));
    const set = new Set((await scanCache(root)).map((c) => c.sha256));
    const r = readiness(clean, (h) => set.has(h), now);
    const alerts = cacheAlerts(clean, (h) => set.has(h), now, rep.plan);
    log(
      `budget 60 % of horizon: ${rep.fetched.length} fetched, ${rep.plan.deferred.length} deferred; ready until +${(((r.firstMissingAt ?? now) - now) / HOUR).toFixed(2)} h (${r.pctAirTime.toFixed(1)} % of air time)`,
    );
    check(
      'over budget: the earliest files are fetched, later ones deferred',
      rep.plan.deferred.length > 0 && lastFetched < firstDeferred,
    );
    check(
      'over budget: cache.budget_exceeded raised',
      alerts.some((a) => a.type === 'cache.budget_exceeded'),
    );
    results.overBudget = {
      budgetBytes,
      horizonBytes: horizon,
      readyUntilH: ((r.firstMissingAt ?? now) - now) / HOUR,
      pctAirTime: r.pctAirTime,
    };
  }

  // 9b. Recently aired files stay pinned for 1 h, and are never fetched -----------------
  {
    const mk = (id: string, sha: string, airAt: number): HorizonItem => ({
      itemId: id,
      sha256: sha,
      ext: 'flac',
      sizeBytes: 100,
      airAt,
      durationMs: 60_000,
    });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
    const p = plan({
      now,
      items: [
        mk('past', a as string, now - 30 * 60_000),
        mk('old', b as string, now - 3 * HOUR),
        mk('gone', c as string, now - 20 * 60_000),
        mk('next', d as string, now + 60_000),
      ],
      cached: [
        { sha256: a as string, ext: 'flac', sizeBytes: 100, lastNeededAt: now - 30 * 60_000 },
        { sha256: b as string, ext: 'flac', sizeBytes: 100, lastNeededAt: now - 3 * HOUR },
      ],
      budgetBytes: 200,
    });
    check(
      'pinning: a file aired 30 min ago is kept, one aired 3 h ago is evicted, a past-only miss is not fetched',
      p.evict.map((e) => e.sha256).join() === b &&
        p.fetch.map((x) => x.sha256).join() === d &&
        p.deferred.length === 0,
    );
  }

  // 10. Engine side: read-only mount, local paths, presigned and HTTPS URLs --------------
  {
    const root = firstRoot;
    const track = tracks[3] as Fixture;
    const trackUrl = await inner.presignGet(
      contentKey({ orgId, sha256: track.sha256, ext: 'flac' }),
      { expiresIn: 600 },
    );
    const showUrl = await inner.presignGet(
      contentKey({ orgId, sha256: show.sha256, ext: 'flac' }),
      { expiresIn: 600 },
    );
    const expiredUrl = await inner.presignGet(
      contentKey({ orgId, sha256: track.sha256, ext: 'flac' }),
      { expiresIn: 1 },
    );
    await sleep(2000);
    const cachedTrack = enginePath('/cache', { sha256: track.sha256, ext: 'flac' });
    const cachedShow = enginePath('/cache', { sha256: show.sha256, ext: 'flac' });
    const uris = [
      cachedTrack,
      cachedShow,
      enginePath('/cache', { sha256: missingSha, ext: 'flac' }),
      trackUrl,
      showUrl,
      expiredUrl,
      HTTPS_FLAC,
      HTTPS_REDIRECT_FLAC,
    ];
    const run = (env: Record<string, string>) => {
      const res = spawnSync(
        'docker',
        [
          ...['run', '--rm', '--network', DEV_NETWORK],
          ...['-v', `${here}:/spike:ro`, '-v', `${root}:/cache:ro`],
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          LIQ_IMAGE,
          '/spike/probe.liq',
        ],
        { encoding: 'utf8', timeout: 180_000 },
      );
      return (res.stdout + res.stderr)
        .split('\n')
        .filter((l) => l.startsWith('PROBE '))
        .map((l) => JSON.parse(l.slice(6)));
    };
    const probes: Array<Record<string, unknown>> = [];
    for (const timeout of ['5.', '60.']) {
      for (const p of run({ PROBE_URIS: uris.join('\n'), PROBE_TIMEOUT: timeout }))
        probes.push({ ...p, timeout });
    }
    const label = (u: string) =>
      u === cachedTrack
        ? 'cached track'
        : u === cachedShow
          ? 'cached show'
          : u.startsWith('/cache')
            ? 'missing local file'
            : u === trackUrl
              ? 'presigned track'
              : u === showUrl
                ? 'presigned show'
                : u === expiredUrl
                  ? 'expired presigned'
                  : u === HTTPS_FLAC
                    ? 'public https'
                    : 'https + redirect';
    for (const p of probes) {
      log(
        `[timeout ${p.timeout}] ${label(p.uri as string)}: ok=${p.ok} resolve ${(p.resolve_ms as number).toFixed(1)} ms, ${p.bytes} bytes, ${(p.duration as number).toFixed(1)} s`,
      );
    }
    results.probes = probes.map((p) => ({ ...p, uri: label(p.uri as string) }));
    const get = (l: string, t: string) =>
      probes.find((p) => label(p.uri as string) === l && p.timeout === t);
    check(
      'engine resolves cached files from the read-only mount',
      !!get('cached track', '5.')?.ok && !!get('cached show', '5.')?.ok,
    );
    check(
      'engine: cached duration matches',
      Math.abs((get('cached track', '5.')?.duration as number) * 1000 - track.durationMs) < 100,
    );
    check(
      'engine: missing local file fails at once (→ 422)',
      get('missing local file', '5.')?.ok === false &&
        (get('missing local file', '5.')?.resolve_ms as number) < 50,
    );
    check(
      'engine: presigned URL of a track resolves (full download before play)',
      !!get('presigned track', '5.')?.ok && get('presigned track', '5.')?.bytes === track.sizeBytes,
    );
    check('engine: expired presigned URL fails', get('expired presigned', '5.')?.ok === false);
    check('engine: public HTTPS URL resolves', !!get('public https', '60.')?.ok);
    log(
      `presigned show (${mb(show.sizeBytes)}) with the template's 5 s timeout: ok=${get('presigned show', '5.')?.ok}`,
    );

    const played = run({ PROBE_URIS: '', PROBE_PLAY: trackUrl, PROBE_PLAY_SECONDS: '5' })[0];
    check(
      'engine plays a presigned URL',
      !!played && (played.tracks as number) === 1 && (played.seconds as number) >= 4.5,
      JSON.stringify(played),
    );

    // Presigned URLs over a slower link: a TCP proxy on the host capped at 10 MB/s (a
    // realistic sustained rate from remote object storage to a VPS). URLs are signed for the
    // proxy's host:port, which Garage checks against the Host header the proxy passes through.
    const rate = 10 * MB;
    const proxy = createNetServer((client) => {
      const upstream = connect(3900, '127.0.0.1');
      client.pipe(upstream);
      upstream.pipe(new Throttle(rate).transform()).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
    });
    await new Promise<void>((r) => proxy.listen(0, '0.0.0.0', r));
    const port = (proxy.address() as AddressInfo).port;
    const slow = createS3Storage({
      ...loadStorageConfig(),
      endpoint: `http://host.docker.internal:${port}`,
    });
    const slowTrack = await slow.presignGet(
      contentKey({ orgId, sha256: track.sha256, ext: 'flac' }),
      { expiresIn: 600 },
    );
    const slowShow = await slow.presignGet(
      contentKey({ orgId, sha256: show.sha256, ext: 'flac' }),
      {
        expiresIn: 600,
      },
    );
    const slowProbes: Array<Record<string, unknown>> = [];
    for (const timeout of ['5.', '60.']) {
      const { stdout, stderr } = await promisify(execFile)(
        'docker',
        [
          ...['run', '--rm', '--add-host', 'host.docker.internal:host-gateway'],
          ...['-v', `${here}:/spike:ro`],
          ...['-e', `PROBE_URIS=${slowTrack}\n${slowShow}`, '-e', `PROBE_TIMEOUT=${timeout}`],
          LIQ_IMAGE,
          '/spike/probe.liq',
        ],
        { maxBuffer: 16 * MB, timeout: 180_000 },
      );
      for (const l of `${stdout}${stderr}`.split('\n')) {
        if (!l.startsWith('PROBE ')) continue;
        const p = JSON.parse(l.slice(6));
        const what = p.uri === slowTrack ? 'track' : 'show';
        slowProbes.push({ ...p, uri: `presigned ${what} @10 MB/s`, timeout });
        log(
          `[timeout ${timeout}] presigned ${what} @10 MB/s: ok=${p.ok} resolve ${(p.resolve_ms / 1000).toFixed(1)} s`,
        );
      }
    }
    proxy.close();
    results.slowProbes = slowProbes;
    const sp = (w: string, t: string) =>
      slowProbes.find((p) => p.uri === `presigned ${w} @10 MB/s` && p.timeout === t);
    check(
      '10 MB/s: a track resolves within the 5 s push timeout',
      !!sp('track', '5.')?.ok,
      `${((sp('track', '5.')?.resolve_ms as number) / 1000).toFixed(1)} s`,
    );
    check(
      '10 MB/s: a 30 min show does not (push would 422 after blocking 5 s)',
      sp('show', '5.')?.ok === false && sp('show', '60.')?.ok === true,
      `${((sp('show', '5.')?.resolve_ms as number) / 1000).toFixed(1)} s, ${((sp('show', '60.')?.resolve_ms as number) / 1000).toFixed(1)} s with a 60 s timeout`,
    );

    const ro = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${root}:/cache:ro`,
        LIQ_IMAGE,
        '-c',
        'touch /cache/x',
      ],
      { encoding: 'utf8' },
    );
    check('engine cannot write to the cache mount', ro.status !== 0, ro.stderr.trim());
  }

  await writeFile(join(work, 'results.json'), JSON.stringify(results, null, 2));
  log(`results: ${join(work, 'results.json')}`);
} finally {
  if (!args.keep) {
    let n = 0;
    for await (const o of storage.list(orgPrefix(orgId))) {
      // Spike objects under a random org: no quota/refcount to maintain.
      await storage.delete(o.key);
      n++;
    }
    await rm(join(work, 'cache'), { recursive: true, force: true });
    log(`cleaned up ${n} objects under ${orgPrefix(orgId)}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
