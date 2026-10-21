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

- **Domain rules and join requests:** `/orgs/:orgId/…` with `member:manage` on the org: owners
  and admins only (station roles never hold it at org level).
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

- Public providers (`free-email-domains`, pinned; its network postinstall is disabled) are
  refused, including their subdomains. A verified domain belongs to one org.
- **Auto-join** (`onUserVerified`, on email verification and on sign-in): a verified user at an
  active auto-join domain gets the rule's default grant, if their account was created after the
  domain was verified and they were never a member of the org (removed people don't walk back
  in). Older accounts go through the review list instead.
- **Request to join:** `GET /me/joinable-orgs`, `POST /me/joinable-orgs/:orgId/join` (joins at
  once on an auto-join rule, files a request otherwise; owners/admins are emailed).
  `GET /orgs/:orgId/join-requests?status=`, `POST …/:id/approve` (optional `grant`), `…/refuse`.
- DNS goes through a `TxtResolver` (`node:dns/promises` by default). Tests inject a fake:
  `buildApp({ invitations: { resolver } })`.

## Invitation lists

`POST {/orgs/:orgId | /stations/:stationId}/invitation-lists/preview` then `…/send`, with
`{format:'emails', text, role, stationId?}` or `{format:'csv', text, defaultRole?, defaultStationId?}`
(CSV `email, role, station?, name?`, header optional, station by id or slug). Rows come back
`valid`, `invalid` (with a `reason`), `already_member` or `duplicate`. Sending turns each valid
row into a normal #6 invitation (`createInvitation`, default 14 days). Limits: 500 rows per list,
300 invitations per org per hour (`limits` option), plus the auth route rate limit.
`GET …/invitation-lists?status=&stationId=&invitedBy=&email=` is the list view, with the inviter.
Resend and revoke are #6's invitation routes. The CSV `name` column is shown in the preview but
not stored.

## Invite links

`POST {prefix}/invite-links` (org: `{grant, …}`, station: `{role, …}`; `label`, `expiresInDays`
default 7, `maxUses`, `restrictToDomains`), `GET` (with `useCount` and `status`), `DELETE` to
revoke. The token is shown once and stored hashed. `POST /invite-links/info` (anonymous) shows the
landing page data; `POST /invite-links/join` (signed in, verified email) joins. The use is counted
in the same transaction as the membership, so a failed join doesn't burn one.

## Audit actions

`org_domain.{create,update,pause,resume,delete,verification_send,verify,member_add,auto_join,self_join}`,
`join_request.{create,approve,refuse}`, `invitation_list.send` (plus #6's `invitation.*`),
`invite_link.{create,use,revoke}`.
