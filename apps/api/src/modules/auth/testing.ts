// Helpers for the api's integration tests (`*.int.test.ts`). Not for production code.
import { createTestDatabase, type TestDatabase } from '@ondes/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { type AppOptions, buildApp } from '../../app.ts';
import type { AuthConfig } from '../../plugins/auth.ts';
import { createMemoryMailer, type MailMessage } from '../../plugins/mail.ts';
import { totpCode } from './totp.ts';

export const TEST_AUTH_CONFIG: AuthConfig = {
  secret: 'test-secret-test-secret-test-secret!',
  appUrl: 'https://app.test',
  cookieSecure: true,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  rateLimit: { max: 1000, timeWindowMs: 60_000 },
};

export interface TestApp {
  app: FastifyInstance;
  tdb: TestDatabase;
  outbox: MailMessage[];
  close(): Promise<void>;
}

/**
 * A throwaway database, the api on top of it, and an in-memory mailer. `routes` adds test-only
 * routes before the app boots.
 */
export async function createTestApp(
  auth: Partial<AuthConfig> = {},
  routes?: (app: FastifyInstance) => void,
  extra: Pick<AppOptions, 'storage'> = {},
): Promise<TestApp> {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: { ...TEST_AUTH_CONFIG, ...auth },
    fastify: { logger: false },
    ...extra,
  });
  routes?.(app);
  await app.ready();
  return {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
}

/** `ondes_session` value from a response's Set-Cookie, if any. */
export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === 'ondes_session')?.value || undefined;
}

/** Token from the last email sent to `to` (the `?token=` of its link). */
export function lastToken(outbox: MailMessage[], to: string): string {
  const mail = outbox.findLast((m) => m.to === to);
  const match = mail?.text.match(/[?&]token=([\w%-]+)/);
  if (!match?.[1]) throw new Error(`no token in mail to ${to}`);
  return decodeURIComponent(match[1]);
}

export const cookieHeader = (token: string) => ({ cookie: `ondes_session=${token}` });

/** Signs up, verifies the email and signs in. Returns the user id and session cookie. */
export async function signUpAndLogin(
  t: TestApp,
  email: string,
  password = 'a long enough password',
): Promise<{ userId: string; cookie: string }> {
  const name = email.split('@')[0] ?? email;
  const signup = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, name, password },
  });
  if (signup.statusCode !== 202) throw new Error(`signup: ${signup.statusCode} ${signup.body}`);
  const verify = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    payload: { token: lastToken(t.outbox, email) },
  });
  if (verify.statusCode !== 204) throw new Error(`verify: ${verify.statusCode} ${verify.body}`);
  return login(t, email, password);
}

export async function login(
  t: TestApp,
  email: string,
  password = 'a long enough password',
): Promise<{ userId: string; cookie: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const cookie = sessionCookie(res);
  const body = res.json();
  if (res.statusCode !== 200 || body.status !== 'ok' || !cookie) {
    throw new Error(`login: ${res.statusCode} ${res.body}`);
  }
  return { userId: body.me.user.id, cookie };
}

/** Sets up and enables TOTP for a signed-in user. Returns the secret and recovery codes. */
export async function enableTotp(
  t: TestApp,
  cookie: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/setup',
    headers: cookieHeader(cookie),
  });
  const { secret } = setup.json();
  const enable = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/enable',
    headers: cookieHeader(cookie),
    payload: { code: totpCode(secret) },
  });
  if (enable.statusCode !== 200) throw new Error(`2fa enable: ${enable.statusCode} ${enable.body}`);
  return { secret, recoveryCodes: enable.json().recoveryCodes };
}
