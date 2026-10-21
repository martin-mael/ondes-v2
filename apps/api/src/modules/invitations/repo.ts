import {
  auditLog,
  type Executor,
  inviteLink,
  joinRequest,
  membership,
  type OrgScope,
  organization,
  orgDomain,
  user,
  userAuth,
  whereOrg,
} from '@ondes/db';
import type {
  InviteLink,
  JoinRequest,
  JoinRequestStatus,
  OrgDomain,
  Role,
  User,
} from '@ondes/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../auth/crypto.ts';
import { verificationRecord } from './domains.ts';

// Tables of #113. Token lookups are global (a token is its own proof); the rest takes an
// `OrgScope`.

export type OrgDomainRow = typeof orgDomain.$inferSelect;
export type InviteLinkRow = typeof inviteLink.$inferSelect;
export type JoinRequestRow = typeof joinRequest.$inferSelect;

// --- Domains -----------------------------------------------------------------------------

export function toOrgDomain(row: OrgDomainRow): OrgDomain {
  const live = row.emailTokenExpiresAt && row.emailTokenExpiresAt > new Date();
  return {
    id: row.id,
    orgId: row.orgId,
    domain: row.domain,
    policy: row.policy,
    defaultRole: row.defaultRole,
    defaultStationId: row.defaultStationId,
    status: !row.verifiedAt ? 'unverified' : row.pausedAt ? 'paused' : 'active',
    dnsRecord: verificationRecord(row.dnsToken),
    verifiedAt: row.verifiedAt,
    verificationMethod: row.verificationMethod,
    emailVerificationSentTo: live ? row.emailTokenSentTo : null,
    pausedAt: row.pausedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export async function listOrgDomains(db: Executor, scope: OrgScope): Promise<OrgDomainRow[]> {
  return db
    .select()
    .from(orgDomain)
    .where(whereOrg(orgDomain, scope))
    .orderBy(asc(orgDomain.domain));
}

export async function getOrgDomain(
  db: Executor,
  scope: OrgScope,
  domainId: string,
): Promise<OrgDomainRow | undefined> {
  const [row] = await db
    .select()
    .from(orgDomain)
    .where(and(eq(orgDomain.id, domainId), whereOrg(orgDomain, scope)));
  return row;
}

/** The org that verified `domain`, if any (a verified domain has one owner). */
export async function verifiedDomainOwner(
  db: Executor,
  domain: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ orgId: orgDomain.orgId })
    .from(orgDomain)
    .where(and(eq(orgDomain.domain, domain), isNotNull(orgDomain.verifiedAt)));
  return row?.orgId;
}

/** Verified, unpaused rules for `domain`, with their org's name. Not tenant-scoped: by email. */
export async function activeRulesForDomain(
  db: Executor,
  domain: string,
): Promise<{ rule: OrgDomainRow; orgName: string }[]> {
  return db
    .select({ rule: orgDomain, orgName: organization.name })
    .from(orgDomain)
    .innerJoin(organization, eq(organization.id, orgDomain.orgId))
    .where(
      and(
        eq(orgDomain.domain, domain),
        isNotNull(orgDomain.verifiedAt),
        isNull(orgDomain.pausedAt),
      ),
    );
}

/** Issues a confirmation-link token (only its hash is stored); replaces any earlier one. */
export async function setDomainEmailToken(
  db: Executor,
  domainId: string,
  sentTo: string,
  ttlMs: number,
): Promise<{ row: OrgDomainRow; token: string }> {
  const token = randomToken();
  const [row] = await db
    .update(orgDomain)
    .set({
      emailTokenHash: sha256(token),
      emailTokenExpiresAt: new Date(Date.now() + ttlMs),
      emailTokenSentTo: sentTo,
    })
    .where(eq(orgDomain.id, domainId))
    .returning();
  if (!row) throw new Error('update returned no row');
  return { row, token };
}

/** The unverified domain a live confirmation token is for. */
export async function findDomainByEmailToken(
  db: Executor,
  token: string,
): Promise<OrgDomainRow | undefined> {
  const [row] = await db
    .select()
    .from(orgDomain)
    .where(
      and(
        eq(orgDomain.emailTokenHash, sha256(token)),
        gt(orgDomain.emailTokenExpiresAt, sql`now()`),
        isNull(orgDomain.verifiedAt),
      ),
    );
  return row;
}

/**
 * Users with a verified email at `domain` and no membership in the org: the review list for
 * a newly verified domain.
 */
export async function domainCandidates(
  db: Executor,
  scope: OrgScope,
  domain: string,
): Promise<User[]> {
  return db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .innerJoin(userAuth, eq(userAuth.userId, user.id))
    .where(
      and(
        sql`split_part(lower(${user.email}), '@', 2) = ${domain}`,
        isNotNull(userAuth.emailVerifiedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(membership)
            .where(and(eq(membership.userId, user.id), whereOrg(membership, scope))),
        ),
      ),
    )
    .orderBy(asc(user.email));
}

