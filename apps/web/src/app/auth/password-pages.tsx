import { emailOnlySchema, resetPasswordSchema } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { MailCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { authApi } from '../api/auth.ts';
import { FormAlert, TextField, useZodForm } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { DelayedSpinner } from '../pending.tsx';
import { AuthCard, linkClass } from './auth-layout.tsx';
import { resetSession } from './session.ts';

const backToLogin = (label: string) => (
  <Link to="/login" className={linkClass}>
    {label}
  </Link>
);

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useZodForm(emailOnlySchema, async (data) => {
    await authApi.forgotPassword(data);
    setSentTo(data.email);
  });

  return (
    <AuthCard
      title={t('auth.forgot.title')}
      description={sentTo ? undefined : t('auth.forgot.description')}
      footer={backToLogin(t('common.back'))}
    >
      {sentTo ? (
        <div className="flex flex-col items-center gap-3 text-center text-sm">
          <MailCheckIcon className="size-10 text-primary" />
          <p>{t('auth.forgot.done', { email: sentTo })}</p>
        </div>
      ) : (
        <form onSubmit={form.onSubmit} noValidate>
          <FieldGroup>
            <FormAlert error={form.formError} />
            <TextField
              form={form}
              name="email"
              type="email"
              label={t('common.email')}
              autoComplete="email"
              autoFocus
            />
            <Button type="submit" disabled={form.pending}>
              <DelayedSpinner when={form.pending} />
              {t('auth.forgot.submit')}
            </Button>
          </FieldGroup>
        </form>
      )}
    </AuthCard>
  );
}

const resetRoute = getRouteApi('/_auth/reset-password');

/** Landing page of the reset email. A reset signs out every session, this one included. */
export function ResetPasswordPage() {
  const { t } = useI18n();
  const { token } = resetRoute.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useZodForm(resetPasswordSchema, async (data) => {
    await authApi.resetPassword(data);
    await resetSession(queryClient);
    await navigate({ to: '/login', search: { notice: 'reset' } });
  });

  return (
    <AuthCard title={t('auth.reset.title')} footer={backToLogin(t('common.back'))}>
      {!token ? (
        <p className="text-sm text-muted-foreground">{t('auth.verify.missing')}</p>
      ) : (
        <form onSubmit={form.onSubmit} noValidate>
          <FieldGroup>
            <FormAlert error={form.formError} />
            <input type="hidden" name="token" value={token} />
            <TextField
              form={form}
              name="password"
              type="password"
              label={t('auth.reset.password')}
              description={t('auth.signup.passwordHint')}
              autoComplete="new-password"
              autoFocus
            />
            <Button type="submit" disabled={form.pending}>
              <DelayedSpinner when={form.pending} />
              {t('auth.reset.submit')}
            </Button>
          </FieldGroup>
        </form>
      )}
    </AuthCard>
  );
}
