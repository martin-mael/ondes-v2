# @ondes/db

Postgres 18 schema, client, migrations and tenancy helpers. Drizzle ORM 0.45 with the
postgres.js driver; drizzle-kit 0.31 generates the migrations.

```
drizzle.config.ts     # drizzle-kit config (timestamp-prefixed migrations)
migrations/           # generated SQL + meta/ (snapshots, _journal.json). Never edit by hand.
src/
  schema/<domain>.ts  # one file per domain; re-exported by schema/index.ts
  client.ts           # createDb(): pool + typed drizzle instance (Db, Tx, Executor types)
  migrate.ts          # runMigrations(): used at boot and by `pnpm --filter @ondes/db migrate`
  tenant.ts           # OrgScope / StationScope, resolveOrgScope(), resolveStationScope(), whereStation()
  audit.ts            # withAudit(), writeAudit(), auditDiff()
  repos/tenancy.ts    # organizations, stations, users, memberships, API keys
  repos/library.ts    # assets, files, cues, loudness, analysis, tags (#17)
  repos/storage.ts    # createPostgresQuotaStore(): @ondes/storage's QuotaStore on Postgres
  testing.ts          # @ondes/db/testing: createTestDatabase() for *.int.test.ts
```

## Commands

```sh
pnpm --filter @ondes/db generate --name <what>   # write a migration from the schema diff
pnpm --filter @ondes/db migrate                  # apply pending migrations to $DATABASE_URL
pnpm test:integration                            # needs `pnpm dev:up`
```

`generate` doesn't need a database: it diffs `src/schema` against the last snapshot in
`migrations/meta`.

## Migrations

- Migrations run **on boot**: the api calls `runMigrations()` before opening its pool
  (`apps/api/src/plugins/db.ts`, disable with `DB_MIGRATE_ON_BOOT=false`). A Postgres advisory
  lock serializes concurrent runs, so several replicas can boot at once.
- They are **forward-only** and must be safe on a populated database. Rename or drop in two
  steps (expand/contract): add the new column and backfill, ship, then drop the old one in a
  later PR.
- File names carry a **timestamp prefix** (`20261019233548_tenancy.sql`), so two PRs never
  produce the same file name.

### Parallel-safe workflow

Several agents add tables at the same time. `migrations/meta/_journal.json` and the snapshots
form a chain, so two branches that each generated a migration will conflict, or worse, merge
cleanly into a broken chain. The rule:

1. Put your tables in your domain's file (`src/schema/<domain>.ts`) and export it from
   `src/schema/index.ts`. Don't edit another domain's file, except to add a foreign key you
   need (say so in the PR).
2. Generate **one** migration for your PR: `pnpm --filter @ondes/db generate --name <issue-slug>`.
   If you change the schema again before merging, delete your migration and generate it again
   (step 3 without the rebase).
3. When `main` moved and gained migrations (conflict or not), **rebase, delete your generated
   migration, regenerate it, rerun the tests**. Your migration is a `.sql` file, a snapshot and
   one journal entry:
   ```sh
   git rebase origin/main        # on a conflict in migrations/meta, just take main's version
   git rm packages/db/migrations/<your-ts>_<name>.sql packages/db/migrations/meta/<your-ts>_snapshot.json
   git checkout origin/main -- packages/db/migrations/meta/_journal.json
   pnpm --filter @ondes/db generate --name <issue-slug>
   pnpm test:integration
   ```
4. **Never hand-merge `_journal.json` or a snapshot.** Regenerating is always correct; merging
   by hand silently corrupts the diff base for everyone after you.
5. Custom SQL that drizzle-kit can't express (triggers, extensions, data backfills) goes in its
   own migration: `pnpm --filter @ondes/db generate --custom --name <what>`, then fill in the file.
   It is the one migration you write by hand, and it survives regeneration of the others.

Before pushing, `pnpm --filter @ondes/db generate` must report "No schema changes, nothing to migrate": the schema
and the migrations are in sync.

## Tenancy

Organizations own stations; users are global and join orgs and stations through
`membership` (org roles `owner`/`admin` have no station; station roles `station_manager`,
`programmer`, `presenter`, `viewer` need one, enforced by a check constraint).

### Scopes

Every station-scoped table carries `station_id` (and `org_id` where relevant). Repository
functions take the tenant scope as an explicit argument and filter every query on it:

```ts
import { resolveStationScope, whereStation } from '@ondes/db';

const scope = await resolveStationScope(db, orgId, stationId); // NotFoundError if not this org's
const rows = await db.select().from(track).where(and(eq(track.id, id), whereStation(track, scope)));
```

- `OrgScope` and `StationScope` are branded types. Get them from `resolveOrgScope()` /
  `resolveStationScope()`, which check the database; a `StationScope` is also an `OrgScope`.
  The auth layer (#6) resolves them after checking the caller's membership.
- A row outside the scope is reported as `NotFoundError` (map it to 404), never as "forbidden":
  callers can't probe other tenants' ids.
- `unsafeScope()` skips the check. Tests only, or ids you just read from a row loaded under
  another scope. Never request input.
- Station-scoped tables that also store `org_id` should use a composite foreign key
  `(station_id, org_id) → station(id, org_id)`, like `membership` and `api_key`, so the database
  refuses a station of another org.

### Audit log

Every mutation made through the api writes an `audit_log` row (actor, action, entity, diff, at)
in the **same transaction**. Use `withAudit`:

```ts
import { auditDiff, withAudit } from '@ondes/db';

await withAudit(db, { actor, scope }, async (tx, audit) => {
  const before = await getThing(tx, scope, id);
  const [after] = await tx.update(thing).set(input).where(/* scoped */).returning();
  await audit({ action: 'thing.update', entity: { type: 'thing', id }, diff: auditDiff(before, after) });
  return after;
});
```

- If the callback never calls `audit()`, the transaction rolls back with `MissingAuditError`.
- If the mutation throws, no audit row is written.
- `orgId`/`stationId` come from the scope; override them in the entry when needed (a newly
  created station, a global entity with `null`).
- `auditDiff(before, after, omit)` keeps changed fields only and drops `id`/timestamps. Pass
  secrets (hashes, tokens) in `omit`.
- Actions are `<entity>.<verb>`; actors are `user`, `api_key` or `system` (jobs, seeds).

### API keys

`createApiKey()` returns the full token once (`ondes_…`); only its SHA-256 (`key_hash`) and a
display prefix are stored. Keys belong to an org, optionally narrowed to one station, and carry
`resource:action` scopes (the permission catalogue comes with #6).

## Integration tests

`createTestDatabase()` (from `@ondes/db/testing`) creates a throwaway database with a random
name on `$TEST_DATABASE_URL` (else `$DATABASE_URL`, else the dev compose `ondes_test`), applies
the migrations and returns a client plus `drop()`. Test files run in parallel without sharing
state:

```ts
let tdb: TestDatabase;
beforeAll(async () => { tdb = await createTestDatabase(); });
afterAll(() => tdb?.drop());
```
