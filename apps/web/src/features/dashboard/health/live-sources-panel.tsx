import type { LiveStatus } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import { isApiError } from '../../../app/api/client.ts';
import { useSse } from '../../../app/sse/sse.tsx';
import { useAlertT } from '../../alerts/messages.ts';
import { healthKeys, liveStatusQuery } from './api.ts';

// Connected live sources (#71): the station's harbor inputs (#64) with a DJ connected, which one
// is on air and which are buffered enough to take it. Refetched on the live events. Members
// without `live:read` get nothing (the api refuses).

const liveEvents = new Set([
  'engine.live.connected',
  'engine.live.disconnected',
  'engine.live.gate',
  'live.session.started',
  'live.session.ended',
  'engine.up',
  'engine.down',
]);

export function LiveSourcesPanel({ stationId }: { stationId: string }) {
  const t = useAlertT();
  const queryClient = useQueryClient();
  const query = useQuery({ ...liveStatusQuery(stationId), retry: false });
  useSse((event) => {
    if (liveEvents.has(event.type)) {
      void queryClient.invalidateQueries({ queryKey: healthKeys.live(stationId) });
    }
  });
  if (query.isError && isApiError(query.error) && query.error.status === 403) return null;

  return (
    <Card size="sm" data-testid="live-sources">
      <CardHeader>
        <CardTitle>{t('live.title')}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {query.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : query.data ? (
          <LiveSources status={query.data} />
        ) : (
          <p className="text-muted-foreground">{t('live.unreachable')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function LiveSources({ status }: { status: LiveStatus }) {
  const t = useAlertT();
  if (!status.enabled) return <p className="text-muted-foreground">{t('live.disabled')}</p>;
  if (!status.reachable) return <p className="text-muted-foreground">{t('live.unreachable')}</p>;
  const connected = status.inputs.filter((input) => input.connected);
  if (connected.length === 0) return <p className="text-muted-foreground">{t('live.none')}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {connected.map((input) => {
        const onAir = status.onAir === input.input;
        return (
          <li
            key={input.input}
            className="relative flex flex-wrap items-center gap-2 overflow-hidden rounded-[4px] bg-muted/40 py-2 pr-3 pl-4"
            data-testid="live-source"
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 w-1 ${onAir ? 'bg-destructive' : input.ready ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            <span className="font-medium">
              {input.streamer?.displayName ?? t('live.unknownDj')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('live.input', { input: input.input })}
            </span>
            <Badge variant={onAir ? 'destructive' : 'outline'} className="ml-auto">
              {onAir ? t('live.onAir') : input.ready ? t('live.ready') : t('live.buffering')}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
