import {
  addMembership,
  auditDiff,
  getOrganization,
  getStation,
  invitation,
  invitationSendReservation,
  inviteLink,
  joinRequest,
  listStations,
  narrowToStation,
  type OrgScope,
  orgDomain,
  resolveOrgScope,
  type Tx,
  user,
  whereOrg,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type CreateInviteLink,
  type CreateOrgDomain,
  createInviteLinkSchema,
  createOrgDomainSchema,
  type DomainCandidate,
  type DomainJoinPolicy,
  expandScopes,
  type Grant,
  type Invitation,
  type InvitationListInput,
  type InvitationListPreview,
  type InvitationListRow,
  type InviteLink,
  invitationListInputSchema,
  isOrgRole,
  type JoinableOrg,
  type JoinRequest,
  type JoinRequestStatus,
  type OrgDomain,
  type OrgRole,
  type Role,
  roleRank,
  roleSchema,
  type SendInvitationList,
  type StationRole,
  sendInvitationListSchema,
  type UpdateOrgDomain,
  type User,
  updateOrgDomainSchema,
  type VerifyOrgDomain,
  verifyOrgDomainSchema,
} from '@ondes/shared';
import { and, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../../plugins/errors.ts';
import { sendTemplate } from '../../plugins/mail.ts';
import { randomToken } from '../auth/crypto.ts';
import {
  findUserWithAuth,
  listInvitations,
  toInvitation,
  userMembershipsInOrg,
} from '../auth/repo.ts';
import {
  type AuthDeps,
  type Caller,
  callerPermissions,
  createInvitation,
  grantCeiling,
} from '../auth/service.ts';
import {
  emailDomain,
  hasVerificationRecord,
  isPublicEmailDomain,
  type TxtResolver,
} from './domains.ts';
import {
  autoJoinedTemplate,
  domainUnverifiedTemplate,
  domainVerificationTemplate,
  joinRequestDecisionTemplate,
  joinRequestTemplate,
} from './emails.ts';
import { parseCsvList, parseEmailList, type RawListRow } from './parse.ts';
import {
  activeRulesForDomain,
  claimDomainCheck,
  claimInviteLinkUse,
  domainCandidates,
  domainsDueForCheck,
  findDomainByEmailToken,
  findInviteLinkByToken,
  findUsableApiKey,
  getInviteLink,
  getJoinRequest,
  getOrgDomain,
  type InviteLinkRow,
  insertInviteLink,
  inviteLinkStatus,
  lastRefusal,
  listInviteLinks,
  listJoinRequests,
  listOrgDomains,
  membershipsByEmail,
  type OrgDomainRow,
  orgAdminRecipients,
  pendingInvitationKeys,
  pendingRequestOrgs,
  setDomainEmailToken,
  toInviteLink,
  toOrgDomain,
  wasEverMember,
} from './repo.ts';

// Team onboarding (#113): email-domain rules, join requests, bulk invitation lists and
// shareable invite links. Built on #6: permissions come from `callerPermissions` and
// `grantCeiling` (so API keys stay capped by their creator), bulk rows go through
// `createInvitation`, and auto-join hangs off `app.auth.onUserVerified`.

export interface InvitationsDeps extends AuthDeps {
  resolver: TxtResolver;
}

export interface InvitationsLimits {
  /** Rows per list. */
  maxListRows: number;
  /** Invitations an org may send per hour, all routes together. */
  invitationsPerHour: number;
}

export const DEFAULT_LIMITS: InvitationsLimits = { maxListRows: 500, invitationsPerHour: 300 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DOMAIN_EMAIL_TTL_MS = 48 * HOUR_MS;
/** Email-confirmed domains are confirmed again after a year. */
const EMAIL_VERIFICATION_TTL_MS = 365 * DAY_MS;
/** Failed DNS re-checks in a row before a domain loses its verification. */
export const MAX_FAILED_CHECKS = 3;
/** After a refusal, the same user can ask the same org again only after this. */
const REQUEST_COOLDOWN_MS = 30 * DAY_MS;

const AUTO_JOIN: Actor = { type: 'system', name: 'domain-auto-join' };
const DOMAIN_VERIFY: Actor = { type: 'system', name: 'domain-verification' };
const userActor = (userId: string): Actor => ({ type: 'user', userId });

const link = (deps: AuthDeps, path: string, token?: string) =>
  `${deps.auth.config.appUrl}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

const forbidden = (permission: string) =>
  new HttpError(403, 'forbidden', `missing permission ${permission}`, { permission });

function requirePermissionOn(
  caller: Caller,
  stationId: string | null,
  permission: 'member:invite' | 'member:manage',
) {
  if (!callerPermissions(caller, stationId).has(permission)) throw forbidden(permission);
}

/** Checks that the caller may hand out `role` on that scope (their own role at most). */
function requireGrantable(caller: Caller, role: Role, stationId: string | null) {
  if (roleRank[role] > grantCeiling(caller, stationId)) {
    throw new HttpError(403, 'role_too_high', `you can't grant ${role}`);
  }
}

/** A grant's station, proven to belong to the org. */
async function grantStationId(
  deps: AuthDeps,
  scope: OrgScope,
  grant: Grant,
): Promise<string | null> {
  if (grant.level === 'org') return null;
  return (await narrowToStation(deps.db, scope, grant.stationId)).stationId;
}

