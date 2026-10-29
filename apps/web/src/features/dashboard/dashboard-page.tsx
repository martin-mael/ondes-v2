import { rolePermissions } from '@ondes/shared';
import { useParams } from '@tanstack/react-router';
import { cn } from 'cn';
import { Badge } from '@/ui/badge';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { Page, PageHeader } from '../../app/page-header.tsx';
import { useSseStatus } from '../../app/sse/sse.tsx';
import { dashboardWidgets } from './widgets.tsx';

// The station dashboard (#69): a title with the real-time status, then the widgets of
// `widgets.tsx` the user's role may see, in a single column on phones.

export function DashboardPage() {
  const { t } = useI18n();
  const { stationId } = useParams({ from: '/_app/stations/$stationId' });
  const station = findStation(useOrgs(), stationId)?.station;
  const status = useSseStatus();
  const permissions = station ? rolePermissions[station.role] : [];
  const widgets = dashboardWidgets.filter(
    (widget) => !widget.permission || permissions.includes(widget.permission),
  );

  return (
    <Page
      className="gap-4 sm:gap-6"
      header={
        <PageHeader
          title={t('dashboard.title')}
          badge={
            <Badge variant={status === 'open' ? 'default' : 'outline'} data-testid="sse-status">
              {status === 'open'
                ? t('dashboard.live')
                : status === 'connecting'
                  ? t('dashboard.connecting')
                  : t('dashboard.offline')}
            </Badge>
          }
        />
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
        {widgets.map(({ id, Component, width }) => (
          <section
            key={id}
            data-widget={id}
            className={cn('min-w-0 empty:hidden', width === 'full' && 'lg:col-span-2')}
          >
            <Component stationId={stationId} />
          </section>
        ))}
      </div>
    </Page>
  );
}
