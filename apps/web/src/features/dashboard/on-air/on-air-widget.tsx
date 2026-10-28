import type {
  OnAir,
  OnAirCurrent,
  OnAirHardEvent,
  OnAirModeKind,
  OnAirNextItem,
  OnAirShow,
} from '@ondes/shared';
import { cn } from 'cn';
import { FlagIcon, MusicIcon } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Progress } from '@/ui/progress';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import { ListSkeleton } from '../../../app/pending.tsx';
import { type OnAirMessageKey, type OnAirT, useOnAirT } from './messages.ts';
import { countdown, formatDuration, progressOf, withOverrun } from './time.ts';
import { useEngineNow, useOnAir } from './use-on-air.ts';

// On air (#70): the station clock, the mode, the item on air with its progress and cue
// markers, the next items with their estimated starts, the next fixed event and the show
// block. Real time over SSE (ADR 0034); every time is the station's.

export function OnAirWidget({ stationId }: { stationId: string }) {
  const t = useOnAirT();
  const { locale } = useI18n();
  // The station's zone only: no other zone stands in while it is unknown.
  const timeZone = findStation(useOrgs(), stationId)?.station.timezone;
  const query = useOnAir(stationId);
  const snapshot = query.data;
  const anchors = [snapshot?.current?.startedAt, snapshot?.nextHardEvent?.at]
    .filter((v): v is string => typeof v === 'string')
    .map(Date.parse);
  const now = useEngineNow(anchors);
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, { timeZone, hour12: false });
  const ahead = snapshot && now !== null ? withOverrun(snapshot, now) : snapshot;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardAction>{snapshot && <ModeBadge t={t} mode={snapshot.mode} />}</CardAction>
      </CardHeader>
      {/* Two columns: the clock over what's playing, then the show and the next fixed time
          beside them, so neither column leaves a hole the width of the card. */}
      <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div>
            <time
              className="block font-mono text-5xl font-semibold tabular-nums tracking-tight sm:text-7xl"
              dateTime={now === null ? undefined : new Date(now).toISOString()}
              data-testid="station-clock"
            >
              {now === null || !timeZone ? '--:--:--' : clock(now)}
            </time>
            <p className="text-xs text-muted-foreground">
              {t('stationTime', { timezone: timeZone ?? '' })}
            </p>
          </div>
          {snapshot && ahead && timeZone ? (
            <NowPlaying t={t} snapshot={snapshot} now={now} />
          ) : query.isError && timeZone ? (
            <p className="text-sm text-destructive">{t('error')}</p>
          ) : (
            <ListSkeleton rows={3} />
          )}
        </div>
        {snapshot && ahead && timeZone && (
          <>
            <div className="flex flex-col gap-6">
              <ShowBlock t={t} show={snapshot.show} clock={clock} />
              <NextEvent t={t} event={ahead.nextHardEvent} now={now} clock={clock} />
            </div>
            <UpNext t={t} items={ahead.next} clock={clock} className="lg:col-span-3" />
          </>
        )}
      </CardContent>
    </Card>
  );
}

const MODE_STYLE: Record<OnAirModeKind, string> = {
  automation: '',
  show: '',
  live: 'bg-red-600 text-white',
  safety: 'border-amber-500 text-amber-700 dark:text-amber-400',
  emergency: '',
  off_air: '',
};
const MODE_VARIANT = {
  automation: 'secondary',
  show: 'default',
  live: 'default',
  safety: 'outline',
  emergency: 'destructive',
  off_air: 'outline',
} as const satisfies Record<OnAirModeKind, string>;

