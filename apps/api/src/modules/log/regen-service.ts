import {
  type Db,
  existingLogDays,
  type GeneratorLoadOptions,
  getRegenSettings,
  type LoadedSnapshot,
  loadGeneratorSnapshot,
  type StationScope,
  stationTimezone,
  withAudit,
} from '@ondes/db';
import type { JobPublisher } from '@ondes/queue';
import { jobType } from '@ondes/queue';
import {
  consecutiveChunks,
  type DiffItem,
  dateRange,
  diffDay,
  type GeneratorExtensions,
  type GeneratorIssue,
  generateDays,
  regenPolicy,
} from '@ondes/scheduling';
import {
  type Actor,
  LOG_GENERATE_JOB,
  LOG_GENERATE_MAX_DAYS,
  LOG_HORIZON_JOB,
  type LocalDate,
  type LogAssetSummary,
  type LogDiffItem,
  type LogRegenPreviewRequest,
  type LogRegenPreviewResponse,
  type LogRegenRequest,
  type LogRegenResponse,
  localDateOf,
  logGenerateJobPayloadSchema,
  logHorizonJobPayloadSchema,
} from '@ondes/shared';
import { HttpError } from '../../plugins/errors.ts';

// Regeneration from the api (#101, ADR 0030): the dry-run (computed here, nothing written) and
// the apply (queued `log-generate` jobs). Both run the generator under the same keep policy as
// the worker (`regenPolicy`: the next hour and manual edits stay, with locked items, segue
// ends and fallback marks), so a preview shows what applying would do.

export const logGenerateJob = jobType(LOG_GENERATE_JOB, logGenerateJobPayloadSchema, {
  lane: 'bulk',
});
export const logHorizonJob = jobType(LOG_HORIZON_JOB, logHorizonJobPayloadSchema, {
  lane: 'bulk',
});

/** The generator's extension points (#46, #60), built like the worker's `log-generate` does. */
export type ExtensionsBuilder = (
  loaded: LoadedSnapshot,
  scope: StationScope,
) => GeneratorExtensions | Promise<GeneratorExtensions>;

export interface RegenServiceDeps {
  db: Db;
  now?: () => Date;
  extensions?: ExtensionsBuilder | undefined;
  rerun?: GeneratorLoadOptions['rerun'];
}

/** Today, station-local; refuses ranges starting before it. */
async function checkRange(db: Db, scope: StationScope, from: LocalDate, now: Date) {
  const timeZone = await stationTimezone(db, scope);
  if (!timeZone) throw new HttpError(404, 'not_found', 'Station not found');
  const today = localDateOf(now, timeZone);
  if (from < today) {
    throw new HttpError(422, 'log_regen_past', `Days before ${today} can't be regenerated`, {
      today,
    });
  }
  return today;
}

const issueDto = (issue: GeneratorIssue) => ({
  code: issue.code,
  at: issue.at.toISOString(),
  ...(issue.until ? { until: issue.until.toISOString() } : {}),
  ...(issue.clockId ? { clockId: issue.clockId } : {}),
  ...(issue.slotIndex !== undefined ? { slotIndex: issue.slotIndex } : {}),
  ...(issue.showSlotId ? { showSlotId: issue.showSlotId } : {}),
  ...(issue.detail ? { detail: issue.detail.slice(0, 500) } : {}),
});

