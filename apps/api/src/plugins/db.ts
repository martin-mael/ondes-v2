import { createDb, type DbClient, runMigrations } from '@ondes/db';

// Database setup for the api. Fastify arrives with #6, which wraps this in a plugin
// (`app.decorate('db', …)`, `onClose` → `close()`). Until then it's a plain function.

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
