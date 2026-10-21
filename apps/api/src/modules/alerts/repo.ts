import {
  alert,
  alertEngineBoot,
  alertEventSeen,
  alertNotification,
  type Db,
  type Executor,
  membership,
  NotFoundError,
  type StationScope,
  type StoredAlertAction,
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
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';

// Alert queries (#33). Every function takes the station scope, except the system sweeps
// (escalation, pending actions, reconcile, emails), which hand each row's scope back.

type AlertRow = typeof alert.$inferSelect;
type RaiseData = ReturnType<typeof raiseAlertSchema.parse>;

export function toAlert(row: AlertRow): Alert {
  return {
    ...row,
    status: row.resolvedAt ? 'resolved' : 'open',
    action: row.action ? { ...row.action, updatedAt: new Date(row.action.updatedAt) } : null,
  };
}

const openAlert = (scope: StationScope, dedupeKey: string) =>
  and(whereStation(alert, scope), eq(alert.dedupeKey, dedupeKey), isNull(alert.resolvedAt));

const higher = (a: AlertSeverity, b: AlertSeverity) => alertSeverityRank[a] > alertSeverityRank[b];
const max = (a: AlertSeverity, b: AlertSeverity) => (higher(a, b) ? a : b);
const later = (a: Date, b: Date) => (a > b ? a : b);

const pendingAction = (name: string | undefined, now: Date): StoredAlertAction | null =>
  name ? { name, state: 'pending', attempts: 0, error: null, updatedAt: now.toISOString() } : null;

export type RaiseResult =
  /** A new alert was opened. */
  | { kind: 'raised'; alert: Alert }
  /** The same problem came back within the reopen window: the last alert is open again. */
  | { kind: 'reopened'; alert: Alert }
  /** The open alert went up in severity. */
  | { kind: 'escalated'; alert: Alert; previousSeverity: AlertSeverity }
  /** Same alert again: one more occurrence, nothing else changed. */
  | { kind: 'repeated'; alert: Alert }
  /** The problem was observed before the last resolve of this key (a late event): ignored. */
  | { kind: 'stale' };

export type RaiseOptions = {
  now: Date;
  /** When the problem was observed (an event's time). Defaults to `now`. */
  occurredAt?: Date;
  /** A key resolved less than this long ago is reopened instead of raised anew. */
  reopenWithinMs: number;
};

/** Thrown inside a raise transaction that lost a race; the caller retries the transaction. */
export const RAISE_RACE = Symbol('raise race');

/**
 * Opens an alert, reopens the last one with the same key (resolved within the reopen window),
 * or counts one more occurrence of the open one. A higher severity escalates the open alert;
 * a lower one never lowers it. Runs inside the caller's transaction; throws `RAISE_RACE` when
 * a concurrent raise won (partial unique index), and the caller retries.
 */
export async function raiseIn(
  tx: Tx,
  scope: StationScope,
  input: RaiseAlert,
  options: RaiseOptions,
): Promise<RaiseResult> {
  const data = raiseAlertSchema.parse(input);
  const { now } = options;
  const at = options.occurredAt ?? now;

  const [current] = await tx
    .select()
    .from(alert)
    .where(openAlert(scope, data.dedupeKey))
    .for('update');
  if (current) return bump(tx, current, data, at, now);

  const [last] = await tx
    .select()
    .from(alert)
    .where(and(whereStation(alert, scope), eq(alert.dedupeKey, data.dedupeKey)))
    .orderBy(desc(alert.id))
    .limit(1)
    .for('update');
  if (last?.resolvedAt && options.occurredAt && last.resolvedAt >= at) return { kind: 'stale' };

  if (last?.resolvedAt && at.getTime() - last.resolvedAt.getTime() < options.reopenWithinMs) {
    const severity = max(last.severity, data.severity);
    const [row] = await tx
      .update(alert)
      .set({
        resolvedAt: null,
        resolution: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        severity,
        escalatedAt: higher(severity, last.severity) ? now : last.escalatedAt,
        occurrences: sql`${alert.occurrences} + 1`,
        lastSeenAt: at,
        title: data.title,
        message: data.message ?? last.message,
        details: { ...last.details, ...data.details },
        action: pendingAction(data.action, now),
        ...escalation(data, severity, at),
      })
      .where(eq(alert.id, last.id))
      .returning()
      .catch(raceOnUniqueViolation);
    if (!row) throw RAISE_RACE;
    return { kind: 'reopened', alert: toAlert(row) };
  }

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
      raisedAt: at,
      lastSeenAt: at,
      action: pendingAction(data.action, now),
      ...escalation(data, data.severity, at),
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw RAISE_RACE;
  return { kind: 'raised', alert: toAlert(created) };
}

function raceOnUniqueViolation(error: unknown): never {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === '23505' || e.cause?.code === '23505') throw RAISE_RACE;
  throw error;
}

