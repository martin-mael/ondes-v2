import {
  backTiming,
  createPromoPlacer,
  type GeneratorExtensions,
  type PromoPlacer,
} from '@ondes/scheduling';
import type { LocalDate } from '@ondes/shared';
import type { Executor } from '../client.ts';
import type { StationScope } from '../tenant.ts';
import type { LoadedSnapshot } from './log-generate.ts';
import { loadPromoSnapshot } from './promos.ts';

// The log generator's hooks for a loaded snapshot, built one way for the `log-generate` job and
// the regeneration preview (#101), so a dry-run's diff shows what the job would write:
// back-timing before hard starts (#46, ADR 0031), then promo placement (#60, ADR 0032).

export interface GeneratorHooks {
  extensions: GeneratorExtensions;
  /** The job writes each day's accepted placements (`promos.resolve`); a preview doesn't. */
  promos: PromoPlacer;
}

export async function loadGeneratorHooks(
  db: Executor,
  scope: StationScope,
  loaded: LoadedSnapshot,
  options: { dates: readonly LocalDate[]; seed?: string | undefined },
): Promise<GeneratorHooks> {
  const promos = createPromoPlacer(
    await loadPromoSnapshot(db, scope, {
      timeZone: loaded.snapshot.timeZone,
      dates: options.dates,
    }),
    { seed: options.seed ?? scope.stationId, clocks: loaded.snapshot.clocks },
  );
  return {
    extensions: { ...backTiming(loaded.snapshot), placeVoiceTrack: promos.placeVoiceTrack },
    promos,
  };
}
