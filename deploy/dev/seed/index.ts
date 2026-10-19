// Dev seed entry point: `pnpm dev:seed` (reads the root .env if present).
//
// Will create a demo org, station and user so a fresh dev database is usable right away.
// The tables don't exist yet: the DB schema and its seed data come with #5, which fills
// in `seed()` below using @ondes/db. Keep it idempotent (upserts keyed on fixed slugs/ids)
// so it can run on every `pnpm dev:up`.

export const demo = {
  org: { slug: 'vandale', name: 'Vandale Radio' },
  station: { slug: 'vandale', name: 'Vandale Radio', timezone: 'Europe/Paris' },
  user: { email: 'dev@ondes.localhost', name: 'Dev Admin' },
} as const;

async function seed(databaseUrl: string): Promise<void> {
  // TODO(#5): connect with @ondes/db and upsert demo.org, demo.station and demo.user.
  void databaseUrl;
  console.log('dev:seed: nothing to seed yet (the DB schema lands with #5).');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('dev:seed: DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}
await seed(databaseUrl);
