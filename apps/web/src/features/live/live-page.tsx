import {
  LIVE_EARLY_CONNECT_MS,
  type LiveConnectionInfo,
  rolePermissions,
  type Streamer,
  type StreamerWithPassword,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { CopyIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useMe, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner, ListSkeleton } from '../../app/pending.tsx';
import { connectionQuery, invalidateLive, liveApi, streamersQuery } from './api.ts';
import { type LiveT, useLiveError, useLiveT } from './messages.ts';
import { ShowChip } from './show-chip.tsx';
import { PasswordDialog, StreamerDialog } from './streamer-dialog.tsx';

// Live (#63): the station's streamers (DJ credentials) and what to type into BUTT, Mixxx or
// OBS. Managers (`live:manage`) see and edit every streamer; other members only see the ones
// linked to them, and may make a new password (`live:broadcast`). The api checks again.

const route = getRouteApi('/_app/stations/$stationId/live');

function useLiveAccess(stationId: string) {
  const me = useMe();
  const found = findStation(useOrgs(), stationId);
  const allowed = new Set(found ? rolePermissions[found.station.role] : []);
  return {
    timezone: found?.station.timezone ?? 'UTC',
    canManage: allowed.has('live:manage'),
    canBroadcast: allowed.has('live:broadcast'),
    userId: me.user.id,
  };
}

function useCopy() {
  const t = useLiveT();
  return (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => toast.success(t('connection.copied')),
      () => {},
    );
  };
}

/** A value DJs type in, with a copy button. */
function Setting({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const t = useLiveT();
  const copy = useCopy();
  return (
    <div className="flex items-center gap-2">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 flex-1 truncate ${mono ? 'font-mono' : ''}`}>{value}</dd>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${t('connection.copy')} ${label}`}
        onClick={() => copy(value)}
      >
        <CopyIcon />
      </Button>
    </div>
  );
}

function SoftwareCard({
  title,
  where,
  children,
}: {
  title: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{where}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">{children}</CardContent>
    </Card>
  );
}

