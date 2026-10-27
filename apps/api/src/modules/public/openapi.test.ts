import { describe, expect, it } from 'vitest';
import { buildOpenApi, PUBLIC_PREFIX, publicOperations } from './openapi.ts';

// The public OpenAPI document (#74) is generated from the operations the routes are registered
// from; `public.int.test.ts` checks that every public route is in it.

describe('buildOpenApi', () => {
  const doc = buildOpenApi();

  it('documents every operation with its parameters and responses', () => {
    expect(doc.openapi).toBe('3.1.0');
    for (const op of publicOperations) {
      const path = PUBLIC_PREFIX + op.path.replace(/:(\w+)/g, '{$1}');
      const documented = doc.paths[path]?.get as {
        operationId: string;
        parameters: { name: string; in: string }[];
        responses: Record<string, unknown>;
      };
      expect(documented.operationId).toBe(op.operationId);
      expect(documented.parameters).toContainEqual(
        expect.objectContaining({ name: 'slug', in: 'path' }),
      );
      expect(Object.keys(documented.responses)).toEqual(Object.keys(op.responses));
    }
  });

  it('resolves every $ref to a component', () => {
    const json = JSON.stringify(doc);
    const refs = [...json.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      const name = ref?.split('/').at(-1) ?? '';
      expect(doc.components.schemas).toHaveProperty(name);
    }
    expect(json).not.toContain('$defs');
  });

  it('documents the history limit as an optional query parameter', () => {
    const get = doc.paths[`${PUBLIC_PREFIX}/stations/{slug}/history`]?.get as {
      parameters: { name: string; required: boolean; schema: { maximum: number } }[];
    };
    expect(get.parameters.find((p) => p.name === 'limit')).toMatchObject({
      required: false,
      schema: { maximum: 50 },
    });
  });
});
