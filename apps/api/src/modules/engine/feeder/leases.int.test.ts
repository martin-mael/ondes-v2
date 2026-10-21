import { randomUUID } from 'node:crypto';
import { createDb, type DbClient } from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeederLeases } from './leases.ts';

// Two api replicas (two pools on one database) compete for the same stations' feeders.

let tdb: TestDatabase;
let other: DbClient;

beforeAll(async () => {
  tdb = await createTestDatabase();
  other = createDb(tdb.url, { max: 2, applicationName: 'replica-b' });
});

afterAll(async () => {
  await other?.close();
  await tdb?.drop();
});

describe('feeder leases', () => {
  it('gives each station to one replica, and hands it over when that replica lets go', async () => {
    const a = createFeederLeases(tdb.sql);
    const b = createFeederLeases(other.sql);
    const station = randomUUID();
    const second = randomUUID();

    expect(await a.acquire(station)).toBe(true);
    expect(await a.acquire(station)).toBe(true);
    expect(await b.acquire(station)).toBe(false);
    expect(await b.acquire(second)).toBe(true);
    expect(await a.holds(station)).toBe(true);
    expect(await b.holds(station)).toBe(false);

    await a.release(station);
    expect(await a.holds(station)).toBe(false);
    expect(await b.acquire(station)).toBe(true);

    // Closing frees every station, and the connection goes back to the pool unlocked.
    await b.close();
    expect(await a.acquire(second)).toBe(true);
    expect(await a.acquire(station)).toBe(true);
    const [locks] = await other.sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and a.application_name = 'replica-b'
        and a.datname = current_database()`;
    expect(locks?.n).toBe(0);
    await a.close();
  });

  it('frees the stations when its session dies', async () => {
    const lost: string[][] = [];
    const a = createFeederLeases(tdb.sql, { onLost: (ids) => lost.push(ids) });
    const b = createFeederLeases(other.sql);
    const station = randomUUID();
    expect(await a.acquire(station)).toBe(true);

    // Kill a's session from b's side, as a database failover or network cut would. Only in
    // this test's own throwaway database: the dev stack is shared.
    await other.sql`
      select pg_terminate_backend(l.pid) from pg_locks l
      join pg_database d on d.oid = l.database
      where l.locktype = 'advisory' and l.granted and l.pid <> pg_backend_pid()
        and d.datname = current_database()`;
    expect(await a.holds(station)).toBe(false);
    expect(lost).toEqual([[station]]);
    expect(await b.acquire(station)).toBe(true);
    await a.close();
    await b.close();
  });
});
