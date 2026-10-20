import { auditLog, session, userAuth } from '@ondes/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createTestApp,
  enableTotp,
  lastToken,
  login,
  sessionCookie,
  signUpAndLogin,
  type TestApp,
} from './testing.ts';
import { totpCode } from './totp.ts';

// Account flows end to end: sign-up, verification, login, 2FA, password reset, sessions.

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const PASSWORD = 'a long enough password';
const nextCode = (secret: string, steps = 1) =>
  totpCode(secret, new Date(Date.now() + steps * 30_000));
/** A code outside the accepted window. */
const wrongCode = (secret: string) => {
  const valid = new Set([-1, 0, 1].map((s) => nextCode(secret, s)));
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c)) as string;
};

describe('sign-up and email verification', () => {
  it('signs up, refuses login until verified, then logs in', async () => {
    const email = 'alice@example.org';
    const signup = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'Alice@Example.org', name: 'Alice', password: PASSWORD },
    });
    expect(signup.statusCode).toBe(202);
    expect(t.outbox.at(-1)).toMatchObject({ to: email, subject: 'Confirm your email address' });
    expect(t.outbox.at(-1)?.text).toContain('https://app.test/verify-email?token=');

    const early = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(early.statusCode).toBe(403);
    expect(early.json().error).toBe('email_not_verified');

    const token = lastToken(t.outbox, email);
    const verify = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token },
    });
    expect(verify.statusCode).toBe(204);
    const reused = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toBe('invalid_token');

    const { cookie } = await login(t, email);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(cookie),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email, name: 'Alice' },
      emailVerified: true,
      twoFactorEnabled: false,
      memberships: [],
    });
  });

  it("doesn't reveal whether an email is registered", async () => {
    await signUpAndLogin(t, 'taken@example.org');
    const sent = t.outbox.length;
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'taken@example.org', name: 'Impostor', password: 'another long password' },
    });
    expect(again.statusCode).toBe(202);
    expect(t.outbox.length).toBe(sent);
    // The original password still works.
    await login(t, 'taken@example.org');
  });

  it('resends a verification link and invalidates the previous one', async () => {
    const email = 'resend@example.org';
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, name: 'Resend', password: PASSWORD },
    });
    const first = lastToken(t.outbox, email);
    const resend = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email/resend',
      payload: { email },
    });
    expect(resend.statusCode).toBe(202);
    const second = lastToken(t.outbox, email);
    expect(second).not.toBe(first);
    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: first },
    });
    expect(stale.statusCode).toBe(400);
  });

  it('rejects short passwords', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'short@example.org', name: 'Short', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });
});

describe('sessions', () => {
  it('sets a hardened cookie and stores only its hash', async () => {
    await signUpAndLogin(t, 'cookie@example.org');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'cookie@example.org', password: PASSWORD },
    });
    const cookie = res.cookies.find((c) => c.name === 'ondes_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    const rows = await t.tdb.db.select().from(session);
    expect(rows.some((r) => r.tokenHash === cookie?.value)).toBe(false);
  });

  it('rotates the session on login and ends it on logout', async () => {
    const { cookie: first } = await signUpAndLogin(t, 'rotate@example.org');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: cookieHeader(first),
      payload: { email: 'rotate@example.org', password: PASSWORD },
    });
    const second = sessionCookie(res);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    const old = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(first),
    });
    expect(old.statusCode).toBe(401);

    const out = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: cookieHeader(second as string),
    });
    expect(out.statusCode).toBe(204);
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(second as string),
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses wrong passwords and unknown emails alike', async () => {
    for (const payload of [
      { email: 'rotate@example.org', password: 'not the password' },
      { email: 'nobody@example.org', password: PASSWORD },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_credentials');
    }
  });

  it('audits sign-ins', async () => {
    const { userId } = await signUpAndLogin(t, 'audited@example.org');
    const rows = await t.tdb.db.select().from(auditLog).where(eq(auditLog.actorId, userId));
    expect(rows.map((r) => r.action)).toContain('session.create');
  });
});

