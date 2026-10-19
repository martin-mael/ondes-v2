import { createHash } from 'node:crypto';

/** JSON with object keys sorted, so equal payloads hash the same whatever their key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, obj[k]]),
      );
    }
    return v;
  });
}

/** Default idempotency key: `<job>:<sha256 of the canonical payload>`. */
export function defaultIdempotencyKey(jobName: string, payload: unknown): string {
  const hash = createHash('sha256')
    .update(stableStringify(payload) ?? 'undefined')
    .digest('hex');
  return `${jobName}:${hash}`;
}
