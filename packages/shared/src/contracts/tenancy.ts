import { z } from 'zod';

// Tenancy contracts (#5): organizations, stations, users, memberships, API keys and the
// audit log. Mirrors packages/db/src/schema/tenancy.ts.

export const uuidSchema = z.uuid();

/** URL-safe identifier: lowercase letters, digits and single dashes, 2–63 chars. */
export const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes only');

/** IANA timezone name (`Europe/Paris`). Validated against the runtime's tz database. */
export const ianaTimezoneSchema = z.string().refine(isIanaTimezone, 'unknown IANA timezone');

export function isIanaTimezone(value: string): boolean {
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// --- Roles -------------------------------------------------------------------------------

/** Org-level roles: membership rows with no station. */
export const orgRoleSchema = z.enum(['owner', 'admin']);
/** Station-level roles: membership rows bound to one station. */
export const stationRoleSchema = z.enum(['station_manager', 'programmer', 'presenter', 'viewer']);
export const roleSchema = z.enum([
  'owner',
  'admin',
  'station_manager',
  'programmer',
  'presenter',
  'viewer',
]);

export type OrgRole = z.infer<typeof orgRoleSchema>;
export type StationRole = z.infer<typeof stationRoleSchema>;
export type Role = z.infer<typeof roleSchema>;

export function isOrgRole(role: Role): role is OrgRole {
  return (orgRoleSchema.options as readonly string[]).includes(role);
}

// --- Organization ------------------------------------------------------------------------

export const organizationSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string().min(1).max(200),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const createOrganizationSchema = organizationSchema.pick({ slug: true, name: true });
export const updateOrganizationSchema = createOrganizationSchema.partial();

export type Organization = z.infer<typeof organizationSchema>;
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

// --- Station -----------------------------------------------------------------------------

/**
 * Per-station engine settings, stored as jsonb. Keys are added by the engine issues (#26 and
 * its sub-issues); unknown keys are kept so older code doesn't drop newer settings.
 */
export const engineSettingsSchema = z.looseObject({});
export type EngineSettings = z.infer<typeof engineSettingsSchema>;

/** Integrated loudness target, in LUFS. -16 for music, -18 for talk (docs/research/03). */
export const loudnessTargetSchema = z.number().min(-31).max(-5);
/** Maximum true peak, in dBTP. */
export const truePeakLimitSchema = z.number().min(-9).max(0);

export const stationSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  slug: slugSchema,
  name: z.string().min(1).max(200),
  timezone: ianaTimezoneSchema,
  loudnessTargetLufs: loudnessTargetSchema,
  truePeakLimitDbtp: truePeakLimitSchema,
  engineSettings: engineSettingsSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const createStationSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  timezone: ianaTimezoneSchema,
  loudnessTargetLufs: loudnessTargetSchema.optional(),
  truePeakLimitDbtp: truePeakLimitSchema.optional(),
  engineSettings: engineSettingsSchema.optional(),
});
export const updateStationSchema = createStationSchema.partial();

export type Station = z.infer<typeof stationSchema>;
export type CreateStation = z.infer<typeof createStationSchema>;
export type UpdateStation = z.infer<typeof updateStationSchema>;

// --- User --------------------------------------------------------------------------------

export const userSchema = z.object({
  id: uuidSchema,
  email: z.email(),
  name: z.string().min(1).max(200),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const createUserSchema = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  name: z.string().min(1).max(200),
});
export const updateUserSchema = createUserSchema.partial();

export type User = z.infer<typeof userSchema>;
export type CreateUser = z.input<typeof createUserSchema>;
export type UpdateUser = z.input<typeof updateUserSchema>;

// --- Membership --------------------------------------------------------------------------

export const membershipSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  orgId: uuidSchema,
  /** `null` for org-level roles (owner, admin). */
  stationId: uuidSchema.nullable(),
  role: roleSchema,
  createdAt: z.date(),
});

/** Org roles have no station; station roles need one. */
export const createMembershipSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('org'), userId: uuidSchema, role: orgRoleSchema }),
  z.object({
    level: z.literal('station'),
    userId: uuidSchema,
    stationId: uuidSchema,
    role: stationRoleSchema,
  }),
]);

export type Membership = z.infer<typeof membershipSchema>;
export type CreateMembership = z.infer<typeof createMembershipSchema>;

// --- API key -----------------------------------------------------------------------------

/**
 * Permission scope granted to an API key, as `resource:action` (`log:read`, `library:*`).
 * The permission catalogue itself comes with RBAC (#6).
 */
export const apiKeyScopeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:(?:[a-z][a-z0-9_-]*|\*)$/, 'expected resource:action');

export const apiKeySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  /** `null` when the key covers every station of the org. */
  stationId: uuidSchema.nullable(),
  name: z.string().min(1).max(200),
  /** First characters of the key, shown in the UI to tell keys apart. Not a secret. */
  prefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  createdBy: uuidSchema.nullable(),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  stationId: uuidSchema.nullable().optional(),
  scopes: z.array(apiKeyScopeSchema).min(1),
  expiresAt: z.date().nullable().optional(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;
export type CreateApiKey = z.infer<typeof createApiKeySchema>;

// --- Audit log ---------------------------------------------------------------------------

/** Who performed a mutation. */
export const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: uuidSchema }),
  z.object({ type: z.literal('api_key'), apiKeyId: uuidSchema }),
  /** Background jobs, migrations, seeds. `name` says which (`dev-seed`, `log-generate`). */
  z.object({ type: z.literal('system'), name: z.string().min(1) }),
]);
export type Actor = z.infer<typeof actorSchema>;

export const actorTypeSchema = z.enum(['user', 'api_key', 'system']);
export type ActorType = z.infer<typeof actorTypeSchema>;

/** `<entity>.<verb>`, e.g. `station.update`, `api_key.revoke`. */
export const auditActionSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);

/** Changed fields only: `{ field: { from, to } }`. Secrets are never included. */
export const auditDiffSchema = z.record(
  z.string(),
  z.object({ from: z.unknown(), to: z.unknown() }),
);
export type AuditDiff = z.infer<typeof auditDiffSchema>;

export const auditLogEntrySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema.nullable(),
  stationId: uuidSchema.nullable(),
  actorType: actorTypeSchema,
  actorId: z.string().nullable(),
  action: auditActionSchema,
  entityType: z.string(),
  entityId: z.string(),
  diff: auditDiffSchema,
  at: z.date(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
