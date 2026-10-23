import type { ListenerHistory } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/ui/chart';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';
import { ListSkeleton } from '../../../app/pending.tsx';
import { useAlertT } from '../../alerts/messages.ts';
import { currentListenersQuery, listenerHistoryQuery } from './api.ts';

// Listeners (#71): per mount now, and the last 24 hours stacked by mount, on the station's
// clock. The Icecast poller (#32) samples every 15 s into minute buckets; there is no listener
// event, so "now" refetches every 30 s and the graph every 5 minutes (quietly: no loader).

const NOW_REFRESH_MS = 30_000;
const HISTORY_REFRESH_MS = 5 * 60_000;
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

function clock(instant: Date | number, timeZone: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

export function ListenersPanel({ stationId }: { stationId: string }) {
  const t = useAlertT();
  const { locale } = useI18n();
  const timeZone = findStation(useOrgs(), stationId)?.station.timezone ?? 'UTC';
  const now = useQuery({ ...currentListenersQuery(stationId), refetchInterval: NOW_REFRESH_MS });
  const history = useQuery({
    ...listenerHistoryQuery(stationId),
    refetchInterval: HISTORY_REFRESH_MS,
  });
  const current = now.data;

  return (
    <Card size="sm" data-testid="listeners">
      <CardHeader>
        <CardTitle>{t('listeners.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {now.isPending ? (
          <ListSkeleton rows={1} className="[&>*]:h-12" />
        ) : !current || current.sampledAt === null ? (
          <p className="text-muted-foreground">{t('listeners.none')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums" data-testid="listeners-total">
                {current.total}
              </span>
              <span className="text-muted-foreground">
                {t('listeners.now')} · {clock(current.sampledAt, timeZone, locale)}
              </span>
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {current.mounts.map((m) => (
                <li key={m.mount} data-testid="listeners-mount">
                  <span className="font-mono">{m.mount}</span>{' '}
                  <span className="font-medium text-foreground tabular-nums">{m.listeners}</span>
                  {!m.sourceConnected && <> · {t('listeners.fallback')}</>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <h3 className="text-sm text-muted-foreground">{t('listeners.graph')}</h3>
          {history.isPending ? (
            <ListSkeleton rows={1} className="[&>*]:h-40" />
          ) : history.data && history.data.mounts.length > 0 ? (
            <ListenerChart history={history.data} timeZone={timeZone} locale={locale} />
          ) : (
            <p className="flex h-40 items-center justify-center text-xs text-muted-foreground">
              {t('listeners.noData')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ListenerChart({
  history,
  timeZone,
  locale,
}: {
  history: ListenerHistory;
  timeZone: string;
  locale: Locale;
}) {
  // Chart keys can't be mounts (they become CSS variable names): m0, m1, … labelled by mount.
  const { config, data, keys } = useMemo(() => {
    const keys = history.mounts.map((_, i) => `m${i}`);
    const config: ChartConfig = Object.fromEntries(
      history.mounts.map((mount, i) => [
        `m${i}`,
        { label: mount, color: COLORS[i % COLORS.length] as string },
      ]),
    );
    const data = history.points.map((p) => ({
      at: p.startsAt.getTime(),
      ...Object.fromEntries(
        history.mounts.map((mount, i) => [
          `m${i}`,
          p.total === null ? null : (p.byMount[mount] ?? 0),
        ]),
      ),
    }));
    return { config, data, keys };
  }, [history]);

  return (
    <ChartContainer config={config} className="aspect-auto h-40 w-full">
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickLine={false}
          axisLine={false}
          minTickGap={32}
          tickFormatter={(value: number) => clock(value, timeZone, locale)}
        />
        <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const at = payload?.[0]?.payload?.at;
                return typeof at === 'number' ? clock(at, timeZone, locale) : '';
              }}
            />
          }
        />
        {keys.map((key) => (
          <Area
            key={key}
            dataKey={key}
            type="monotone"
            stackId="listeners"
            stroke={`var(--color-${key})`}
            fill={`var(--color-${key})`}
            fillOpacity={0.3}
            isAnimationActive={false}
          />
        ))}
        {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      </AreaChart>
    </ChartContainer>
  );
}
