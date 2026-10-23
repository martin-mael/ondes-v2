import {
  clearRegenRequest,
  existingLogDays,
  getRegenRequest,
  getRegenSettings,
  recordRegenRequest,
  type StationScope,
  stationTimezone,
} from '@ondes/db';
import { consecutiveChunks, horizonDates, horizonWork } from '@ondes/scheduling';
import { LOG_GENERATE_MAX_DAYS, type LocalDate, type LogHorizonJobPayload } from '@ondes/shared';
import {
  type LogGenerateDeps,
  type LogGenerateReport,
  runLogGenerate,
} from '../log-generate/generate.ts';

// One `log-horizon` pass for a station (#101, ADR 0030):
// 1. with `change`, record the schedule change (debounced: it's due 30 s after the last
//    change, 5 min after the first at most);
// 2. generate the horizon's days that have no log yet (the nightly extension: a new day
//    enters the horizon at local midnight);
// 3. once a recorded change is due, regenerate the horizon from its first date on, then clear
//    it (unless another change came in meanwhile).
// The api's sweep enqueues a pass for every station that needs one; the trigger, one per change.

export interface LogHorizonReport {
  recorded: boolean;
  missing: LocalDate[];
  regenerated: LocalDate[];
  runs: LogGenerateReport[];
}

export async function runLogHorizon(
  deps: LogGenerateDeps,
  scope: StationScope,
  payload: Pick<LogHorizonJobPayload, 'change'>,
): Promise<LogHorizonReport | null> {
  const now = deps.now?.() ?? new Date();
  if (payload.change) {
    await recordRegenRequest(deps.db, scope, {
      at: new Date(payload.change.at),
      areas: payload.change.areas,
      from: payload.change.from,
    });
  }
  const timeZone = await stationTimezone(deps.db, scope);
  if (!timeZone) return null;
  const settings = await getRegenSettings(deps.db, scope);
  const horizon = horizonDates(now, timeZone, settings.horizonDays);
  const existing = await existingLogDays(deps.db, scope, horizon);
  const request = await getRegenRequest(deps.db, scope);
  const due = request && request.dueAt.getTime() <= now.getTime() ? request : null;
  const work = horizonWork({
    horizon,
    existing: new Set(existing.keys()),
    ...(due ? { dueFrom: due.fromDate } : {}),
  });
  const runs: LogGenerateReport[] = [];
  for (const localDates of consecutiveChunks(
    [...work.missing, ...work.regenerate],
    LOG_GENERATE_MAX_DAYS,
  )) {
    const report = await runLogGenerate(deps, scope, {
      localDates,
      status: settings.newDayStatus,
    });
    if (report) runs.push(report);
  }
  if (due) await clearRegenRequest(deps.db, scope, due.lastRequestedAt);
  return {
    recorded: payload.change !== undefined,
    missing: work.missing,
    regenerated: work.regenerate,
    runs,
  };
}
