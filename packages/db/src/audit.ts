import type { Actor, AuditDiff } from '@ondes/shared';
import type { Db, Tx } from './client.ts';
import { MissingAuditError } from './errors.ts';
import { auditLog } from './schema/tenancy.ts';
import type { OrgScope, StationScope } from './tenant.ts';

export interface AuditEntry {
  /** `<entity>.<verb>`: `station.create`, `api_key.revoke`. */
  action: string;
  entity: { type: string; id: string };
  diff?: AuditDiff;
  /** Override the ids taken from the context scope (e.g. the station that was just created). */
  orgId?: string | null;
  stationId?: string | null;
}

export interface MutationContext {
  actor: Actor;
  /** `null` for global entities (users). */
  scope: OrgScope | StationScope | null;
}

export type AuditFn = (entry: AuditEntry) => Promise<void>;

/**
 * Runs a mutation in a transaction together with its audit rows. The callback must call
 * `audit()` at least once, or the transaction is rolled back with `MissingAuditError`. If the
 * mutation fails, no audit row is written either.
 *
 *     await withAudit(db, ctx, async (tx, audit) => {
 *       const [row] = await tx.update(station).set(input).where(…).returning();
 *       await audit({ action: 'station.update', entity: { type: 'station', id: row.id }, diff });
 *       return row;
 *     });
 */
export async function withAudit<T>(
  db: Db | Tx,
  ctx: MutationContext,
  fn: (tx: Tx, audit: AuditFn) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    let written = 0;
    const audit: AuditFn = async (entry) => {
      await writeAudit(tx, ctx, entry);
      written++;
    };
    const result = await fn(tx, audit);
    if (written === 0) throw new MissingAuditError();
    return result;
  });
}

/** Inserts one audit row. Prefer `withAudit`, which ties it to the mutation's transaction. */
export async function writeAudit(db: Db | Tx, ctx: MutationContext, entry: AuditEntry) {
  await db.insert(auditLog).values(auditRow(ctx, entry));
}

/**
 * Inserts one audit row per entry, a thousand per statement: bulk edits, which audit each
 * entity they change. Call it inside the mutation's transaction.
 */
export async function writeAuditMany(db: Db | Tx, ctx: MutationContext, entries: AuditEntry[]) {
  for (let i = 0; i < entries.length; i += 1000) {
    await db.insert(auditLog).values(entries.slice(i, i + 1000).map((e) => auditRow(ctx, e)));
  }
}

function auditRow(ctx: MutationContext, entry: AuditEntry): typeof auditLog.$inferInsert {
  const scope = ctx.scope;
  const scopeStationId = scope && 'stationId' in scope ? scope.stationId : null;
  return {
    orgId: entry.orgId !== undefined ? entry.orgId : (scope?.orgId ?? null),
    stationId: entry.stationId !== undefined ? entry.stationId : scopeStationId,
    actorType: ctx.actor.type,
    actorId: actorId(ctx.actor),
    action: entry.action,
    entityType: entry.entity.type,
    entityId: entry.entity.id,
    diff: entry.diff ?? {},
  };
}

function actorId(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return actor.userId;
    case 'api_key':
      return actor.apiKeyId;
    case 'system':
      return actor.name;
  }
}

/** Fields never written to the audit log, whatever the entity. */
const ALWAYS_IGNORED = new Set(['id', 'createdAt', 'updatedAt']);

/**
 * Changed fields between two versions of a row, as `{ field: { from, to } }`. Pass `null` as
 * `before` for a creation and as `after` for a deletion. `omit` drops secrets (hashes, tokens).
 */
export function auditDiff<T extends Record<string, unknown>>(
  before: T | null,
  after: T | null,
  omit: readonly (keyof T)[] = [],
): AuditDiff {
  const diff: AuditDiff = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (ALWAYS_IGNORED.has(key) || omit.includes(key as keyof T)) continue;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  return diff;
}
