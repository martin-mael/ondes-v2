import {
  createOrganization,
  createStation,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import { resolveCategory } from '@ondes/scheduling';
import type { Actor, AssetType } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prng, randomMembers, randomRule, seedLibrary } from './fixture.ts';
import { type LibraryCandidate, loadCandidates, previewDraft } from './repo.ts';

// The api's SQL membership (sql.ts) against the reference resolver (@ondes/scheduling), on a
// generated library and generated rules: counts, member order and sources, manual effects.

const system: Actor = { type: 'system', name: 'test' };
const SEED = 37;
const RULES = 150;
const at = new Date('2026-10-21T12:00:00Z');

let tdb: TestDatabase;
let scope: StationScope;
let ids: string[];
let candidates: LibraryCandidate[];

beforeAll(async () => {
  tdb = await createTestDatabase();
  const org = await createOrganization(tdb.db, system, { slug: 'sql-org', name: 'Org' });
  const orgScope = await resolveOrgScope(tdb.db, org.id);
  const st = await createStation(
    tdb.db,
    { actor: system, scope: orgScope },
    { slug: 'sql-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(tdb.db, org.id, st.id);
  ids = await seedLibrary(tdb.db, scope, 400, prng(SEED));
  candidates = await loadCandidates(tdb.db, scope);
}, 60_000);

afterAll(() => tdb?.drop());

describe('SQL membership', () => {
  it(`agrees with resolveCategory on ${RULES} generated rules`, async () => {
    const rand = prng(SEED + 1);
    let nonTrivial = 0;
    for (let i = 0; i < RULES; i++) {
      const assetType: AssetType = rand.chance(0.8) ? 'song' : 'jingle';
      const rule = rand.chance(0.9) ? randomRule(rand) : null;
      const members = randomMembers(rand, ids, rand.int(12));
      const input = { assetType, rule, members };

      const expected = resolveCategory(input, candidates, at);
      const actual = await previewDraft(
        tdb.db,
        scope,
        { ...input, limit: 500, manualLimit: 1000 },
        at,
      );
      const context = `rule #${i}: ${JSON.stringify(input)}`;

      expect(actual.counts, context).toEqual(expected.counts);
      expect(
        actual.items.map((m) => [m.assetId, m.source, m.schedulable]),
        context,
      ).toEqual(expected.members.map((m) => [m.asset.id, m.source, m.schedulable]));
      expect(
        actual.manual.map((m) => [m.assetId, m.mode, m.effect]),
        context,
      ).toEqual(expected.manual.map((m) => [m.asset.id, m.mode, m.effect]));
      expect(actual.manualTotal, context).toBe(expected.manual.length);
      if (expected.counts.members > 0 && expected.counts.members < candidates.length / 2) {
        nonTrivial++;
      }
    }
    // The generator must produce selective rules, or agreement proves little.
    expect(nonTrivial).toBeGreaterThan(RULES / 4);
  }, 120_000);
});
