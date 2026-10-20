import {
  apiKey,
  authToken,
  type Executor,
  hashApiKey,
  invitation,
  membership,
  type OrgScope,
  orgAuthPolicy,
  recoveryCode,
  session,
  station,
  user,
  userAuth,
  whereOrg,
} from '@ondes/db';
import type { ApiKey, Invitation, InvitationStatus, Membership, User } from '@ondes/shared';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { randomToken, sha256 } from './crypto.ts';

// Auth tables. Lookups by token are global by nature (a token is its own proof); everything
// org-related takes an `OrgScope`.

export type UserAuthRow = typeof userAuth.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type InvitationRow = typeof invitation.$inferSelect;
export type TokenPurpose = 'verify_email' | 'reset_password';

// --- Users -------------------------------------------------------------------------------

export async function findUserWithAuth(
  db: Executor,
  where: { email: string } | { userId: string },
): Promise<{ user: User; auth: UserAuthRow | null } | undefined> {
  const [row] = await db
    .select({ user, auth: userAuth })
    .from(user)
    .leftJoin(userAuth, eq(userAuth.userId, user.id))
    .where(
      'email' in where
        ? sql`lower(${user.email}) = lower(${where.email})`
        : eq(user.id, where.userId),
    );
  return row;
}

// --- Sessions ----------------------------------------------------------------------------

export async function insertSession(
  db: Executor,
  values: {
    userId: string;
    twoFactorPending: boolean;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ session: SessionRow; token: string }> {
  const token = randomToken();
  const [row] = await db
    .insert(session)
    .values({ ...values, tokenHash: sha256(token) })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { session: row, token };
}

/** The live session for a cookie token, with its user. Expired sessions are ignored. */
export async function findSessionByToken(
  db: Executor,
  token: string,
): Promise<{ session: SessionRow; user: User; auth: UserAuthRow | null } | undefined> {
  const [row] = await db
    .select({ session, user, auth: userAuth })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .leftJoin(userAuth, eq(userAuth.userId, user.id))
    .where(and(eq(session.tokenHash, sha256(token)), gt(session.expiresAt, sql`now()`)));
  return row;
}

export async function touchSession(db: Executor, sessionId: string): Promise<void> {
  await db.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, sessionId));
}

export async function deleteSession(
  db: Executor,
  sessionId: string,
): Promise<SessionRow | undefined> {
  const [row] = await db.delete(session).where(eq(session.id, sessionId)).returning();
  return row;
}

export async function deleteUserSessions(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return rows.length;
}

/** Housekeeping on sign-in: drops the user's expired sessions (abandoned 2FA logins included). */
export async function deleteExpiredSessions(db: Executor, userId: string): Promise<void> {
  await db
    .delete(session)
    .where(and(eq(session.userId, userId), lte(session.expiresAt, sql`now()`)));
}

// --- Email tokens ------------------------------------------------------------------------

/** Issues a token; any earlier unused token of the same purpose stops working. */
export async function issueAuthToken(
  db: Executor,
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
): Promise<string> {
  await db
    .update(authToken)
    .set({ usedAt: new Date() })
    .where(
      and(eq(authToken.userId, userId), eq(authToken.purpose, purpose), isNull(authToken.usedAt)),
    );
  const token = randomToken();
  await db.insert(authToken).values({
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

/** Marks a token used and returns its user, or `undefined` if unknown, used or expired. */
export async function consumeAuthToken(
  db: Executor,
  token: string,
  purpose: TokenPurpose,
): Promise<string | undefined> {
  const [row] = await db
    .update(authToken)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authToken.tokenHash, sha256(token)),
        eq(authToken.purpose, purpose),
        isNull(authToken.usedAt),
        gt(authToken.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: authToken.userId });
  return row?.userId;
}

// --- Recovery codes ----------------------------------------------------------------------

export async function replaceRecoveryCodes(
  db: Executor,
  userId: string,
  codeHashes: string[],
): Promise<void> {
  await db.delete(recoveryCode).where(eq(recoveryCode.userId, userId));
  if (codeHashes.length > 0) {
    await db.insert(recoveryCode).values(codeHashes.map((codeHash) => ({ userId, codeHash })));
  }
}

export async function useRecoveryCode(
  db: Executor,
  userId: string,
  codeHash: string,
): Promise<boolean> {
  const rows = await db
    .update(recoveryCode)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCode.userId, userId),
        eq(recoveryCode.codeHash, codeHash),
        isNull(recoveryCode.usedAt),
      ),
    )
    .returning({ id: recoveryCode.id });
  return rows.length > 0;
}

// --- Memberships and scopes --------------------------------------------------------------

