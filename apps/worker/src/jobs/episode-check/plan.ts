import { EPISODE_CHECK_LEAD_MS, type EpisodeCheckStep } from '@ondes/shared';

// Which missing-episode steps are due (#47, ADR 0022). Pure: the job feeds it the expanded
// occurrences (`@ondes/scheduling`, station-local) and the steps already recorded.
//
// Leads are elapsed time before the occurrence's UTC start: "48 h before" a Sunday 20:00 slot
// after the spring-forward night is Friday 19:00 on the wall clock (47 h), and Friday 21:00
// before the fall-back night (49 h). Expansion already put the start right on DST nights.

const { t48h, t6h, fallback } = EPISODE_CHECK_LEAD_MS;

/** How far ahead the job has to look: the earliest step's lead. */
export const CHECK_HORIZON_MS = t48h;

export interface CheckedOccurrence {
  slotId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  /** The occurrence's premiere has its audio (an asset). */
  hasAudio: boolean;
}

/**
 * The steps to record for an occurrence at `now`, given those already recorded.
 * - Alerts, before the start only: the most recent due one (`t6h` once 6 h are left, else
 *   `t48h` once 48 h are left). An occurrence first seen 3 h ahead gets `t6h` only, and a
 *   `t48h` is never recorded after a `t6h`.
 * - `fallback`: from its lead until the occurrence ends (a worker that was down at T−1h still
 *   applies it; the api refuses to touch an item that already aired).
 */
export function dueSteps(
  occurrence: CheckedOccurrence,
  now: Date,
  recorded: ReadonlySet<EpisodeCheckStep> = new Set(),
): EpisodeCheckStep[] {
  if (occurrence.hasAudio) return [];
  const t = now.getTime();
  const start = occurrence.startsAt.getTime();
  const out: EpisodeCheckStep[] = [];
  if (t < start) {
    const alert = t >= start - t6h ? 't6h' : t >= start - t48h ? 't48h' : null;
    if (alert && !recorded.has(alert) && !(alert === 't48h' && recorded.has('t6h'))) {
      out.push(alert);
    }
  }
  if (t >= start - fallback && t < occurrence.endsAt.getTime() && !recorded.has('fallback')) {
    out.push('fallback');
  }
  return out;
}

/** When the next step of an occurrence falls due (for logs and tests); null if none is left. */
export function nextStepAt(occurrence: CheckedOccurrence, now: Date): Date | null {
  if (occurrence.hasAudio) return null;
  const start = occurrence.startsAt.getTime();
  const next = [start - t48h, start - t6h, start - fallback].find((at) => at > now.getTime());
  return next === undefined ? null : new Date(next);
}
