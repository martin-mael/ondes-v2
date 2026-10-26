import type { LiveStatus } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HeadphonesIcon, SquareIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { API_BASE, isApiError } from '../../../app/api/client.ts';
import { ListSkeleton } from '../../../app/pending.tsx';
import { useSse } from '../../../app/sse/sse.tsx';
import { useAlertT } from '../../alerts/messages.ts';
import { healthKeys, liveStatusQuery } from './api.ts';

// Connected live sources (#71): the station's harbor inputs (#64) with a DJ connected, which one
// is on air and which are buffered enough to take it, and a pre-listen of each ready input (the
// engine's stream of it, proxied by the api) to check a DJ before putting them on air. One input
// at a time. Refetched on the live events. Members without `live:read` get nothing.

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
          <ListSkeleton rows={1} className="[&>*]:h-12" />
        ) : query.data ? (
          <LiveSources stationId={stationId} status={query.data} />
        ) : (
          <p className="text-muted-foreground">{t('live.unreachable')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function LiveSources({ stationId, status }: { stationId: string; status: LiveStatus }) {
  const t = useAlertT();
  const [listening, setListening] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  // The DJ left (or isn't ready any more): stop, so a reconnect doesn't play without a click.
  const listenable = status.inputs.find((i) => i.input === listening)?.ready === true;
  useEffect(() => {
    if (listening !== null && !listenable) setListening(null);
  }, [listening, listenable]);
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
            {input.ready && (
              <Button
                size="sm"
                variant={listening === input.input ? 'secondary' : 'outline'}
                aria-pressed={listening === input.input}
                onClick={() => {
                  setFailed(null);
                  setListening(listening === input.input ? null : input.input);
                }}
              >
                {listening === input.input ? <SquareIcon /> : <HeadphonesIcon />}
                {listening === input.input ? t('live.stopListen') : t('live.preListen')}
              </Button>
            )}
            {listening === input.input && (
              // biome-ignore lint/a11y/useMediaCaption: a live DJ stream has no captions.
              <audio
                autoPlay
                src={`${API_BASE}/stations/${encodeURIComponent(stationId)}/live/inputs/${input.input}/listen`}
                onError={() => {
                  setListening(null);
                  setFailed(input.input);
                }}
                data-testid="prelisten-audio"
              />
            )}
            {failed === input.input && (
              <p className="w-full text-xs text-muted-foreground">
                {t('live.preListenUnavailable')}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
