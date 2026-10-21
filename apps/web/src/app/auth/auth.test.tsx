import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, renderApp, signedIn, signedOut, stationId } from '../testing/render.tsx';

const password = 'a long enough password';

describe('sign-in', () => {
  it('validates with the shared contract before calling the api', async () => {
    const { user, screen, calls } = renderApp('/login', signedOut);
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findAllByText(/invalid email/i)).not.toHaveLength(0);
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
  });

  it('shows a translated message for wrong credentials', async () => {
    const { user, screen } = renderApp('/login', {
      ...signedOut,
      'POST /auth/login': [401, { error: 'invalid_credentials', message: 'nope' }],
    });
    await user.type(await screen.findByLabelText('Email'), 'dj@vandale.test');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
  });

  it('asks for the TOTP code, then lands on the station dashboard', async () => {
    let signedInNow = false;
    const { user, screen, calls, history } = renderApp('/login', {
      'GET /auth/me': () =>
        signedInNow ? [200, me] : [401, { error: 'unauthenticated', message: '' }],
      'GET /orgs': signedIn()['GET /orgs'] ?? [500],
      'POST /auth/login': [200, { status: 'two_factor_required' }],
      'POST /auth/login/2fa': () => {
        signedInNow = true;
        return [200, { status: 'ok', me }];
      },
    });
    await user.type(await screen.findByLabelText('Email'), 'DJ@Vandale.test');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      email: 'dj@vandale.test',
      password,
    });
    await user.keyboard('123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${stationId}`));
    expect(calls.find((c) => c.path === '/auth/login/2fa')?.body).toEqual({ code: '123456' });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('accepts a recovery code instead', async () => {
    const { user, screen, calls } = renderApp('/login', {
      ...signedOut,
      'POST /auth/login': [200, { status: 'two_factor_required' }],
      'POST /auth/login/2fa': [401, { error: 'invalid_code', message: 'bad' }],
    });
    await user.type(await screen.findByLabelText('Email'), 'dj@vandale.test');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), 'abcde-fghij');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('This code is not valid.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login/2fa')?.body).toEqual({
      recoveryCode: 'abcde-fghij',
    });
  });

  it('sends signed-out visitors of a protected page to sign-in and back', async () => {
    const { history, screen } = renderApp('/account', signedOut);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
    expect(history.location.search).toContain('redirect=%2Faccount');
  });

  it('ignores redirects to other sites', async () => {
    const { user, screen, history } = renderApp('/login?redirect=%2F%2Fevil.example', {
      ...signedIn(),
      'GET /auth/me': [401, { error: 'unauthenticated', message: '' }],
      'POST /auth/login': [200, { status: 'ok', me }],
    });
    await user.type(await screen.findByLabelText('Email'), 'dj@vandale.test');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${stationId}`));
  });
});

describe('sign-up', () => {
  it('signs up, then offers to resend the verification email', async () => {
    const { user, screen, calls } = renderApp('/signup', {
      ...signedOut,
      'POST /auth/signup': [202, { status: 'accepted' }],
      'POST /auth/verify-email/resend': [202, { status: 'accepted' }],
    });
    await user.type(await screen.findByLabelText('Name'), 'Camille');
    await user.type(screen.getByLabelText('Email'), 'camille@vandale.test');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText(/>=10 characters/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/signup')?.body).toEqual({
      name: 'Camille',
      email: 'camille@vandale.test',
      password,
    });
    await user.click(screen.getByRole('button', { name: 'Resend the email' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/verify-email/resend')?.body).toEqual({
        email: 'camille@vandale.test',
      }),
    );
  });

  it('carries the invitation token', async () => {
    const token = 'invitation-token-0123456789';
    const { user, screen, calls } = renderApp(`/signup?invitation=${token}`, {
      ...signedOut,
      'POST /auth/signup': [202, { status: 'accepted' }],
    });
    expect(await screen.findByText('Create your account to accept the invitation.')).toBeVisible();
    await user.type(screen.getByLabelText('Name'), 'Camille');
    await user.type(screen.getByLabelText('Email'), 'camille@vandale.test');
    await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Your account is ready. Sign in to continue.')).toBeVisible();
    expect(calls.find((c) => c.path === '/auth/signup')?.body).toMatchObject({
      invitationToken: token,
    });
  });
});

describe('email links', () => {
  const token = 'link-token-0123456789abcdef';

  it('verifies the email once and goes to sign-in', async () => {
    const { screen, calls, history } = renderApp(`/verify-email?token=${token}`, {
      ...signedOut,
      'POST /auth/verify-email': [204],
    });
    expect(await screen.findByText('Your email is verified. You can sign in.')).toBeVisible();
    expect(history.location.pathname).toBe('/login');
    expect(calls.filter((c) => c.path === '/auth/verify-email')).toEqual([
      { method: 'POST', path: '/auth/verify-email', body: { token } },
    ]);
  });

  it('explains an expired verification link', async () => {
    const { screen } = renderApp(`/verify-email?token=${token}`, {
      ...signedOut,
      'POST /auth/verify-email': [400, { error: 'invalid_token', message: 'expired' }],
    });
    expect(await screen.findByText('This link is invalid or has expired.')).toBeVisible();
  });

  it('sends a reset link without revealing whether the account exists', async () => {
    const { user, screen } = renderApp('/forgot-password', {
      ...signedOut,
      'POST /auth/password/forgot': [202, { status: 'accepted' }],
    });
    await user.type(await screen.findByLabelText('Email'), 'who@vandale.test');
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(
      await screen.findByText('If an account uses who@vandale.test, a reset link is on its way.'),
    ).toBeVisible();
  });

  it('resets the password with the token, then asks to sign in', async () => {
    const { user, screen, calls, history } = renderApp(`/reset-password?token=${token}`, {
      ...signedOut,
      'POST /auth/password/reset': [204],
    });
    await user.type(await screen.findByLabelText('New password'), password);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Your password was changed. Sign in with the new one.'),
    ).toBeVisible();
    expect(history.location.pathname).toBe('/login');
    expect(calls.find((c) => c.path === '/auth/password/reset')?.body).toEqual({
      token,
      password,
    });
  });

  it('accepts an invitation when signed in', async () => {
    const { user, screen, calls, history } = renderApp(`/invitations/accept?token=${token}`, {
      ...signedIn(),
      'POST /invitations/accept': [
        200,
        {
          id: '01a15ddf-0000-7000-8000-0000000000c1',
          orgId: '01a15ddf-0000-7000-8000-0000000000a1',
          stationId: null,
          email: me.user.email,
          role: 'admin',
          status: 'accepted',
          invitedBy: null,
          acceptedBy: me.user.id,
          expiresAt: '2026-10-27T08:00:00.000Z',
          acceptedAt: '2026-10-20T08:00:00.000Z',
          revokedAt: null,
          createdAt: '2026-10-20T08:00:00.000Z',
        },
      ],
    });
    expect(await screen.findByText(`Signed in as ${me.user.email}.`)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept the invitation' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${stationId}`));
    expect(calls.find((c) => c.path === '/invitations/accept')?.body).toEqual({ token });
  });

  it('offers sign-up or sign-in for an invitation when signed out', async () => {
    const { screen } = renderApp(`/invitations/accept?token=${token}`, signedOut);
    // Link-buttons: <a href> with the button role.
    expect(await screen.findByRole('button', { name: 'Create an account' })).toHaveAttribute(
      'href',
      `/signup?invitation=${token}`,
    );
    expect(screen.getByRole('button', { name: 'I already have an account' })).toHaveAttribute(
      'href',
      expect.stringContaining('/login?redirect='),
    );
  });
});
