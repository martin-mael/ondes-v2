import { useParams } from '@tanstack/react-router';
import { Badge } from '@/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { findStation, useOrgs } from '../auth/session.ts';
import { useI18n } from '../i18n/i18n.tsx';
import { useServerClock, useSseStatus } from '../sse/sse.tsx';

// Placeholder station dashboard (#9 acceptance: a live clock over SSE). The real
// dashboard is a feature (`features/dashboard`) and replaces this page.

export function DashboardPage() {
  const { t, locale } = useI18n();
  const { stationId } = useParams({ from: '/_app/stations/$stationId' });
  const station = findStation(useOrgs(), stationId)?.station;
  const now = useServerClock();
  const status = useSseStatus();
  const time = (timeZone?: string) =>
    now?.toLocaleTimeString(locale, { timeZone, hour12: false }) ?? '--:--:--';

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-heading text-xl font-semibold">{t('dashboard.title')}</h1>
        <Badge variant={status === 'open' ? 'default' : 'outline'} data-testid="sse-status">
          {status === 'open'
            ? t('dashboard.live')
            : status === 'connecting'
              ? t('dashboard.connecting')
              : t('dashboard.offline')}
        </Badge>
      </div>
      {/* One clock: the station's time (kept in step with the server's clock over SSE). */}
      <Card className="sm:max-w-sm">
        <CardHeader>
          <CardDescription>
            {t('dashboard.stationTime', { timezone: station?.timezone ?? '' })}
          </CardDescription>
          <CardTitle>
            <time
              className="font-mono text-3xl tabular-nums"
              dateTime={now?.toISOString()}
              data-testid="station-clock"
            >
              {time(station?.timezone)}
            </time>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t('dashboard.empty')}
        </CardContent>
      </Card>
    </div>
  );
}
