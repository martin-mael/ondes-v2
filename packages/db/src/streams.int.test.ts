import type { Actor } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listListenerMinutes, minuteOf, recordListenerSamples } from './repos/streams.ts';
import { createOrganization, createStation } from './repos/tenancy.ts';
import { resolveOrgScope, resolveStationScope } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing.ts';

const system: Actor = { type: 'system', name: 'test' };

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb?.drop());

async function makeStation(slug: string) {
  const org = await createOrganization(tdb.db, system, { slug: `${slug}-org`, name: slug });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug, name: slug, timezone: 'Europe/Paris' },
  );
  return resolveStationScope(tdb.db, org.id, st.id);
}

const at = (iso: string) => new Date(iso);

describe('listener stats', () => {
  it('folds samples into minute rows', async () => {
    const scope = await makeStation('stats-a');
    const sample = (iso: string, listeners: number, sourceConnected = true) => ({
      stationId: scope.stationId,
      mount: '/stats-a/mp3',
      at: at(iso),
      listeners,
      sourceConnected,
    });
    await recordListenerSamples(tdb.db, [
      sample('2026-10-25T00:59:10Z', 4),
      sample('2026-10-25T00:59:25Z', 10, false),
    ]);
    // Separate calls (another poll), same minute, plus the next minute and another mount.
    await recordListenerSamples(tdb.db, [
      sample('2026-10-25T00:59:40Z', 7),
      sample('2026-10-25T00:59:55Z', 3),
      sample('2026-10-25T01:00:05Z', 12),
      { ...sample('2026-10-25T00:59:40Z', 1), mount: '/stats-a/aac' },
    ]);

    const rows = await listListenerMinutes(tdb.db, scope, {
      from: at('2026-10-25T00:00:00Z'),
      to: at('2026-10-25T02:00:00Z'),
    });
    expect(rows).toEqual([
      {
        mount: '/stats-a/aac',
        minute: at('2026-10-25T00:59:00Z'),
        samples: 1,
        listenersAvg: 1,
        listenersMax: 1,
        listenersMin: 1,
        sourceUptime: 1,
      },
      {
        mount: '/stats-a/mp3',
        minute: at('2026-10-25T00:59:00Z'),
        samples: 4,
        listenersAvg: 6,
        listenersMax: 10,
        listenersMin: 3,
        sourceUptime: 0.75,
      },
      {
        mount: '/stats-a/mp3',
        minute: at('2026-10-25T01:00:00Z'),
        samples: 1,
        listenersAvg: 12,
        listenersMax: 12,
        listenersMin: 12,
        sourceUptime: 1,
      },
    ]);

    const aacOnly = await listListenerMinutes(tdb.db, scope, {
      mount: '/stats-a/aac',
      from: '2026-10-25T00:59:00Z',
      to: '2026-10-25T01:00:00Z',
    });
    expect(aacOnly.map((r) => r.mount)).toEqual(['/stats-a/aac']);
  });

  it("never returns another station's rows", async () => {
    const a = await makeStation('stats-b');
    const b = await makeStation('stats-c');
    await recordListenerSamples(tdb.db, [
      {
        stationId: a.stationId,
        mount: '/stats-b/mp3',
        at: at('2026-10-21T10:00:00Z'),
        listeners: 2,
        sourceConnected: true,
      },
    ]);
    const range = { from: at('2026-10-21T00:00:00Z'), to: at('2026-10-22T00:00:00Z') };
    expect(await listListenerMinutes(tdb.db, b, range)).toEqual([]);
    expect(await listListenerMinutes(tdb.db, a, range)).toHaveLength(1);
  });

  it('rejects bad samples and ranges', async () => {
    const scope = await makeStation('stats-d');
    await expect(
      recordListenerSamples(tdb.db, [
        {
          stationId: scope.stationId,
          mount: 'no-slash',
          at: new Date(),
          listeners: 1,
          sourceConnected: true,
        },
      ]),
    ).rejects.toThrow();
    await expect(
      listListenerMinutes(tdb.db, scope, {
        from: at('2026-01-01T00:00:00Z'),
        to: at('2026-03-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/31 days/);
  });

  it('truncates to the minute', () => {
    expect(minuteOf(at('2026-03-29T01:59:59.999Z'))).toEqual(at('2026-03-29T01:59:00Z'));
  });
});