function membershipInput(userId: string, role: Role, stationId: string | null) {
  return stationId
    ? { level: 'station' as const, userId, stationId, role: role as StationRole }
    : { level: 'org' as const, userId, role: role as OrgRole };
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function verifiedUser(deps: AuthDeps, userId: string): Promise<User> {
  const found = await findUserWithAuth(deps.db, { userId });
  if (!found) throw new HttpError(401, 'unauthenticated', 'sign in first');
  if (!found.auth?.emailVerifiedAt) {
    throw new HttpError(403, 'email_not_verified', 'confirm your email address first');
  }
  return found.user;
}

async function inviterName(deps: AuthDeps, actor: Actor, fallback: string): Promise<string> {
  if (actor.type !== 'user') return fallback;
  return (await findUserWithAuth(deps.db, { userId: actor.userId }))?.user.name ?? fallback;
}

// --- Email-domain rules ------------------------------------------------------------------
// Org level only, for owners and admins: station roles never hold `member:manage` on the org.

/** Auto-join never hands out org roles: owners and admins go through request and approval. */
function assertAutoJoinGrant(policy: DomainJoinPolicy, role: Role) {
  if (policy === 'auto_join' && roleRank[role] > roleRank.station_manager) {
    throw new HttpError(
      422,
      'auto_join_role_too_high',
      `auto-join grants station roles only; use request-to-join for ${role}`,
    );
  }
}

/**
 * Whether a verified domain still proves out: the TXT record for DNS-verified domains, the
 * confirmation's age for email-verified ones (they're confirmed again yearly).
 */
async function stillVerified(deps: InvitationsDeps, row: OrgDomainRow): Promise<boolean> {
  if (!row.verifiedAt) return false;
  if (row.verificationMethod === 'email') {
    return row.verifiedAt.getTime() + EMAIL_VERIFICATION_TTL_MS > Date.now();
  }
  return hasVerificationRecord(deps.resolver, row.domain, row.dnsToken);
}

/** Drops a domain's verification (the rule stops applying) and tells the owners and admins. */
async function unverify(deps: AuthDeps, row: OrgDomainRow, reason: string): Promise<void> {
  const scope = await resolveOrgScope(deps.db, row.orgId);
  const done = await withAudit(deps.db, { actor: DOMAIN_VERIFY, scope }, async (tx, audit) => {
    const [updated] = await tx
      .update(orgDomain)
      .set({ verifiedAt: null, verificationMethod: null, failedChecks: 0 })
      .where(and(eq(orgDomain.id, row.id), isNotNull(orgDomain.verifiedAt)))
      .returning();
    await audit({
      action: 'org_domain.unverify',
      entity: { type: 'org_domain', id: row.id },
      diff: { verifiedAt: { from: row.verifiedAt, to: null }, reason: { from: null, to: reason } },
    });
    return updated !== undefined;
  });
  if (!done) return;
  const org = await getOrganization(deps.db, scope);
  for (const to of await orgAdminRecipients(deps.db, scope)) {
    await sendTemplate(deps.mailer, to, domainUnverifiedTemplate, {
      orgName: org.name,
      domain: row.domain,
      reason,
      link: link(deps, `/orgs/${row.orgId}/settings/domains`),
    });
  }
}

/** Before resuming a rule or changing its policy: the domain must still be verified. */
async function requireStillVerified(deps: InvitationsDeps, row: OrgDomainRow): Promise<void> {
  if (!row.verifiedAt || (await stillVerified(deps, row))) return;
  const reason = row.verificationMethod === 'email' ? 'confirmation_expired' : 'record_missing';
  await unverify(deps, row, reason);
  throw new HttpError(409, 'verification_lost', `${row.domain} has to be verified again`, {
    reason,
    expectedRecord: toOrgDomain(row).dnsRecord,
  });
}

/**
 * Periodic re-check of verified domains (`recheckIntervalMs` in the routes options). A DNS
 * domain whose record is gone `MAX_FAILED_CHECKS` times in a row, or an email confirmation older
 * than a year, loses its verification; owners and admins are emailed. DNS outages don't count.
 */
export async function recheckDomains(
  deps: InvitationsDeps,
  options: { everyMs: number; batch?: number } = { everyMs: DAY_MS },
): Promise<{ checked: number; unverified: number }> {
  const cutoff = new Date(Date.now() - options.everyMs);
  let checked = 0;
  let unverified = 0;
  for (const due of await domainsDueForCheck(deps.db, cutoff, options.batch ?? 100)) {
    const row = await claimDomainCheck(deps.db, due.id, cutoff);
    if (!row) continue;
    checked++;
    let ok: boolean;
    try {
      ok = await stillVerified(deps, row);
    } catch (err) {
      deps.log.warn({ err, domain: row.domain }, 'domain re-check skipped: DNS unavailable');
      continue;
    }
    if (ok) {
      if (row.failedChecks > 0) {
        await deps.db.update(orgDomain).set({ failedChecks: 0 }).where(eq(orgDomain.id, row.id));
      }
      continue;
    }
    if (row.verificationMethod === 'email') {
      await unverify(deps, row, 'confirmation_expired');
      unverified++;
      continue;
    }
    const [counted] = await deps.db
      .update(orgDomain)
      .set({ failedChecks: sql`${orgDomain.failedChecks} + 1` })
      .where(eq(orgDomain.id, row.id))
      .returning({ failedChecks: orgDomain.failedChecks });
    if ((counted?.failedChecks ?? 0) >= MAX_FAILED_CHECKS) {
      await unverify(deps, row, 'record_missing');
      unverified++;
    }
  }
  return { checked, unverified };
}

export async function listDomains(deps: AuthDeps, scope: OrgScope): Promise<OrgDomain[]> {
  return (await listOrgDomains(deps.db, scope)).map(toOrgDomain);
}

async function domainOf(deps: AuthDeps, scope: OrgScope, domainId: string): Promise<OrgDomainRow> {
  const row = await getOrgDomain(deps.db, scope, domainId);
  if (!row) throw new HttpError(404, 'not_found', `domain ${domainId} not found`);
  return row;
}

export async function addDomain(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  input: CreateOrgDomain,
): Promise<OrgDomain> {
  const parsed = createOrgDomainSchema.parse(input);
  requirePermissionOn(caller, null, 'member:manage');
  if (isPublicEmailDomain(parsed.domain)) {
    throw new HttpError(
      422,
      'public_email_domain',
      `${parsed.domain} is a public email provider: anyone can get an address there`,
    );
  }
  assertAutoJoinGrant(parsed.policy, parsed.defaultGrant.role);
  const stationId = await grantStationId(deps, scope, parsed.defaultGrant);
  requireGrantable(caller, parsed.defaultGrant.role, stationId);

  try {
    return await withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
      const [row] = await tx
        .insert(orgDomain)
        .values({
          orgId: scope.orgId,
          domain: parsed.domain,
          policy: parsed.policy,
          defaultRole: parsed.defaultGrant.role,
          defaultStationId: stationId,
          dnsToken: randomToken(),
          createdBy: caller.actor.type === 'user' ? caller.actor.userId : null,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await audit({
        action: 'org_domain.create',
        entity: { type: 'org_domain', id: row.id },
        diff: auditDiff(null, toOrgDomain(row), ['dnsRecord']),
      });
      return toOrgDomain(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'domain_exists', `${parsed.domain} is already listed`);
    }
    throw err;
  }
}

export async function updateDomain(
  deps: InvitationsDeps,
  caller: Caller,
  scope: OrgScope,
  domainId: string,
  input: UpdateOrgDomain,
): Promise<OrgDomain> {
  const parsed = updateOrgDomainSchema.parse(input);
  requirePermissionOn(caller, null, 'member:manage');
  const before = await domainOf(deps, scope, domainId);
  assertAutoJoinGrant(
    parsed.policy ?? before.policy,
    parsed.defaultGrant?.role ?? before.defaultRole,
  );
  const resuming = parsed.paused === false && before.pausedAt !== null;
  if (resuming || (parsed.policy && parsed.policy !== before.policy)) {
    await requireStillVerified(deps, before);
  }
  const set: Partial<typeof orgDomain.$inferInsert> = {};
  if (parsed.policy) set.policy = parsed.policy;
  if (parsed.defaultGrant) {
    const stationId = await grantStationId(deps, scope, parsed.defaultGrant);
    requireGrantable(caller, parsed.defaultGrant.role, stationId);
    set.defaultRole = parsed.defaultGrant.role;
    set.defaultStationId = stationId;
  }
  if (parsed.paused !== undefined)
    set.pausedAt = parsed.paused ? (before.pausedAt ?? new Date()) : null;

  return withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    const [row] = await tx
      .update(orgDomain)
      .set(set)
      .where(and(eq(orgDomain.id, before.id), whereOrg(orgDomain, scope)))
      .returning();
    if (!row) throw new HttpError(404, 'not_found', `domain ${domainId} not found`);
    const action =
      parsed.paused === true && !before.pausedAt
        ? 'org_domain.pause'
        : parsed.paused === false && before.pausedAt
          ? 'org_domain.resume'
          : 'org_domain.update';
    await audit({
      action,
      entity: { type: 'org_domain', id: row.id },
      diff: auditDiff(toOrgDomain(before), toOrgDomain(row)),
    });
    return toOrgDomain(row);
  });
}

