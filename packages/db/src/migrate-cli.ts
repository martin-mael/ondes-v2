// `pnpm --filter @ondes/db migrate`: applies pending migrations to $DATABASE_URL.
import { runMigrations } from './migrate.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set.');
  process.exit(1);
}
await runMigrations(databaseUrl);
console.log('migrate: database is up to date.');