function ConnectionSettings({
  info,
  username,
  t,
}: {
  info: LiveConnectionInfo;
  /** The signed-in DJ's own username, when they have exactly one streamer. */
  username: string | undefined;
  t: LiveT;
}) {
  const user = username ?? `<${t('connection.yourUser')}>`;
  const password = `<${t('connection.yourPassword')}>`;
  const port = info.port === null ? '…' : String(info.port);
  const common = (
    <dl className="flex flex-col gap-1">
      <Setting label={t('connection.host')} value={info.host} />
      <Setting label={t('connection.port')} value={port} />
      <Setting label={t('connection.mount')} value={info.mount} />
      <Setting label={t('connection.user')} value={user} mono={!!username} />
    </dl>
  );
  return (
    <div className="flex flex-col gap-3">
      {!info.enabled && (
        <Alert variant="destructive">
          <AlertDescription>{t('connection.off')}</AlertDescription>
        </Alert>
      )}
      {info.port === null && (
        <Alert>
          <AlertDescription>{t('connection.noPort')}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        <SoftwareCard title={t('butt.title')} where={t('butt.where')}>
          <p>{t('butt.type')}</p>
          {common}
        </SoftwareCard>
        <SoftwareCard title={t('mixxx.title')} where={t('mixxx.where')}>
          <p>{t('mixxx.type')}</p>
          {common}
        </SoftwareCard>
        <SoftwareCard title={t('obs.title')} where={t('obs.where')}>
          <p>{t('obs.url')}</p>
          <dl>
            <Setting
              label={t('obs.urlLabel')}
              value={`icecast://${user}:${password}@${info.host}:${port}/${info.mount}`}
            />
          </dl>
          <p className="text-muted-foreground">{t('obs.format')}</p>
        </SoftwareCard>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>{t('connection.formats', { formats: info.formats.join(', ') })}</li>
        <li>{t('connection.window', { minutes: LIVE_EARLY_CONNECT_MS / 60_000 })}</li>
        {info.mounts.length > 1 && (
          <li>
            {t('connection.mounts', {
              mount: info.mount,
              others: info.mounts.slice(1).join(', '),
            })}
          </li>
        )}
        <li>
          {info.shoutcastPort === null
            ? t('connection.shoutcastOff')
            : t('connection.shoutcast', { port: info.shoutcastPort })}
        </li>
      </ul>
    </div>
  );
}

function StreamerRow({
  streamer,
  timezone,
  canManage,
  canResetPassword,
  onEdit,
  busy,
  onNewPassword,
  onDelete,
}: {
  streamer: Streamer;
  timezone: string;
  canManage: boolean;
  canResetPassword: boolean;
  onEdit(): void;
  /** The action running on this row, if any. */
  busy: 'password' | 'delete' | null;
  onNewPassword(): void;
  onDelete(): void;
}) {
  const t = useLiveT();
  const { locale } = useI18n();
  // Station time only (CLAUDE.md "Web app").
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  const statusVariant =
    streamer.status === 'active'
      ? 'secondary'
      : streamer.status === 'expired'
        ? 'outline'
        : 'destructive';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{streamer.displayName}</span>
          <span className="font-mono text-sm text-muted-foreground">{streamer.username}</span>
          <Badge variant={statusVariant}>{t(`status.${streamer.status}`)}</Badge>
          {!streamer.user && <Badge variant="outline">{t('streamers.guest')}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {streamer.anyTime ? (
            <span>{t('streamers.anyTime')}</span>
          ) : streamer.shows.length === 0 ? (
            <span>{t('streamers.noShow')}</span>
          ) : (
            streamer.shows.map((s) => <ShowChip key={s.id} show={s} />)
          )}
          {streamer.user && <span>· {streamer.user.name}</span>}
          {streamer.expiresAt && (
            <span>· {t('streamers.expires', { date: when(streamer.expiresAt) })}</span>
          )}
          <span>
            ·{' '}
            {streamer.lastConnectedAt
              ? t('streamers.lastConnected', { date: when(streamer.lastConnectedAt) })
              : t('streamers.never')}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        {canManage && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('streamers.edit')}
          </Button>
        )}
        {canResetPassword && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onNewPassword}>
            <DelayedSpinner when={busy === 'password'} data-icon="inline-start" />
            {t('streamers.newPassword')}
          </Button>
        )}
        {canManage && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onDelete}>
            <DelayedSpinner when={busy === 'delete'} data-icon="inline-start" />
            {t('streamers.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

export function LivePage() {
  const t = useLiveT();
  const liveError = useLiveError();
  const { stationId } = route.useParams();
  const access = useLiveAccess(stationId);
  const queryClient = useQueryClient();
  const copy = useCopy();
  const streamers = useQuery(streamersQuery(stationId));
  const connection = useQuery(connectionQuery(stationId));
  const [editing, setEditing] = useState<Streamer | 'new' | null>(null);
  const [password, setPassword] = useState<StreamerWithPassword | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: 'password' | 'delete' } | null>(null);

  const list = streamers.data?.streamers ?? [];
  const own = list.filter((s) => s.user?.id === access.userId);
  const ownUsername = own.length === 1 ? own[0]?.username : undefined;

  const newPassword = async (s: Streamer) => {
    // window.confirm, like the other destructive actions (shows' delete).
    if (!window.confirm(t('streamers.newPasswordConfirm', { name: s.displayName }))) return;
    setBusy({ id: s.id, action: 'password' });
    try {
      setPassword(await liveApi.setPassword(stationId, s.id));
      await invalidateLive(queryClient, stationId);
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: Streamer) => {
    if (!window.confirm(t('streamers.deleteConfirm', { name: s.displayName }))) return;
    setBusy({ id: s.id, action: 'delete' });
    try {
      await liveApi.remove(stationId, s.id);
      await invalidateLive(queryClient, stationId);
      toast.success(t('streamers.deleted'));
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setBusy(null);
    }
  };

  if (streamers.isError && isApiError(streamers.error, 'forbidden')) {
    return <p className="p-4 text-sm text-muted-foreground sm:p-6">{t('forbidden')}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {access.canManage && (
          <Button className="ml-auto" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            {t('streamers.new')}
          </Button>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{t('connection.title')}</h2>
        {connection.isPending ? (
          <ListSkeleton rows={4} />
        ) : connection.isError ? (
          <FormAlert error={connection.error} />
        ) : (
          <>
            {access.canManage && streamers.isSuccess && list.length === 0 && (
              <Alert>
                <AlertDescription>{t('connection.noStreamers')}</AlertDescription>
              </Alert>
            )}
            <ConnectionSettings info={connection.data} username={ownUsername} t={t} />
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          {access.canManage ? t('streamers.title') : t('streamers.mine')}
        </h2>
        {streamers.isPending ? (
          <ListSkeleton rows={3} />
        ) : streamers.isError ? (
          <FormAlert error={streamers.error} />
        ) : list.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {access.canManage ? t('streamers.empty') : t('streamers.emptyMine')}
            </CardContent>
          </Card>
        ) : (
          <Card size="sm">
            <CardContent>
              <ul className="divide-y">
                {list.map((s) => (
                  <StreamerRow
                    key={s.id}
                    streamer={s}
                    timezone={access.timezone}
                    canManage={access.canManage}
                    canResetPassword={
                      access.canManage || (access.canBroadcast && s.user?.id === access.userId)
                    }
                    busy={busy?.id === s.id ? busy.action : null}
                    onEdit={() => setEditing(s)}
                    onNewPassword={() => newPassword(s)}
                    onDelete={() => remove(s)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      {access.canManage && (
        <StreamerDialog
          stationId={stationId}
          timezone={access.timezone}
          streamer={editing && editing !== 'new' ? editing : undefined}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onCreated={setPassword}
        />
      )}
      <PasswordDialog result={password} onClose={() => setPassword(null)} copy={copy} />
    </div>
  );
}
