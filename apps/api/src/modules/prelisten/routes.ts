import { Readable } from 'node:stream';
import { uuidSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import type { EngineAdapter } from '../engine/adapter/index.ts';

// Pre-listen (#71): a live input's audio as its DJ sends it, before it takes the air, for the
// dashboard's live sources panel. The engine serves it on its internal control port (the
// template's `prelisten/<input>` harbor outputs); this proxies it to members with `live:read`.
//   GET /stations/:stationId/live/inputs/:input/listen   audio/mpeg, until the client hangs up
// Not audited: it reads. 404 when nobody streams on the input, 503 when the engine is away, 429
// past the caps: each stream holds an engine connection and an encoder's output, so a member
// gets 2 at once and a station 4 (per api replica).

const params = z.object({ stationId: uuidSchema, input: z.coerce.number().int().min(1).max(16) });

export type PrelistenRoutesOptions = {
  /** The station's engine adapter (#35's `adapterFor`), from any replica. */
  engineFor?: (stationId: string) => Promise<Pick<EngineAdapter, 'listen'> | undefined>;
  /** Streams open at once per member (user or api key). Default 2. */
  perActor?: number;
  /** Streams open at once per station. Default 4. */
  perStation?: number;
};

/** Open streams per key. */
function counter() {
  const open = new Map<string, number>();
  return {
    count: (key: string) => open.get(key) ?? 0,
    add(key: string, delta: number) {
      const n = (open.get(key) ?? 0) + delta;
      if (n > 0) open.set(key, n);
      else open.delete(key);
    },
  };
}

export async function prelistenRoutes(app: FastifyInstance, options: PrelistenRoutesOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const perActor = options.perActor ?? 2;
  const perStation = options.perStation ?? 4;
  const byActor = counter();
  const byStation = counter();
  r.get(
    '/stations/:stationId/live/inputs/:input/listen',
    { preHandler: app.requirePermission('live', 'read'), schema: { params } },
    async (request, reply) => {
      const scope = stationScopeOf(request);
      const actor = actorOf(request);
      const who =
        actor.type === 'user'
          ? `user:${actor.userId}`
          : actor.type === 'api_key'
            ? `key:${actor.apiKeyId}`
            : `system:${actor.name}`;
      if (byActor.count(who) >= perActor || byStation.count(scope.stationId) >= perStation) {
        throw new HttpError(429, 'too_many_streams', 'too many pre-listen streams open at once');
      }
      const engine = await options.engineFor?.(scope.stationId);
      if (!engine) throw new HttpError(503, 'engine_unavailable', 'the engine is not running');
      // Held from here until the client hangs up (or the request fails), released once.
      byActor.add(who, 1);
      byStation.add(scope.stationId, 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        byActor.add(who, -1);
        byStation.add(scope.stationId, -1);
      };
      const hangUp = new AbortController();
      request.raw.on('close', () => {
        release();
        hangUp.abort();
      });
      reply.raw.on('close', release);
      let res: Response | null;
      try {
        res = await engine.listen(request.params.input, hangUp.signal);
      } catch (error) {
        release();
        if (hangUp.signal.aborted) return reply;
        request.log.warn({ err: error, stationId: scope.stationId }, 'Pre-listen failed');
        throw new HttpError(503, 'engine_unavailable', 'the engine did not answer');
      }
      if (!res?.body) {
        release();
        throw new HttpError(404, 'not_connected', 'nobody streams on this input');
      }
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      body.on('error', () => {}); // The client hung up: the abort ends the upstream fetch.
      hangUp.signal.addEventListener('abort', () => body.destroy(), { once: true });
      return reply
        .header('content-type', 'audio/mpeg')
        .header('cache-control', 'no-store')
        .header('x-accel-buffering', 'no')
        .send(body);
    },
  );
}