/** Removes the rule. Members who joined through it stay members. */
export async function removeDomain(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  domainId: string,
): Promise<void> {
  requirePermissionOn(caller, null, 'member:manage');
  const before = await domainOf(deps, scope, domainId);
  await withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    await tx.delete(orgDomain).where(and(eq(orgDomain.id, before.id), whereOrg(orgDomain, scope)));
    await audit({
      action: 'org_domain.delete',
      entity: { type: 'org_domain', id: before.id },
      diff: auditDiff(toOrgDomain(before), null),
    });
  });
}

/** DNS: checks the TXT record now. Email: sends a confirmation link to an admin mailbox. */
export async function verifyDomain(
  deps: InvitationsDeps,
  caller: Caller,
  scope: OrgScope,
  domainId: string,
  input: VerifyOrgDomain,
): Promise<OrgDomain> {
  const parsed = verifyOrgDomainSchema.parse(input);
  requirePermissionOn(caller, null, 'member:manage');
  const row = await domainOf(deps, scope, domainId);
  if (row.verifiedAt) return toOrgDomain(row);

  if (parsed.method === 'dns') {
    if (!(await hasVerificationRecord(deps.resolver, row.domain, row.dnsToken))) {
      throw cantVerify(row);
    }
    return markVerified(deps, { actor: caller.actor, scope }, row, 'dns');
  }

  const to = `${parsed.mailbox}@${row.domain}`;
  const { token } = await withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    const issued = await setDomainEmailToken(tx, row.id, to, DOMAIN_EMAIL_TTL_MS);
    await audit({
      action: 'org_domain.verification_send',
      entity: { type: 'org_domain', id: row.id },
      diff: { sentTo: { from: null, to } },
    });
    return issued;
  });
  const org = await getOrganization(deps.db, scope);
  await sendTemplate(deps.mailer, to, domainVerificationTemplate, {
    orgName: org.name,
    domain: row.domain,
    inviter: await inviterName(deps, caller.actor, org.name),
    link: link(deps, '/domains/confirm', token),
  });
  return toOrgDomain((await getOrgDomain(deps.db, scope, row.id)) ?? row);
}

/** The confirmation link from the admin mailbox. Anonymous: the link is the proof. */
export async function confirmDomainEmail(deps: AuthDeps, token: string): Promise<OrgDomain> {
  const row = await findDomainByEmailToken(deps.db, token);
  if (!row) throw new HttpError(400, 'invalid_token', 'this link is invalid or has expired');
  const scope = await resolveOrgScope(deps.db, row.orgId);
  return markVerified(deps, { actor: DOMAIN_VERIFY, scope }, row, 'email');
}

const cantVerify = (row: OrgDomainRow) =>
  new HttpError(422, 'verification_failed', `${row.domain} couldn't be verified`, {
    expectedRecord: toOrgDomain(row).dnsRecord,
  });

