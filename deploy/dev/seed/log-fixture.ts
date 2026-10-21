// Fixture log (#100): yesterday, today and tomorrow (station-local) for the demo station, so
// the feeder, as-run, timeline and dashboard have a realistic log before the generator (#50).
// Called from index.ts (`pnpm dev:seed`). Creates the fixture's assets (metadata only, no
// audio files: `pnpm dev:seed:audio` adds them, see audio.ts) and writes each day only if it has no items yet, so manual
// edits survive a re-seed. `LOG_FIXTURE_FORCE=1 pnpm dev:seed` rewrites the days.

import {
  buildFixtureDay,
  FIXTURE_LIBRARY,
  type FixtureAsset,
} from '../../../apps/api/src/modules/log/fixture.ts';
import { logDayItemCount, writeLogDay } from '../../../apps/api/src/modules/log/repo.ts';
import { addDays, localDateOf } from '../../../apps/api/src/modules/log/time.ts';
import { createAsset, type Db, type StationScope } from '../../../packages/db/src/index.ts';
import type { Actor } from '../../../packages/shared/src/index.ts';

export const FIXTURE_PREFIX = 'fixture/log/';

export async function seedLogFixture(
  db: Db,
  actor: Actor,
  scope: StationScope,
  timezone: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<string> {
  const ctx = { actor, scope };
  const existing = await db.query.asset.findMany({
    where: (t, { and, eq, like }) =>
      and(eq(t.stationId, scope.stationId), like(t.sourceFilename, `${FIXTURE_PREFIX}%`)),
    columns: { id: true, type: true, title: true, durationMs: true, sourceFilename: true },
  });
  const assets: FixtureAsset[] = [];
  for (const spec of FIXTURE_LIBRARY) {
    const sourceFilename = `${FIXTURE_PREFIX}${spec.type}/${spec.title}`;
    const found =
      existing.find((a) => a.sourceFilename === sourceFilename) ??
      (await createAsset(db, ctx, { ...spec, sourceFilename }));
    assets.push({
      id: found.id,
      type: found.type,
      title: found.title,
      durationMs: found.durationMs ?? spec.durationMs,
    });
  }

  const today = localDateOf(options.now ?? new Date(), timezone);
  const written: string[] = [];
  for (const localDate of [addDays(today, -1), today, addDays(today, 1)]) {
    if (!options.force && (await logDayItemCount(db, scope, localDate)) > 0) continue;
    const out = await writeLogDay(db, ctx, {
      localDate,
      status: 'published',
      items: buildFixtureDay(localDate, timezone, assets),
      generatedAt: new Date(),
      seed: 'fixture',
      generatorVersion: 'log-fixture/1',
      cause: 'fixture',
    });
    written.push(`${localDate} (${out.itemCount} items)`);
  }
  return written.length ? `log fixture written: ${written.join(', ')}` : 'log fixture: days exist';
}
