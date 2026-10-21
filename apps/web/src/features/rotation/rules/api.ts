import {
  type PickRequest,
  pickResponseSchema,
  rotationRulesSettingsSchema,
  type UpdateRotationRules,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { request } from '../../../app/api/client.ts';

// Rotation rules api (#38): /api/v1/stations/:stationId/rotation.

const base = (stationId: string) => `/stations/${stationId}/rotation`;

export const rulesKeys = {
  settings: (stationId: string) => ['stations', stationId, 'rotation', 'rules'] as const,
};

export const rulesQuery = (stationId: string) =>
  queryOptions({
    queryKey: rulesKeys.settings(stationId),
    queryFn: ({ signal }) =>
      request(`${base(stationId)}/rules`, { schema: rotationRulesSettingsSchema, signal }),
  });

export const rulesApi = {
  save: (stationId: string, body: UpdateRotationRules) =>
    request(`${base(stationId)}/rules`, {
      method: 'PUT',
      body,
      schema: rotationRulesSettingsSchema,
    }),
  pick: (stationId: string, body: PickRequest) =>
    request(`${base(stationId)}/pick`, { body, schema: pickResponseSchema }),
};
