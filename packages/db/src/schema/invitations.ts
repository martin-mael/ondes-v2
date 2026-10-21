import type {
  DomainJoinPolicy,
  DomainVerificationMethod,
  JoinRequestStatus,
  Role,
} from '@ondes/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKey, organization, station, user } from './tenancy.ts';

// Team onboarding (#113): email-domain rules, shareable invite links and join requests.
// Contracts: packages/shared/src/contracts/invitations.ts. Single and bulk invitations reuse
// #6's `invitation` table (tenancy.ts): every bulk row is a normal invitation.

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Same rule as memberships and invitations: org roles have no station, station roles need one. */
const roleLevelCheck = (name: string, role: unknown, stationId: unknown) =>
  check(
    name,
    sql`(${role} in ('owner', 'admin') and ${stationId} is null)
      or (${role} in ('station_manager', 'programmer', 'presenter', 'viewer') and ${stationId} is not null)`,
  );

/**
 * An email domain claimed by an org. Inactive until verified (DNS TXT or a link sent to an
 * admin mailbox at the domain); a verified domain belongs to one org only.
 */
export const orgDomain = pgTable(
  'org_domain',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Lowercase, no leading `@`. */
    domain: text('domain').notNull(),
    policy: text('policy').$type<DomainJoinPolicy>().notNull(),
    /** Role new members get; `default_station_id` set for station roles. */
    defaultRole: text('default_role').$type<Role>().notNull(),
    defaultStationId: uuid('default_station_id'),
    /** Public challenge for the `ondes-verify=<token>` TXT record. Not a secret. */
    dnsToken: text('dns_token').notNull(),
    /** SHA-256 of the confirmation link's token, while one is outstanding. */
    emailTokenHash: text('email_token_hash').unique(),
    emailTokenExpiresAt: timestamp('email_token_expires_at', { withTimezone: true }),
    emailTokenSentTo: text('email_token_sent_to'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationMethod: text('verification_method').$type<DomainVerificationMethod>(),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Last periodic re-check of a verified domain, and the failures in a row since. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    failedChecks: integer('failed_checks').notNull().default(0),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'org_domain_station_org_fk',
      columns: [t.defaultStationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    uniqueIndex('org_domain_org_domain_key').on(t.orgId, t.domain),
    // One org owns a verified domain.
    uniqueIndex('org_domain_verified_key').on(t.domain).where(sql`${t.verifiedAt} is not null`),
    index('org_domain_domain_idx').on(t.domain),
    check('org_domain_policy_check', sql`${t.policy} in ('auto_join', 'request')`),
    roleLevelCheck('org_domain_role_level_check', t.defaultRole, t.defaultStationId),
  ],
);

/** A shareable link: fixed role and scope, expiry, optional use cap. Token stored hashed. */
export const inviteLink = pgTable(
  'invite_link',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** `null` for org-level roles. */
    stationId: uuid('station_id'),
    role: text('role').$type<Role>().notNull(),
    label: text('label'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    /** Only users whose email is at one of the org's verified domains may join. */
    restrictToDomains: boolean('restrict_to_domains').notNull().default(false),
    /** Who made it: a user, or an API key. Their current rights cap every join. */
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKey.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'invite_link_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    index('invite_link_org_id_idx').on(t.orgId),
    check('invite_link_max_uses_check', sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    check(
      'invite_link_use_count_check',
      sql`${t.useCount} >= 0 and (${t.maxUses} is null or ${t.useCount} <= ${t.maxUses})`,
    ),
    roleLevelCheck('invite_link_role_level_check', t.role, t.stationId),
  ],
);

/** "Request access" from a user whose email matches a verified `request` domain rule. */
export const joinRequest = pgTable(
  'join_request',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The rule that allowed the request; kept when the rule is removed. */
    domainId: uuid('domain_id').references(() => orgDomain.id, { onDelete: 'set null' }),
    status: text('status').$type<JoinRequestStatus>().notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('join_request_org_id_idx').on(t.orgId),
    uniqueIndex('join_request_pending_key')
      .on(t.orgId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    check('join_request_status_check', sql`${t.status} in ('pending', 'approved', 'refused')`),
  ],
);

/**
 * Everyone who ever held a membership in an org, filled by a trigger on `membership` inserts
 * (migration `org-member-history`). Domain rules don't let a removed member back in on their own.
 */
export const orgMemberHistory = pgTable(
  'org_member_history',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    firstJoinedAt: timestamp('first_joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/**
 * Invitations a list send has reserved but not created yet, so parallel sends can't overrun an
 * org's hourly budget. Taken under a per-org advisory lock; old rows don't count.
 */
export const invitationSendReservation = pgTable(
  'invitation_send_reservation',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    remaining: integer('remaining').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitation_send_reservation_org_id_idx').on(t.orgId, t.createdAt),
    check('invitation_send_reservation_remaining_check', sql`${t.remaining} >= 0`),
  ],
);
