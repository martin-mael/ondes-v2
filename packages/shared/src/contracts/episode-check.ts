import { z } from 'zod';
import { uuidSchema } from './tenancy.ts';

// Missing-episode alerts and fallbacks (#47, ADR 0022).
//
// The worker's `episode-check` job looks at every pre-recorded occurrence coming up and
// records a step when one is due and the occurrence's episode has no audio: an alert at
// T−48h, another at T−6h, and the fallback at T−1h. The api works the recorded steps off
// (dashboard alert, emails to the hosts and programmers, the log edit that airs the fallback).
// Times are elapsed time before the occurrence's start (UTC instants), like slot durations
// (ADR 0014): on a DST night "48 h before" is 47 or 49 h of wall clock.

const HOUR = 3600 * 1000;

/**
 * - `t48h`, `t6h`: alert the hosts and programmers (dashboard and email). Only the most recent
 *   due one is recorded: an occurrence planned 3 h ahead gets no 48 h alert.
 * - `fallback`: decide and apply the show's fallback.
 */
export const episodeCheckStepSchema = z.enum(['t48h', 't6h', 'fallback']);
export type EpisodeCheckStep = z.infer<typeof episodeCheckStepSchema>;

/** How long before the occurrence's start each step is due. */
export const EPISODE_CHECK_LEAD_MS = {
  t48h: 48 * HOUR,
  t6h: 6 * HOUR,
  /**
   * The fallback is decided an hour ahead, not at T: the feeder queues about 10 minutes ahead
   * (ADR 0012) and the playout cache must hold the file (ADR 0004).
   */
  fallback: 1 * HOUR,
} as const satisfies Record<EpisodeCheckStep, number>;

export const EPISODE_FALLBACK_LEAD_MS = EPISODE_CHECK_LEAD_MS.fallback;

/**
 * An episode whose audio arrives after its fallback was applied still airs, if this long or
 * more is left before its start: the fallback item is put back to the episode.
 */
export const EPISODE_RESTORE_MIN_LEAD_MS = 15 * 60 * 1000;

/** `episode-check`: one pass over a station's coming occurrences (worker, `high` lane). */
export const EPISODE_CHECK_JOB = 'episode-check';
export const episodeCheckJobPayloadSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema,
});
export type EpisodeCheckJobPayload = z.infer<typeof episodeCheckJobPayloadSchema>;
