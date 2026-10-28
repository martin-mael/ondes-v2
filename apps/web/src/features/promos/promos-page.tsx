import {
  type Promo,
  type PromoStatus,
  promoStatusSchema,
  rolePermissions,
  type VtPool,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { PageHeader } from '../../app/page-header.tsx';
import { DelayedSpinner, ListSkeleton } from '../../app/pending.tsx';
import { invalidatePromos, promosApi, promosQuery, vtPoolsQuery } from './api.ts';
import { type PromoT, usePromoError, usePromoT } from './messages.ts';
import { PlaysDialog } from './plays-dialog.tsx';
import { PoolDialog } from './pool-dialog.tsx';
import { PromoDialog } from './promo-dialog.tsx';

// Promo VTs and VT pools (#60): the station's pools, its promos with their validity, rules and
// plays, filtered by pool and status. Reading needs `voice_track:read`, editing
// `voice_track:write`; the api checks again. Every time is the station's.

const route = getRouteApi('/_app/stations/$stationId/promos');

function usePromoAccess(stationId: string) {
  const found = findStation(useOrgs(), stationId);
  const allowed = new Set(found ? rolePermissions[found.station.role] : []);
  return {
    timezone: found?.station.timezone ?? 'UTC',
    canEdit: allowed.has('voice_track:write'),
  };
}

const statusVariant: Record<PromoStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'default',
  scheduled: 'secondary',
  expired: 'outline',
  disabled: 'outline',
};

