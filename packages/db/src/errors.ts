/**
 * The entity doesn't exist **in this tenant**. Cross-tenant access raises this too, so callers
 * can't tell "not yours" from "doesn't exist" (map it to 404).
 */
export class NotFoundError extends Error {
  readonly entityType: string;
  readonly entityId: string;

  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} not found`);
    this.name = 'NotFoundError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** A mutation finished without writing its audit row (see `withAudit`). */
export class MissingAuditError extends Error {
  constructor() {
    super('mutation finished without an audit entry: call audit() inside withAudit()');
    this.name = 'MissingAuditError';
  }
}
