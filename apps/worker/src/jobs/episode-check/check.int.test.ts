import {
  createAsset,
  createOrganization,
  createStation,
  episode,
  episodeChecksOf,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  show,
  showSlot,
  showSlotException,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { Actor, SlotRule } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCheckedStations, runEpisodeCheck } from './check.ts';

// The worker's half of #47: which steps a pass records, against a real database. The times are
// fixed; DST thresholds are covered by plan.test.ts.

const system: Actor = { type: 'system', name: 'test' };
const HOUR = 3600 * 1000;

let tdb: TestDatabase;
let scope: StationScope;
let showId: string;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'ep-worker', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'ep-worker-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  const [row] = await tdb.db
    .insert(show)
    .values({ orgId: scope.orgId, stationId: scope.stationId, name: 'Le Midi' })
    .returning();
  if (!row) throw new Error('no show');
  showId = row.id;
}, 60_000);

afterAll(() => tdb?.drop());

/** A weekly Sunday slot at `time`, Europe/Paris. */
async function slot(time: string, type: 'prerecorded' | 'live' = 'prerecorded') {
  const rule: SlotRule = {
    freq: 'weekly',
    startDate: '2026-11-01',
    until: null,
    interval: 1,
    byDay: ['su'],
    time,
  };
  const [row] = await tdb.db
    .insert(showSlot)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      showId,
      type,
      rule,
      startsOn: '2026-11-01',
      durationMs: HOUR,
    })
    .returning();
  if (!row) throw new Error('no slot');
  return row.id;
}

async function steps(slotId: string) {
  const rows = await episodeChecksOf(tdb.db, scope, [slotId]);
  return rows.map((r) => `${r.occurrenceDate}:${r.step}`).sort();
}

// Sunday 15 November 2026, 20:00 CET = 19:00Z.
const at = (iso: string) => new Date(iso);

describe('episode check pass', () => {
  it('records each due step once, as time goes by', async () => {
    const slotId = await slot('20:00');
    await runEpisodeCheck(tdb.db, scope, at('2026-11-13T18:00:00Z'));
    expect(await steps(slotId)).toEqual([]);

    const first = await runEpisodeCheck(tdb.db, scope, at('2026-11-13T19:00:00Z'));
    expect(first.recorded).toEqual([{ slotId, occurrenceDate: '2026-11-15', step: 't48h' }]);
    // A second pass (another worker, a redelivery) records nothing new.
    expect((await runEpisodeCheck(tdb.db, scope, at('2026-11-13T19:01:00Z'))).recorded).toEqual([]);

    await runEpisodeCheck(tdb.db, scope, at('2026-11-15T13:00:00Z'));
    await runEpisodeCheck(tdb.db, scope, at('2026-11-15T18:00:00Z'));
    expect(await steps(slotId)).toEqual([
      '2026-11-15:fallback',
      '2026-11-15:t48h',
      '2026-11-15:t6h',
    ]);
    const [row] = await episodeChecksOf(tdb.db, scope, [slotId]);
    expect(row).toMatchObject({ showId, startsAt: at('2026-11-15T19:00:00Z'), episodeId: null });
  });

  it('skips occurrences whose premiere has audio, live slots and cancelled occurrences', async () => {
    const withAudio = await slot('10:00');
    const audio = await createAsset(
      tdb.db,
      { actor: system, scope },
      { type: 'episode', title: 'Ep' },
    );
    await tdb.db.insert(episode).values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      showId,
      number: 1,
      kind: 'prerecorded',
      assetId: audio.id,
      status: 'ready',
      slotId: withAudio,
      occurrenceDate: '2026-11-22',
    });
    // A premiere planned without audio is still missing; its id goes on the step.
    const planned = await slot('12:00');
    const [premiere] = await tdb.db
      .insert(episode)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        showId,
        number: 2,
        kind: 'prerecorded',
        slotId: planned,
        occurrenceDate: '2026-11-22',
      })
      .returning();
    const live = await slot('14:00', 'live');
    const cancelled = await slot('16:00');
    await tdb.db.insert(showSlotException).values({
      slotId: cancelled,
      orgId: scope.orgId,
      stationId: scope.stationId,
      date: '2026-11-22',
      kind: 'cancelled',
    });

    await runEpisodeCheck(tdb.db, scope, at('2026-11-22T06:00:00Z'));
    expect(await steps(withAudio)).toEqual([]);
    expect(await steps(live)).toEqual([]);
    expect(await steps(cancelled)).toEqual([]);
    expect(await steps(planned)).toEqual(['2026-11-22:t6h']);
    const [row] = await episodeChecksOf(tdb.db, scope, [planned]);
    expect(row?.episodeId).toBe(premiere?.id);
  });

  it('lists the stations the sweep checks', async () => {
    const stations = await listCheckedStations(tdb.db, at('2026-11-22T06:00:00Z'));
    expect(stations).toContainEqual({ orgId: scope.orgId, stationId: scope.stationId });
  });
});
