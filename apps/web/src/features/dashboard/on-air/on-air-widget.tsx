import { Card, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import { useServerClock } from '../../../app/sse/sse.tsx';

// On air (#70). For now, the station's clock (#9), kept in step with the server over SSE.

export function OnAirWidget({ stationId }: { stationId: string }) {
  const { t, locale } = useI18n();
  const station = findStation(useOrgs(), stationId)?.station;
  const now = useServerClock();
  const time =
    now?.toLocaleTimeString(locale, { timeZone: station?.timezone, hour12: false }) ?? '--:--:--';
  return (
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
            {time}
          </time>
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
