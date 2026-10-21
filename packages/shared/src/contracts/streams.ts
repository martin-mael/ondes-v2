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
