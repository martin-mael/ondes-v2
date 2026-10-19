import { type HealthResponse, healthResponseSchema } from '@ondes/shared';

export function health(): HealthResponse {
  return healthResponseSchema.parse({ status: 'ok', service: 'api' });
}
