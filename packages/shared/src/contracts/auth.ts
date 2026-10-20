import { z } from 'zod';
import {
  apiKeySchema,
  isOrgRole,
  membershipSchema,
  orgRoleSchema,
  type Role,
  roleSchema,
  stationRoleSchema,
  userSchema,
  uuidSchema,
} from './tenancy.ts';

// Authentication and RBAC contracts (#6): permission catalogue, role presets, auth DTOs.

// --- Permissions -------------------------------------------------------------------------

/**
 * Every `resource:action` the api checks. Modules guard their routes with
 * `requirePermission(resource, action)`; API keys carry a subset of these as scopes.
 * Adding a resource or action is additive; renaming one is a contract change.
 */
export const permissionCatalogue = {
  org: ['read', 'update', 'delete'],
  station: ['read', 'create', 'update', 'delete'],
  member: ['read', 'invite', 'manage'],
  api_key: ['read', 'manage'],
  audit: ['read'],
  library: ['read', 'write'],
  rotation: ['read', 'write'],
  clock: ['read', 'write'],
  /** `write_own`: only shows the user presents (row-level check in the shows module). */
  show: ['read', 'write', 'write_own'],
  log: ['read', 'write'],
  voice_track: ['read', 'write', 'write_own'],
  /** `broadcast`: go live with one's own live credentials. */
  live: ['read', 'manage', 'broadcast'],
  engine: ['read', 'control'],
  alert: ['read', 'manage'],
  dashboard: ['read'],
} as const;

export type Resource = keyof typeof permissionCatalogue;
export type Action<R extends Resource = Resource> = (typeof permissionCatalogue)[R][number];
/** `resource:action`, e.g. `library:write`. */
export type Permission = {
  [R in Resource]: `${R}:${(typeof permissionCatalogue)[R][number]}`;
}[Resource];

export const resources = Object.keys(permissionCatalogue) as Resource[];

export const allPermissions: readonly Permission[] = resources.flatMap((resource) =>
  permissionCatalogue[resource].map((action) => `${resource}:${action}` as Permission),
);

const permissionSet = new Set<string>(allPermissions);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}

export const permissionSchema = z.string().refine(isPermission, 'unknown permission');

/**
 * An API-key scope: a permission, or `resource:*` for every action on a resource.
 * Narrower than `apiKeyScopeSchema` (tenancy), which only checks the shape.
 */
export const permissionScopeSchema = z
  .string()
  .refine(
    (value) =>
      isPermission(value) || (value.endsWith(':*') && value.slice(0, -2) in permissionCatalogue),
    'unknown permission scope',
  );

/** Expands `resource:*` scopes into the permissions they grant. Unknown scopes are dropped. */
export function expandScopes(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if (isPermission(scope)) out.add(scope);
    else if (scope.endsWith(':*')) {
      const resource = scope.slice(0, -2);
      if (resource in permissionCatalogue) {
        for (const action of permissionCatalogue[resource as Resource]) {
          out.add(`${resource}:${action}` as Permission);
        }
      }
    }
  }
  return out;
}

// --- Role presets ------------------------------------------------------------------------

const all = (resource: Resource): Permission[] =>
  permissionCatalogue[resource].map((action) => `${resource}:${action}` as Permission);

const stationWork: Permission[] = [
  ...all('library'),
  ...all('rotation'),
  ...all('clock'),
  ...all('log'),
  'show:read',
  'show:write',
  'voice_track:read',
  'voice_track:write',
];

/**
 * Role presets from the spec (#1, "Users & roles"). Org roles apply to every station of the
 * org; station roles apply to their station only (see `effectivePermissions`).
 */
export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: allPermissions,
  admin: allPermissions.filter((p) => p !== 'org:delete'),
  /** Everything on a station, but not the station's existence (create/delete are org-level). */
  station_manager: [
    'org:read',
    'station:read',
    'station:update',
    ...all('member'),
    ...all('api_key'),
    'audit:read',
    ...stationWork,
    'show:write_own',
    'voice_track:write_own',
    ...all('live'),
    ...all('engine'),
    ...all('alert'),
    'dashboard:read',
  ],
  programmer: [
    'org:read',
    'station:read',
    'member:read',
    ...stationWork,
    'show:write_own',
    'voice_track:write_own',
    'live:read',
    'engine:read',
    'alert:read',
    'dashboard:read',
  ],
  presenter: [
    'org:read',
    'station:read',
    'library:read',
    'log:read',
    'show:read',
    'show:write_own',
    'voice_track:read',
    'voice_track:write_own',
    'live:read',
    'live:broadcast',
    'engine:read',
    'dashboard:read',
  ],
  viewer: ['org:read', 'station:read', 'dashboard:read', 'log:read', 'show:read', 'engine:read'],
};

/** What a station-level membership grants on org-level routes (it can see its org, no more). */
export const stationRoleOrgPermissions: readonly Permission[] = ['org:read'];

/** Higher grants more. Used for "invite at or below your own role". */
export const roleRank: Record<Role, number> = {
  owner: 6,
  admin: 5,
  station_manager: 4,
  programmer: 3,
  presenter: 2,
  viewer: 1,
};

export interface MembershipGrant {
  role: Role;
  /** `null` for org roles. */
  stationId: string | null;
}

/**
 * Permissions a user's memberships (in one org) grant in a scope: the org itself
 * (`stationId` null) or one of its stations.
 */
