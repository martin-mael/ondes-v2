import { expect, it } from 'vitest';
import { health } from './health.ts';

it('reports the api as healthy', () => {
  expect(health()).toEqual({ status: 'ok', service: 'api' });
});
