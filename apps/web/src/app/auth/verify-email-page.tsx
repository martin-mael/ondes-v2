import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, Navigate } from '@tanstack/react-router';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { authApi } from '../api/auth.ts';
import { FormAlert } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { AuthCard } from './auth-layout.tsx';

const route = getRouteApi('/_auth/verify-email');

/** Landing page of the verification email: `?token=` is spent once, then sign-in. */
export function VerifyEmailPage() {
  const { t } = useI18n();
  const { token } = route.useSearch();
  // A query, not an effect: it runs once even under StrictMode, and tokens are single-use.
  const verify = useQuery({
    queryKey: ['auth', 'verify-email', token],
    queryFn: async () => {
      await authApi.verifyEmail(token ?? '');
      return true;
    },
    enabled: Boolean(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  if (verify.isSuccess) return <Navigate to="/login" search={{ notice: 'verified' }} />;
  return (
    <AuthCard title={t('auth.verify.title')}>
      {!token ? (
        <p className="text-sm text-muted-foreground">{t('auth.verify.missing')}</p>
      ) : verify.isError ? (
        <div className="flex flex-col gap-4">
          <FormAlert error={verify.error} />
          <Button variant="outline" nativeButton={false} render={<Link to="/login" />}>
            {t('auth.login.submit')}
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t('auth.verify.pending')}
        </p>
      )}
    </AuthCard>
  );
}
