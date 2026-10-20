import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @ondes/db generate` diffs src/schema against migrations/meta and writes a new
// timestamp-prefixed SQL migration. See README.md before generating.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  migrations: { prefix: 'timestamp' },
  strict: true,
  verbose: true,
});
