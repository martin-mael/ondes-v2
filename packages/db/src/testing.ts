// Integration-test helpers (`@ondes/db/testing`). Not for production code.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, type DbClient } from './client.ts';
import { runMigrations } from './migrate.ts';

export interface TestDatabase extends DbClient {
  /** Connection string of the throwaway database. */
  url: string;
  /** Closes the pool and drops the database. */
  drop: () => Promise<void>;
}

/** Default from .env.example: the `ondes_test` database of deploy/compose.dev.yml. */
const DEV_TEST_DATABASE_URL = 'postgres://ondes:ondes@127.0.0.1:5432/ondes_test';

/** Server to create throwaway databases on: $TEST_DATABASE_URL, else $DATABASE_URL (CI). */
export function testServerUrl(): string {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEV_TEST_DATABASE_URL;
}

/**
 * Creates an empty database with a random name on the test server, so test files can run in
 * parallel without sharing state. Migrations are applied unless `migrate: false`.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const serverUrl = testServerUrl();
  const name = `ondes_it_${randomBytes(6).toString('hex')}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  if (options.migrate ?? true) await runMigrations(url.href);

  const client = createDb(url.href, { max: 5, applicationName: 'ondes-test' });
  return {
    ...client,
    url: url.href,
    drop: async () => {
      await client.close();
      const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}
