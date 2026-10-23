import {
  type LogRegenPreviewRequest,
  type LogRegenRequest,
  logRegenPreviewResponseSchema,
  logRegenResponseSchema,
} from '@ondes/shared';
import { request } from '../../../app/api/client.ts';

// Regeneration calls (#101): the dry-run with its diff, and applying it.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

export const regenApi = {
  preview: (stationId: string, body: LogRegenPreviewRequest, signal?: AbortSignal) =>
    request(`${station(stationId)}/log/regen/preview`, {
      body,
      schema: logRegenPreviewResponseSchema,
      signal,
    }),
  apply: (stationId: string, body: LogRegenRequest) =>
    request(`${station(stationId)}/log/regen`, { body, schema: logRegenResponseSchema }),
};
