// Local station engines: `pnpm dev:engine` (reads the root .env). See README.md here.
//
// 1. Checks the engine lines of .env; prints them, with this checkout's paths, if missing.
// 2. Starts the `ondes-dev-engine` compose project (the Docker proxy guard on 127.0.0.1, and
//    the Icecast that serves the api's generated config). Never touches `ondes-dev`.
// 3. Marks the seeded station's engine as wanted (`desired_state = running`), as
//    `POST …/engine/start` does. The api starts its container at boot: start (or restart)
//    `pnpm dev` after this.
// Idempotent. `pnpm dev:engine:down` (`up.ts down`) removes the station engine containers and
// stops this project; the stations stay marked running, so the next `pnpm dev:engine` and api
// boot bring them back.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  loadStationEngine,
  setDesiredState,
} from '../../../apps/api/src/modules/engine/lifecycle/repo.ts';
import {
  createEngineSecretBox,
  engineSecretKeysFromEnv,
} from '../../../apps/api/src/modules/engine/lifecycle/secrets.ts';
import { createDb, resolveStationScope } from '../../../packages/db/src/index.ts';
import { demo } from '../seed/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const env = process.env;

const required = [
  'DATABASE_URL',
  'ENGINE_DOCKER_URL',
  'ENGINE_NETWORK',
  'ENGINE_API_URL',
  'ENGINE_CACHE_ROOT',
  'ENGINE_SECRETS_KEY',
  'ENGINE_PUBLISH_CONTROL_ON_LOOPBACK',
  'ENGINE_EXTRA_HOSTS',
  'ICECAST_CONFIG_PATH',
] as const;
const down = process.argv[2] === 'down';
const missing = required.filter((key) => !env[key]);
const relative = (['ENGINE_CACHE_ROOT', 'ICECAST_CONFIG_PATH'] as const).filter(
  (key) => env[key] && !isAbsolute(env[key]),
);
if (missing.length || relative.length) {
  if (missing.length) console.error(`dev:engine: not set in .env: ${missing.join(', ')}.`);
  if (relative.length) console.error(`dev:engine: must be absolute: ${relative.join(', ')}.`);
  console.error(`Add these lines to ${resolve(root, '.env')} (see deploy/dev/engine/README.md):\n`);
  console.error(envBlock());
  process.exit(1);
}

const cacheRoot = env.ENGINE_CACHE_ROOT as string;
const configPath = env.ICECAST_CONFIG_PATH as string;
mkdirSync(cacheRoot, { recursive: true });
mkdirSync(dirname(configPath), { recursive: true });

const compose = ['compose', '-f', resolve(root, 'deploy/dev/engine/compose.yml')];
const composeEnv = { ...env, ICECAST_CONFIG_DIR: dirname(configPath) };
if (down) {
  // Engine containers are the api's, not compose's: remove them first (they hold the network).
  const prefix = env.ENGINE_CONTAINER_PREFIX ?? 'ondes-engine';
  const list = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', 'label=ondes.engine=true', '--filter', `name=^${prefix}-`],
    { encoding: 'utf8' },
  );
  const ids = list.stdout.split('\n').filter(Boolean);
  if (ids.length) docker(['rm', '-f', ...ids]);
  docker([...compose, 'down']);
  process.exit(0);
}

docker([...compose, 'up', '-d', '--wait', 'docker-proxy-guard']);
// Not --wait: Icecast waits for the config the api writes (ICECAST_CONFIG_PATH) before it
// starts, so it turns healthy once `pnpm dev` runs.
docker([...compose, 'up', '-d', 'icecast']);

const { db, close } = createDb(env.DATABASE_URL as string, {
  max: 1,
  applicationName: 'dev-engine',
});
try {
  const st = await db.query.station.findFirst({
    where: (t, { eq }) => eq(t.slug, demo.station.slug),
  });
  if (!st) {
    console.error(`dev:engine: no station "${demo.station.slug}". Run pnpm dev:seed first.`);
    process.exit(1);
  }
  const scope = await resolveStationScope(db, st.orgId, st.id);
  // Creates the engine row and its secrets on first use, as the lifecycle does.
  await loadStationEngine(db, createEngineSecretBox(engineSecretKeysFromEnv(env)), scope);
  await setDesiredState(db, scope, 'running');
  console.log(
    `dev:engine: up. Station "${st.slug}" (${st.id}) marked running: start or restart pnpm dev, ` +
      `then listen on http://127.0.0.1:${env.ENGINE_DEV_ICECAST_PORT ?? 8010}/${st.slug}/mp3.`,
  );
} finally {
  await close();
}

function docker(args: string[]) {
  const result = spawnSync('docker', args, { stdio: 'inherit', env: composeEnv });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function envBlock(): string {
  const dev = resolve(root, '.dev');
  return [
    '# --- Local station engines (pnpm dev:engine, deploy/dev/engine/README.md) ---',
    'ENGINE_DOCKER_URL=http://127.0.0.1:2376',
    'ENGINE_NETWORK=ondes-dev-engines',
    'ENGINE_API_URL=http://host.docker.internal:3000',
    'ENGINE_PUBLISH_CONTROL_ON_LOOPBACK=true',
    'ENGINE_EXTRA_HOSTS=host.docker.internal:host-gateway',
    'ENGINE_LIVE_BIND_IP=127.0.0.1',
    `ENGINE_CACHE_ROOT=${dev}/cache`,
    `ENGINE_SECRETS_KEY=dev-only-engine-secrets-key-change-me-0123`,
    `ICECAST_CONFIG_PATH=${dev}/icecast/icecast.xml`,
    'ICECAST_URL=http://127.0.0.1:8010',
  ].join('\n');
}