/** The dry-run: the regenerated days and their diff against the log as it is. */
export async function previewRegen(
  deps: RegenServiceDeps,
  scope: StationScope,
  request: LogRegenPreviewRequest,
): Promise<LogRegenPreviewResponse> {
  const now = deps.now?.() ?? new Date();
  await checkRange(deps.db, scope, request.from, now);
  const dates = dateRange(request.from, request.to);
  const keep = regenPolicy(now);
  const loaded = await loadGeneratorSnapshot(deps.db, scope, {
    dates,
    now,
    mode: 'regenerate',
    keep,
    ...(deps.rerun ? { rerun: deps.rerun } : {}),
  });
  if (!loaded) throw new HttpError(404, 'not_found', 'Station not found');
  const extensions = deps.extensions ? await deps.extensions(loaded, scope) : undefined;
  const generated = generateDays(loaded.snapshot, dates, {
    ...(request.seed ? { seed: request.seed } : {}),
    ...(extensions ? { extensions } : {}),
  });

  const summary = (assetId: string | null): LogAssetSummary | null => {
    const a = assetId ? loaded.snapshot.assets.get(assetId) : undefined;
    return a
      ? {
          id: a.id,
          type: a.type,
          title: a.title,
          artists: [...a.artists],
          durationMs: a.durationMs,
        }
      : null;
  };
  const dto = (i: DiffItem): LogDiffItem => ({
    id: i.id,
    kind: i.kind,
    plannedStart: i.plannedStart.toISOString(),
    plannedDurationMs: i.plannedDurationMs,
    assetId: i.assetId,
    asset: summary(i.assetId),
    episodeId: i.episodeId,
    liveSlotId: i.liveSlotId,
    title: i.title,
    timing: i.timing,
    origin: i.origin,
    relaxedRules: [...i.relaxedRules],
    conflict: i.conflict,
  });

  const totals = { added: 0, removed: 0, moved: 0, relaxed: 0, issues: 0 };
  const days = generated.map((day) => {
    const existing = loaded.days.get(day.localDate) ?? null;
    const diff = diffDay(loaded.current.get(day.localDate) ?? null, day, loaded.keptReasons);
    totals.added += diff.added.length;
    totals.removed += diff.removed.length;
    totals.moved += diff.moved.length;
    totals.relaxed += diff.relaxed.length;
    totals.issues += day.issues.length;
    return {
      localDate: day.localDate,
      logDayId: existing?.id ?? null,
      version: existing?.version ?? null,
      change: diff.change,
      added: diff.added.map(dto),
      removed: diff.removed.map(dto),
      moved: diff.moved.map((m) => ({
        item: dto(m.item),
        fromStart: m.fromStart.toISOString(),
        shiftMs: m.shiftMs,
      })),
      relaxed: diff.relaxed.map((r) => ({ item: dto(r.item), new: r.new })),
      kept: diff.kept,
      unchangedCount: diff.unchangedCount,
      items: diff.items.map(dto),
      issues: day.issues.map(issueDto),
    };
  });
  return { frozenUntil: keep.frozenUntil.toISOString(), days, totals };
}

/**
 * Applies a previewed regeneration: checks the range and the versions the preview saw, audits
 * the request (`log_day.regenerate`), then queues a `log-generate` job. The job writes the days
 * (`log_day.generate`) and publishes `log.updated` (cause `generate`).
 */
export async function applyRegen(
  deps: RegenServiceDeps & { jobs: JobPublisher },
  ctx: { actor: Actor; scope: StationScope },
  request: LogRegenRequest,
): Promise<LogRegenResponse> {
  const now = deps.now?.() ?? new Date();
  const { scope } = ctx;
  await checkRange(deps.db, scope, request.from, now);
  const dates = dateRange(request.from, request.to);
  const unseen = dates.filter((date) => !(date in request.expectedVersions));
  if (unseen.length) {
    throw new HttpError(422, 'log_regen_unpreviewed', 'Preview these days before regenerating', {
      localDates: unseen,
    });
  }
  const existing = await existingLogDays(deps.db, scope, dates);
  const changed = dates.filter(
    (date) => (existing.get(date)?.version ?? null) !== request.expectedVersions[date],
  );
  if (changed.length) {
    throw new HttpError(409, 'log_regen_stale', 'The log changed since the preview', {
      localDates: changed,
    });
  }
  const settings = await getRegenSettings(deps.db, scope);
  await withAudit(deps.db, ctx, async (_tx, audit) => {
    await audit({
      action: 'log_day.regenerate',
      entity: { type: 'station', id: scope.stationId },
      diff: {
        from: { from: null, to: request.from },
        to: { from: null, to: request.to },
        ...(request.seed ? { seed: { from: null, to: request.seed } } : {}),
      },
    });
  });
  const chunks = consecutiveChunks(dates, LOG_GENERATE_MAX_DAYS);
  for (const localDates of chunks) {
    await deps.jobs.enqueue(
      logGenerateJob,
      {
        orgId: scope.orgId,
        stationId: scope.stationId,
        localDates,
        status: settings.newDayStatus,
        ...(request.seed ? { seed: request.seed } : {}),
      },
      { orgId: scope.orgId, stationId: scope.stationId },
    );
  }
  return { localDates: dates, jobs: chunks.length };
}