/**
 * Whether the user ever had a membership in the org (every membership is created through the
 * audited `addMembership`). Someone who was removed isn't let back in by a domain rule.
 */
export async function wasEverMember(
  db: Executor,
  scope: OrgScope,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, scope.orgId),
        eq(auditLog.action, 'membership.create'),
        sql`${auditLog.diff} -> 'userId' ->> 'to' = ${userId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// --- Join requests -----------------------------------------------------------------------

const joinRequestColumns = {
  id: joinRequest.id,
  orgId: joinRequest.orgId,
  userId: joinRequest.userId,
  email: user.email,
  name: user.name,
  domainId: joinRequest.domainId,
  status: joinRequest.status,
  decidedBy: joinRequest.decidedBy,
  decidedAt: joinRequest.decidedAt,
  createdAt: joinRequest.createdAt,
};

export async function listJoinRequests(
  db: Executor,
  scope: OrgScope,
  status?: JoinRequestStatus,
): Promise<JoinRequest[]> {
  return db
    .select(joinRequestColumns)
    .from(joinRequest)
    .innerJoin(user, eq(user.id, joinRequest.userId))
    .where(and(whereOrg(joinRequest, scope), status ? eq(joinRequest.status, status) : undefined))
    .orderBy(asc(joinRequest.createdAt));
}

export async function getJoinRequest(
  db: Executor,
  scope: OrgScope,
  requestId: string,
): Promise<JoinRequest | undefined> {
  const [row] = await db
    .select(joinRequestColumns)
    .from(joinRequest)
    .innerJoin(user, eq(user.id, joinRequest.userId))
    .where(and(eq(joinRequest.id, requestId), whereOrg(joinRequest, scope)));
  return row;
}

/** Org ids where the user has a pending request. */
export async function pendingRequestOrgs(db: Executor, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ orgId: joinRequest.orgId })
    .from(joinRequest)
    .where(and(eq(joinRequest.userId, userId), eq(joinRequest.status, 'pending')));
  return new Set(rows.map((r) => r.orgId));
}

/** Emails of the org's owners and admins: they get join-request notifications. */
export async function orgAdminRecipients(db: Executor, scope: OrgScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(whereOrg(membership, scope), inArray(membership.role, ['owner', 'admin'] as Role[])),
    );
  return rows.map((r) => r.email);
}

// --- Invite links ------------------------------------------------------------------------

export function inviteLinkStatus(row: InviteLinkRow, now = new Date()): InviteLink['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  if (row.maxUses !== null && row.useCount >= row.maxUses) return 'used_up';
  return 'active';
}

export function toInviteLink(row: InviteLinkRow): InviteLink {
  const { tokenHash: _secret, ...rest } = row;
  return { ...rest, status: inviteLinkStatus(row) };
}

export async function insertInviteLink(
  db: Executor,
  values: Omit<typeof inviteLink.$inferInsert, 'tokenHash'>,
): Promise<{ row: InviteLinkRow; token: string }> {
  const token = randomToken();
  const [row] = await db
    .insert(inviteLink)
    .values({ ...values, tokenHash: sha256(token) })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { row, token };
}

export async function listInviteLinks(db: Executor, scope: OrgScope): Promise<InviteLinkRow[]> {
  return db
    .select()
    .from(inviteLink)
    .where(whereOrg(inviteLink, scope))
    .orderBy(asc(inviteLink.createdAt));
}

export async function getInviteLink(
  db: Executor,
  scope: OrgScope,
  linkId: string,
): Promise<InviteLinkRow | undefined> {
  const [row] = await db
    .select()
    .from(inviteLink)
    .where(and(eq(inviteLink.id, linkId), whereOrg(inviteLink, scope)));
  return row;
}

export async function findInviteLinkByToken(
  db: Executor,
  token: string,
): Promise<InviteLinkRow | undefined> {
  const [row] = await db
    .select()
    .from(inviteLink)
    .where(eq(inviteLink.tokenHash, sha256(token)));
  return row;
}

/**
 * Counts one use, only while the link is active. One statement, so concurrent joins can't go
 * past `max_uses`. Returns the updated row, or `undefined` if the link is no longer usable.
 */
export async function claimInviteLinkUse(
  db: Executor,
  linkId: string,
): Promise<InviteLinkRow | undefined> {
  const [row] = await db
    .update(inviteLink)
    .set({ useCount: sql`${inviteLink.useCount} + 1` })
    .where(
      and(
        eq(inviteLink.id, linkId),
        isNull(inviteLink.revokedAt),
        gt(inviteLink.expiresAt, sql`now()`),
        sql`(${inviteLink.maxUses} is null or ${inviteLink.useCount} < ${inviteLink.maxUses})`,
      ),
    )
    .returning();
  return row;
}