async function markVerified(
  deps: AuthDeps,
  ctx: { actor: Actor; scope: OrgScope },
  row: OrgDomainRow,
  method: 'dns' | 'email',
): Promise<OrgDomain> {
  try {
    return await withAudit(deps.db, ctx, async (tx, audit) => {
      const [updated] = await tx
        .update(orgDomain)
        .set({
          verifiedAt: new Date(),
          verificationMethod: method,
          emailTokenHash: null,
          emailTokenExpiresAt: null,
          emailTokenSentTo: null,
          lastCheckedAt: new Date(),
          failedChecks: 0,
        })
        .where(and(eq(orgDomain.id, row.id), isNull(orgDomain.verifiedAt)))
        .returning();
      if (!updated)
        throw new HttpError(409, 'already_verified', `${row.domain} is already verified`);
      await audit({
        action: 'org_domain.verify',
        entity: { type: 'org_domain', id: row.id },
        diff: {
          verifiedAt: { from: null, to: updated.verifiedAt },
          method: { from: null, to: method },
        },
      });
      return toOrgDomain(updated);
    });
  } catch (err) {
    // Another org verified it. Same answer as a missing record: it doesn't say who owns what.
    if (isUniqueViolation(err)) throw cantVerify(row);
    throw err;
  }
}

/**
 * Users already registered with a verified email at the domain, not yet members. They are
 * never added on their own: an admin reviews this list and adds them.
 */
export async function listDomainCandidates(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  domainId: string,
): Promise<DomainCandidate[]> {
  requirePermissionOn(caller, null, 'member:manage');
  const row = await domainOf(deps, scope, domainId);
  if (!row.verifiedAt) return [];
  return (await domainCandidates(deps.db, scope, row.domain)).map((u) => ({
    userId: u.id,
    email: u.email,
    name: u.name,
  }));
}

/** Adds reviewed candidates with the rule's default role. Ids that aren't candidates are skipped. */
export async function addDomainCandidates(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  domainId: string,
  userIds: string[],
): Promise<{ added: string[] }> {
  requirePermissionOn(caller, null, 'member:manage');
  const row = await domainOf(deps, scope, domainId);
  if (!row.verifiedAt) throw new HttpError(409, 'domain_not_verified', 'verify the domain first');
  requireGrantable(caller, row.defaultRole, row.defaultStationId);
  const wanted = new Set(userIds);
  const candidates = (await domainCandidates(deps.db, scope, row.domain)).filter((u) =>
    wanted.has(u.id),
  );
  if (candidates.length === 0) return { added: [] };
  const ctx = { actor: caller.actor, scope };
  await withAudit(deps.db, ctx, async (tx, audit) => {
    for (const candidate of candidates) {
      await addMembership(
        tx,
        ctx,
        membershipInput(candidate.id, row.defaultRole, row.defaultStationId),
      );
      await audit({
        action: 'org_domain.member_add',
        entity: { type: 'org_domain', id: row.id },
        stationId: row.defaultStationId,
        diff: {
          userId: { from: null, to: candidate.id },
          role: { from: null, to: row.defaultRole },
        },
      });
    }
  });
  return { added: candidates.map((c) => c.id) };
}

// --- Auto-join and join requests ---------------------------------------------------------

/**
 * `onUserVerified` handler: a verified user at an auto-join domain becomes a member. Only
 * accounts created after the domain was verified: older ones go through the review list.
 */
export async function autoJoin(deps: AuthDeps, target: User): Promise<void> {
  const found = await findUserWithAuth(deps.db, { userId: target.id });
  if (!found?.auth?.emailVerifiedAt) return;
  const member = found.user;
  for (const { rule, orgName } of await activeRulesForDomain(deps.db, emailDomain(member.email))) {
    const scope = await resolveOrgScope(deps.db, rule.orgId);
    if ((await effectivePolicy(deps, scope, rule, member)) !== 'auto_join') continue;
    const ctx = { actor: AUTO_JOIN, scope };
    const joined = await withAudit(deps.db, ctx, async (tx, audit) => {
      // Serializes with a concurrent sign-in of the same user doing the same.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`auto-join:${rule.orgId}:${member.id}`}))`,
      );
      if (await wasEverMember(tx, scope, member.id)) throw ALREADY_JOINED;
      await addMembership(
        tx,
        ctx,
        membershipInput(member.id, rule.defaultRole, rule.defaultStationId),
      );
      await audit({
        action: 'org_domain.auto_join',
        entity: { type: 'org_domain', id: rule.id },
        stationId: rule.defaultStationId,
        diff: { userId: { from: null, to: member.id }, role: { from: null, to: rule.defaultRole } },
      });
      return true;
    }).catch((err) => {
      if (err === ALREADY_JOINED) return false;
      throw err;
    });
    if (joined) {
      await sendTemplate(deps.mailer, member.email, autoJoinedTemplate, {
        name: member.name,
        orgName,
        role: rule.defaultRole,
      });
    }
  }
}

const ALREADY_JOINED = new Error('already joined');

/**
 * The rule's policy as it applies to this user. Auto-join only for accounts created after the
 * domain was verified (older ones are never added silently: they ask, or an admin adds them
 * from the review list), never for someone who was a member before (and was removed), and
 * never with an org role (rules made before that cap, or edited in the database).
 */
async function effectivePolicy(
  deps: AuthDeps,
  scope: OrgScope,
  rule: OrgDomainRow,
  member: User,
): Promise<DomainJoinPolicy> {
  if (
    rule.policy !== 'auto_join' ||
    !rule.verifiedAt ||
    member.createdAt < rule.verifiedAt ||
    roleRank[rule.defaultRole] > roleRank.station_manager ||
    (await wasEverMember(deps.db, scope, member.id))
  ) {
    return 'request';
  }
  return 'auto_join';
}

/** Orgs the signed-in user may join (auto-join) or ask to join through their email domain. */
export async function joinableOrgs(deps: AuthDeps, userId: string): Promise<JoinableOrg[]> {
  const current = await verifiedUser(deps, userId);
  const pending = await pendingRequestOrgs(deps.db, current.id);
  const out: JoinableOrg[] = [];
  for (const { rule, orgName } of await activeRulesForDomain(deps.db, emailDomain(current.email))) {
    const scope = await resolveOrgScope(deps.db, rule.orgId);
    if ((await userMembershipsInOrg(deps.db, current.id, scope)).length > 0) continue;
    out.push({
      orgId: rule.orgId,
      orgName,
      domainId: rule.id,
      policy: await effectivePolicy(deps, scope, rule, current),
      requestPending: pending.has(rule.orgId),
    });
  }
  return out;
}