export function PromosPage() {
  const t = usePromoT();
  const promoError = usePromoError();
  const { stationId } = route.useParams();
  const access = usePromoAccess(stationId);
  const queryClient = useQueryClient();
  const [poolFilter, setPoolFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromoStatus | ''>('');
  const pools = useQuery(vtPoolsQuery(stationId));
  const promos = useQuery(
    promosQuery(stationId, {
      ...(poolFilter ? { poolId: poolFilter } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
    }),
  );
  const [editingPool, setEditingPool] = useState<VtPool | 'new' | null>(null);
  const [editingPromo, setEditingPromo] = useState<Promo | 'new' | null>(null);
  const [playsOf, setPlaysOf] = useState<Promo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const poolList = pools.data?.items ?? [];
  const poolsById = new Map(poolList.map((p) => [p.id, p]));
  const list = promos.data?.items ?? [];
  const filtered = poolFilter !== '' || statusFilter !== '';

  const removePool = async (pool: VtPool) => {
    if (!window.confirm(t('pools.deleteConfirm', { name: pool.name }))) return;
    setBusy(pool.id);
    try {
      await promosApi.removePool(stationId, pool.id);
      if (poolFilter === pool.id) setPoolFilter('');
      await invalidatePromos(queryClient, stationId);
      toast.success(t('pools.deleted'));
    } catch (error) {
      toast.error(promoError(error));
    } finally {
      setBusy(null);
    }
  };
  const removePromo = async (promo: Promo) => {
    if (!window.confirm(t('promos.deleteConfirm', { title: promo.title }))) return;
    setBusy(promo.id);
    try {
      await promosApi.remove(stationId, promo.id);
      await invalidatePromos(queryClient, stationId);
      toast.success(t('promos.deleted'));
    } catch (error) {
      toast.error(promoError(error));
    } finally {
      setBusy(null);
    }
  };

  if (
    (promos.isError && isApiError(promos.error, 'forbidden')) ||
    (pools.isError && isApiError(pools.error, 'forbidden'))
  ) {
    return <p className="p-4 text-sm text-muted-foreground sm:p-6">{t('forbidden')}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          access.canEdit && (
            <Button onClick={() => setEditingPromo('new')}>
              <PlusIcon data-icon="inline-start" />
              {t('promos.new')}
            </Button>
          )
        }
      />

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{t('pools.title')}</h2>
          {access.canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setEditingPool('new')}
            >
              <PlusIcon data-icon="inline-start" />
              {t('pools.new')}
            </Button>
          )}
        </div>
        {pools.isPending ? (
          <ListSkeleton rows={2} />
        ) : pools.isError ? (
          <FormAlert error={pools.error} />
        ) : poolList.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              {t('pools.empty')}
            </CardContent>
          </Card>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {poolList.map((pool) => (
              <li
                key={pool.id}
                className="relative flex flex-col gap-2 overflow-hidden rounded-[4px] border bg-card py-3 pr-3 pl-4"
              >
                {pool.color && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1"
                    style={{ backgroundColor: pool.color }}
                  />
                )}
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{pool.name}</span>
                  {pool.description && (
                    <span className="text-sm text-muted-foreground">{pool.description}</span>
                  )}
                  <span className="text-sm text-muted-foreground">
                    {t('pools.count', { active: pool.activeCount, count: pool.promoCount })}
                  </span>
                </div>
                {access.canEdit && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingPool(pool)}>
                      {t('pools.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => removePool(pool)}
                    >
                      <DelayedSpinner when={busy === pool.id} data-icon="inline-start" />
                      {t('pools.delete')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">{t('promos.title')}</h2>
          <div className="ml-auto flex flex-wrap gap-2">
            <NativeSelect
              size="sm"
              aria-label={t('promos.filterPool')}
              value={poolFilter}
              onChange={(e) => setPoolFilter(e.target.value)}
            >
              <NativeSelectOption value="">{t('promos.allPools')}</NativeSelectOption>
              {poolList.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              size="sm"
              aria-label={t('promos.filterStatus')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as PromoStatus | '')}
            >
              <NativeSelectOption value="">{t('promos.allStatuses')}</NativeSelectOption>
              {promoStatusSchema.options.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {t(`status.${s}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        {promos.isPending ? (
          <ListSkeleton rows={4} />
        ) : promos.isError ? (
          <FormAlert error={promos.error} />
        ) : list.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {filtered ? t('promos.emptyFilter') : t('promos.empty')}
            </CardContent>
          </Card>
        ) : (
          <Card size="sm">
            <CardContent>
              <ul className="divide-y">
                {list.map((promo) => (
                  <PromoRow
                    key={promo.id}
                    promo={promo}
                    pools={poolsById}
                    timezone={access.timezone}
                    canEdit={access.canEdit}
                    busy={busy === promo.id}
                    disabled={busy !== null}
                    t={t}
                    onEdit={() => setEditingPromo(promo)}
                    onPlays={() => setPlaysOf(promo)}
                    onDelete={() => removePromo(promo)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      {access.canEdit && (
        <>
          <PoolDialog
            stationId={stationId}
            pool={editingPool && editingPool !== 'new' ? editingPool : undefined}
            open={editingPool !== null}
            onOpenChange={(open) => !open && setEditingPool(null)}
          />
          <PromoDialog
            stationId={stationId}
            timezone={access.timezone}
            promo={editingPromo && editingPromo !== 'new' ? editingPromo : undefined}
            open={editingPromo !== null}
            onOpenChange={(open) => !open && setEditingPromo(null)}
          />
        </>
      )}
      <PlaysDialog
        stationId={stationId}
        timezone={access.timezone}
        promo={playsOf}
        onClose={() => setPlaysOf(null)}
      />
    </div>
  );
}

function PromoRow({
  promo,
  pools,
  timezone,
  canEdit,
  busy,
  disabled,
  t,
  onEdit,
  onPlays,
  onDelete,
}: {
  promo: Promo;
  pools: Map<string, VtPool>;
  timezone: string;
  canEdit: boolean;
  busy: boolean;
  disabled: boolean;
  t: PromoT;
  onEdit(): void;
  onPlays(): void;
  onDelete(): void;
}) {
  const { locale } = useI18n();
  // Station time only (CLAUDE.md "Web app").
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  const validity = [
    promo.startAt && t('promos.from', { date: when(promo.startAt) }),
    promo.killAt && t('promos.until', { date: when(promo.killAt) }),
  ].filter(Boolean);
  const rules = [
    t('promos.weight', { weight: promo.weight }),
    promo.maxPlaysPerDay !== null && t('promos.maxPerDay', { max: promo.maxPlaysPerDay }),
    promo.showName && t('promos.show', { name: promo.showName }),
    promo.eventName &&
      (promo.eventAt
        ? t('promos.eventAt', { name: promo.eventName, date: when(promo.eventAt) })
        : t('promos.event', { name: promo.eventName })),
  ].filter(Boolean);
  const poolNames = promo.poolIds.flatMap((id) => {
    const pool = pools.get(id);
    return pool ? [pool] : [];
  });
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{promo.title}</span>
          <Badge variant={statusVariant[promo.status]}>{t(`status.${promo.status}`)}</Badge>
          {poolNames.length === 0 ? (
            <span className="text-sm text-muted-foreground">{t('promos.noPool')}</span>
          ) : (
            poolNames.map((pool) => (
              <Badge key={pool.id} variant="outline">
                {pool.name}
              </Badge>
            ))
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span>{validity.length ? validity.join(' · ') : t('promos.always')}</span>
          {rules.map((r) => (
            <span key={String(r)}>· {r}</span>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span>
            {t('promos.plays', {
              today: promo.plays.airedToday,
              week: promo.plays.aired7d,
              total: promo.plays.airedTotal,
              planned: promo.plays.planned,
            })}
          </span>
          <span>
            ·{' '}
            {promo.plays.lastAiredAt
              ? t('promos.lastAired', { date: when(promo.plays.lastAiredAt) })
              : t('promos.neverAired')}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPlays}>
          {t('promos.playsButton')}
        </Button>
        {canEdit && (
          <>
            <Button variant="outline" size="sm" onClick={onEdit}>
              {t('promos.edit')}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={onDelete}>
              <DelayedSpinner when={busy} data-icon="inline-start" />
              {t('promos.delete')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
