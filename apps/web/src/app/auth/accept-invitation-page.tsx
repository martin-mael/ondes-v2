import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { authApi } from '../api/auth.ts';
import { FormAlert } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { AuthCard } from './auth-layout.tsx';
import { meQuery, orgsQuery } from './session.ts';

const route = getRouteApi('/_auth/invitations/accept');

/**
 * Landing page of an invitation email. Signed in: accept with this account (the api checks
 * the email matches). Signed out: sign in and come back, or sign up with the token.
 */
export function AcceptInvitationPage() {
  const { t } = useI18n();
  const { token } = route.useSearch();
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const accept = useMutation({
    mutationFn: () => authApi.acceptInvitation(token ?? ''),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orgsQuery.queryKey });
      toast.success(t('auth.invitation.accepted'));
      await navigate({ to: '/' });
    },
  });

  if (!token) {
    return (
      <AuthCard title={t('auth.invitation.title')}>
        <p className="text-sm text-muted-foreground">{t('auth.verify.missing')}</p>
      </AuthCard>
    );
  }
  if (me.isPending) {
    return (
      <AuthCard title={t('auth.invitation.title')}>
        <Spinner />
      </AuthCard>
    );
  }

  const user = me.data?.user;
  return (
    <AuthCard
      title={t('auth.invitation.title')}
      description={
        user
          ? t('auth.invitation.signedInAs', { email: user.email })
          : t('auth.invitation.description')
      }
    >
      <div className="flex flex-col gap-3">
        <FormAlert error={accept.error} />
        {user ? (
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending && <Spinner />}
            {t('auth.invitation.accept')}
          </Button>
        ) : (
          <>
            <Button
              nativeButton={false}
              render={<Link to="/signup" search={{ invitation: token }} />}
            >
              {t('auth.invitation.signupToAccept')}
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/login"
                  search={{ redirect: `/invitations/accept?token=${encodeURIComponent(token)}` }}
                />
              }
            >
              {t('auth.invitation.loginToAccept')}
            </Button>
          </>
        )}
      </div>
    </AuthCard>
  );
}