/**
 * The user asks to join an org through its domain rule: joins at once on an auto-join rule
 * (it's their own explicit action), files a request otherwise.
 */
export async function joinOrg(
  deps: AuthDeps,
  userId: string,
  orgId: string,
): Promise<{ status: 'joined' } | { status: 'requested'; request: JoinRequest }> {
  const current = await verifiedUser(deps, userId);
  const match = (await activeRulesForDomain(deps.db, emailDomain(current.email))).find(
    (r) => r.rule.orgId === orgId,
  );
  if (!match) throw new HttpError(404, 'not_found', `organization ${orgId} not found`);
  const { rule, orgName } = match;
  const scope = await resolveOrgScope(deps.db, orgId);
  const ctx = { actor: userActor(current.id), scope };
  if ((await userMembershipsInOrg(deps.db, current.id, scope)).length > 0) {
    throw new HttpError(409, 'already_member', `you're already a member of ${orgName}`);
  }

  if ((await effectivePolicy(deps, scope, rule, current)) === 'auto_join') {
    await withAudit(deps.db, ctx, async (tx, audit) => {
      await addMembership(
        tx,
        ctx,
        membershipInput(current.id, rule.defaultRole, rule.defaultStationId),
      );
      await audit({
        action: 'org_domain.self_join',
        entity: { type: 'org_domain', id: rule.id },
        stationId: rule.defaultStationId,
        diff: {
          userId: { from: null, to: current.id },
          role: { from: null, to: rule.defaultRole },
        },
      });
    });
    return { status: 'joined' };
  }

  const refused = await lastRefusal(
    deps.db,
    scope,
    current.id,
    new Date(Date.now() - REQUEST_COOLDOWN_MS),
  );
  if (refused) {
    const retryAt = new Date(refused.getTime() + REQUEST_COOLDOWN_MS);
    throw new HttpError(429, 'request_cooldown', 'your last request was refused, ask again later', {
      retryAt: retryAt.toISOString(),
    });
  }

  let requestId: string;
  try {
    requestId = await withAudit(deps.db, ctx, async (tx, audit) => {
      const [row] = await tx
        .insert(joinRequest)
        .values({ orgId, userId: current.id, domainId: rule.id })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await audit({
        action: 'join_request.create',
        entity: { type: 'join_request', id: row.id },
        diff: { userId: { from: null, to: current.id }, domainId: { from: null, to: rule.id } },
      });
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'request_pending', 'your request is already waiting for approval');
    }
    throw err;
  }
  for (const to of await orgAdminRecipients(deps.db, scope)) {
    await sendTemplate(deps.mailer, to, joinRequestTemplate, {
      orgName,
      name: current.name,
      email: current.email,
      link: link(deps, `/orgs/${orgId}/settings/join-requests`),
    });
  }
  const request = await getJoinRequest(deps.db, scope, requestId);
  if (!request) throw new Error('join request vanished');
  return { status: 'requested', request };
}

export async function listScopeJoinRequests(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  status?: JoinRequestStatus,
): Promise<JoinRequest[]> {
  requirePermissionOn(caller, null, 'member:manage');
  return listJoinRequests(deps.db, scope, status);
}

async function pendingRequest(
  deps: AuthDeps,
  scope: OrgScope,
  requestId: string,
): Promise<JoinRequest> {
  const request = await getJoinRequest(deps.db, scope, requestId);
  if (!request) throw new HttpError(404, 'not_found', `join request ${requestId} not found`);
  if (request.status !== 'pending') {
    throw new HttpError(409, 'request_not_pending', `request is ${request.status}`);
  }
  return request;
}

/** Decides a request in one statement, so two admins can't both decide it. */
async function decide(
  tx: Tx,
  scope: OrgScope,
  caller: Caller,
  requestId: string,
  status: 'approved' | 'refused',
) {
  const [row] = await tx
    .update(joinRequest)
    .set({
      status,
      decidedAt: new Date(),
      decidedBy: caller.actor.type === 'user' ? caller.actor.userId : null,
    })
    .where(
      and(
        eq(joinRequest.id, requestId),
        whereOrg(joinRequest, scope),
        eq(joinRequest.status, 'pending'),
      ),
    )
    .returning();
  if (!row) throw new HttpError(409, 'request_not_pending', 'request was already decided');
  return row;
}

export async function approveJoinRequest(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  requestId: string,
  grant: Grant | undefined,
): Promise<JoinRequest> {
  requirePermissionOn(caller, null, 'member:manage');
  const request = await pendingRequest(deps, scope, requestId);
  let role: Role;
  let stationId: string | null;
  if (grant) {
    role = grant.role;
    stationId = await grantStationId(deps, scope, grant);
  } else {
    const rule = request.domainId
      ? await getOrgDomain(deps.db, scope, request.domainId)
      : undefined;
    if (!rule) throw new HttpError(400, 'grant_required', 'the domain rule is gone: pick a role');
    role = rule.defaultRole;
    stationId = rule.defaultStationId;
  }
  requireGrantable(caller, role, stationId);

  const ctx = { actor: caller.actor, scope };
  await withAudit(deps.db, ctx, async (tx, audit) => {
    await decide(tx, scope, caller, request.id, 'approved');
    if (
      (await userMembershipsInOrg(tx, request.userId, scope)).some((m) => m.stationId === stationId)
    ) {
      throw new HttpError(409, 'already_member', 'this user already has a role in this scope');
    }
    await addMembership(tx, ctx, membershipInput(request.userId, role, stationId));
    await audit({
      action: 'join_request.approve',
      entity: { type: 'join_request', id: request.id },
      stationId,
      diff: { status: { from: 'pending', to: 'approved' }, role: { from: null, to: role } },
    });
  });
  const org = await getOrganization(deps.db, scope);
  await sendTemplate(deps.mailer, request.email, joinRequestDecisionTemplate, {
    name: request.name,
    orgName: org.name,
    approved: true,
    role,
  });
  return (await getJoinRequest(deps.db, scope, request.id)) ?? request;
}

