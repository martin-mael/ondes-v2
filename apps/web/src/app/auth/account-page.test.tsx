import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, renderApp, signedIn } from '../testing/render.tsx';

const recoveryCodes = ['aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff'];

describe('account: two-factor authentication', () => {
  it('sets up TOTP from the otpauth QR code and shows the recovery codes once', async () => {
    let enabled = false;
    const { user, screen, calls } = renderApp('/account', {
      ...signedIn(),
      'GET /auth/me': () => [200, { ...me, twoFactorEnabled: enabled }],
      'POST /auth/2fa/setup': [
        200,
        {
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/Ondes:dj?secret=JBSWY3DPEHPK3PXP',
        },
      ],
      'POST /auth/2fa/enable': () => {
        enabled = true;
        return [200, { recoveryCodes }];
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByTitle('otpauth')).toBeInTheDocument();

    await user.keyboard('654321');
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(list).toHaveTextContent(recoveryCodes.join(''));
    expect(calls.find((c) => c.path === '/auth/2fa/enable')?.body).toEqual({ code: '654321' });
    expect(await screen.findByText('On')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "I've saved them" }));
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('regenerates recovery codes with a current code', async () => {
    const { user, screen, calls } = renderApp('/account', {
      ...signedIn({ twoFactorEnabled: true }),
      'POST /auth/2fa/recovery-codes': [200, { recoveryCodes }],
    });
    await screen.findByRole('button', { name: 'New recovery codes' });
    const [codeInput] = screen.getAllByLabelText('Code');
    await user.click(codeInput as HTMLElement);
    await user.keyboard('111111');
    await user.click(screen.getByRole('button', { name: 'New recovery codes' }));
    expect(await screen.findByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/2fa/recovery-codes')?.body).toEqual({
      code: '111111',
    });
  });

  it('turns TOTP off with the password and a code', async () => {
    const { user, screen, calls } = renderApp('/account', {
      ...signedIn({ twoFactorEnabled: true }),
      'POST /auth/2fa/disable': [401, { error: 'invalid_code', message: 'bad' }],
    });
    await user.type(await screen.findByLabelText('Password'), 'my password');
    const codeInput = screen.getAllByLabelText('Code')[1];
    await user.click(codeInput as HTMLElement);
    await user.keyboard('222222');
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('This code is not valid.')).toBeVisible();
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/2fa/disable')?.body).toEqual({
        password: 'my password',
        code: '222222',
      }),
    );
  });

  it('explains why when an org requires 2FA', async () => {
    const { screen } = renderApp('/account?reason=two_factor_required', signedIn());
    expect(
      await screen.findByText(/One of your organizations requires two-factor authentication/),
    ).toBeVisible();
  });
});
