// Dev seed entry point: `pnpm dev:seed` (reads the root .env if present).
//
// Applies migrations, then creates a demo org, station and user (owner of the org) so a fresh
// dev database is usable right away. Idempotent: rows are looked up by slug/email first and
// only created (through the audited repositories) when missing, so it can run on every
// `pnpm dev:up`.

import {
  addMembership,
  createDb,
  createOrganization,
  createStation,
  createUser,
  findUserByEmail,
  listMemberships,
  resolveOrgScope,
  runMigrations,
} from '../../../packages/db/src/index.ts';
import type { Actor } from '../../../packages/shared/src/index.ts';

export const demo = {
  org: { slug: 'vandale', name: 'Vandale Radio' },
  station: { slug: 'vandale', name: 'Vandale Radio', timezone: 'Europe/Paris' },
  user: { email: 'dev@ondes.localhost', name: 'Dev Admin' },
} as const;

const actor: Actor = { type: 'system', name: 'dev-seed' };

async function seed(databaseUrl: string): Promise<void> {
  await runMigrations(databaseUrl);
  const { db, close } = createDb(databaseUrl, { max: 1, applicationName: 'dev-seed' });
  try {
    const org =
      (await db.query.organization.findFirst({
        where: (t, { eq }) => eq(t.slug, demo.org.slug),
      })) ?? (await createOrganization(db, actor, demo.org));
    const scope = await resolveOrgScope(db, org.id);

    const st =
      (await db.query.station.findFirst({
        where: (t, { eq }) => eq(t.slug, demo.station.slug),
      })) ?? (await createStation(db, { actor, scope }, demo.station));
    if (st.orgId !== org.id) throw new Error(`station "${st.slug}" belongs to another org`);

    const user =
      (await findUserByEmail(db, demo.user.email)) ?? (await createUser(db, actor, demo.user));
    const memberships = await listMemberships(db, scope);
    if (!memberships.some((m) => m.userId === user.id && m.stationId === null)) {
      await addMembership(db, { actor, scope }, { level: 'org', userId: user.id, role: 'owner' });
    }

    console.log(
      `dev:seed: org "${org.slug}" (${org.id}), station "${st.slug}" (${st.id}, ${st.timezone}), ` +
        `user ${user.email} (owner).`,
    );
  } finally {
    await close();
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('dev:seed: DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}
await seed(databaseUrl);