export async function refuseJoinRequest(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  requestId: string,
): Promise<JoinRequest> {
  requirePermissionOn(caller, null, 'member:manage');
  const request = await pendingRequest(deps, scope, requestId);
  await withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    await decide(tx, scope, caller, request.id, 'refused');
    await audit({
      action: 'join_request.refuse',
      entity: { type: 'join_request', id: request.id },
      diff: { status: { from: 'pending', to: 'refused' } },
    });
  });
  const org = await getOrganization(deps.db, scope);
  await sendTemplate(deps.mailer, request.email, joinRequestDecisionTemplate, {
    name: request.name,
    orgName: org.name,
    approved: false,
    role: null,
  });
  return (await getJoinRequest(deps.db, scope, request.id)) ?? request;
}

// --- Invitation lists (bulk) -------------------------------------------------------------

const emailCheck = z.email().max(320);

/**
 * Checks every row of a pasted list or CSV: valid, invalid (with a reason), already a member,
 * or a duplicate of an earlier row. On a station route (`routeStationId`) every row is for
 * that station. Nothing is written.
 */
export async function previewInvitationList(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  routeStationId: string | null,
  input: InvitationListInput,
  limits: InvitationsLimits = DEFAULT_LIMITS,
): Promise<InvitationListPreview> {
  const parsed = invitationListInputSchema.parse(input);
  const raw: RawListRow[] =
    parsed.format === 'csv' ? parseCsvList(parsed.text) : parseEmailList(parsed.text);
  if (raw.length > limits.maxListRows) {
    throw new HttpError(400, 'too_many_rows', `a list holds at most ${limits.maxListRows} rows`, {
      max: limits.maxListRows,
    });
  }
  const defaultRole = parsed.format === 'csv' ? (parsed.defaultRole ?? null) : parsed.role;
  const defaultStation =
    routeStationId ??
    (parsed.format === 'csv' ? parsed.defaultStationId : parsed.stationId) ??
    null;

  const stations = await listStations(deps.db, scope);
  const stationByRef = new Map<string, string>();
  for (const s of stations) {
    stationByRef.set(s.id, s.id);
    stationByRef.set(s.slug, s.id);
  }
  if (defaultStation && !stationByRef.has(defaultStation)) {
    throw new HttpError(404, 'not_found', `station ${defaultStation} not found`);
  }

  // Who's already in, and what's already pending, for the emails in the list: two queries.
  const emails = [...new Set(raw.map((r) => r.email.toLowerCase()))];
  const members = await membershipsByEmail(deps.db, scope, emails);
  const pending = await pendingInvitationKeys(deps.db, scope, emails);

  const seen = new Set<string>();
  const rows: InvitationListRow[] = raw.map((r) => {
    const email = r.email.toLowerCase();
    const base = { line: r.line, email, name: r.name, replacesPending: false };
    const invalid = (
      reason: string,
      role: Role | null = null,
      stationId: string | null = null,
    ) => ({
      ...base,
      role,
      stationId,
      status: 'invalid' as const,
      reason,
    });
    if (!emailCheck.safeParse(email).success) return invalid('invalid_email');

    const roleText = r.role?.toLowerCase().replace(/[\s-]+/g, '_') ?? defaultRole;
    if (!roleText) return invalid('missing_role');
    const roleParse = roleSchema.safeParse(roleText);
    if (!roleParse.success) return invalid('unknown_role');
    const role = roleParse.data;

    let stationId: string | null = null;
    if (r.station) {
      const found = stationByRef.get(r.station);
      if (!found) return invalid('unknown_station', role);
      if (routeStationId && found !== routeStationId)
        return invalid('forbidden_station', role, found);
      stationId = found;
    } else if (!isOrgRole(role)) {
      stationId = defaultStation;
    }

    // On a station route, org roles are judged against the caller's role on that station.
    if (roleRank[role] > grantCeiling(caller, stationId ?? routeStationId))
      return invalid('role_too_high', role, stationId);
    if (isOrgRole(role) && routeStationId) return invalid('org_role_on_station_route', role);
    if (!callerPermissions(caller, stationId).has('member:invite')) {
      return invalid('forbidden', role, stationId);
    }
    if (isOrgRole(role) && stationId) return invalid('org_role_with_station', role, stationId);
    if (!isOrgRole(role) && !stationId) return invalid('missing_station', role);

    const key = `${email}|${stationId}`;
    if (seen.has(key))
      return { ...base, role, stationId, status: 'duplicate' as const, reason: null };
    seen.add(key);
    const held = members.get(email) ?? [];
    if (
      held.some((m) => m.stationId === stationId || (m.stationId === null && stationId !== null))
    ) {
      return { ...base, role, stationId, status: 'already_member' as const, reason: null };
    }
    return {
      ...base,
      role,
      stationId,
      status: 'valid' as const,
      reason: null,
      replacesPending: pending.has(key),
    };
  });

  const counts = { valid: 0, invalid: 0, already_member: 0, duplicate: 0 };
  for (const row of rows) counts[row.status]++;
  return { rows, counts };
}

/**
 * Sends a list: every valid row becomes a normal invitation (#6's `createInvitation`, which
 * re-checks permissions and writes its own audit row). The org's hourly sending budget caps it.
 */
