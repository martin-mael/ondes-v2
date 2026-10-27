import {
  publicErrorSchema,
  publicHistoryQuerySchema,
  publicHistorySchema,
  publicNowPlayingSchema,
  publicSlugSchema,
} from '@ondes/shared';
import { z } from 'zod';

// OpenAPI document of the public API (#74, ADR 0041), generated from the zod contracts it
// validates with: each operation below is both the route's schema (routes.ts registers the
// routes from this list) and its documentation, so the two can't drift. The schedule API
// (#75) adds its operations to `publicOperations`. Served at `GET /api/v1/public/openapi.json`.

export const PUBLIC_PREFIX = '/api/v1/public';

type ZodObjectAny = z.ZodObject<z.ZodRawShape>;

export interface PublicResponse {
  description: string;
  /** JSON body; for `text/event-stream`, the schema of each event's `data`. */
  schema?: z.ZodType;
  contentType?: 'application/json' | 'text/event-stream';
  headers?: Record<string, string>;
}

export interface PublicOperation {
  /** Fastify path under `PUBLIC_PREFIX`, e.g. `/stations/:slug/now-playing`. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  params?: ZodObjectAny;
  query?: ZodObjectAny;
  responses: Record<number, PublicResponse>;
}

export const stationSlugParams = z.object({ slug: publicSlugSchema });

const CACHE_HEADERS = {
  ETag: 'Strong validator of the content: send it back as `If-None-Match` to get a 304.',
  'Cache-Control': 'How long shared caches and browsers may keep it.',
};
const RATE_HEADERS = {
  'x-ratelimit-limit': 'Requests allowed per window, per client IP.',
  'x-ratelimit-remaining': 'Requests left in the window.',
};

const notFound: PublicResponse = {
  description: 'No station has this slug.',
  schema: publicErrorSchema,
};
const rateLimited: PublicResponse = {
  description: 'Too many requests from this IP: wait `Retry-After` seconds.',
  schema: publicErrorSchema,
  headers: { 'Retry-After': 'Seconds to wait.' },
};

export const publicOperations: PublicOperation[] = [
  {
    path: '/stations/:slug/now-playing',
    operationId: 'getNowPlaying',
    summary: 'What is on air now',
    description:
      'The item on air (with its start on the engine clock and expected length), the mode ' +
      '(automation, show, live, off air), the show block and its episode, the DJ while live, ' +
      'and the next tracks. Times are UTC; show them in `station.timezone`. To follow it in ' +
      'real time, use the `events` stream rather than polling.',
    tags: ['Now playing'],
    params: stationSlugParams,
    responses: {
      200: {
        description: 'The station now.',
        schema: publicNowPlayingSchema,
        headers: { ...CACHE_HEADERS, ...RATE_HEADERS },
      },
      304: { description: 'Unchanged since the `If-None-Match` ETag.' },
      404: notFound,
      429: rateLimited,
    },
  },
  {
    path: '/stations/:slug/history',
    operationId: 'getHistory',
    summary: 'What aired recently',
    description:
      'The last tracks, episodes and live blocks that left the air, newest first. Jingles, ' +
      'voice tracks and items skipped within seconds are left out; so is the item on air.',
    tags: ['Now playing'],
    params: stationSlugParams,
    query: publicHistoryQuerySchema,
    responses: {
      200: {
        description: 'Recent history.',
        schema: publicHistorySchema,
        headers: { ...CACHE_HEADERS, ...RATE_HEADERS },
      },
      304: { description: 'Unchanged since the `If-None-Match` ETag.' },
      400: { description: 'Invalid `limit`.', schema: publicErrorSchema },
      404: notFound,
      429: rateLimited,
    },
  },
  {
    path: '/stations/:slug/events',
    operationId: 'streamNowPlaying',
    summary: 'Now playing, in real time (Server-Sent Events)',
    description:
      'A `text/event-stream` for `EventSource`. Each `now_playing` event carries the whole ' +
      'now-playing object (same as `GET …/now-playing`): one on connect, then one whenever it ' +
      'changes. Its `id` is the ETag. Comment lines keep the connection alive; the server ' +
      'ends streams after about 30 minutes and browsers reconnect on their own. A few streams ' +
      'per client IP at most.',
    tags: ['Now playing'],
    params: stationSlugParams,
    responses: {
      200: {
        description: 'The stream; `data` of each `now_playing` event.',
        schema: publicNowPlayingSchema,
        contentType: 'text/event-stream',
      },
      404: notFound,
      429: {
        description: 'Too many streams or connection attempts from this IP.',
        schema: publicErrorSchema,
      },
      503: {
        description: 'This server has no room for another stream: retry later.',
        schema: publicErrorSchema,
      },
    },
  },
];

const toOpenApiPath = (path: string) => PUBLIC_PREFIX + path.replace(/:(\w+)/g, '{$1}');

/** The OpenAPI 3.1 document of `operations`; shared schemas (`.meta({ id })`) in components. */
export function buildOpenApi(operations: readonly PublicOperation[] = publicOperations) {
  const components: Record<string, unknown> = {};
  const jsonSchema = (schema: z.ZodType, io: 'input' | 'output') => {
    const generated = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
    // Shared schemas (`.meta({ id })`) come out as `#/$defs/<id>`: hoisted into components.
    const {
      $defs,
      $schema: _,
      ...rest
    } = JSON.parse(
      JSON.stringify(generated).replaceAll('"#/$defs/', '"#/components/schemas/'),
    ) as Record<string, unknown> & { $defs?: Record<string, unknown> };
    Object.assign(components, $defs ?? {});
    return rest;
  };
  const parameters = (location: 'path' | 'query', object: ZodObjectAny | undefined) =>
    Object.entries(object?.shape ?? {}).map(([name, field]) => {
      const schema = jsonSchema(field as z.ZodType, 'input');
      const { description, ...rest } = schema;
      return {
        name,
        in: location,
        required: location === 'path' || !(field as z.ZodType).safeParse(undefined).success,
        ...(description ? { description } : {}),
        schema: rest,
      };
    });

  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const responses: Record<string, unknown> = {};
    for (const [status, response] of Object.entries(op.responses)) {
      responses[status] = {
        description: response.description,
        ...(response.headers
          ? {
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([name, description]) => [
                  name,
                  { description, schema: { type: 'string' } },
                ]),
              ),
            }
          : {}),
        ...(response.schema
          ? {
              content: {
                [response.contentType ?? 'application/json']: {
                  schema: jsonSchema(response.schema, 'output'),
                },
              },
            }
          : {}),
      };
    }
    const path = toOpenApiPath(op.path);
    paths[path] = {
      ...paths[path],
      get: {
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        parameters: [...parameters('path', op.params), ...parameters('query', op.query)],
        responses,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Ondes public API',
      version: '1.0.0',
      description:
        "Read-only, anonymous API of a station's public surface: now playing, history, and " +
        'a real-time stream. Stations are named by their public slug. CORS is open to every ' +
        'origin (no credentials); responses carry ETags and short Cache-Control lifetimes; ' +
        'requests are rate limited per client IP.',
    },
    paths,
    components: { schemas: components },
  };
}
