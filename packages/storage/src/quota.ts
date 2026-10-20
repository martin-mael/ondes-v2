import { orgPrefix } from './keys.ts';
import type { Storage } from './storage.ts';

export type OrgUsage = {
  usedBytes: number;
  /** `null` means unlimited. */
  limitBytes: number | null;
};

/**
 * Persistence port for per-org storage usage, with a reference count per stored object.
 * Content-addressed keys mean several assets of an org can share one object, so the org is
 * charged when the first reference appears and credited when the last one goes, and the
 * object may only be deleted at that point. The DB layer implements it (e.g. a
 * `storage_object (org_id, key, size_bytes, ref_count)` table updated in one statement);
 * {@link createMemoryQuotaStore} is for tests.
 */
export interface QuotaStore {
  get(orgId: string): Promise<OrgUsage>;
  /**
   * Atomically adds a reference to `key`. Only the first reference charges `sizeBytes`, so
   * two concurrent uploads of the same content are charged once.
   */
  addReference(
    orgId: string,
    key: string,
    sizeBytes: number,
  ): Promise<{ usedBytes: number; firstReference: boolean }>;
  /**
   * Atomically removes a reference to `key`. When it was the last one, credits the object's
   * size and returns `lastReference: true`: the caller may then delete the object.
   * Removing a reference that doesn't exist is a no-op.
   */
  removeReference(
    orgId: string,
    key: string,
  ): Promise<{ usedBytes: number; lastReference: boolean }>;
  /** Overwrites the usage counter, used by {@link reconcileOrgUsage}. */
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
 * Records that an asset now references the stored object `key` (after a successful upload,
 * or when an upload turned out to be a duplicate). Charges the org on the first reference.
 */
export async function chargeStoredObject(
  store: QuotaStore,
  orgId: string,
  key: string,
  sizeBytes: number,
): Promise<number> {
  assertBytes(sizeBytes);
  return (await store.addReference(orgId, key, sizeBytes)).usedBytes;
}

/**
 * Drops an asset's reference to `key`. Deletes the object from storage, and credits the org,
 * only when no other asset still references it. Returns whether the object was deleted.
 * If the delete itself fails after the credit, the orphaned object is picked up by
 * {@link reconcileOrgUsage}, which measures the bucket.
 */
export async function releaseStoredObject(
  storage: Pick<Storage, 'delete'>,
  store: QuotaStore,
  orgId: string,
  key: string,
): Promise<{ usedBytes: number; deleted: boolean }> {
  const { usedBytes, lastReference } = await store.removeReference(orgId, key);
  if (lastReference) await storage.delete(key);
  return { usedBytes, deleted: lastReference };
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
  const objects = new Map<string, { sizeBytes: number; refs: number }>();
  const objectId = (orgId: string, key: string) => `${orgId}\u0000${key}`;
  return {
    async get(orgId) {
      return { usedBytes: used.get(orgId) ?? 0, limitBytes: limits[orgId] ?? null };
    },
    async addReference(orgId, key, sizeBytes) {
      const id = objectId(orgId, key);
      const object = objects.get(id);
      if (object) {
        object.refs++;
        return { usedBytes: used.get(orgId) ?? 0, firstReference: false };
      }
      objects.set(id, { sizeBytes, refs: 1 });
      const next = (used.get(orgId) ?? 0) + sizeBytes;
      used.set(orgId, next);
      return { usedBytes: next, firstReference: true };
    },
    async removeReference(orgId, key) {
      const id = objectId(orgId, key);
      const object = objects.get(id);
      const current = used.get(orgId) ?? 0;
      if (!object) return { usedBytes: current, lastReference: false };
      object.refs--;
      if (object.refs > 0) return { usedBytes: current, lastReference: false };
      objects.delete(id);
      const next = Math.max(0, current - object.sizeBytes);
      used.set(orgId, next);
      return { usedBytes: next, lastReference: true };
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