export async function sendInvitationList(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  routeStationId: string | null,
  input: SendInvitationList,
  limits: InvitationsLimits = DEFAULT_LIMITS,
): Promise<{ sent: Invitation[]; skipped: InvitationListRow[] }> {
  const parsed = sendInvitationListSchema.parse(input);
  const preview = await previewInvitationList(deps, caller, scope, routeStationId, parsed, limits);
  const valid = preview.rows.filter((r) => r.status === 'valid');
  const skipped = preview.rows.filter((r) => r.status !== 'valid');

  const reservationId = await reserveSendBudget(deps, scope, valid.length, limits);
  const sent: Invitation[] = [];
  let completed = false;
  try {
    for (const row of valid) {
      if (!row.role) continue;
      sent.push(
        await createInvitation(deps, caller, scope, {
          ...(row.stationId
            ? { level: 'station', stationId: row.stationId, role: row.role as StationRole }
            : { level: 'org', role: row.role as OrgRole }),
          email: row.email,
          expiresInDays: parsed.expiresInDays,
        }),
      );
      // The invitation now counts by itself: hand its reserved slot back.
      await deps.db
        .update(invitationSendReservation)
        .set({ remaining: sql`greatest(${invitationSendReservation.remaining} - 1, 0)` })
        .where(eq(invitationSendReservation.id, reservationId));
    }
    completed = true;
  } finally {
    await deps.db
      .delete(invitationSendReservation)
      .where(eq(invitationSendReservation.id, reservationId));
    // Written even when a row fails halfway, so the log says how far the list got.
    await withAudit(deps.db, { actor: caller.actor, scope }, async (_tx, audit) => {
      await audit({
        action: 'invitation_list.send',
        entity: { type: 'organization', id: scope.orgId },
        stationId: routeStationId,
        diff: {
          sent: { from: null, to: sent.length },
          skipped: { from: null, to: skipped.length },
          completed: { from: null, to: completed },
          ...(completed ? {} : { unsent: { from: null, to: valid.length - sent.length } }),
        },
      });
    });
  }
  return { sent, skipped };
}

/**
 * Reserves `wanted` invitations of the org's hourly budget. Under a per-org advisory lock, so
 * parallel sends see each other: the budget counts invitations created in the last hour plus
 * the slots other sends have reserved and not used yet. Returns the reservation to release.
 */
