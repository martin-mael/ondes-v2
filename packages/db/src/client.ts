import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything repositories can run queries on: the pool or an open transaction. */
export type Executor = Db | Tx;

export interface DbClient {
  db: Db;
  /** Underlying postgres.js client, for raw SQL in tests and scripts. */
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Pool size. Defaults to 10. */
  max?: number;
  /** Shown in `pg_stat_activity` (`api`, `worker`, `dev-seed`). */
  applicationName?: string;
}

/** Opens a connection pool. Call `close()` on shutdown. */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbClient {
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? 'ondes' },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
