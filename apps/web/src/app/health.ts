import { type HealthResponse, healthResponseSchema } from '@ondes/shared';

/** Validates a health payload received from the api. */
export function parseHealth(payload: unknown): HealthResponse {
  return healthResponseSchema.parse(payload);
}