export async function userMemberships(db: Executor, userId: string): Promise<Membership[]> {
  return db
    .select()
    .from(membership)
    .where(eq(membership.userId, userId))
    .orderBy(asc(membership.createdAt));
}

export async function userMembershipsInOrg(
  db: Executor,
  userId: string,
  scope: OrgScope,
): Promise<Membership[]> {
  return db
    .select()
    .from(membership)
    .where(and(eq(membership.userId, userId), whereOrg(membership, scope)));
}

/** The org a station belongs to, to resolve `/stations/:stationId` routes. */
export async function stationOrgId(db: Executor, stationId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ orgId: station.orgId })
    .from(station)
    .where(eq(station.id, stationId));
  return row?.orgId;
}

export async function getOrgAuthPolicy(db: Executor, scope: OrgScope) {
  const [row] = await db.select().from(orgAuthPolicy).where(eq(orgAuthPolicy.orgId, scope.orgId));
  return { orgId: scope.orgId, requireTwoFactor: row?.requireTwoFactor ?? false };
}

export async function upsertOrgAuthPolicy(
  db: Executor,
  scope: OrgScope,
  values: { requireTwoFactor: boolean },
) {
  await db
    .insert(orgAuthPolicy)
    .values({ orgId: scope.orgId, ...values })
    .onConflictDoUpdate({ target: orgAuthPolicy.orgId, set: values });
  return { orgId: scope.orgId, ...values };
}

// --- API keys ----------------------------------------------------------------------------

/** A usable key: not revoked, not expired. */
export async function findApiKeyByToken(db: Executor, token: string): Promise<ApiKey | undefined> {
  const [row] = await db
    .select({
      id: apiKey.id,
      orgId: apiKey.orgId,
      stationId: apiKey.stationId,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      createdBy: apiKey.createdBy,
      expiresAt: apiKey.expiresAt,
      lastUsedAt: apiKey.lastUsedAt,
      revokedAt: apiKey.revokedAt,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(
      and(
        eq(apiKey.keyHash, hashApiKey(token)),
        isNull(apiKey.revokedAt),
        sql`(${apiKey.expiresAt} is null or ${apiKey.expiresAt} > now())`,
      ),
    );
  return row;
}

/** Records use at most once a minute, to keep reads cheap. */
export async function touchApiKey(db: Executor, apiKeyId: string): Promise<void> {
  await db
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKey.id, apiKeyId),
        sql`(${apiKey.lastUsedAt} is null or ${apiKey.lastUsedAt} < now() - interval '1 minute')`,
      ),
    );
}

// --- Invitations -------------------------------------------------------------------------

export function invitationStatus(row: InvitationRow, now = new Date()): InvitationStatus {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  return 'pending';
}

export function toInvitation(row: InvitationRow): Invitation {
  const { tokenHash: _secret, ...rest } = row;
  return { ...rest, status: invitationStatus(row) };
}

export async function insertInvitation(
  db: Executor,
  values: Omit<typeof invitation.$inferInsert, 'tokenHash'>,
): Promise<{ invitation: InvitationRow; token: string }> {
  const token = randomToken();
  const [row] = await db
    .insert(invitation)
    .values({ ...values, tokenHash: sha256(token) })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { invitation: row, token };
}

/** Revokes the pending invitations for the same person and scope (a new one replaces them). */
export async function revokePendingInvitations(
  db: Executor,
  scope: OrgScope,
  email: string,
  stationId: string | null,
): Promise<InvitationRow[]> {
  return db
    .update(invitation)
    .set({ revokedAt: new Date() })
    .where(
      and(
        whereOrg(invitation, scope),
        sql`lower(${invitation.email}) = lower(${email})`,
        stationId === null ? isNull(invitation.stationId) : eq(invitation.stationId, stationId),
        isNull(invitation.acceptedAt),
        isNull(invitation.revokedAt),
      ),
    )
    .returning();
}

export async function getInvitation(
  db: Executor,
  scope: OrgScope,
  invitationId: string,
): Promise<InvitationRow | undefined> {
  const [row] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.id, invitationId), whereOrg(invitation, scope)));
  return row;
}

export async function listInvitations(db: Executor, scope: OrgScope): Promise<InvitationRow[]> {
  return db
    .select()
    .from(invitation)
    .where(whereOrg(invitation, scope))
    .orderBy(asc(invitation.createdAt));
}

export async function findInvitationByToken(
  db: Executor,
  token: string,
): Promise<InvitationRow | undefined> {
  const [row] = await db
    .select()
    .from(invitation)
    .where(eq(invitation.tokenHash, sha256(token)));
  return row;
}
