import { z } from 'zod';
import { invitationSchema, invitationStatusSchema, linkTokenSchema } from './auth.ts';
import { orgRoleSchema, roleSchema, stationRoleSchema, uuidSchema } from './tenancy.ts';

// Team onboarding contracts (#113): email-domain rules, bulk invitation lists, shareable
// invite links and join requests. Single invitations are #6's (`auth.ts`).

/** A role and where it applies: the org, or one station (same rule as memberships). */
const grantSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('org'), role: orgRoleSchema }),
  z.object({ level: z.literal('station'), stationId: uuidSchema, role: stationRoleSchema }),
]);
export type Grant = z.input<typeof grantSchema>;

// --- Email-domain rules ------------------------------------------------------------------

export const domainJoinPolicySchema = z.enum(['auto_join', 'request']);
export type DomainJoinPolicy = z.infer<typeof domainJoinPolicySchema>;
export const domainVerificationMethodSchema = z.enum(['dns', 'email']);
export type DomainVerificationMethod = z.infer<typeof domainVerificationMethodSchema>;
export const orgDomainStatusSchema = z.enum(['unverified', 'active', 'paused']);

/** `vandaleradio.org`: lowercase, at least one dot, no `@`. */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^@/, '').replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
        'expected a domain name like example.org',
      ),
  );

export const orgDomainSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  domain: z.string(),
  policy: domainJoinPolicySchema,
  defaultRole: roleSchema,
  defaultStationId: uuidSchema.nullable(),
  status: orgDomainStatusSchema,
  /** Publish `ondes-verify=<dnsToken>` as a TXT record on the domain. */
  dnsRecord: z.string(),
  verifiedAt: z.date().nullable(),
  verificationMethod: domainVerificationMethodSchema.nullable(),
  /** Where the last confirmation link went, while it is outstanding. */
  emailVerificationSentTo: z.string().nullable(),
  pausedAt: z.date().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: z.date(),
});
export type OrgDomain = z.infer<typeof orgDomainSchema>;

export const createOrgDomainSchema = z.object({
  domain: domainNameSchema,
  policy: domainJoinPolicySchema,
  /** Role (and scope) new members get. */
  defaultGrant: grantSchema,
});
export type CreateOrgDomain = z.input<typeof createOrgDomainSchema>;

export const updateOrgDomainSchema = z
  .object({
    policy: domainJoinPolicySchema,
    defaultGrant: grantSchema,
    paused: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateOrgDomain = z.input<typeof updateOrgDomainSchema>;

/** Mailboxes a confirmation link may go to (same idea as certificate authorities use). */
export const domainAdminMailboxSchema = z.enum([
  'admin',
  'administrator',
  'hostmaster',
  'postmaster',
  'webmaster',
]);

export const verifyOrgDomainSchema = z.discriminatedUnion('method', [
  /** Checks the TXT record now. */
  z.object({ method: z.literal('dns') }),
  /** Sends a confirmation link to `<mailbox>@<domain>`. */
  z.object({ method: z.literal('email'), mailbox: domainAdminMailboxSchema }),
]);
export type VerifyOrgDomain = z.input<typeof verifyOrgDomainSchema>;

/** A user whose verified email matches the domain but who isn't a member yet. */
export const domainCandidateSchema = z.object({
  userId: uuidSchema,
  email: z.string(),
  name: z.string(),
});
export type DomainCandidate = z.infer<typeof domainCandidateSchema>;

export const addDomainCandidatesSchema = z.object({
  userIds: z.array(uuidSchema).min(1).max(500),
});

// --- Join requests -----------------------------------------------------------------------

export const joinRequestStatusSchema = z.enum(['pending', 'approved', 'refused']);
export type JoinRequestStatus = z.infer<typeof joinRequestStatusSchema>;

export const joinRequestSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  userId: uuidSchema,
  email: z.string(),
  name: z.string(),
  domainId: uuidSchema.nullable(),
  status: joinRequestStatusSchema,
  decidedBy: uuidSchema.nullable(),
  decidedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

/** Approving: the rule's default grant, unless the admin picks another one. */
export const approveJoinRequestSchema = z.object({ grant: grantSchema.optional() });

/** An org the signed-in user may join (or ask to join) through a domain rule. */
export const joinableOrgSchema = z.object({
  orgId: uuidSchema,
  orgName: z.string(),
  domainId: uuidSchema,
  policy: domainJoinPolicySchema,
  /** A request of theirs is already waiting. */
  requestPending: z.boolean(),
});
export type JoinableOrg = z.infer<typeof joinableOrgSchema>;

export const joinOrgResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('joined') }),
  z.object({ status: z.literal('requested'), request: joinRequestSchema }),
]);

