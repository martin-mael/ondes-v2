import { expect, it } from 'vitest';
import { parseHealth } from './health.ts';

it('parses an api health payload with the shared contract', () => {
  expect(parseHealth({ status: 'ok', service: 'api' }).service).toBe('api');
  expect(() => parseHealth({ status: 'down' })).toThrow();
});
