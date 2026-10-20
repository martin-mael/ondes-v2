import { createDb, type Db, type DbClient, runMigrations } from '@ondes/db';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

// Database access for the api: `app.db` (Drizzle) and `app.dbClient` (pool + raw SQL).

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    dbClient: DbClient;
  }
}

export interface DbConfig {
  databaseUrl: string;
  /** Apply pending migrations before opening the pool. Defaults to true. */
  migrateOnBoot?: boolean;
}

/** Reads the config from the environment: `DATABASE_URL`, `DB_MIGRATE_ON_BOOT` (default true). */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return { databaseUrl, migrateOnBoot: env.DB_MIGRATE_ON_BOOT !== 'false' };
}

/** Runs migrations (unless disabled), then opens the pool. Call once at boot. */
export async function setupDb(config: DbConfig): Promise<DbClient> {
  if (config.migrateOnBoot ?? true) await runMigrations(config.databaseUrl);
  return createDb(config.databaseUrl, { applicationName: 'ondes-api' });
}

export type DbPluginOptions =
  /** Runs `setupDb` and closes the pool on shutdown. */
  | { config: DbConfig }
  /** An already open client (tests). The caller closes it. */
  | { client: DbClient };

export const dbPlugin = fp(
  async (app: FastifyInstance, options: DbPluginOptions) => {
    const client = 'client' in options ? options.client : await setupDb(options.config);
    app.decorate('dbClient', client);
    app.decorate('db', client.db);
    if ('config' in options) app.addHook('onClose', () => client.close());
  },
  { name: 'db' },
);
