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
  mail: { config: mailConfigFromEnv(env) },
  auth: authConfigFromEnv(env),
  fastify: {
    logger: { level: env.LOG_LEVEL ?? 'info' },
    // Behind Caddy in production: trust its X-Forwarded-For so rate limits see client IPs.
    trustProxy: env.API_TRUST_PROXY === 'true',
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
