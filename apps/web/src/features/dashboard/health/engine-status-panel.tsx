import type { EngineStatusView } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { ListSkeleton } from '../../../app/pending.tsx';
import { useSse } from '../../../app/sse/sse.tsx';
import { type AlertMessageKey, useAlertT } from '../../alerts/messages.ts';
import { engineStatusQuery, healthKeys } from './api.ts';

// Engine status (#71): up / down / starting from the health monitor (#35), recent crash restarts,
// a crash loop, and a settings change waiting for a restart. Refetched on every engine
// lifecycle event, so a state change shows at once.

const lifecycleEvents = new Set([
  'engine.up',
  'engine.down',
  'engine.booted',
  'engine.restarted',
  'engine.restart_storm',
]);

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const toneClass: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-destructive',
  idle: 'bg-muted-foreground/40',
};

export function engineState(status: EngineStatusView): { label: AlertMessageKey; tone: Tone } {
  if (status.restartStorm.tripped) return { label: 'engine.storm', tone: 'bad' };
  if (status.desiredState === 'stopped') return { label: 'engine.stopped', tone: 'idle' };
  switch (status.health) {
    case 'up':
      return { label: 'engine.up', tone: 'ok' };
    case 'down':
      return { label: 'engine.down', tone: 'bad' };
    case 'unknown':
      return { label: 'engine.unknown', tone: 'warn' };
    default:
      return { label: 'engine.unmonitored', tone: 'idle' };
  }
}

export function EngineStatusPanel({ stationId }: { stationId: string }) {
  const t = useAlertT();
  const queryClient = useQueryClient();
  const query = useQuery(engineStatusQuery(stationId));
  useSse((event) => {
    if (lifecycleEvents.has(event.type)) {
      void queryClient.invalidateQueries({ queryKey: healthKeys.engine(stationId) });
    }
  });
  const status = query.data;
  const state = status ? engineState(status) : null;

  return (
    <Card size="sm" data-testid="engine-status">
      <CardHeader>
        <CardTitle>{t('engine.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {query.isPending ? (
          <ListSkeleton rows={1} className="[&>*]:h-12" />
        ) : !status || !state ? (
          <p className="text-muted-foreground">{t('engine.unavailable')}</p>
        ) : (
          <>
            <p className="flex items-center gap-2 font-medium">
              <span aria-hidden className={`size-2.5 rounded-full ${toneClass[state.tone]}`} />
              <span data-testid="engine-state">{t(state.label)}</span>
            </p>
            <p className="text-muted-foreground">
              {status.restartStorm.restarts > 0
                ? t('engine.restarts', {
                    count: status.restartStorm.restarts,
                    minutes: Math.round(status.restartStorm.windowSeconds / 60),
                  })
                : t('engine.noRestarts')}
            </p>
            {status.restartPending && (
              <p className="text-amber-700 dark:text-amber-400">{t('engine.restartPending')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