describe('two-factor authentication', () => {
  it('enrols, then requires a code at login, and refuses replays', async () => {
    const email = 'totp@example.org';
    const { cookie } = await signUpAndLogin(t, email);
    const { secret, recoveryCodes } = await enableTotp(t, cookie);
    expect(recoveryCodes).toHaveLength(10);

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(cookie),
    });
    expect(me.json().twoFactorEnabled).toBe(true);
    const [stored] = await t.tdb.db
      .select()
      .from(userAuth)
      .where(eq(userAuth.userId, me.json().user.id));
    expect(stored?.totpSecret).not.toContain(secret);

    const step1 = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(step1.json()).toEqual({ status: 'two_factor_required' });
    const pending = sessionCookie(step1) as string;
    // A pending session isn't signed in.
    const blocked = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(pending),
    });
    expect(blocked.statusCode).toBe(401);

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/2fa',
      headers: cookieHeader(pending),
      payload: { code: wrongCode(secret) },
    });
    expect(wrong.statusCode).toBe(401);

    const code = nextCode(secret);
    const step2 = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/2fa',
      headers: cookieHeader(pending),
      payload: { code },
    });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().status).toBe('ok');
    const full = sessionCookie(step2) as string;
    expect(full).not.toBe(pending);
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(full),
    });
    expect(ok.statusCode).toBe(200);

    // Same code again, on a new pending login: refused.
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/2fa',
      headers: cookieHeader(sessionCookie(again) as string),
      payload: { code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const email = 'recovery@example.org';
    const { cookie } = await signUpAndLogin(t, email);
    const { recoveryCodes } = await enableTotp(t, cookie);
    const recoveryCode = (recoveryCodes[0] as string).toUpperCase();

    const tryCode = async () => {
      const step1 = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      return t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/2fa',
        headers: cookieHeader(sessionCookie(step1) as string),
        payload: { recoveryCode },
      });
    };
    expect((await tryCode()).statusCode).toBe(200);
    expect((await tryCode()).statusCode).toBe(401);
  });

  it('disables 2FA with password and code', async () => {
    const email = 'disable@example.org';
    const { cookie } = await signUpAndLogin(t, email);
    const { secret } = await enableTotp(t, cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      headers: cookieHeader(cookie),
      payload: { password: PASSWORD, code: nextCode(secret) },
    });
    expect(res.statusCode).toBe(204);
    await login(t, email);
  });
});

describe('password reset', () => {
  it('resets the password and signs out every session', async () => {
    const email = 'reset@example.org';
    const { cookie } = await signUpAndLogin(t, email);

    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email: 'ghost@example.org' },
    });
    expect(unknown.statusCode).toBe(202);

    const forgot = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email },
    });
    expect(forgot.statusCode).toBe(202);
    expect(t.outbox.at(-1)?.text).toContain('https://app.test/reset-password?token=');
    const token = lastToken(t.outbox, email);

    const reset = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, password: 'a brand new password' },
    });
    expect(reset.statusCode).toBe(204);

    const old = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeader(cookie),
    });
    expect(old.statusCode).toBe(401);
    await expect(login(t, email)).rejects.toThrow('401');
    await login(t, email, 'a brand new password');

    const reused = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, password: 'yet another password' },
    });
    expect(reused.statusCode).toBe(400);
  });
});

describe('onUserVerified', () => {
  it('fires on verification and on sign-in, and never blocks sign-in', async () => {
    const local = await createTestApp();
    const events: string[] = [];
    // Registered after boot here; a real consumer (#113) registers from a plugin.
    local.app.auth.onUserVerified(async (event) => {
      events.push(`${event.reason}:${event.user.email}`);
    });
    local.app.auth.onUserVerified(() => {
      throw new Error('a broken handler');
    });
    try {
      await signUpAndLogin(local, 'hooked@example.org');
      expect(events).toEqual(['email_verified:hooked@example.org', 'sign_in:hooked@example.org']);
    } finally {
      await local.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits login attempts per client', async () => {
    const local = await createTestApp({ rateLimit: { max: 3, timeWindowMs: 60_000 } });
    try {
      const attempt = () =>
        local.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'brute@example.org', password: 'guess guess guess' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
      const limited = await attempt();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toBe('rate_limited');
    } finally {
      await local.close();
    }
  });
});
