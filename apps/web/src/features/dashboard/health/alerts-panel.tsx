import { rolePermissions } from '@ondes/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { ListSkeleton } from '../../../app/pending.tsx';
import { AlertItem } from '../../alerts/alert-item.tsx';
import { alertsQuery, severityOrder, useLiveAlerts } from '../../alerts/api.ts';
import { useAlertT } from '../../alerts/messages.ts';

// Open alerts on the dashboard (#71): the most severe first, a few of them, with acknowledge;
// the alerts page has the rest. Kept fresh by the `alert.*` events (no polling), so a new alert
// is on screen within a second of being raised.

const SHOWN = 5;

export function AlertsPanel({ stationId }: { stationId: string }) {
  const t = useAlertT();
  const station = findStation(useOrgs(), stationId)?.station;
  const canManage = station ? rolePermissions[station.role].includes('alert:manage') : false;
  const queryClient = useQueryClient();
  useLiveAlerts(queryClient, stationId);
  const query = useInfiniteQuery(alertsQuery(stationId, { status: 'open' }, 100));
  const open = (query.data?.pages[0]?.items ?? [])
    .slice()
    .sort(
      (a, b) =>
        severityOrder[a.severity] - severityOrder[b.severity] ||
        b.raisedAt.getTime() - a.raisedAt.getTime(),
    );
  const rest = open.length - SHOWN;

  return (
    <Card size="sm" data-testid="alerts-panel">
      <CardHeader>
        <CardTitle>{t('alerts.title')}</CardTitle>
        <CardAction>
          <Link
            to="/stations/$stationId/alerts"
            params={{ stationId }}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            {rest > 0 ? t('alerts.more', { count: rest }) : t('alerts.all')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {query.isPending ? (
          <ListSkeleton rows={2} className="[&>*]:h-14" />
        ) : open.length === 0 ? (
          <p className="text-muted-foreground">{t('emptyOpen')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {open.slice(0, SHOWN).map((alert) => (
              <AlertItem
                key={alert.id}
                alert={alert}
                stationId={stationId}
                timeZone={station?.timezone ?? 'UTC'}
                canManage={canManage}
                compact
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
