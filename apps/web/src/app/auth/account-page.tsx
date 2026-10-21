import { disableTotpSchema, totpCodeOnlySchema } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { CopyIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { FieldGroup } from '@/ui/field';
import { Separator } from '@/ui/separator';
import { authApi } from '../api/auth.ts';
import { CodeField, FormAlert, TextField, useErrorMessage, useZodForm } from '../forms.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { DelayedSpinner } from '../pending.tsx';
import { meQuery, useMe } from './session.ts';

const route = getRouteApi('/_app/account');

export function AccountPage() {
  const { t } = useI18n();
  const me = useMe();
  const { reason } = route.useSearch();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="font-heading text-xl font-semibold">{t('account.title')}</h1>
      {reason === 'two_factor_required' && !me.twoFactorEnabled && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertDescription>{t('account.twoFactor.required')}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('account.profile')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('common.name')}</dt>
            <dd>{me.user.name}</dd>
            <dt className="text-muted-foreground">{t('common.email')}</dt>
            <dd>{me.user.email}</dd>
          </dl>
        </CardContent>
      </Card>
      <TwoFactorCard enabled={me.twoFactorEnabled} />
    </div>
  );
}

function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  const refreshMe = () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('account.twoFactor.title')}
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? t('account.twoFactor.on') : t('account.twoFactor.off')}
          </Badge>
        </CardTitle>
        <CardDescription>
          {enabled ? t('account.twoFactor.descriptionOn') : t('account.twoFactor.descriptionOff')}
        </CardDescription>
        <CardAction>
          {enabled ? (
            <ShieldCheckIcon className="size-5 text-primary" />
          ) : (
            <ShieldAlertIcon className="size-5 text-muted-foreground" />
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : enabled ? (
          <>
            <RegenerateCodes onCodes={setCodes} />
            <Separator />
            <DisableTwoFactor onDisabled={refreshMe} />
          </>
        ) : (
          <SetupTwoFactor
            onEnabled={async (recoveryCodes) => {
              setCodes(recoveryCodes);
              await refreshMe();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SetupTwoFactor({ onEnabled }: { onEnabled: (codes: string[]) => Promise<void> }) {
  const { t } = useI18n();
  const errorMessage = useErrorMessage();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const form = useZodForm(totpCodeOnlySchema, async ({ code }) => {
    const { recoveryCodes } = await authApi.enableTotp(code);
    toast.success(t('account.twoFactor.enabled'));
    await onEnabled(recoveryCodes);
  });

  if (!setup) {
    const start = async () => {
      setStarting(true);
      try {
        setSetup(await authApi.setupTotp());
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setStarting(false);
      }
    };
    return (
      <Button className="self-start" onClick={start} disabled={starting}>
        <DelayedSpinner when={starting} />
        {t('account.twoFactor.setup')}
      </Button>
    );
  }

  return (
    <form onSubmit={form.onSubmit} noValidate>
      <FieldGroup>
        <p className="text-sm">{t('account.twoFactor.scan')}</p>
        <div className="flex flex-wrap items-center gap-6">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={setup.otpauthUrl} size={160} title="otpauth" />
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('account.twoFactor.manual')}</span>
            <code className="break-all font-mono text-sm" data-testid="totp-secret">
              {setup.secret}
            </code>
          </div>
        </div>
        <FormAlert error={form.formError} />
        <CodeField form={form} label={t('auth.twoFactor.code')} />
        <Button type="submit" className="self-start" disabled={form.pending}>
          <DelayedSpinner when={form.pending} />
          {t('account.twoFactor.enable')}
        </Button>
      </FieldGroup>
    </form>
  );
}

function RegenerateCodes({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const { t } = useI18n();
  const form = useZodForm(totpCodeOnlySchema, async ({ code }) => {
    onCodes((await authApi.regenerateRecoveryCodes(code)).recoveryCodes);
  });
  return (
    <form onSubmit={form.onSubmit} noValidate>
      <FieldGroup>
        <div>
          <h3 className="text-sm font-medium">{t('account.recovery.regenerate')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('account.recovery.regenerateDescription')}
          </p>
        </div>
        <FormAlert error={form.formError} />
        <CodeField form={form} label={t('auth.twoFactor.code')} />
        <Button type="submit" variant="outline" className="self-start" disabled={form.pending}>
          <DelayedSpinner when={form.pending} />
          {t('account.recovery.regenerate')}
        </Button>
      </FieldGroup>
    </form>
  );
}

function DisableTwoFactor({ onDisabled }: { onDisabled: () => Promise<unknown> }) {
  const { t } = useI18n();
  const form = useZodForm(disableTotpSchema, async (data) => {
    await authApi.disableTotp(data);
    toast.success(t('account.twoFactor.disabled'));
    await onDisabled();
  });
  return (
    <form onSubmit={form.onSubmit} noValidate>
      <FieldGroup>
        <div>
          <h3 className="text-sm font-medium">{t('account.twoFactor.disable')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('account.twoFactor.disableDescription')}
          </p>
        </div>
        <FormAlert error={form.formError} />
        <TextField
          form={form}
          name="password"
          type="password"
          label={t('common.password')}
          autoComplete="current-password"
        />
        <CodeField form={form} label={t('auth.twoFactor.code')} />
        <Button type="submit" variant="destructive" className="self-start" disabled={form.pending}>
          <DelayedSpinner when={form.pending} />
          {t('account.twoFactor.disable')}
        </Button>
      </FieldGroup>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const copy = async () => {
    await navigator.clipboard.writeText(codes.join('\n'));
    toast.success(t('common.copied'));
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium">{t('account.recovery.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('account.recovery.description')}</p>
      </div>
      <ul
        aria-label={t('account.recovery.title')}
        className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="outline" onClick={copy}>
          <CopyIcon />
          {t('common.copy')}
        </Button>
        <Button onClick={onDone}>{t('account.recovery.done')}</Button>
      </div>
    </div>
  );
}
