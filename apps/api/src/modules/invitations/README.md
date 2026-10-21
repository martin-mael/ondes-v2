# invitations module (#113)

Team onboarding on top of #6's single invitations: email-domain rules (auto-join or
request-to-join), bulk invitation lists and shareable invite links.

```
modules/invitations/
  routes.ts      # routes (below) + the `onUserVerified` auto-join hook; options: resolver, limits
  service.ts     # the flows; every mutation goes through withAudit
  repo.ts        # org_domain, invite_link, join_request
  domains.ts     # public-provider blocklist, DNS TXT check (injectable resolver)
  parse.ts       # pasted emails and CSV
  emails.ts      # domain confirmation, join request / decision, auto-joined
  testing.ts     # createInvitationsTestApp() with a fake DNS resolver
packages/db/src/schema/invitations.ts         # tables
packages/shared/src/contracts/invitations.ts  # DTOs
```

## Permissions

Everything reuses #6's `callerPermissions` and `grantCeiling`, so API keys stay capped by their
creator (and never grant org roles).

- **Domain rules and join requests:** `/orgs/:orgId/…` with `member:manage` on the org, and a
  signed-in user (`requireUser`): owners and admins themselves, never API keys.
- **Lists and links:** org routes (any scope, owners/admins) and station routes (station roles,
  that station only). Callers grant at most their own role on the target scope.

## Email-domain rules

| Route | |
|---|---|
| `GET/POST /orgs/:orgId/domains` | list, add (`domain`, `policy: auto_join \| request`, `defaultGrant`) |
| `PATCH/DELETE /orgs/:orgId/domains/:id` | policy, default grant, `paused`; delete keeps members |
| `POST /orgs/:orgId/domains/:id/verify` | `{method:'dns'}` checks `ondes-verify=<token>` now; `{method:'email', mailbox}` mails a link to `admin@`, `postmaster@`, … |
| `POST /domains/confirm` | the emailed link (anonymous, token is the proof) |
| `GET/POST /orgs/:orgId/domains/:id/candidates` | review list of existing users at the domain; add them |

- Public providers (`free-email-domains`, pinned, its network postinstall disabled, plus Tuta's
  domains in `EXTRA_PUBLIC_DOMAINS`) are refused, including their subdomains.
- A verified domain belongs to one org. Adding a domain someone else verified works, and
  verifying it fails like a missing record, so the api doesn't reveal who owns which domain.
- Auto-join rules grant station roles only (`auto_join_role_too_high`); org roles go through
  request and approval.
- **Re-checks:** verified domains are re-checked daily (`recheckIntervalMs`; claimed per domain
  so replicas don't double up). A DNS domain whose record is missing `MAX_FAILED_CHECKS` (3)
  times in a row, or an email confirmation older than a year, is unverified and owners/admins
  are emailed. DNS outages don't count. Resuming a rule or changing its policy re-checks first
  (`409 verification_lost`).
- **Auto-join** (`onUserVerified`, on email verification and on sign-in): a verified user at an
  active auto-join domain gets the rule's default grant, if their account was created after the
  domain was verified and they were never a member of the org (removed people don't walk back
  in). Older accounts go through the review list, or ask. "Ever a member" is
  `org_member_history`, filled by a trigger on `membership` inserts (migration
  `org-member-history`, backfilled from memberships and the audit log).
- **Request to join:** `GET /me/joinable-orgs`, `POST /me/joinable-orgs/:orgId/join` (joins at
  once when auto-join applies to them, files a request otherwise; owners/admins are emailed once
  per request). After a refusal the user waits 30 days before asking again
  (`429 request_cooldown`).
  `GET /orgs/:orgId/join-requests?status=`, `POST …/:id/approve` (optional `grant`), `…/refuse`.
- DNS goes through a `TxtResolver` (`node:dns/promises` by default). Tests inject a fake:
  `buildApp({ invitations: { resolver } })`.

## Invitation lists

`POST {/orgs/:orgId | /stations/:stationId}/invitation-lists/preview` then `…/send`, with
`{format:'emails', text, role, stationId?}` or `{format:'csv', text, defaultRole?, defaultStationId?}`
(CSV `email, role, station?, name?`, header optional, station by id or slug). Rows come back
`valid`, `invalid` (with a `reason`), `already_member` or `duplicate`. Sending turns each valid
row into a normal #6 invitation (`createInvitation`, default 14 days). Limits: 500 rows per list,
300 invitations per org per hour (`limits` option), plus the auth route rate limit. A send
reserves its rows of the hourly budget under a per-org advisory lock
(`invitation_send_reservation`), so parallel sends can't overrun it. The `invitation_list.send`
audit row is written even if a send stops halfway (`completed`, `unsent`).
`GET …/invitation-lists?status=&stationId=&invitedBy=&email=` is the list view, with the inviter
(their email only for callers with `member:invite`).
Resend and revoke are #6's invitation routes. The CSV `name` column is shown in the preview but
not stored.

## Invite links

`POST {prefix}/invite-links` (org: `{grant, …}`, station: `{role, …}`; `label`, `expiresInDays`
default 7, `maxUses`, `restrictToDomains`), `GET` (with `useCount` and `status`), `DELETE` to
revoke. The token is shown once and stored hashed. `POST /invite-links/info` (anonymous) shows the
landing page data; `POST /invite-links/join` (signed in, verified email) joins. The use is counted
in the same transaction as the membership, so a failed join doesn't burn one. Every join
re-checks the creator's current rights, like API keys: a removed or demoted creator, or a
revoked or expired API key (`created_by_api_key_id`), makes the link `410 invite_link_invalid`.

## Audit actions

`org_domain.{create,update,pause,resume,delete,verification_send,verify,unverify,member_add,auto_join,self_join}`,
`join_request.{create,approve,refuse}`, `invitation_list.send` (plus #6's `invitation.*`),
`invite_link.{create,use,revoke}`.
