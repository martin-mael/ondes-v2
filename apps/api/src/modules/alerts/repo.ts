import {
  alert,
  type Db,
  type Executor,
  membership,
  NotFoundError,
  type StationScope,
  silenceSetting,
  station,
  type Tx,
  unsafeScope,
  user,
  userAuth,
  whereStation,
} from '@ondes/db';
import {
  type Alert,
  type AlertSeverity,
  alertSeverityRank,
  type ListAlertsQuery,
  listAlertsQuerySchema,
  type RaiseAlert,
  type Role,
  raiseAlertSchema,
  rolePermissions,
  type SilenceSettings,
  silenceSettingsSchema,
  type UpdateSilenceSettings,
} from '@ondes/shared';
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';

// Alert queries (#33). Every function takes the station scope, except the escalation sweep,
// a system job over all stations that hands each row's scope back to the caller.

type AlertRow = typeof alert.$inferSelect;

export function toAlert(row: AlertRow): Alert {
  return {
    ...row,
    status: row.resolvedAt ? 'resolved' : 'open',
  };
}

const openAlert = (scope: StationScope, dedupeKey: string) =>
  and(whereStation(alert, scope), eq(alert.dedupeKey, dedupeKey), isNull(alert.resolvedAt));

const higher = (a: AlertSeverity, b: AlertSeverity) => alertSeverityRank[a] > alertSeverityRank[b];

export type RaiseResult =
  /** A new alert was opened. */
  | { kind: 'raised'; alert: Alert }
  /** The open alert went up in severity. */
  | { kind: 'escalated'; alert: Alert; previousSeverity: AlertSeverity }
  /** Same alert again: one more occurrence, nothing else changed. */
  | { kind: 'repeated'; alert: Alert };

/**
 * Opens an alert, or counts one more occurrence of the open alert with the same dedupe key.
 * A higher severity escalates the open alert; a lower one never lowers it. Safe under
 * concurrency: the partial unique index on open alerts decides who opens it.
 */
export async function raiseAlert(
  db: Db,
  scope: StationScope,
  input: RaiseAlert,
  now = new Date(),
): Promise<RaiseResult> {
  const data = raiseAlertSchema.parse(input);
  for (let attempt = 0; ; attempt++) {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(alert)
        .where(openAlert(scope, data.dedupeKey))
        .for('update');
      if (current) return bump(tx, current, data, now);

      const [created] = await tx
        .insert(alert)
        .values({
          orgId: scope.orgId,
          stationId: scope.stationId,
          type: data.type,
          severity: data.severity,
          dedupeKey: data.dedupeKey,
          title: data.title,
          message: data.message ?? null,
          details: data.details ?? {},
          raisedAt: now,
          lastSeenAt: now,
          ...escalation(data, now),
        })
        .onConflictDoNothing()
        .returning();
      return created ? ({ kind: 'raised', alert: toAlert(created) } as const) : null;
    });
    if (result) return result;
    // Another raise opened it between our select and insert: bump that one.
    if (attempt >= 2) throw new Error(`could not raise alert ${data.dedupeKey}`);
  }
}

function escalation(data: ReturnType<typeof raiseAlertSchema.parse>, now: Date) {
  if (!data.escalate || !higher(data.escalate.to, data.severity)) {
    return { escalateAt: null, escalateTo: null };
  }
  return {
    escalateAt: new Date(now.getTime() + data.escalate.afterSeconds * 1000),
    escalateTo: data.escalate.to,
  };
}

async function bump(
  tx: Tx,
  current: AlertRow,
  data: ReturnType<typeof raiseAlertSchema.parse>,
  now: Date,
): Promise<RaiseResult> {
  const escalates = higher(data.severity, current.severity);
  // A pending escalation that the new severity already reaches is done.
  const pendingDone = current.escalateTo && !higher(current.escalateTo, data.severity);
  const [row] = await tx
    .update(alert)
    .set({
      occurrences: sql`${alert.occurrences} + 1`,
      lastSeenAt: now,
      details: { ...current.details, ...data.details },
      ...(escalates
        ? {
            severity: data.severity,
            escalatedAt: now,
            title: data.title,
            message: data.message ?? current.message,
          }
        : {}),
      ...(escalates && pendingDone ? { escalateAt: null, escalateTo: null } : {}),
      // An escalation schedule on a repeat raise only applies if none is pending.
      ...(!current.escalateAt && !escalates ? escalation(data, now) : {}),
    })
    .where(eq(alert.id, current.id))
    .returning();
  if (!row) throw new Error('alert vanished under lock');
  return escalates
    ? { kind: 'escalated', alert: toAlert(row), previousSeverity: current.severity }
    : { kind: 'repeated', alert: toAlert(row) };
}

