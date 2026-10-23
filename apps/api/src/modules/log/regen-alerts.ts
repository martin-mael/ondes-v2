import { createHash } from 'node:crypto';
import { type Db, resolveStationScope, type StationScope, stationTimezone } from '@ondes/db';
import { alertedIssues, generationAlertKey } from '@ondes/scheduling';
import {
  alertTypes,
  type GeneratorIssueCode,
  type LogGeneratedData,
  localDateOf,
  type RealtimeEvent,
} from '@ondes/shared';
import type { FastifyBaseLogger } from 'fastify';
import { listAlerts } from '../alerts/repo.ts';
import type { AlertService } from '../alerts/service.ts';

// The generator's issues as alerts (#101, ADR 0030; ADR 0026 left it to the caller): one
// `log.generation_issues` alert per station and local date, raised from `log.generated`
// (durable queue), resolved when a regeneration of the day has none left, or once the day is
// over. Missing episodes have their own alerts (#47); unplaced voice tracks aren't alerted.

export interface RegenAlertsDeps {
  db: Db;
  alerts: AlertService;
  logger: FastifyBaseLogger;
  now?: () => Date;
}

/** A stable uuid per (event, day): the alert framework dedupes on uuid event ids. */
export function dayEventId(eventId: string, localDate: string): string {
  const h = createHash('sha256').update(`${eventId}:${localDate}`).digest('hex');
  const variant = ((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const ISSUE_LABELS: Record<GeneratorIssueCode, string> = {
  no_clock: 'hours without a clock',
  unknown_clock: 'hours whose clock is missing',
  unfilled_slot: 'slots nothing could fill',
  underfilled_clock: 'clocks too short for their hour',
  episode_missing: 'episodes without audio',
  occurrence_dropped: 'show occurrences dropped',
  occurrence_overlap: 'overlapping show occurrences',
  vt_placeholder: 'voice tracks not placed',
};

export function createRegenAlerts(deps: RegenAlertsDeps) {
  const now = () => deps.now?.() ?? new Date();

  async function handleDay(
    scope: StationScope,
    day: LogGeneratedData['days'][number],
    event: RealtimeEvent,
  ) {
    const key = generationAlertKey(day.localDate);
    const counts = alertedIssues(
      Object.entries(day.issueCounts).map(([code, n]) => ({
        code: code as GeneratorIssueCode,
        n: n ?? 0,
      })),
    );
    const total = counts.reduce((sum, c) => sum + c.n, 0);
    const options = {
      occurredAt: new Date(event.at),
      eventId: dayEventId(event.id, day.localDate),
    };
    if (total === 0) {
      await deps.alerts.resolve(scope, key, { ...options, reason: 'regenerated' });
      return;
    }
    await deps.alerts.raise(
      scope,
      {
        type: alertTypes.logGenerationIssues,
        severity: 'warning',
        dedupeKey: key,
        title: `Log for ${day.localDate}: ${total} generation issue${total > 1 ? 's' : ''}`,
        message: counts.map((c) => `${c.n} ${ISSUE_LABELS[c.code]}`).join(', '),
        details: {
          localDate: day.localDate,
          logDayId: day.logDayId,
          counts: Object.fromEntries(counts.map((c) => [c.code, c.n])),
          issues: alertedIssues(day.issues).slice(0, 20),
          i18n: { key: 'logRegen.issues', params: { localDate: day.localDate, total } },
        },
      },
      options,
    );
  }

  /** Resolves the station's alerts for days that are over. */
  async function resolvePast(scope: StationScope) {
    const timeZone = await stationTimezone(deps.db, scope);
    if (!timeZone) return;
    const today = localDateOf(now(), timeZone);
    const open = await listAlerts(deps.db, scope, {
      status: 'open',
      type: alertTypes.logGenerationIssues,
      limit: 200,
    });
    for (const alert of open.items) {
      const date = alert.details.localDate;
      if (typeof date === 'string' && date < today) {
        await deps.alerts.resolve(scope, alert.dedupeKey, { reason: 'day_over' });
      }
    }
  }

  return {
    async handle(event: RealtimeEvent): Promise<void> {
      if (event.type !== 'log.generated') return;
      const scope = await resolveStationScope(deps.db, event.data.orgId, event.stationId);
      for (const day of event.data.days) {
        // An unchanged day keeps the issues it already raised.
        if (!day.changed) continue;
        await handleDay(scope, day, event);
      }
      await resolvePast(scope);
    },
  };
}