async function reserveSendBudget(
  deps: AuthDeps,
  scope: OrgScope,
  wanted: number,
  limits: InvitationsLimits,
): Promise<string> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`invitation-budget:${scope.orgId}`}))`,
    );
    const since = new Date(Date.now() - HOUR_MS);
    const [created] = await tx
      .select({ n: count() })
      .from(invitation)
      .where(and(whereOrg(invitation, scope), gt(invitation.createdAt, since)));
    const [reserved] = await tx
      .select({ n: sql<number>`coalesce(sum(${invitationSendReservation.remaining}), 0)::int` })
      .from(invitationSendReservation)
      .where(
        and(
          whereOrg(invitationSendReservation, scope),
          gt(invitationSendReservation.createdAt, since),
        ),
      );
    const remaining = Math.max(
      limits.invitationsPerHour - (created?.n ?? 0) - (reserved?.n ?? 0),
      0,
    );
    if (wanted > remaining) {
      throw new HttpError(
        429,
        'rate_limited',
        `this organization can send ${remaining} more invitations this hour`,
        { remaining, requested: wanted },
      );
    }
    const [row] = await tx
      .insert(invitationSendReservation)
      .values({ orgId: scope.orgId, remaining: wanted })
      .returning({ id: invitationSendReservation.id });
    if (!row) throw new Error('insert returned no row');
    return row.id;
  });
}

/** The invitation list view: filters, and who invited whom. */
export async function listInvitationsWithInviter(
  deps: AuthDeps,
  scope: OrgScope,
  routeStationId: string | null,
  query: { status?: string; stationId?: string; invitedBy?: string; email?: string },
  /** Inviters' emails only for people who manage invitations; others see names. */
  showInviterEmails: boolean,
) {
  const all = (await listInvitations(deps.db, scope)).map(toInvitation);
  const stationId = routeStationId ?? query.stationId;
  const filtered = all.filter(
    (i) =>
      (!stationId || i.stationId === stationId) &&
      (!query.status || i.status === query.status) &&
      (!query.invitedBy || i.invitedBy === query.invitedBy) &&
      (!query.email || i.email.includes(query.email.toLowerCase())),
  );
  const inviterIds = [
    ...new Set(filtered.map((i) => i.invitedBy).filter((id): id is string => !!id)),
  ];
  const inviters = new Map<string, { id: string; name: string; email: string | null }>();
  if (inviterIds.length > 0) {
    for (const u of await deps.db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, inviterIds))) {
      inviters.set(u.id, showInviterEmails ? u : { ...u, email: null });
    }
  }
  return filtered.map((i) => ({
    ...i,
    inviter: i.invitedBy ? (inviters.get(i.invitedBy) ?? null) : null,
  }));
}

// --- Invite links ------------------------------------------------------------------------

export async function createInviteLink(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  input: CreateInviteLink,
): Promise<{ inviteLink: InviteLink; token: string; url: string }> {
  const parsed = createInviteLinkSchema.parse(input);
  const stationId = await grantStationId(deps, scope, parsed.grant);
  requirePermissionOn(caller, stationId, 'member:invite');
  requireGrantable(caller, parsed.grant.role, stationId);
  if (parsed.restrictToDomains) {
    const verified = (await listOrgDomains(deps.db, scope)).filter((d) => d.verifiedAt);
    if (verified.length === 0) {
      throw new HttpError(
        409,
        'no_verified_domains',
        'verify a domain before restricting a link to it',
      );
    }
  }
  const { row, token } = await withAudit(
    deps.db,
    { actor: caller.actor, scope },
    async (tx, audit) => {
      const created = await insertInviteLink(tx, {
        orgId: scope.orgId,
        stationId,
        role: parsed.grant.role,
        label: parsed.label ?? null,
        expiresAt: new Date(Date.now() + parsed.expiresInDays * DAY_MS),
        maxUses: parsed.maxUses ?? null,
        restrictToDomains: parsed.restrictToDomains,
        createdBy: caller.actor.type === 'user' ? caller.actor.userId : null,
        createdByApiKeyId: caller.actor.type === 'api_key' ? caller.actor.apiKeyId : null,
      });
      await audit({
        action: 'invite_link.create',
        entity: { type: 'invite_link', id: created.row.id },
        stationId,
        diff: auditDiff(null, toInviteLink(created.row)),
      });
      return created;
    },
  );
  return { inviteLink: toInviteLink(row), token, url: link(deps, '/join', token) };
}

export async function listScopeInviteLinks(
  deps: AuthDeps,
  scope: OrgScope,
  routeStationId: string | null,
): Promise<InviteLink[]> {
  return (await listInviteLinks(deps.db, scope))
    .filter((l) => routeStationId === null || l.stationId === routeStationId)
    .map(toInviteLink);
}

export async function revokeInviteLink(
  deps: AuthDeps,
  caller: Caller,
  scope: OrgScope,
  linkId: string,
  routeStationId: string | null,
): Promise<InviteLink> {
  const row = await getInviteLink(deps.db, scope, linkId);
  if (!row || (routeStationId !== null && row.stationId !== routeStationId)) {
    throw new HttpError(404, 'not_found', `invite link ${linkId} not found`);
  }
  requirePermissionOn(caller, row.stationId, 'member:invite');
  if (row.revokedAt) return toInviteLink(row);
  return withAudit(deps.db, { actor: caller.actor, scope }, async (tx, audit) => {
    const [updated] = await tx
      .update(inviteLink)
      .set({ revokedAt: new Date() })
      .where(and(eq(inviteLink.id, row.id), isNull(inviteLink.revokedAt)))
      .returning();
    if (!updated) throw new HttpError(409, 'invite_link_revoked', 'link is already revoked');
    await audit({
      action: 'invite_link.revoke',
      entity: { type: 'invite_link', id: row.id },
      stationId: row.stationId,
      diff: {
        revokedAt: { from: null, to: updated.revokedAt },
        useCount: { from: null, to: updated.useCount },
      },
    });
    return toInviteLink(updated);
  });
}

/** A link that can still be used, or the reason it can't (404 unknown, 410 otherwise). */
async function usableLink(deps: AuthDeps, token: string): Promise<InviteLinkRow> {
  const row = await findInviteLinkByToken(deps.db, token);
  if (!row) throw new HttpError(404, 'invite_link_not_found', 'unknown invite link');
  const status = inviteLinkStatus(row);
  if (status !== 'active')
    throw new HttpError(410, `invite_link_${status}`, `this link is ${status.replace('_', ' ')}`);
  return row;
}

/**
 * The link's creator, as they are now: a link never grants more than whoever made it may still
 * grant. A removed or demoted user, or a revoked or expired API key (itself capped by its own
 * creator), stops the link working.
 */
async function linkCreator(
  deps: AuthDeps,
  scope: OrgScope,
  row: InviteLinkRow,
): Promise<Caller | null> {
  if (row.createdByApiKeyId) {
    const key = await findUsableApiKey(deps.db, row.createdByApiKeyId);
    if (!key || key.orgId !== scope.orgId) return null;
    return {
      actor: { type: 'api_key', apiKeyId: key.id },
      memberships: null,
      keyPermissions: expandScopes(key.scopes),
      keyStationId: key.stationId,
      keyCreatorMemberships: key.createdBy
        ? await userMembershipsInOrg(deps.db, key.createdBy, scope)
        : null,
    };
  }
  if (row.createdBy) {
    return {
      actor: userActor(row.createdBy),
      memberships: await userMembershipsInOrg(deps.db, row.createdBy, scope),
      keyPermissions: null,
    };
  }
  return null;
}

async function requireCreatorStillGrants(
  deps: AuthDeps,
  scope: OrgScope,
  row: InviteLinkRow,
): Promise<void> {
  const creator = await linkCreator(deps, scope, row);
  if (
    !creator ||
    !callerPermissions(creator, row.stationId).has('member:invite') ||
    roleRank[row.role] > grantCeiling(creator, row.stationId)
  ) {
    throw new HttpError(
      410,
      'invite_link_invalid',
      "this link's creator can no longer grant this role",
    );
  }
}

/** What a link's landing page shows. */
export async function inviteLinkInfo(deps: AuthDeps, token: string) {
  const row = await usableLink(deps, token);
  const scope = await resolveOrgScope(deps.db, row.orgId);
  await requireCreatorStillGrants(deps, scope, row);
  const org = await getOrganization(deps.db, scope);
  return {
    orgName: org.name,
    stationName: row.stationId ? (await getStation(deps.db, scope, row.stationId)).name : null,
    role: row.role,
    expiresAt: row.expiresAt,
    restrictToDomains: row.restrictToDomains,
  };
}

/**
 * Joins through a link as the signed-in user. Needs a verified email, and one at the org's
 * verified domains when the link is restricted. The use is counted in the same transaction
 * as the membership, so a failed join doesn't burn a use.
 */
export async function joinWithInviteLink(deps: AuthDeps, userId: string, token: string) {
  const current = await verifiedUser(deps, userId);
  const row = await usableLink(deps, token);
  const scope = await resolveOrgScope(deps.db, row.orgId);
  if (row.restrictToDomains) {
    const domain = emailDomain(current.email);
    const allowed = (await listOrgDomains(deps.db, scope)).some(
      (d) => d.verifiedAt && d.domain === domain,
    );
    if (!allowed) {
      throw new HttpError(
        403,
        'domain_not_allowed',
        "this link is for the organization's email domains only",
      );
    }
  }
  await requireCreatorStillGrants(deps, scope, row);
  const ctx = { actor: userActor(current.id), scope };
  await withAudit(deps.db, ctx, async (tx, audit) => {
    const claimed = await claimInviteLinkUse(tx, row.id);
    if (!claimed) {
      const now = (await findInviteLinkByToken(tx, token)) ?? row;
      const status = inviteLinkStatus(now);
      throw new HttpError(
        410,
        `invite_link_${status === 'active' ? 'used_up' : status}`,
        'this link can no longer be used',
      );
    }
    if (
      (await userMembershipsInOrg(tx, current.id, scope)).some((m) => m.stationId === row.stationId)
    ) {
      throw new HttpError(409, 'already_member', 'you already have a role in this scope');
    }
    await addMembership(tx, ctx, membershipInput(current.id, row.role, row.stationId));
    await audit({
      action: 'invite_link.use',
      entity: { type: 'invite_link', id: row.id },
      stationId: row.stationId,
      diff: {
        userId: { from: null, to: current.id },
        useCount: { from: claimed.useCount - 1, to: claimed.useCount },
      },
    });
  });
  return { orgId: row.orgId, stationId: row.stationId, role: row.role };
}