/** Resolves the open alert with this dedupe key, if any. */
export async function resolveAlert(
  db: Executor,
  scope: StationScope,
  dedupeKey: string,
  resolution: string,
  now = new Date(),
): Promise<Alert | null> {
  const [row] = await db
    .update(alert)
    .set({ resolvedAt: now, resolution, escalateAt: null, escalateTo: null })
    .where(openAlert(scope, dedupeKey))
    .returning();
  return row ? toAlert(row) : null;
}

/** Resolves an open alert by id (API). Null if it was already resolved. */
export async function resolveAlertById(
  db: Executor,
  scope: StationScope,
  alertId: string,
  resolution: string,
  now = new Date(),
): Promise<Alert | null> {
  const [row] = await db
    .update(alert)
    .set({ resolvedAt: now, resolution, escalateAt: null, escalateTo: null })
    .where(and(whereStation(alert, scope), eq(alert.id, alertId), isNull(alert.resolvedAt)))
    .returning();
  return row ? toAlert(row) : null;
}

/** Marks an open alert acknowledged by a user. Null if already acknowledged or resolved. */
export async function acknowledgeAlert(
  db: Executor,
  scope: StationScope,
  alertId: string,
  userId: string | null,
  now = new Date(),
): Promise<Alert | null> {
  const [row] = await db
    .update(alert)
    .set({ acknowledgedAt: now, acknowledgedBy: userId })
    .where(
      and(
        whereStation(alert, scope),
        eq(alert.id, alertId),
        isNull(alert.resolvedAt),
        isNull(alert.acknowledgedAt),
      ),
    )
    .returning();
  return row ? toAlert(row) : null;
}

export async function getAlert(db: Executor, scope: StationScope, alertId: string): Promise<Alert> {
  const [row] = await db
    .select()
    .from(alert)
    .where(and(whereStation(alert, scope), eq(alert.id, alertId)));
  if (!row) throw new NotFoundError('alert', alertId);
  return toAlert(row);
}

