# auth module (#6)

Accounts, sessions, TOTP 2FA, single invitations, scoped API keys and RBAC.

```
plugins/auth.ts        # request.auth, requirePermission, requireUser, onUserVerified, cookies, rate limit
plugins/mail.ts        # app.mailer (SMTP from env), defineTemplate / sendTemplate
plugins/errors.ts      # HttpError and the error handler ({ error, message, details? })
modules/auth/
  routes.ts            # /api/v1/auth/*, /invitations/accept, org/station invitations, API keys, 2FA policy
  service.ts           # the flows; every mutation goes through withAudit
  repo.ts              # auth tables (user_auth, session, auth_token, recovery_code, invitation, org_auth_policy)
  totp.ts crypto.ts password.ts emails.ts
  testing.ts           # createTestApp(), signUpAndLogin(), enableTotp() for *.int.test.ts
packages/shared/src/contracts/auth.ts   # permission catalogue, role presets, DTOs
```

## Guarding a route

```ts
app.get(
  '/stations/:stationId/tracks',
  { preHandler: app.requirePermission('library', 'read') },
  async (request) => listTracks(app.db, stationScopeOf(request)),
);
```

- The guard authenticates (session cookie or `Authorization: Bearer ondes_…`), resolves the tenant
  scope from `:orgId` / `:stationId` with the branded scopes, checks membership, the org's
  "require 2FA" policy, then the permission. It sets `request.scope` and `request.permissions`.
- Not a member, or an id of another tenant → **404**. Member without the permission → **403
  `forbidden`**. Org requires 2FA and the user has none → **403 `two_factor_required`**.
  Anonymous → **401**.
- Org roles (owner, admin) apply to every station. Station roles apply to their station, and only
  grant `org:read` on org-level routes. Presets: `rolePermissions` in the shared contract; the
  matrix is pinned by `packages/shared/src/contracts/auth.test.ts`.
- Audit actor: `actorOf(request)`. Row-level rules (`show:write_own`) are the module's job.
- New resource or action: add it to `permissionCatalogue`, the presets and the expected matrix.

## Sessions

- `ondes_session` cookie: random 256-bit token, `HttpOnly`, `Secure` (`AUTH_COOKIE_SECURE`),
  `SameSite=Lax`, path `/`. Only its SHA-256 is stored. Every sign-in issues a new token and drops
  the one presented; a password reset drops all of the user's sessions.
- CSRF: `SameSite=Lax` plus JSON-only bodies (form posts get 415).
- With TOTP on, `POST /auth/login` answers `two_factor_required` and sets a 10-minute *pending*
  session that only `POST /auth/login/2fa` accepts (code or recovery code). TOTP codes can't be
  replayed (the last used time step is stored).
- Rate limit: `AUTH_RATE_LIMIT_MAX` per minute, per client IP and route, in memory (per replica).

## Extension point: `onUserVerified`

```ts
app.auth.onUserVerified(async ({ user, reason }) => {
  // reason: 'email_verified' (verification link, invitation sign-up, reset link) or 'sign_in'
});
```

Register it from a plugin at boot. Handlers run in order after the fact (the session or
verification is already committed); a throwing handler is logged and never blocks the user.

## Invitations

`POST /orgs/:orgId/invitations` (any level; owners/admins) and `POST /stations/:stationId/invitations`
(station roles; station managers). The inviter needs `member:invite` on the target scope and can
grant at most their own role (API keys: no org roles, at most `station_manager`). A new invitation
for the same email and scope revokes the pending one. Tokens are random, stored hashed, expire
(default 7 days, `expiresInDays` up to 30) and can be revoked or resent.

Accepting: `POST /invitations/accept` signed in with the invited email (the membership attaches to
that account), or `POST /auth/signup` with `invitationToken` (the email counts as verified).