/** The time-based escalation of a raise, counted from `from` (when the problem started). */
function escalation(data: RaiseData, severity: AlertSeverity, from: Date) {
  if (!data.escalate || !higher(data.escalate.to, severity)) {
    return { escalateAt: null, escalateTo: null };
  }
  return {
    escalateAt: new Date(from.getTime() + data.escalate.afterSeconds * 1000),
    escalateTo: data.escalate.to,
  };
}

async function bump(
  tx: Tx,
  current: AlertRow,
  data: RaiseData,
  at: Date,
  now: Date,
): Promise<RaiseResult> {
  const escalates = higher(data.severity, current.severity);
  // A pending escalation that the new severity already reaches is done.
  const pendingDone = current.escalateTo && !higher(current.escalateTo, data.severity);
  const [row] = await tx
    .update(alert)
    .set({
      occurrences: sql`${alert.occurrences} + 1`,
      lastSeenAt: later(current.lastSeenAt, at),
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
      ...(!current.escalateAt && !escalates ? escalation(data, current.severity, at) : {}),
    })
    .where(eq(alert.id, current.id))
    .returning();
  if (!row) throw new Error('alert vanished under lock');
  return escalates
    ? { kind: 'escalated', alert: toAlert(row), previousSeverity: current.severity }
    : { kind: 'repeated', alert: toAlert(row) };
}

export type ResolveResult = Alert | null | 'stale';

/**
 * Resolves the open alert with this dedupe key, if any. With `occurredAt` (an event's time),
 * an open alert last raised after it stays open: the resolve is older than the problem.
 */
