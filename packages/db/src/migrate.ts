import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Arbitrary constant: serializes concurrent migrators (several api replicas booting at once). */
const MIGRATION_LOCK_ID = 7_201_105;

/**
 * Applies pending migrations from `packages/db/migrations`. Safe to call on every boot and from
 * several processes at once: a Postgres advisory lock lets one run while the others wait, then
 * find nothing left to apply.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  // One dedicated connection, so the session-level lock and the migrations share it.
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'ondes-migrate' },
  });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
