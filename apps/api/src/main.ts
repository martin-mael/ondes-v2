import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { buildApp } from './app.ts';
import { authConfigFromEnv } from './plugins/auth.ts';
import { dbConfigFromEnv } from './plugins/db.ts';
import { mailConfigFromEnv } from './plugins/mail.ts';

// Api entry point: `node src/main.ts` (reads the environment; see .env.example).

const env = process.env;
const rabbitUrl = env.RABBITMQ_URL;
if (!rabbitUrl) throw new Error('RABBITMQ_URL is not set');

const app = await buildApp({
  db: { config: dbConfigFromEnv(env) },
  rabbit: { url: rabbitUrl },
  storage: createS3Storage(loadStorageConfig(env)),
  mail: { config: mailConfigFromEnv(env) },
  auth: authConfigFromEnv(env),
  fastify: {
    logger: { level: env.LOG_LEVEL ?? 'info' },
    // Behind Caddy, rate limits key on the client IP from X-Forwarded-For. Default: trust
    // proxies on loopback and private networks (Caddy on the Docker network), so a missing
    // setting can't put every client in one rate-limit bucket. `false` disables it; `true` or
    // an address/CIDR list (proxy-addr syntax) overrides it.
    trustProxy: trustProxyFromEnv(env.API_TRUST_PROXY),
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: env.API_HOST ?? '0.0.0.0', port: Number(env.API_PORT ?? 3000) });

function trustProxyFromEnv(value: string | undefined): boolean | string {
  if (value === undefined || value === '') return 'loopback,uniquelocal';
  if (value === 'false') return false;
  if (value === 'true') return true;
  return value;
}
