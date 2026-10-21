import { loginSchema, recoveryCodeSchema, totpCodeSchema } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { CircleCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { Spinner } from '@/ui/spinner';
import { authApi } from '../api/auth.ts';
import { CodeField, FormAlert, TextField, useZodForm } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { AuthCard, linkClass } from './auth-layout.tsx';
import { resetSession } from './session.ts';

const route = getRouteApi('/_auth/login');

const codeSchema = z.object({ code: totpCodeSchema });
const recoverySchema = z.object({ recoveryCode: recoveryCodeSchema });

/** Sign-in: password, then a TOTP or recovery code when 2FA is on. */
export function LoginPage() {
  const { t } = useI18n();
  const { redirect, notice } = route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<'password' | 'code' | 'recovery'>('password');

  const signedIn = async (result: Awaited<ReturnType<typeof authApi.login>>) => {
    if (result.status === 'two_factor_required') {
      setStep('code');
      return;
    }
    await resetSession(queryClient, result.me);
    // `href`, not `to`: the redirect may carry a query string (`/invitations/accept?token=…`).
    await navigate({ href: redirect ?? '/' });
  };

  const password = useZodForm(loginSchema, async (data) => signedIn(await authApi.login(data)));
  const code = useZodForm(codeSchema, async (data) =>
    signedIn(await authApi.loginSecondFactor(data)),
  );
  const recovery = useZodForm(recoverySchema, async (data) =>
    signedIn(await authApi.loginSecondFactor(data)),
  );

  if (step !== 'password') {
    const form = step === 'code' ? code : recovery;
    return (
      <AuthCard title={t('auth.twoFactor.title')} description={t('auth.twoFactor.description')}>
        <form onSubmit={form.onSubmit} noValidate>
          <FieldGroup>
            <FormAlert error={form.formError} />
            {step === 'code' ? (
              <CodeField form={code} label={t('auth.twoFactor.code')} />
            ) : (
              <TextField
                form={recovery}
                name="recoveryCode"
                label={t('auth.twoFactor.recoveryCode')}
                autoComplete="one-time-code"
                autoFocus
                className="font-mono"
              />
            )}
            <Button type="submit" disabled={form.pending}>
              {form.pending && <Spinner />}
              {t('auth.twoFactor.submit')}
            </Button>
            <div className="flex justify-between text-xs">
              <button
                type="button"
                className={linkClass}
                onClick={() => setStep(step === 'code' ? 'recovery' : 'code')}
              >
                {step === 'code' ? t('auth.twoFactor.useRecovery') : t('auth.twoFactor.useCode')}
              </button>
              <button type="button" className={linkClass} onClick={() => setStep('password')}>
                {t('common.back')}
              </button>
            </div>
          </FieldGroup>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('auth.login.title')}
      description={t('auth.login.description')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <Link to="/signup" className={linkClass}>
            {t('auth.login.signupLink')}
          </Link>
        </>
      }
    >
      <form onSubmit={password.onSubmit} noValidate>
        <FieldGroup>
          {notice && !password.formError && (
            <Alert>
              <CircleCheckIcon />
              <AlertDescription>
                {notice === 'verified' ? t('auth.login.verified') : t('auth.login.reset')}
              </AlertDescription>
            </Alert>
          )}
          <FormAlert error={password.formError} />
          <TextField
            form={password}
            name="email"
            type="email"
            label={t('common.email')}
            autoComplete="email"
            autoFocus
          />
          <TextField
            form={password}
            name="password"
            type="password"
            label={t('common.password')}
            autoComplete="current-password"
          />
          <Button type="submit" disabled={password.pending}>
            {password.pending && <Spinner />}
            {t('auth.login.submit')}
          </Button>
          <Link to="/forgot-password" className={`${linkClass} text-center text-xs`}>
            {t('auth.login.forgot')}
          </Link>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
