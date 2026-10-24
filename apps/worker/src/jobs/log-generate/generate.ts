import { randomUUID } from 'node:crypto';
import {
  type Db,
  type GeneratorLoadOptions,
  type LoadedSnapshot,
  loadGeneratorSnapshot,
  type StationScope,
  type WrittenDay,
  writeGeneratedDay,
} from '@ondes/db';
import {
  type GeneratorExtensions,
  type GeneratorIssue,
  generateDays,
  issueCounts,
  regenPolicy,
} from '@ondes/scheduling';
import {
  type Actor,
  type GeneratorIssueDto,
  LOG_GENERATED_MAX_ISSUES,
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
//
// Regeneration (#101, ADR 0030): what aired, plays or is with the feeder (before the freeze
// point, `regenPolicy`) and manual edits are kept like locked items, and a day that comes out
// as it is isn't written (`changed: false`): no new version, no `log.updated` for it. Every
// day, changed or not, goes out on `log.generated` with its issues (the api's alerts).

export const ACTOR: Actor = { type: 'system', name: 'log-generate' };

export interface LogGenerateDeps {
  db: Db;
  publish?: PublishEvent | undefined;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  rerun?: GeneratorLoadOptions['rerun'];
  /**
   * The generator's extension points for the loaded snapshot (#46's `beforeAnchor`, #60's
   * `placeVoiceTrack`). The api's dry-run builds them the same way.
   */
  extensions?: (
    loaded: LoadedSnapshot,
    scope: StationScope,
  ) => GeneratorExtensions | Promise<GeneratorExtensions>;
  /** Writes one day. Default `writeGeneratedDay` (tests make it fail mid-run). */
  writeDay?: typeof writeGeneratedDay;
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
  const now = deps.now?.() ?? new Date();
  const keep = regenPolicy(now);
  const loaded = await loadGeneratorSnapshot(deps.db, scope, {
    dates: payload.localDates,
    now,
    mode: 'regenerate',
    keep,
    ...(deps.rerun ? { rerun: deps.rerun } : {}),
  });
  if (!loaded) return null;
  const extensions = deps.extensions ? await deps.extensions(loaded, scope) : undefined;
  const generated = generateDays(loaded.snapshot, payload.localDates, {
    ...(payload.seed ? { seed: payload.seed } : {}),
    ...(extensions ? { extensions } : {}),
  });
  const write = deps.writeDay ?? writeGeneratedDay;
  const days: WrittenDay[] = [];
  // Each day commits on its own. If a later one fails, what was written is announced before
  // the error goes up: the retry finds those days unchanged and would announce nothing.
  const announceWritten = async () => {
    const changed = days.filter((d) => d.changed);
    if (changed.length) {
      await announce(deps.publish, logUpdated(scope.stationId, changed), deps.log);
    }
    if (days.length) {
      await announce(deps.publish, logGenerated(scope, days, generated), deps.log);
    }
  };
  try {
    for (const day of generated) {
      days.push(
        await write(deps.db, { actor: ACTOR, scope }, day, { status: payload.status, keep }),
      );
    }
  } catch (error) {
    await announceWritten();
    throw error;
  }
  await announceWritten();
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

export const issueDto = (issue: GeneratorIssue): GeneratorIssueDto => ({
  code: issue.code,
  at: issue.at.toISOString(),
  ...(issue.until ? { until: issue.until.toISOString() } : {}),
  ...(issue.clockId ? { clockId: issue.clockId } : {}),
  ...(issue.slotIndex !== undefined ? { slotIndex: issue.slotIndex } : {}),
  ...(issue.showSlotId ? { showSlotId: issue.showSlotId } : {}),
  ...(issue.detail ? { detail: issue.detail.slice(0, 500) } : {}),
});

/** `log.generated`: every day the job went through, with its issues (#101: the api's alerts). */
export function logGenerated(
  scope: StationScope,
  days: WrittenDay[],
  generated: { localDate: string; issues: GeneratorIssue[] }[],
): RealtimeEvent {
  const issuesOf = new Map(generated.map((d) => [d.localDate, d.issues]));
  return realtimeEventSchema.parse({
    id: randomUUID(),
    stationId: scope.stationId,
    at: new Date().toISOString(),
    type: 'log.generated',
    data: {
      orgId: scope.orgId,
      days: days.map((d) => {
        const issues = issuesOf.get(d.localDate) ?? [];
        return {
          logDayId: d.logDayId,
          localDate: d.localDate,
          version: d.version,
          changed: d.changed,
          issueCounts: issueCounts(issues),
          issues: issues.slice(0, LOG_GENERATED_MAX_ISSUES).map(issueDto),
        };
      }),
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
