import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Db, type Executor, station } from '@ondes/db';
import { sql } from 'drizzle-orm';
import { type IcecastConfigOptions, renderIcecastConfig } from './config.ts';
import {
  STREAM_ASSETS_DIR,
  StationOutputsError,
  type StreamMount,
  type StreamStation,
  stationMounts,
} from './mounts.ts';
import { icecastSourcePassword } from './passwords.ts';

// Keeps Icecast's config in step with the stations in the database.
//
// The api renders `icecast.xml` for every station and writes it, atomically and only when it
// changed, to a volume the Icecast container also mounts. The container notices the new file,
// fills in the global passwords and sends Icecast a SIGHUP (deploy/icecast/entrypoint.sh).
// Icecast 2.5 re-reads its config in place: connected listeners and sources stay connected,
// new mounts and changed mount settings apply at once, and a file it can't parse is ignored
// (it keeps the old one). Measured in icecast.int.test.ts; see deploy/icecast/README.md.
//
// Several api processes may run the sync: a Postgres advisory lock makes them take turns, so
// two never write the file at once.

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

/** `pg_advisory_xact_lock` key of the config sync. */
const SYNC_LOCK = sql`hashtext('ondes.icecast.config-sync')`;

export async function loadStreamStations(db: Executor): Promise<StreamStation[]> {
  return db
    .select({
      id: station.id,
      orgId: station.orgId,
      slug: station.slug,
      engineSettings: station.engineSettings,
    })
    .from(station)
    .orderBy(station.slug);
}

/**
 * Writes the file when its content differs (unique temp file + rename: Icecast never reads
 * half a file, and two writers never share a temp file). Resolves `true` when it wrote.
 */
export async function writeIfChanged(
  path: string,
  content: string,
  mode = 0o600,
): Promise<boolean> {
  const current = await readFile(path, 'utf8').catch(() => undefined);
  if (current === content) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return true;
}

export type IcecastConfigSyncOptions = {
  db: Db;
  /** Where the Icecast container reads the generated config (`ICECAST_CONFIG_PATH`). */
  path: string;
  config: IcecastConfigOptions;
  /** `ICECAST_SOURCE_PASSWORD`: the master the per-station source passwords derive from. */
  sourceMaster: string;
  /**
   * The api's view of Icecast's `/_ondes` webroot volume (`ICECAST_ASSETS_DIR`). A mount's
   * fallback and intro are only configured once their file is there; unset: none are.
   */
  assetsDir?: string;
  /**
   * File mode of the written config. Default 0600: the api and Icecast both run as uid 1000
   * in their images. The per-station source passwords are in it.
   */
  fileMode?: number;
  /** Re-checks the database this often, on top of explicit `syncNow()` calls. Default 30 s. */
  intervalMs?: number;
  logger?: Logger;
  /** A station's outputs became invalid: its last good mounts stay served (alerts.ts). */
  onConfigInvalid?: (err: StationOutputsError) => void;
  /** A station's outputs are valid (first sync, or again after being invalid). */
  onConfigValid?: (station: { id: string; orgId: string }) => void;
};

export type IcecastConfigSync = {
  /** Re-reads the stations and rewrites the config if it changed. Calls are serialized. */
  syncNow(): Promise<{ changed: boolean; mounts: StreamMount[]; invalid: StationOutputsError[] }>;
  /** The mounts Icecast was last configured with (empty before the first sync). */
  mounts(): StreamMount[];
  start(): void;
  stop(): Promise<void>;
};

export function createIcecastConfigSync(options: IcecastConfigSyncOptions): IcecastConfigSync {
  let current: StreamMount[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  /** Each station's last valid mounts, kept while its settings are broken. */
  const lastGood = new Map<string, StreamMount[]>();
  /** Last known validity per station, to report changes only. */
  const valid = new Map<string, boolean>();
  let warnedNoAssets = false;
  const sourcePasswordFor = (stationId: string) =>
    icecastSourcePassword(options.sourceMaster, stationId);
  // Fails fast on a missing or short master, before anything is written.
  sourcePasswordFor('check');

  async function withAssets(mounts: StreamMount[]): Promise<StreamMount[]> {
    const dir = options.assetsDir;
    if (!dir) {
      if (!warnedNoAssets && mounts.some((m) => m.fallbackFile || m.introFile)) {
        warnedNoAssets = true;
        options.logger?.warn({}, 'ICECAST_ASSETS_DIR not set: no fallback or intro configured');
      }
      return mounts.map(({ fallbackFile: _f, introFile: _i, ...m }) => m);
    }
    const prefix = `/${STREAM_ASSETS_DIR}/`;
    const exists = async (file?: string) =>
      file?.startsWith(prefix)
        ? access(join(dir, file.slice(prefix.length))).then(
            () => true,
            () => false,
          )
        : false;
    return Promise.all(
      mounts.map(async ({ fallbackFile, introFile, ...m }) => ({
        ...m,
        ...((await exists(fallbackFile)) ? { fallbackFile } : {}),
        ...((await exists(introFile)) ? { introFile } : {}),
      })),
    );
  }

  async function run() {
    return options.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK})`);
      const stations = await loadStreamStations(tx);
      const planned: StreamMount[] = [];
      const invalid: StationOutputsError[] = [];
      for (const st of stations) {
        let mounts: StreamMount[];
        try {
          mounts = stationMounts(st);
        } catch (err) {
          if (!(err instanceof StationOutputsError)) throw err;
          invalid.push(err);
          if (valid.get(st.id) !== false) {
            valid.set(st.id, false);
            options.logger?.warn(
              { stationId: st.id, err, keptMounts: lastGood.get(st.id)?.length ?? 0 },
              'station outputs invalid, keeping its last good mounts',
            );
            options.onConfigInvalid?.(err);
          }
          planned.push(...(lastGood.get(st.id) ?? []));
          continue;
        }
        lastGood.set(st.id, mounts);
        if (valid.get(st.id) !== true) {
          valid.set(st.id, true);
          options.onConfigValid?.({ id: st.id, orgId: st.orgId });
        }
        planned.push(...mounts);
      }
      const ids = new Set(stations.map((s) => s.id));
      for (const id of [...lastGood.keys()]) if (!ids.has(id)) lastGood.delete(id);
      for (const id of [...valid.keys()]) if (!ids.has(id)) valid.delete(id);

      const mounts = await withAssets(planned);
      const xml = renderIcecastConfig(mounts, options.config, { sourcePasswordFor });
      const changed = await writeIfChanged(options.path, xml, options.fileMode);
      if (changed) {
        options.logger?.info(
          { path: options.path, mounts: mounts.length },
          'icecast config written',
        );
      }
      current = mounts;
      return { changed, mounts, invalid };
    });
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
