import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Executor, station } from '@ondes/db';
import { type IcecastConfigOptions, renderIcecastConfig } from './config.ts';
import { type MountPlan, planMounts, type StreamMount, type StreamStation } from './mounts.ts';

// Keeps Icecast's config in step with the stations in the database.
//
// The api renders `icecast.xml` for every station and writes it, atomically and only when it
// changed, to a volume the Icecast container also mounts. The container notices the new file,
// fills in the passwords and sends Icecast a SIGHUP (deploy/icecast/entrypoint.sh). Icecast 2.5
// re-reads its config in place: connected listeners and sources stay connected, new mounts and
// changed mount settings apply at once, and a file it can't parse is ignored (it keeps the old
// one). Measured in icecast.int.test.ts; see deploy/icecast/README.md.

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

export async function loadStreamStations(db: Executor): Promise<StreamStation[]> {
  return db
    .select({
      id: station.id,
      orgId: station.orgId,
      slug: station.slug,
      engineSettings: station.engineSettings,
    })
    .from(station);
}

/**
 * Writes the file when its content differs (temp file + rename: Icecast never reads half a
 * file). Resolves `true` when it wrote.
 */
export async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readFile(path, 'utf8').catch(() => undefined);
  if (current === content) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // World-readable: the Icecast container runs as another user. No secrets in it.
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, path);
  return true;
}

export type IcecastConfigSyncOptions = {
  db: Executor;
  /** Where the Icecast container reads the generated config (`ICECAST_CONFIG_PATH`). */
  path: string;
  config: IcecastConfigOptions;
  /** Re-checks the database this often, on top of explicit `syncNow()` calls. Default 30 s. */
  intervalMs?: number;
  logger?: Logger;
};

export type IcecastConfigSync = {
  /** Re-reads the stations and rewrites the config if it changed. Calls are serialized. */
  syncNow(): Promise<{ changed: boolean; plan: MountPlan }>;
  /** The last synced plan's mounts (empty before the first sync). */
  mounts(): StreamMount[];
  start(): void;
  stop(): Promise<void>;
};

export function createIcecastConfigSync(options: IcecastConfigSyncOptions): IcecastConfigSync {
  let current: StreamMount[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const reported = new Set<string>();

  async function run() {
    const plan = planMounts(await loadStreamStations(options.db));
    for (const err of plan.skipped) {
      // Once per distinct problem, not every 30 s.
      if (reported.has(err.message)) continue;
      reported.add(err.message);
      options.logger?.warn({ stationId: err.stationId, err }, 'station streams not served');
    }
    const changed = await writeIfChanged(
      options.path,
      renderIcecastConfig(plan.mounts, options.config),
    );
    if (changed) {
      options.logger?.info(
        { path: options.path, mounts: plan.mounts.length },
        'icecast config written',
      );
    }
    current = plan.mounts;
    return { changed, plan };
  }

  function syncNow() {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    syncNow,
    mounts: () => current,
    start() {
      if (timer) return;
      const tick = () =>
        syncNow().catch((err) => options.logger?.warn({ err }, 'icecast config sync failed'));
      void tick();
      timer = setInterval(tick, options.intervalMs ?? 30_000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}