// --- Invitation lists (bulk) -------------------------------------------------------------

export const invitationListInputSchema = z.discriminatedUnion('format', [
  /** Emails separated by newlines, commas, semicolons or spaces; all get `role`. */
  z.object({
    format: z.literal('emails'),
    text: z.string().max(200_000),
    role: roleSchema,
    /** For station roles (on org routes; station routes use their own station). */
    stationId: uuidSchema.optional(),
  }),
  /**
   * CSV `email, role, station?, name?` (header optional). `station` is a station id or slug;
   * empty role/station cells fall back to the defaults.
   */
  z.object({
    format: z.literal('csv'),
    text: z.string().max(200_000),
    defaultRole: roleSchema.optional(),
    defaultStationId: uuidSchema.optional(),
  }),
]);
export type InvitationListInput = z.input<typeof invitationListInputSchema>;

export const sendInvitationListSchema = invitationListInputSchema.and(
  z.object({ expiresInDays: z.number().int().min(1).max(30).default(14) }),
);
export type SendInvitationList = z.input<typeof sendInvitationListSchema>;

export const invitationListRowStatusSchema = z.enum([
  'valid',
  'invalid',
  'already_member',
  'duplicate',
]);

export const invitationListRowSchema = z.object({
  /** 1-based line in the input. */
  line: z.number().int(),
  email: z.string(),
  name: z.string().nullable(),
  role: roleSchema.nullable(),
  stationId: uuidSchema.nullable(),
  status: invitationListRowStatusSchema,
  /** Why a row is invalid: `invalid_email`, `unknown_role`, `unknown_station`, `role_too_high`, … */
  reason: z.string().nullable(),
  /** A pending invitation for the same person and scope will be replaced. */
  replacesPending: z.boolean(),
});
export type InvitationListRow = z.infer<typeof invitationListRowSchema>;

export const invitationListPreviewSchema = z.object({
  rows: z.array(invitationListRowSchema),
  counts: z.record(invitationListRowStatusSchema, z.number().int()),
});
export type InvitationListPreview = z.infer<typeof invitationListPreviewSchema>;

export const invitationListResultSchema = z.object({
  sent: z.array(invitationSchema),
  /** Rows that weren't sent (invalid, duplicate, already a member). */
  skipped: z.array(invitationListRowSchema),
});

/** Invitation list view: filters, and who invited whom. */
export const invitationListQuerySchema = z.object({
  status: invitationStatusSchema.optional(),
  stationId: uuidSchema.optional(),
  invitedBy: uuidSchema.optional(),
  /** Substring of the invited email. */
  email: z.string().max(320).optional(),
});

export const invitationWithInviterSchema = invitationSchema.extend({
  /** `email` only for callers who can invite (`member:invite`); others get names. */
  inviter: z.object({ id: uuidSchema, name: z.string(), email: z.string().nullable() }).nullable(),
});

// --- Invite links ------------------------------------------------------------------------

export const inviteLinkStatusSchema = z.enum(['active', 'expired', 'revoked', 'used_up']);

export const inviteLinkSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema.nullable(),
  role: roleSchema,
  label: z.string().nullable(),
  expiresAt: z.date(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  restrictToDomains: z.boolean(),
  status: inviteLinkStatusSchema,
  createdBy: uuidSchema.nullable(),
  /** Set for links made with an API key. */
  createdByApiKeyId: uuidSchema.nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type InviteLink = z.infer<typeof inviteLinkSchema>;

const inviteLinkOptionsSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  maxUses: z.number().int().min(1).max(10_000).optional(),
  restrictToDomains: z.boolean().default(false),
});

export const createInviteLinkSchema = z.object({ grant: grantSchema }).and(inviteLinkOptionsSchema);
export type CreateInviteLink = z.input<typeof createInviteLinkSchema>;

/** On station routes the station is the route's. */
export const createStationInviteLinkSchema = z
  .object({ role: stationRoleSchema })
  .and(inviteLinkOptionsSchema);

export const createInviteLinkResponseSchema = z.object({
  inviteLink: inviteLinkSchema,
  /** Shown once: only its hash is stored. */
  token: z.string(),
  url: z.string(),
});

/** What the landing page of a link shows before joining. */
export const inviteLinkInfoSchema = z.object({
  orgName: z.string(),
  stationName: z.string().nullable(),
  role: roleSchema,
  expiresAt: z.date(),
  restrictToDomains: z.boolean(),
});

export const inviteLinkTokenSchema = z.object({ token: linkTokenSchema });

export const joinInviteLinkResponseSchema = z.object({
  orgId: uuidSchema,
  stationId: uuidSchema.nullable(),
  role: roleSchema,
});
