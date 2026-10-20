import { NotFoundError } from '@ondes/db';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorsPlugin, HttpError } from './errors.ts';

async function app() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  app.get('/not-found', () => {
    throw new NotFoundError('station', 'x');
  });
  app.get('/http', () => {
    throw new HttpError(409, 'conflict_here', 'nope', { a: 1 });
  });
  app.get('/zod', () => z.object({ a: z.string() }).parse({}));
  app.get('/boom', () => {
    throw new Error('secret internals');
  });
  app.post('/body', { schema: { body: z.object({ n: z.number() }) } }, () => 'ok');
  return app;
}

describe('error handler', () => {
  it('maps known errors to the error contract', async () => {
    const a = await app();
    const cases = {
      '/not-found': [404, { error: 'not_found', message: 'station x not found' }],
      '/http': [409, { error: 'conflict_here', message: 'nope', details: { a: 1 } }],
      '/missing-route': [404, { error: 'not_found' }],
      '/zod': [400, { error: 'validation_failed' }],
      '/boom': [500, { error: 'internal', message: 'internal server error' }],
    } as const;
    for (const [url, [status, body]] of Object.entries(cases)) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(status);
      expect(res.json(), url).toMatchObject(body);
    }
  });

  it('reports request validation and unsupported bodies', async () => {
    const a = await app();
    const invalid = await a.inject({ method: 'POST', url: '/body', payload: { n: 'x' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('validation_failed');
    const form = await a.inject({
      method: 'POST',
      url: '/body',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'n=1',
    });
    expect(form.statusCode).toBe(415);
    expect(form.json().error).toBe('unsupported_media_type');
  });
});