function ModeBadge({ t, mode }: { t: OnAirT; mode: OnAir['mode'] }) {
  const label =
    mode.kind === 'live'
      ? mode.djName
        ? t('mode.live', { name: mode.djName })
        : t('mode.liveUnknown')
      : t(`mode.${mode.kind}`);
  return (
    <Badge
      variant={MODE_VARIANT[mode.kind]}
      className={MODE_STYLE[mode.kind]}
      data-testid="on-air-mode"
      aria-label={`${t('mode.label')}: ${label}`}
    >
      {label}
    </Badge>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>;
}

function titleOf(t: OnAirT, current: OnAirCurrent): string {
  if (current.title) return current.title;
  if (current.source === 'live') return t('now.live');
  if (current.source === 'safety') return t('now.safety');
  if (current.source === 'emergency') return t('now.emergency');
  return t('now.untitled');
}

function NowPlaying({
  t,
  snapshot,
  now,
  className,
}: {
  t: OnAirT;
  snapshot: OnAir;
  now: number | null;
  className?: string;
}) {
  const current = snapshot.current;
  const artwork = snapshot.show?.artworkUrl ?? null;
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <Heading>{t('now.title')}</Heading>
      {current ? (
        <>
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:size-24">
              {artwork ? (
                <img src={artwork} alt="" className="size-full object-cover" />
              ) : (
                <MusicIcon className="size-8 text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold" data-testid="on-air-title">
                {titleOf(t, current)}
              </p>
              {current.artist && (
                <p className="truncate text-sm text-muted-foreground">{current.artist}</p>
              )}
              {current.kind && (
                <Badge variant="outline" className="mt-1">
                  {t(`kind.${current.kind}` as OnAirMessageKey)}
                </Badge>
              )}
            </div>
          </div>
          <ItemProgress t={t} current={current} now={now} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('now.nothing')}</p>
      )}
    </section>
  );
}

function ItemProgress({
  t,
  current,
  now,
}: {
  t: OnAirT;
  current: OnAirCurrent;
  now: number | null;
}) {
  const startedAt = Date.parse(current.startedAt);
  const p = now === null ? null : progressOf(startedAt, current.durationMs, now);
  const length = current.durationMs;
  const marker = (ms: number | null) =>
    length && ms !== null && ms <= length ? (ms / length) * 100 : null;
  const intro = marker(current.introMs);
  const outro = marker(current.outroMs);
  return (
    <div className="flex flex-col gap-1.5">
      {length ? (
        <div className="relative">
          <Progress value={p?.percent ?? 0} aria-label={t('now.progress')} />
          {intro !== null && (
            <span
              className="absolute -top-1 h-3 w-0.5 bg-emerald-500"
              style={{ left: `${intro}%` }}
              title={t('now.intro')}
              data-testid="on-air-intro"
            />
          )}
          {outro !== null && (
            <span
              className="absolute -top-1 h-3 w-0.5 bg-amber-500"
              style={{ left: `${outro}%` }}
              title={t('now.outro')}
              data-testid="on-air-outro"
            />
          )}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between font-mono text-sm tabular-nums">
        <span data-testid="on-air-elapsed">
          <span className="sr-only">{t('now.elapsed')} </span>
          {p ? formatDuration(p.elapsed) : '-:--'}
        </span>
        {length ? (
          <span data-testid="on-air-remaining">
            <span className="sr-only">{t('now.remaining')} </span>−
            {p?.remaining != null ? formatDuration(p.remaining) : '-:--'}
          </span>
        ) : null}
      </div>
      {(current.introMs !== null || current.outroMs !== null) && (
        <p className="flex gap-4 text-xs text-muted-foreground">
          {current.introMs !== null && (
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />
              {t('now.intro')} {formatDuration(current.introMs / 1000)}
            </span>
          )}
          {current.outroMs !== null && (
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-amber-500" />
              {t('now.outro')} {formatDuration(current.outroMs / 1000)}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function ShowBlock({
  t,
  show,
  clock,
}: {
  t: OnAirT;
  show: OnAirShow | null;
  clock: (ms: number) => string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <Heading>{t('show.title')}</Heading>
      {show ? (
        <div
          className="relative overflow-hidden rounded-[4px] bg-muted/50 py-2 pr-3 pl-4"
          data-testid="on-air-show"
        >
          {show.colour && (
            <span
              className="absolute inset-y-0 left-0 w-1"
              style={{ backgroundColor: show.colour }}
              aria-hidden
            />
          )}
          <p className="truncate font-medium">{show.name}</p>
          <p className="text-xs text-muted-foreground">
            {t('show.range', {
              from: clock(Date.parse(show.startsAt)),
              to: clock(Date.parse(show.endsAt)),
            })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="outline">{t(`show.type.${show.type}`)}</Badge>
            {show.episode && (
              <Badge variant="secondary">
                {t('show.episode', { number: show.episode.number })}
              </Badge>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('show.none')}</p>
      )}
    </section>
  );
}

function NextEvent({
  t,
  event,
  now,
  clock,
}: {
  t: OnAirT;
  event: OnAirHardEvent | null;
  now: number | null;
  clock: (ms: number) => string;
}) {
  const at = event ? Date.parse(event.at) : null;
  return (
    <section className="flex flex-col gap-1">
      <Heading>{t('event.title')}</Heading>
      {event && at !== null ? (
        <>
          <p className="flex items-center gap-1.5 truncate text-sm">
            <FlagIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">{t(`event.${event.kind}`)}</span>
            {event.title && <span className="truncate font-medium">{event.title}</span>}
          </p>
          <p
            className="font-mono text-3xl font-semibold tabular-nums"
            data-testid="on-air-countdown"
          >
            {now === null ? '-:--' : formatDuration(countdown(at, now))}
          </p>
          <p className="text-xs text-muted-foreground">{t('event.at', { time: clock(at) })}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('event.none')}</p>
      )}
    </section>
  );
}

function UpNext({
  t,
  items,
  clock,
  className,
}: {
  t: OnAirT;
  items: readonly OnAirNextItem[];
  clock: (ms: number) => string;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <Heading>{t('next.title')}</Heading>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('next.empty')}</p>
      ) : (
        <ol className="flex flex-col divide-y" data-testid="on-air-next">
          {items.map((item) => (
            <li key={item.logItemId} className="flex items-center gap-3 py-2 text-sm">
              <time
                className="w-20 shrink-0 font-mono tabular-nums"
                dateTime={item.estimatedStart}
                title={t('next.estimated')}
              >
                {clock(Date.parse(item.estimatedStart))}
              </time>
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 text-[0.65rem] sm:px-2 sm:text-xs"
              >
                {t(`kind.${item.kind}` as OnAirMessageKey)}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {item.title ?? t('now.untitled')}
                {item.artists.length > 0 && (
                  <span className="text-muted-foreground"> · {item.artists.join(', ')}</span>
                )}
              </span>
              {item.timing !== 'flow' && (
                <Badge variant="secondary" className="shrink-0">
                  {t(
                    item.timing === 'hard'
                      ? 'next.hard'
                      : item.timing === 'soft'
                        ? 'next.soft'
                        : 'next.not_before',
                  )}
                </Badge>
              )}
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {formatDuration(item.durationMs / 1000)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
