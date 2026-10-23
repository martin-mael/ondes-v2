import { z } from 'zod';
import { asRunSourceSchema } from './asrun.ts';
import { logItemKindSchema, logItemTimingSchema } from './log.ts';
import { slotTypeSchema } from './shows.ts';
import { uuidSchema } from './tenancy.ts';

// On air (#70): what the dashboard shows of the station right now, in one read. Internal and
// authenticated (`dashboard:read`); the public now-playing API is #74. The client refetches it
// on the real-time events that change it (ADR 0034), never on a timer.

const isoTime = z.iso.datetime({ offset: true });

/**
 * - `automation`: the log plays (music, jingles, VTs);
 * - `show`: a pre-recorded episode is on air;
 * - `live`: a DJ is on air;
 * - `safety` / `emergency`: the engine fell back to the safety playlist or the emergency file;
 * - `off_air`: nothing is on air (no open as-run entry: the engine is down or restarting).
 */
export const onAirModeKindSchema = z.enum([
  'automation',
  'show',
  'live',
  'safety',
  'emergency',
  'off_air',
]);
export type OnAirModeKind = z.infer<typeof onAirModeKindSchema>;

export const onAirModeSchema = z.object({
  kind: onAirModeKindSchema,
  /** `live`: the DJ on air (their streamer's display name); null when unknown. */
  djName: z.string().nullable(),
});
export type OnAirMode = z.infer<typeof onAirModeSchema>;

/** The item on air: the station's open as-run entry, with its cue markers. */
export const onAirCurrentSchema = z.object({
  asRunId: uuidSchema,
  source: asRunSourceSchema,
  kind: logItemKindSchema.nullable(),
  logItemId: uuidSchema.nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  /** On the engine's clock, UTC (the as-run's `startedAt`). */
  startedAt: isoTime,
  /** How long it is expected to play, in ms: the log's plan, else the asset's cues. */
  durationMs: z.int().nonnegative().nullable(),
  /** End of the intro, in ms after `startedAt` (the asset's `introEnd` cue). */
  introMs: z.int().nonnegative().nullable(),
  /** Start of the outro, in ms after `startedAt` (the asset's `outroStart` cue). */
  outroMs: z.int().nonnegative().nullable(),
});
export type OnAirCurrent = z.infer<typeof onAirCurrentSchema>;

/** One of the next log items, with its start re-estimated from what is on air. */
export const onAirNextItemSchema = z.object({
  logItemId: uuidSchema,
  kind: logItemKindSchema,
  timing: logItemTimingSchema,
  title: z.string().nullable(),
  artists: z.array(z.string()),
  plannedStart: isoTime,
  estimatedStart: isoTime,
  durationMs: z.int().nonnegative(),
});
export type OnAirNextItem = z.infer<typeof onAirNextItemSchema>;

/** The next fixed point in time: a show starting, a hard or soft start, a marker. */
export const onAirHardEventSchema = z.object({
  kind: z.enum(['show', 'hard_start', 'soft_start', 'marker']),
  at: isoTime,
  /** The show's name, or the log item's title. */
  title: z.string().nullable(),
  logItemId: uuidSchema.nullable(),
  showId: uuidSchema.nullable(),
});
export type OnAirHardEvent = z.infer<typeof onAirHardEventSchema>;

/** The show block the station is in (its slot occurrence). */
export const onAirShowSchema = z.object({
  showId: uuidSchema,
  name: z.string(),
  colour: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  type: slotTypeSchema,
  startsAt: isoTime,
  endsAt: isoTime,
  /** The episode of this occurrence (for a rerun, the episode aired again). */
  episode: z.object({ id: uuidSchema, number: z.int(), title: z.string().nullable() }).nullable(),
  rerun: z.boolean(),
});
export type OnAirShow = z.infer<typeof onAirShowSchema>;

/** `GET /api/v1/stations/:stationId/on-air` */
export const onAirSchema = z.object({
  /** The api's clock when it answered. */
  at: isoTime,
  mode: onAirModeSchema,
  current: onAirCurrentSchema.nullable(),
  /** At most `ON_AIR_NEXT_ITEMS`, in play order. */
  next: z.array(onAirNextItemSchema),
  nextHardEvent: onAirHardEventSchema.nullable(),
  show: onAirShowSchema.nullable(),
});
export type OnAir = z.infer<typeof onAirSchema>;

export const ON_AIR_NEXT_ITEMS = 5;
