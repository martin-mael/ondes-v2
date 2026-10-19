import { z } from 'zod';

/** Liveness payload returned by every service (`GET /healthz` on the api once #5 adds a server). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker', 'web']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
