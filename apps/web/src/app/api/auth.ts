import {
  acceptedResponseSchema,
  type disableTotpSchema,
  type emailOnlySchema,
  invitationSchema,
  type Login,
  loginResponseSchema,
  type loginSecondFactorSchema,
  meSchema,
  myOrgsResponseSchema,
  recoveryCodesResponseSchema,
  type resetPasswordSchema,
  type Signup,
  totpSetupResponseSchema,
} from '@ondes/shared';
import type { z } from 'zod';
import { request } from './client.ts';

// The #6 auth api and `GET /orgs`, typed by the shared contracts.

type In<S extends z.ZodType> = z.input<S>;

export const authApi = {
  signup: (body: Signup) => request('/auth/signup', { body, schema: acceptedResponseSchema }),
  verifyEmail: (token: string) => request('/auth/verify-email', { body: { token } }),
  resendVerification: (body: In<typeof emailOnlySchema>) =>
    request('/auth/verify-email/resend', { body, schema: acceptedResponseSchema }),
  login: (body: Login) => request('/auth/login', { body, schema: loginResponseSchema }),
  loginSecondFactor: (body: In<typeof loginSecondFactorSchema>) =>
    request('/auth/login/2fa', { body, schema: loginResponseSchema }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me', { schema: meSchema }),
  forgotPassword: (body: In<typeof emailOnlySchema>) =>
    request('/auth/password/forgot', { body, schema: acceptedResponseSchema }),
  resetPassword: (body: In<typeof resetPasswordSchema>) =>
    request('/auth/password/reset', { body }),
  setupTotp: () => request('/auth/2fa/setup', { method: 'POST', schema: totpSetupResponseSchema }),
  enableTotp: (code: string) =>
    request('/auth/2fa/enable', { body: { code }, schema: recoveryCodesResponseSchema }),
  disableTotp: (body: In<typeof disableTotpSchema>) => request('/auth/2fa/disable', { body }),
  regenerateRecoveryCodes: (code: string) =>
    request('/auth/2fa/recovery-codes', { body: { code }, schema: recoveryCodesResponseSchema }),
  acceptInvitation: (token: string) =>
    request('/invitations/accept', { body: { token }, schema: invitationSchema }),
  orgs: () => request('/orgs', { schema: myOrgsResponseSchema }),
};
