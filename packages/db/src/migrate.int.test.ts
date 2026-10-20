import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

describe('migrations', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrate: false });
  });
  afterAll(() => tdb?.drop());

  it('apply cleanly on an empty database', async () => {
    await runMigrations(tdb.url);
    const tables = await tdb.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining([
        'api_key',
        'audit_log',
        'membership',
        'organization',
        'station',
        'user',
      ]),
    );
  });

  it('are idempotent and safe to run from several processes at once', async () => {
    await Promise.all([runMigrations(tdb.url), runMigrations(tdb.url), runMigrations(tdb.url)]);
    const [applied] = await tdb.sql<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations`;
    const journal = await import('../migrations/meta/_journal.json', { with: { type: 'json' } });
    expect(applied?.count).toBe(journal.default.entries.length);
  });
});
