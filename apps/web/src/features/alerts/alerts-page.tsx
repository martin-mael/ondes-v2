import { alertTypes, rolePermissions } from '@ondes/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@/ui/button';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { Page, PageHeader } from '../../app/page-header.tsx';
import { DelayedSpinner, ListSkeleton } from '../../app/pending.tsx';
import { AlertItem } from './alert-item.tsx';
import { type AlertFilter, alertsQuery, useLiveAlerts } from './api.ts';
import { alertTypeLabel } from './format.ts';
import { useAlertT } from './messages.ts';

// The station's alerts (#71): open ones by default, filtered by status and type, newest first,
// acknowledged or resolved by hand by members with `alert:manage`. The `alert.*` events refetch
// the list, so a new alert shows within a second of being raised (no polling).

export const alertsSearchSchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).optional().catch(undefined),
  type: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
    .optional()
    .catch(undefined),
});

const statuses = ['open', 'resolved', 'all'] as const;

export function AlertsPage() {
  const t = useAlertT();
  const { stationId } = useParams({ from: '/_app/stations/$stationId/alerts' });
  const search = useSearch({ from: '/_app/stations/$stationId/alerts' });
  const navigate = useNavigate({ from: '/stations/$stationId/alerts' });
  const station = findStation(useOrgs(), stationId)?.station;
  const canManage = station ? rolePermissions[station.role].includes('alert:manage') : false;
  const timeZone = station?.timezone ?? 'UTC';
  const filter: AlertFilter = { status: search.status ?? 'open', type: search.type };
  const queryClient = useQueryClient();
  useLiveAlerts(queryClient, stationId);
  const query = useInfiniteQuery(alertsQuery(stationId, filter));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const setFilter = (next: Partial<AlertFilter>) =>
    void navigate({
      search: (prev) => {
        const merged = { ...prev, ...next };
        return {
          status: merged.status === 'open' ? undefined : merged.status,
          type: merged.type || undefined,
        };
      },
      replace: true,
    });

  return (
    <Page width="list" header={<PageHeader title={t('title')} description={t('description')} />}>
      {/* One row on one baseline: which alerts (tabs) on the left, of what type on the right. */}
      <div className="flex flex-wrap items-center gap-4">
        <Tabs
          value={filter.status}
          onValueChange={(value) => setFilter({ status: value as AlertFilter['status'] })}
        >
          <TabsList aria-label={t('filter.status')}>
            {statuses.map((s) => (
              <TabsTrigger key={s} value={s}>
                {t(`status.${s}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <NativeSelect
          className="ml-auto"
          aria-label={t('filter.type')}
          value={filter.type ?? ''}
          onChange={(e) => setFilter({ type: e.target.value || undefined })}
        >
          <NativeSelectOption value="">{t('filter.allTypes')}</NativeSelectOption>
          {typeOptions(filter.type).map((type) => (
            <NativeSelectOption key={type} value={type}>
              {alertTypeLabel(type, t)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {query.isError && <FormAlert error={query.error} />}
      {query.isPending ? (
        <ListSkeleton rows={4} className="[&>*]:h-16" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="alerts-empty">
          {filter.status === 'open' && !filter.type ? t('emptyOpen') : t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('title')}>
          {items.map((alert) => (
            <AlertItem
              key={alert.id}
              alert={alert}
              stationId={stationId}
              timeZone={timeZone}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <div>
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            <DelayedSpinner when={query.isFetchingNextPage} />
            {t('more')}
          </Button>
        </div>
      )}
    </Page>
  );
}

/** The known types, plus the filtered one if the app doesn't know it (a link from elsewhere). */
function typeOptions(current: string | undefined): string[] {
  const known: string[] = Object.values(alertTypes);
  const all = current && !known.includes(current) ? [...known, current] : known;
  return [...all].sort();
}
