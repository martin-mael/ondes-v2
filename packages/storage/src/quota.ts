import { orgPrefix } from './keys.ts';
import type { Storage } from './storage.ts';

export type OrgUsage = {
  usedBytes: number;
  /** `null` means unlimited. */
  limitBytes: number | null;
};

/**
 * Persistence port for per-org storage counters. #5's schema backs it in Postgres; this
 * package only defines the contract (plus {@link createMemoryQuotaStore} for tests).
 * `add` must be atomic (e.g. `UPDATE … SET used_bytes = used_bytes + $delta RETURNING`).
 */
export interface QuotaStore {
  get(orgId: string): Promise<OrgUsage>;
  /** Adds `deltaBytes` (may be negative) and returns the new total, never below 0. */
  add(orgId: string, deltaBytes: number): Promise<number>;
  /** Overwrites the counter, used by {@link reconcileOrgUsage}. */
  set(orgId: string, usedBytes: number): Promise<void>;
}

export class QuotaExceededError extends Error {
  readonly orgId: string;
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly requestedBytes: number;

  constructor(
    orgId: string,
    usage: { usedBytes: number; limitBytes: number },
    requestedBytes: number,
  ) {
    super(
      `Storage quota exceeded for org ${orgId}: ${usage.usedBytes} + ${requestedBytes} > ${usage.limitBytes} bytes`,
    );
    this.name = 'QuotaExceededError';
    this.orgId = orgId;
    this.usedBytes = usage.usedBytes;
    this.limitBytes = usage.limitBytes;
    this.requestedBytes = requestedBytes;
  }
}

/**
 * Throws {@link QuotaExceededError} if storing `incomingBytes` more would go over the org's
 * limit. Call it before handing out upload URLs; it doesn't reserve anything.
 */
export async function assertQuota(
  store: QuotaStore,
  orgId: string,
  incomingBytes: number,
): Promise<OrgUsage> {
  assertBytes(incomingBytes);
  const usage = await store.get(orgId);
  if (usage.limitBytes !== null && usage.usedBytes + incomingBytes > usage.limitBytes) {
    throw new QuotaExceededError(
      orgId,
      { usedBytes: usage.usedBytes, limitBytes: usage.limitBytes },
      incomingBytes,
    );
  }
  return usage;
}

/**
 * Charges the org for an object that now exists in storage. Content-addressed keys dedupe,
 * so pass `alreadyExisted: true` (from a `head` before the upload) to skip double counting.
 */
export async function chargeStoredObject(
  store: QuotaStore,
  orgId: string,
  sizeBytes: number,
  { alreadyExisted = false }: { alreadyExisted?: boolean } = {},
): Promise<number> {
  assertBytes(sizeBytes);
  if (alreadyExisted) return (await store.get(orgId)).usedBytes;
  return store.add(orgId, sizeBytes);
}

/** Credits the org for a deleted object. */
export async function releaseStoredObject(
  store: QuotaStore,
  orgId: string,
  sizeBytes: number,
): Promise<number> {
  assertBytes(sizeBytes);
  return store.add(orgId, -sizeBytes);
}

/** Sums the size of every object under the org's prefix. The bucket is the source of truth. */
export async function measureOrgUsage(storage: Storage, orgId: string): Promise<number> {
  let total = 0;
  for await (const object of storage.list(orgPrefix(orgId))) total += object.size;
  return total;
}

/** Resets the counter from what the bucket actually holds (periodic job, or after a crash). */
export async function reconcileOrgUsage(
  storage: Storage,
  store: QuotaStore,
  orgId: string,
): Promise<number> {
  const usedBytes = await measureOrgUsage(storage, orgId);
  await store.set(orgId, usedBytes);
  return usedBytes;
}

/** In-memory {@link QuotaStore} for tests and scripts. */
export function createMemoryQuotaStore(limits: Record<string, number | null> = {}): QuotaStore {
  const used = new Map<string, number>();
  return {
    async get(orgId) {
      return { usedBytes: used.get(orgId) ?? 0, limitBytes: limits[orgId] ?? null };
    },
    async add(orgId, deltaBytes) {
      const next = Math.max(0, (used.get(orgId) ?? 0) + deltaBytes);
      used.set(orgId, next);
      return next;
    },
    async set(orgId, usedBytes) {
      used.set(orgId, usedBytes);
    },
  };
}

function assertBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid byte count: ${bytes}`);
  }
}
