/**
 * JSON with object keys sorted at every level, so equal values serialise (and hash) the same
 * whatever their key order. Used for idempotency keys (#8) and engine config versions (#27).
 */
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
