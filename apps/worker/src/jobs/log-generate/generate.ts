import { randomUUID } from 'node:crypto';
import {
  type Db,
  type GeneratorLoadOptions,
  loadGeneratorSnapshot,
  type StationScope,
  type WrittenDay,
  writeGeneratedDay,
} from '@ondes/db';
import { type GeneratorIssue, generateDays } from '@ondes/scheduling';
import {
  type Actor,
  type LogGenerateJobPayload,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import { announce, type PublishEvent } from '../_events/asset-updated.ts';

// One `log-generate` job (#50, ADR 0026): load the station's snapshot once for all the days,
// generate them in order with @ondes/scheduling (each day's picks count for the next), write
// each day in its own transaction, then publish `log.updated` (cause `generate`) for what was
// written. Deterministic: the same snapshot and seed write the same items, so a retried job
// rewrites the same days.

export const ACTOR: Actor = { type: 'system', name: 'log-generate' };

export interface LogGenerateDeps {
  db: Db;
  publish?: PublishEvent | undefined;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  rerun?: GeneratorLoadOptions['rerun'];
}

export interface LogGenerateReport {
  days: WrittenDay[];
  issues: { localDate: string; issues: GeneratorIssue[] }[];
}

export async function runLogGenerate(
  deps: LogGenerateDeps,
  scope: StationScope,
  payload: Pick<LogGenerateJobPayload, 'localDates' | 'seed' | 'status'>,
): Promise<LogGenerateReport | null> {
  const loaded = await loadGeneratorSnapshot(deps.db, scope, {
    dates: payload.localDates,
    now: deps.now?.() ?? new Date(),
    mode: 'regenerate',
    ...(deps.rerun ? { rerun: deps.rerun } : {}),
  });
  if (!loaded) return null;
  const generated = generateDays(
    loaded.snapshot,
    payload.localDates,
    payload.seed ? { seed: payload.seed } : {},
  );
  const days: WrittenDay[] = [];
  for (const day of generated) {
    days.push(
      await writeGeneratedDay(deps.db, { actor: ACTOR, scope }, day, { status: payload.status }),
    );
  }
  if (days.length) await announce(deps.publish, logUpdated(scope.stationId, days), deps.log);
  return {
    days,
    issues: generated.map((d) => ({ localDate: d.localDate, issues: d.issues })),
  };
}

/** One `log.updated` covering every written day (and a following day whose first item moved). */
export function logUpdated(stationId: string, days: WrittenDay[]): RealtimeEvent {
  const touched = new Map<string, { logDayId: string; localDate: string; version: number }>();
  for (const d of days) {
    touched.set(d.logDayId, { logDayId: d.logDayId, localDate: d.localDate, version: d.version });
  }
  // A following day that is also written keeps the written version (it comes later).
  for (const d of days) {
    if (d.following && !touched.has(d.following.logDayId)) {
      touched.set(d.following.logDayId, d.following);
    }
  }
  const from = Math.min(...days.map((d) => d.range.from.getTime()));
  const to = Math.max(...days.map((d) => d.range.to.getTime()));
  return realtimeEventSchema.parse({
    id: randomUUID(),
    stationId,
    at: new Date().toISOString(),
    type: 'log.updated',
    data: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      days: [...touched.values()],
      cause: 'generate',
    },
  });
}

/** Counts per issue code, for the job log. */
export function issueSummary(report: LogGenerateReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const day of report.issues) {
    for (const issue of day.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  return counts;
}
