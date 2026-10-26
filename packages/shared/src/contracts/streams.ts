import { z } from 'zod';
import { dateInputSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Public streams (#32): listener statistics per Icecast mount. Mirrors
// packages/db/src/schema/streams.ts. Counts only, never a listener's IP address (GDPR).

/** Icecast mount with its leading slash, in the station's namespace: `/vandale/mp3`. */
export const streamMountSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/, 'invalid mount');

/** One poll of one mount, as the stats poller records it. */
export const listenerSampleSchema = z.object({
  stationId: uuidSchema,
  mount: streamMountSchema,
  at: z.date(),
  /** Listeners on the mount, including those parked on its fallback file. */
  listeners: z.int().min(0),
  /** The engine was connected to the mount (otherwise listeners got the fallback). */
  sourceConnected: z.boolean(),
});
export type ListenerSample = z.infer<typeof listenerSampleSchema>;

/** Bucket sizes: minutes for recent data, hours once downsampled. */
export const listenerBucketSecondsSchema = z.union([z.literal(60), z.literal(3600)]);

/** One bucket (a minute, or an hour for older data) of one mount. */
export const listenerStatSchema = z.object({
  mount: streamMountSchema,
  /** Start of the bucket, UTC. */
  bucketStart: z.date(),
  bucketSeconds: listenerBucketSecondsSchema,
  samples: z.int().min(1),
  listenersAvg: z.number().min(0),
  listenersMax: z.int().min(0),
  listenersMin: z.int().min(0),
  /** Share of the bucket's samples where the engine fed the mount, 0–1. */
  sourceUptime: z.number().min(0).max(1),
});
export type ListenerStat = z.infer<typeof listenerStatSchema>;

export const listListenerStatsQuerySchema = z
  .object({
    mount: streamMountSchema.optional(),
    from: dateInputSchema,
    to: dateInputSchema,
  })
  .refine((q) => q.to > q.from, { message: 'must be after from', path: ['to'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= 366 * 86_400_000, {
    message: 'at most 366 days',
    path: ['to'],
  });
export type ListListenerStatsQuery = z.input<typeof listListenerStatsQuerySchema>;

// --- Dashboard (#71) -----------------------------------------------------------------------

/**
 * `GET /api/v1/stations/:stationId/listeners`: listeners per mount now, from the newest minute
 * bucket of each mount seen in the last 3 minutes (the poller samples every 15 s). Empty when
 * the poller isn't running or Icecast can't be read: unknown is not zero.
 */
export const currentListenersSchema = z.object({
  /** Newest bucket among the mounts; null when there is no recent data. */
  sampledAt: z.date().nullable(),
  total: z.int().min(0),
  mounts: z.array(
    z.object({
      mount: streamMountSchema,
      /** The bucket's average, rounded. */
      listeners: z.int().min(0),
      listenersMax: z.int().min(0),
      /** The engine fed the mount for most of the bucket (otherwise listeners got its fallback). */
      sourceConnected: z.boolean(),
      /** Start of the minute bucket read. */
      sampledAt: z.date(),
    }),
  ),
});
export type CurrentListeners = z.infer<typeof currentListenersSchema>;

export const listenerHistoryQuerySchema = z.object({
  /** Hours back from now. Default 24. */
  hours: z.coerce.number().int().min(1).max(168).default(24),
});
export type ListenerHistoryQuery = z.input<typeof listenerHistoryQuerySchema>;

/**
 * `GET /api/v1/stations/:stationId/listeners/history`: average listeners per step (288 steps,
 * 5 min over 24 h), per mount and in total. A step without any sample is null (no data), not 0.
 */
export const listenerHistorySchema = z.object({
  startsAt: z.date(),
  endsAt: z.date(),
  stepSeconds: z.int().positive(),
  /** Mounts with data in the range, sorted. */
  mounts: z.array(streamMountSchema),
  points: z.array(
    z.object({
      /** Start of the step, UTC. */
      startsAt: z.date(),
      total: z.number().min(0).nullable(),
      /** Mount -> average listeners; mounts without data in the step are absent. */
      byMount: z.record(z.string(), z.number().min(0)),
    }),
  ),
});
export type ListenerHistory = z.infer<typeof listenerHistorySchema>;
