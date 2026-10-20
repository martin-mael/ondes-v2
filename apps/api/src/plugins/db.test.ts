import { describe, expect, it } from 'vitest';
import { dbConfigFromEnv } from './db.ts';

describe('dbConfigFromEnv', () => {
  it('migrates on boot unless disabled', () => {
    const databaseUrl = 'postgres://u:p@localhost/db';
    expect(dbConfigFromEnv({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      migrateOnBoot: true,
    });
    expect(
      dbConfigFromEnv({ DATABASE_URL: databaseUrl, DB_MIGRATE_ON_BOOT: 'false' }).migrateOnBoot,
    ).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => dbConfigFromEnv({})).toThrow('DATABASE_URL');
  });
});
