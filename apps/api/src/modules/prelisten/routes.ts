import { Readable } from 'node:stream';
import { uuidSchema } from '@ondes/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stationScopeOf } from '../../plugins/auth.ts';
import { HttpError } from '../../plugins/errors.ts';
import type { EngineAdapter } from '../engine/adapter/index.ts';

// Pre-listen (#71): a live input's audio as its DJ sends it, before it takes the air, for the
// dashboard's live sources panel. The engine serves it on its internal control port (the
// template's `prelisten/<input>` harbor outputs); this proxies it to members with `live:read`.
//   GET /stations/:stationId/live/inputs/:input/listen   audio/mpeg, until the client hangs up
// Not audited: it reads. 404 when nobody streams on the input, 503 when the engine is away.

const params = z.object({ stationId: uuidSchema, input: z.coerce.number().int().min(1).max(16) });

export type PrelistenRoutesOptions = {
  /** The station's engine adapter (#35's `adapterFor`), from any replica. */
  engineFor?: (stationId: string) => Promise<Pick<EngineAdapter, 'listen'> | undefined>;
};

export async function prelistenRoutes(app: FastifyInstance, options: PrelistenRoutesOptions) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/stations/:stationId/live/inputs/:input/listen',
    { preHandler: app.requirePermission('live', 'read'), schema: { params } },
    async (request, reply) => {
      const scope = stationScopeOf(request);
      const engine = await options.engineFor?.(scope.stationId);
      if (!engine) throw new HttpError(503, 'engine_unavailable', 'the engine is not running');
      const hangUp = new AbortController();
      request.raw.on('close', () => hangUp.abort());
      let res: Response | null;
      try {
        res = await engine.listen(request.params.input, hangUp.signal);
      } catch (error) {
        if (hangUp.signal.aborted) return reply;
        request.log.warn({ err: error, stationId: scope.stationId }, 'Pre-listen failed');
        throw new HttpError(503, 'engine_unavailable', 'the engine did not answer');
      }
      if (!res?.body) throw new HttpError(404, 'not_connected', 'nobody streams on this input');
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      body.on('error', () => {}); // The client hung up: the abort ends the upstream fetch.
      return reply
        .header('content-type', 'audio/mpeg')
        .header('cache-control', 'no-store')
        .header('x-accel-buffering', 'no')
        .send(body);
    },
  );
}
