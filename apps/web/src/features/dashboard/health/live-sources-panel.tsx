import { LIVE_HANDOVER_FADE_MS_DEFAULT, type LiveStatus } from '@ondes/shared';
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
import {
  HandoverFadeSelect,
  LiveInputActions,
  ScheduledHandovers,
  useCanControlLive,
} from '../../live/handover.tsx';
import { useLiveT } from '../../live/messages.ts';
import { healthKeys, liveStatusQuery } from './api.ts';

// Connected live sources (#71): the station's harbor inputs (#64) with a DJ connected, which one
// is on air and which are buffered enough to take it, and a pre-listen of each ready input (the
// engine's stream of it, proxied by the api) to check a DJ before putting them on air. One input
// at a time. Refetched on the live events. Members without `live:read` get nothing.
// DJ handover (#66): members with `engine:control` also get each input's actions (on air or
// hand over with the chosen crossfade, mute, disconnect) and the scheduled handovers.

const liveEvents = new Set([
  'engine.live.connected',
  'engine.live.disconnected',
  'engine.live.gate',
  'engine.live.muted',
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
      <CardContent className="flex flex-col gap-4 text-sm">
        {query.isPending ? (
          <ListSkeleton rows={1} className="[&>*]:h-12" />
        ) : query.data ? (
          <LiveSources stationId={stationId} status={query.data} />
        ) : (
          <p className="text-muted-foreground">{t('live.unreachable')}</p>
        )}
        {query.data?.enabled && <ScheduledHandovers stationId={stationId} />}
      </CardContent>
    </Card>
  );
}

function LiveSources({ stationId, status }: { stationId: string; status: LiveStatus }) {
  const t = useAlertT();
  const liveT = useLiveT();
  const canControl = useCanControlLive(stationId);
  const [fadeMs, setFadeMs] = useState(LIVE_HANDOVER_FADE_MS_DEFAULT);
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
    <div className="flex flex-col gap-2">
      {canControl && connected.length > 1 && (
        // biome-ignore lint/a11y/noLabelWithoutControl: the select is the label's control.
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {liveT('handover.fade')}
          <HandoverFadeSelect value={fadeMs} onChange={setFadeMs} />
        </label>
      )}
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
              {input.muted && <Badge variant="secondary">{liveT('handover.mutedBadge')}</Badge>}
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
              <LiveInputActions
                stationId={stationId}
                status={status}
                input={input}
                fadeMs={fadeMs}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