export function effectivePermissions(
  memberships: readonly MembershipGrant[],
  stationId: string | null,
): Set<Permission> {
  const out = new Set<Permission>();
  for (const m of memberships) {
    let granted: readonly Permission[] = [];
    if (isOrgRole(m.role)) granted = rolePermissions[m.role];
    else if (stationId === null) granted = stationRoleOrgPermissions;
    else if (m.stationId === stationId) granted = rolePermissions[m.role];
    for (const p of granted) out.add(p);
  }
  return out;
}

/** Highest role among the memberships that apply to a scope, or `null`. */
export function highestRole(
  memberships: readonly MembershipGrant[],
  stationId: string | null,
): Role | null {
  let best: Role | null = null;
  for (const m of memberships) {
    const applies = isOrgRole(m.role) || (stationId !== null && m.stationId === stationId);
    if (applies && (best === null || roleRank[m.role] > roleRank[best])) best = m.role;
  }
  return best;
}

// --- Credentials -------------------------------------------------------------------------

/** 10–256 characters. The upper bound keeps argon2 from hashing megabytes. */
export const passwordSchema = z.string().min(10).max(256);
export const emailSchema = z
  .email()
  .max(320)
  .transform((email) => email.toLowerCase());
/** Opaque random token from an email link (base64url). */
export const linkTokenSchema = z.string().min(20).max(200);
/** 6-digit TOTP code. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'expected a 6-digit code');
/** `xxxxx-xxxxx`, case-insensitive; the dash is optional. */
export const recoveryCodeSchema = z.string().min(10).max(11);

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().min(1).max(200),
  password: passwordSchema,
  /** Signing up from an invitation link: proves the email, so it starts verified. */
  invitationToken: linkTokenSchema.optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

export const loginSecondFactorSchema = z.union([
  z.object({ code: totpCodeSchema }),
  z.object({ recoveryCode: recoveryCodeSchema }),
]);

export const emailOnlySchema = z.object({ email: emailSchema });
export const tokenOnlySchema = z.object({ token: linkTokenSchema });
export const resetPasswordSchema = z.object({ token: linkTokenSchema, password: passwordSchema });

export const totpSetupResponseSchema = z.object({
  /** Base32 secret, for manual entry. */
  secret: z.string(),
  /** `otpauth://totp/…`, for the QR code. */
  otpauthUrl: z.string(),
});
export const totpCodeOnlySchema = z.object({ code: totpCodeSchema });
export const disableTotpSchema = z.object({
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
});
export const recoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });

export type Signup = z.input<typeof signupSchema>;
export type Login = z.input<typeof loginSchema>;

// --- Session / me ------------------------------------------------------------------------

export const meSchema = z.object({
  user: userSchema,
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  memberships: z.array(membershipSchema),
});
export type Me = z.infer<typeof meSchema>;

export const loginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), me: meSchema }),
  /** Password accepted; send a TOTP or recovery code to `POST /auth/login/2fa`. */
  z.object({ status: z.literal('two_factor_required') }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Generic "we did it (or pretended to)" answer, for routes that mustn't reveal accounts. */
export const acceptedResponseSchema = z.object({ status: z.literal('accepted') });

/** Payload of the `onUserVerified` extension point (#113 attaches domain memberships). */
export const userVerifiedEventSchema = z.object({
  user: userSchema,
  /** Why it fired: the email was just verified, or a verified user signed in. */
  reason: z.enum(['email_verified', 'sign_in']),
});
export type UserVerifiedEvent = z.infer<typeof userVerifiedEventSchema>;

// --- Org auth policy ---------------------------------------------------------------------

export const orgAuthPolicySchema = z.object({
  orgId: uuidSchema,
  /** Members without TOTP get `403 two_factor_required` on this org's routes. */
  requireTwoFactor: z.boolean(),
});
export const updateOrgAuthPolicySchema = orgAuthPolicySchema.pick({ requireTwoFactor: true });
export type OrgAuthPolicy = z.infer<typeof orgAuthPolicySchema>;

// --- Invitations -------------------------------------------------------------------------

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'expired', 'revoked']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema.nullable(),
  email: z.email(),
  role: roleSchema,
  status: invitationStatusSchema,
  invitedBy: uuidSchema.nullable(),
  acceptedBy: uuidSchema.nullable(),
  expiresAt: z.date(),
  acceptedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** Org roles have no station; station roles need one (same rule as memberships). */
export const createInvitationSchema = z
  .discriminatedUnion('level', [
    z.object({ level: z.literal('org'), email: emailSchema, role: orgRoleSchema }),
    z.object({
      level: z.literal('station'),
      email: emailSchema,
      stationId: uuidSchema,
      role: stationRoleSchema,
    }),
  ])
  .and(z.object({ expiresInDays: z.number().int().min(1).max(30).optional() }));
export type CreateInvitation = z.input<typeof createInvitationSchema>;

// --- API keys ----------------------------------------------------------------------------

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(200),
  stationId: uuidSchema.nullable().optional(),
  scopes: z.array(permissionScopeSchema).min(1),
  expiresAt: z.coerce.date().nullable().optional(),
});
export const createApiKeyResponseSchema = z.object({
  apiKey: apiKeySchema,
  /** The full key. Shown once, never stored. */
  token: z.string(),
});
