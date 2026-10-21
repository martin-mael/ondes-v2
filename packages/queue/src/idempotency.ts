import { createHash } from 'node:crypto';
import { stableStringify } from '@ondes/shared';

/** Re-exported for existing callers; lives in `@ondes/shared`. */
export { stableStringify };

/** Default idempotency key: `<job>:<sha256 of the canonical payload>`. */
export function defaultIdempotencyKey(jobName: string, payload: unknown): string {
  const hash = createHash('sha256')
    .update(stableStringify(payload) ?? 'undefined')
    .digest('hex');
  return `${jobName}:${hash}`;
}