export async function resolveIn(
  db: Executor,
  scope: StationScope,
  dedupeKey: string,
  resolution: string,
  options: { now: Date; occurredAt?: Date },
): Promise<ResolveResult> {
  const [current] = await db
    .select({ lastSeenAt: alert.lastSeenAt })
    .from(alert)
    .where(openAlert(scope, dedupeKey))
    .for('update');
  if (!current) return null;
  if (options.occurredAt && current.lastSeenAt > options.occurredAt) return 'stale';
  const [row] = await db
    .update(alert)
    .set({
      resolvedAt: options.occurredAt ?? options.now,
      resolution,
      escalateAt: null,
      escalateTo: null,
    })
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

/** An alert by id across stations, with its scope (system jobs: emails, actions). */
export async function findAlert(
  db: Executor,
  alertId: string,
): Promise<{ scope: StationScope; alert: Alert } | null> {
  const [row] = await db.select().from(alert).where(eq(alert.id, alertId));
  // The ids were just read from the alert row.
  return row ? { scope: unsafeScope(row.orgId, row.stationId), alert: toAlert(row) } : null;
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
 * locked by another replica's sweep are skipped, so each escalation happens once. A failed
 * action goes back to pending, for one more attempt.
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
      const retryAction =
        escalates && current.action?.state === 'failed'
          ? {
              action: {
                ...current.action,
                state: 'pending' as const,
                updatedAt: now.toISOString(),
              },
            }
          : {};
      const [row] = await tx
        .update(alert)
        .set({
          escalateAt: null,
          escalateTo: null,
          ...(escalates ? { severity: to, escalatedAt: now, ...retryAction } : {}),
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

// --- Actions -----------------------------------------------------------------------------

/**
 * Claims an open alert's pending action (pending -> running). Null if it isn't pending any
 * more: another replica claimed it, or the alert resolved (never act on a problem that is
 * gone, e.g. skip a healthy item after the silence ended).
 */
export async function claimAction(
  db: Executor,
  alertId: string,
  now = new Date(),
): Promise<{ scope: StationScope; alert: Alert } | null> {
  const [row] = await db
    .update(alert)
    .set({
      action: sql`${alert.action} || jsonb_build_object('state', 'running', 'attempts', coalesce((${alert.action} ->> 'attempts')::int, 0) + 1, 'updatedAt', ${now.toISOString()}::text)`,
    })
    .where(
      and(
        eq(alert.id, alertId),
        isNull(alert.resolvedAt),
        sql`${alert.action} ->> 'state' = 'pending'`,
      ),
    )
    .returning();
  return row ? { scope: unsafeScope(row.orgId, row.stationId), alert: toAlert(row) } : null;
}

export async function finishAction(
  db: Executor,
  alertId: string,
  outcome: { state: 'done' | 'failed'; error: string | null },
  now = new Date(),
): Promise<void> {
  const patch = JSON.stringify({ ...outcome, updatedAt: now.toISOString() });
  await db
    .update(alert)
    .set({ action: sql`${alert.action} || ${patch}::jsonb` })
    .where(and(eq(alert.id, alertId), sql`${alert.action} ->> 'state' = 'running'`));
}

/** Open alerts with a pending action, oldest first (optionally of one station). */
export async function pendingActions(
  db: Executor,
  stationId?: string,
): Promise<Array<{ alertId: string; stationId: string; name: string }>> {
  const rows = await db
    .select({ alertId: alert.id, stationId: alert.stationId, action: alert.action })
    .from(alert)
    .where(
      and(
        isNull(alert.resolvedAt),
        sql`${alert.action} ->> 'state' = 'pending'`,
        stationId ? eq(alert.stationId, stationId) : undefined,
      ),
    )
    .orderBy(alert.id)
    .limit(100);
  return rows.flatMap((r) =>
    r.action ? [{ alertId: r.alertId, stationId: r.stationId, name: r.action.name }] : [],
  );
}

// --- Event bookkeeping (the durable consumer) --------------------------------------------

/** Records an event as applied. False if it already was (a redelivery). */
export async function claimEvent(
  tx: Executor,
  eventId: string,
  stationId: string,
): Promise<boolean> {
  const rows = await tx
    .insert(alertEventSeen)
    .values({ eventId, stationId })
    .onConflictDoNothing()
    .returning({ eventId: alertEventSeen.eventId });
  return rows.length > 0;
}

export async function pruneSeenEvents(db: Executor, before: Date): Promise<void> {
  await db.delete(alertEventSeen).where(lt(alertEventSeen.seenAt, before));
}

/** Notes an engine boot for the station; the newest one (by time) wins. */
export async function noteEngineBoot(
  db: Executor,
  scope: StationScope,
  bootId: string,
  at: Date,
): Promise<void> {
  await db
    .insert(alertEngineBoot)
    .values({ stationId: scope.stationId, orgId: scope.orgId, bootId, bootedAt: at })
    .onConflictDoUpdate({
      target: alertEngineBoot.stationId,
      set: { bootId, bootedAt: at },
      setWhere: and(ne(alertEngineBoot.bootId, bootId), lt(alertEngineBoot.bootedAt, at)),
    });
}

/** Whether an event of `bootId` at `at` belongs to a boot older than the newest one seen. */
export async function isStaleBoot(
  db: Executor,
  scope: StationScope,
  bootId: string | null,
  at: Date,
): Promise<boolean> {
  if (!bootId) return false;
  const [row] = await db
    .select()
    .from(alertEngineBoot)
    .where(eq(alertEngineBoot.stationId, scope.stationId));
  return !!row && row.bootId !== bootId && at < row.bootedAt;
}

/** Open alerts of these types not seen since `seenBefore`, across stations (reconcile). */
export async function quietOpenAlerts(
  db: Executor,
  types: string[],
  seenBefore: Date,
): Promise<Array<{ scope: StationScope; alert: Alert }>> {
  const rows = await db
    .select()
    .from(alert)
    .where(
      and(isNull(alert.resolvedAt), inArray(alert.type, types), lt(alert.lastSeenAt, seenBefore)),
    )
    .limit(500);
  return rows.map((row) => ({ scope: unsafeScope(row.orgId, row.stationId), alert: toAlert(row) }));
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

// --- Notifications -----------------------------------------------------------------------

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

/** What the email job already did for this alert at this severity (a retried job). */
export async function notificationsOf(
  db: Executor,
  alertId: string,
  severity: AlertSeverity,
): Promise<{ sent: Set<string>; suppressed: boolean }> {
  const rows = await db
    .select({ email: alertNotification.email, status: alertNotification.status })
    .from(alertNotification)
    .where(and(eq(alertNotification.alertId, alertId), eq(alertNotification.severity, severity)));
  return {
    sent: new Set(rows.filter((r) => r.status === 'sent').map((r) => r.email)),
    suppressed: rows.some((r) => r.status === 'suppressed'),
  };
}

export async function recordNotification(
  db: Executor,
  target: Alert,
  severity: AlertSeverity,
  entry: { email: string; status: 'sent' | 'suppressed'; reason?: string },
): Promise<void> {
  await db
    .insert(alertNotification)
    .values({
      alertId: target.id,
      orgId: target.orgId,
      stationId: target.stationId,
      type: target.type,
      severity,
      email: entry.email,
      status: entry.status,
      reason: entry.reason ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Whether another alert of the same (station, type) was emailed at this severity or above
 * since `since`: the cooldown against flapping.
 */
export async function emailedRecently(
  db: Executor,
  target: Alert,
  severity: AlertSeverity,
  since: Date,
): Promise<boolean> {
  const atLeast = (Object.keys(alertSeverityRank) as AlertSeverity[]).filter(
    (s) => alertSeverityRank[s] >= alertSeverityRank[severity],
  );
  const [row] = await db
    .select({ id: alertNotification.id })
    .from(alertNotification)
    .where(
      and(
        eq(alertNotification.stationId, target.stationId),
        eq(alertNotification.type, target.type),
        ne(alertNotification.alertId, target.id),
        eq(alertNotification.status, 'sent'),
        inArray(alertNotification.severity, atLeast),
        gte(alertNotification.createdAt, since),
      ),
    )
    .limit(1);
  return !!row;
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
 * engine settings untouched), the rest into `silence_setting`. Omitted fields keep their
 * value. Run it in a transaction.
 */
export async function updateSilenceSettings(
  db: Executor,
  scope: StationScope,
  patch: UpdateSilenceSettings,
): Promise<{ before: SilenceSettings; after: SilenceSettings }> {
  const before = await getSilenceSettings(db, scope);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const after = silenceSettingsSchema.parse({ ...before, ...defined });
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
