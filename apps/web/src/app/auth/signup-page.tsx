import { signupSchema } from '@ondes/shared';
import { getRouteApi, Link } from '@tanstack/react-router';
import { MailCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { authApi } from '../api/auth.ts';
import { FormAlert, TextField, useErrorMessage, useZodForm } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { DelayedSpinner } from '../pending.tsx';
import { AuthCard, linkClass } from './auth-layout.tsx';

const route = getRouteApi('/_auth/signup');

/** Sign-up. From an invitation link (`?invitation=`) the email counts as verified. */
export function SignupPage() {
  const { t } = useI18n();
  const { invitation } = route.useSearch();
  const errorMessage = useErrorMessage();
  const [done, setDone] = useState<string | null>(null);
  const form = useZodForm(signupSchema, async (data) => {
    await authApi.signup(data);
    setDone(data.email);
  });

  if (done) {
    const resend = async () => {
      try {
        await authApi.resendVerification({ email: done });
        toast.success(t('auth.signup.resent'));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    };
    return (
      <AuthCard
        title={t('auth.signup.done.title')}
        description={
          invitation
            ? t('auth.signup.done.invited')
            : t('auth.signup.done.description', { email: done })
        }
      >
        <div className="flex flex-col items-center gap-4">
          <MailCheckIcon className="size-10 text-primary" />
          {invitation ? (
            <Button className="w-full" nativeButton={false} render={<Link to="/login" />}>
              {t('auth.login.submit')}
            </Button>
          ) : (
            <Button variant="outline" className="w-full" onClick={resend}>
              {t('auth.signup.resend')}
            </Button>
          )}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('auth.signup.title')}
      description={invitation ? t('auth.signup.invited') : t('auth.signup.description')}
      footer={
        <>
          {t('auth.signup.hasAccount')}{' '}
          <Link to="/login" className={linkClass}>
            {t('auth.login.submit')}
          </Link>
        </>
      }
    >
      <form onSubmit={form.onSubmit} noValidate>
        <FieldGroup>
          <FormAlert error={form.formError} />
          {invitation && <input type="hidden" name="invitationToken" value={invitation} />}
          <TextField
            form={form}
            name="name"
            label={t('common.name')}
            autoComplete="name"
            autoFocus
          />
          <TextField
            form={form}
            name="email"
            type="email"
            label={t('common.email')}
            autoComplete="email"
          />
          <TextField
            form={form}
            name="password"
            type="password"
            label={t('common.password')}
            description={t('auth.signup.passwordHint')}
            autoComplete="new-password"
          />
          <Button type="submit" disabled={form.pending}>
            <DelayedSpinner when={form.pending} />
            {t('auth.signup.submit')}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