/** Newest first. Cursor = the last alert id of the previous page (ids are UUIDv7). */
export async function listAlerts(
  db: Executor,
  scope: StationScope,
  query: ListAlertsQuery = {},
): Promise<{ items: Alert[]; nextCursor: string | null }> {
  const q = listAlertsQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(alert)
    .where(
      and(
        whereStation(alert, scope),
        q.status === 'open' ? isNull(alert.resolvedAt) : undefined,
        q.status === 'resolved' ? isNotNull(alert.resolvedAt) : undefined,
        q.type ? eq(alert.type, q.type) : undefined,
        q.before ? lt(alert.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(alert.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit).map(toAlert);
  return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
}

export type DueEscalation = {
  scope: StationScope;
  alert: Alert;
  previousSeverity: AlertSeverity;
};

/**
 * Applies every time-based escalation that is due, across stations (a system sweep). Rows
 * locked by another replica's sweep are skipped, so each escalation happens once.
 */
export async function escalateDue(db: Db, now = new Date()): Promise<DueEscalation[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(alert)
      .where(and(isNull(alert.resolvedAt), lte(alert.escalateAt, now)))
      .for('update', { skipLocked: true });
    const out: DueEscalation[] = [];
    for (const current of due) {
      const to = current.escalateTo;
      const escalates = to !== null && higher(to, current.severity);
      const [row] = await tx
        .update(alert)
        .set({
          escalateAt: null,
          escalateTo: null,
          ...(escalates ? { severity: to, escalatedAt: now } : {}),
        })
        .where(eq(alert.id, current.id))
        .returning();
      if (row && escalates) {
        out.push({
          scope: unsafeScope(row.orgId, row.stationId),
          alert: toAlert(row),
          previousSeverity: current.severity,
        });
      }
    }
    return out;
  });
}

/** The scope of a station known only by id (engine events). Null if there is none. */
export async function stationScopeById(
  db: Executor,
  stationId: string,
): Promise<StationScope | null> {
  const [row] = await db
    .select({ orgId: station.orgId })
    .from(station)
    .where(eq(station.id, stationId));
  // The ids were just read from the station row.
  return row ? unsafeScope(row.orgId, stationId) : null;
}

/** Roles that may manage alerts: they get the emails. */
const managerRoles = (Object.keys(rolePermissions) as Role[]).filter((role) =>
  rolePermissions[role].includes('alert:manage'),
);

/**
 * Who to email about a station's alerts: members with `alert:manage` on it (station managers
 * of the station, org owners and admins) whose email address is verified.
 */
export async function alertRecipients(
  db: Executor,
  scope: StationScope,
): Promise<Array<{ email: string; name: string }>> {
  return db
    .selectDistinct({ email: user.email, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .innerJoin(userAuth, eq(userAuth.userId, user.id))
    .where(
      and(
        eq(membership.orgId, scope.orgId),
        inArray(membership.role, managerRoles),
        or(isNull(membership.stationId), eq(membership.stationId, scope.stationId)),
        isNotNull(userAuth.emailVerifiedAt),
      ),
    )
    .orderBy(user.email);
}

// --- Silence settings --------------------------------------------------------------------
// One source of truth per value: the template's `blank` settings (threshold, duration) live in
// `station.engine_settings.blank`, which the engine lifecycle (#35) renders from; the app's
// own (action, escalation) live in `silence_setting`. Defaults apply to whatever is unset.

const stationOf = (scope: StationScope) =>
  and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId));

/** The station's silence settings, defaults where none were saved. */
export async function getSilenceSettings(
  db: Executor,
  scope: StationScope,
): Promise<SilenceSettings> {
  const [[st], [row]] = await Promise.all([
    db.select({ engineSettings: station.engineSettings }).from(station).where(stationOf(scope)),
    db.select().from(silenceSetting).where(whereStation(silenceSetting, scope)),
  ]);
  if (!st) throw new NotFoundError('station', scope.stationId);
  const blank = (st.engineSettings.blank ?? {}) as { maxSeconds?: unknown; thresholdDb?: unknown };
  return silenceSettingsSchema.parse({
    maxSeconds: blank.maxSeconds,
    thresholdDb: blank.thresholdDb,
    action: row?.action,
    escalateAfterSeconds: row?.escalateAfterSeconds,
  });
}

/**
 * Saves a patch: `maxSeconds` / `thresholdDb` into `station.engine_settings.blank` (other
 * engine settings untouched), the rest into `silence_setting`. Run it in a transaction.
 */
export async function updateSilenceSettings(
  db: Executor,
  scope: StationScope,
  patch: UpdateSilenceSettings,
): Promise<{ before: SilenceSettings; after: SilenceSettings }> {
  const before = await getSilenceSettings(db, scope);
  const after = silenceSettingsSchema.parse({ ...before, ...patch });
  if (patch.maxSeconds !== undefined || patch.thresholdDb !== undefined) {
    const blank = { maxSeconds: after.maxSeconds, thresholdDb: after.thresholdDb };
    await db
      .update(station)
      .set({
        engineSettings: sql`${station.engineSettings} || jsonb_build_object('blank', coalesce(${station.engineSettings} -> 'blank', '{}'::jsonb) || ${JSON.stringify(blank)}::jsonb)`,
      })
      .where(stationOf(scope));
  }
  if (patch.action !== undefined || patch.escalateAfterSeconds !== undefined) {
    const own = { action: after.action, escalateAfterSeconds: after.escalateAfterSeconds };
    await db
      .insert(silenceSetting)
      .values({ stationId: scope.stationId, orgId: scope.orgId, ...own })
      .onConflictDoUpdate({ target: silenceSetting.stationId, set: own });
  }
  return { before, after };
}

/** Adds keys to an alert's details (what an automatic action did). No event. */
export async function mergeAlertDetails(
  db: Executor,
  scope: StationScope,
  alertId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .update(alert)
    .set({ details: sql`${alert.details} || ${JSON.stringify(details)}::jsonb` })
    .where(and(whereStation(alert, scope), eq(alert.id, alertId)));
}
