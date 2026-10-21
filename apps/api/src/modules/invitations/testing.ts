// Helpers for the invitations integration tests. Not for production code.
import { createTestDatabase } from '@ondes/db/testing';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import type { TxtResolver } from './domains.ts';
import type { InvitationsLimits } from './service.ts';

/** TXT records by host. Tests set them; nothing ever reaches real DNS. */
export type FakeDns = Map<string, string[][]>;

export function fakeResolver(records: FakeDns): TxtResolver {
  return {
    resolveTxt: async (host) => {
      const found = records.get(host);
      if (!found) throw Object.assign(new Error(`queryTxt ENODATA ${host}`), { code: 'ENODATA' });
      return found;
    },
  };
}

/** Like `createTestApp` (#6), with a fake DNS resolver and optional sending limits. */
export async function createInvitationsTestApp(
  limits: Partial<InvitationsLimits> = {},
): Promise<TestApp & { dns: FakeDns }> {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const dns: FakeDns = new Map();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    invitations: { resolver: fakeResolver(dns), limits, recheckIntervalMs: 0 },
    fastify: { logger: false },
  });
  await app.ready();
  return {
    app,
    tdb,
    dns,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
}
