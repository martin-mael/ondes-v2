import type { AsRunEntry, AsRunOverlayRow, LocalDate } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { isApiError } from '../../../app/api/client.ts';
import { FormAlert } from '../../../app/forms.tsx';
import { ListSkeleton } from '../../../app/pending.tsx';
import { useSseEvent } from '../../../app/sse/sse.tsx';
import { dayHours, formatClock, formatDuration, formatSigned } from '../time.ts';
import { overlayKey, overlayQuery } from './api.ts';
import { type HistoryT, useHistoryT } from './messages.ts';
import {
  DRIFT_WARN_MS,
  groupByHour,
  type HistoryHour,
  isOffPlan,
  nextPendingEndMs,
  statusTone,
} from './model.ts';

// Log vs as-run (#53): a past (or the current) station-local day as it really aired, laid over
// its plan, hour by hour: exact air times in station time, drift, and what went off plan
// (not aired, replaced, fallbacks, safety, live). Read-only.

export type TimelineView = 'plan' | 'history';

/**
 * Which view the timeline shows for `date`: past days open on what aired, today and later on
 * the plan. A choice sticks until the date changes.
 */
export function useTimelineView(date: LocalDate, today: LocalDate) {
  const [choice, setChoice] = useState<{ date: LocalDate; view: TimelineView } | null>(null);
  const fallback: TimelineView = date < today ? 'history' : 'plan';
  const view = choice?.date === date ? choice.view : fallback;
  return [view, (next: TimelineView) => setChoice({ date, view: next })] as const;
}

/** Plan / plan vs aired switch. Only for days that have begun: the future has no as-run. */
export function TimelineViewTabs({
  value,
  onChange,
}: {
  value: TimelineView;
  onChange(view: TimelineView): void;
}) {
  const t = useHistoryT();
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as TimelineView)}>
      <TabsList>
        <TabsTrigger value="plan">{t('view.plan')}</TabsTrigger>
        <TabsTrigger value="history">{t('view.history')}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function LogHistory({
  stationId,
  date,
  timeZone,
  isToday,
}: {
  stationId: string;
  date: LocalDate;
  timeZone: string;
  isToday: boolean;
}) {
  const t = useHistoryT();
  const queryClient = useQueryClient();
  const overlay = useQuery(overlayQuery(stationId, date));
  const hours = useMemo(() => dayHours(date, timeZone), [date, timeZone]);
  const groups = useMemo(() => groupByHour(overlay.data?.rows ?? [], hours), [overlay.data, hours]);
  const entries = useMemo(() => {
    const byId = new Map<string, AsRunEntry>();
    for (const row of overlay.data?.rows ?? []) if (row.entry) byId.set(row.entry.id, row.entry);
    return byId;
  }, [overlay.data]);

  // Today keeps moving: refetch on what airs and on log edits (no loader for it).
  const refresh = () => {
    if (isToday) void queryClient.invalidateQueries({ queryKey: [...overlayKey(stationId), date] });
  };
  useSseEvent('asrun.started', refresh);
  useSseEvent('asrun.ended', refresh);
  useSseEvent('log.updated', refresh);

  // An upcoming item turns "not aired" when its slot ends, which no event announces: refetch
  // then (the api decides, on its clock). A refetch shows no loader.
  const nextEnd = isToday && overlay.data ? nextPendingEndMs(overlay.data) : null;
  useEffect(() => {
    if (nextEnd === null) return;
    const timer = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: [...overlayKey(stationId), date] }),
      nextEnd,
    );
    return () => clearTimeout(timer);
  }, [nextEnd, queryClient, stationId, date]);

  if (overlay.isPending) return <ListSkeleton />;
  if (overlay.isError) {
    return isApiError(overlay.error, 'forbidden') ? (
      <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
    ) : (
      <FormAlert error={overlay.error} />
    );
  }
  const shown = groups.filter((g) => g.rows.length > 0);
  if (shown.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t('summary.empty')}
        </CardContent>
      </Card>
    );
  }
  const reveal = (start: number) =>
    document.getElementById(`history-hour-${start}`)?.scrollIntoView?.({ block: 'start' });
  const pending = overlay.data.rows.some((r) => r.status === 'pending');

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t('summary.title')} className="flex flex-wrap gap-1">
        {shown.map((g) => (
          <Button key={g.start} size="xs" variant="ghost" onClick={() => reveal(g.start)}>
            {g.label}
            {g.offPlan > 0 && <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />}
          </Button>
        ))}
      </nav>
      {pending && <p className="text-sm text-muted-foreground">{t('summary.pendingHint')}</p>}
      {shown.map((group) => (
        <HourSection key={group.start} group={group} t={t}>
          {group.rows.map((row) => (
            <HistoryRow
              key={row.entry?.id ?? row.plan?.logItemId}
              row={row}
              t={t}
              timeZone={timeZone}
              entries={entries}
            />
          ))}
        </HourSection>
      ))}
    </div>
  );
}

function HourSection({
  group,
  t,
  children,
}: {
  group: HistoryHour;
  t: HistoryT;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`history-hour-${group.start}`}
      aria-label={group.label}
      className="scroll-mt-4 rounded-md border"
    >
      <h2 className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <span className="font-semibold tabular-nums">{group.label}</span>
        <span className="text-muted-foreground">{t('hour.aired', { count: group.aired })}</span>
        {group.offPlan > 0 && (
          <Badge variant="outline">{t('hour.issues', { count: group.offPlan })}</Badge>
        )}
        {group.driftMs !== null && (
          <span
            className={
              Math.abs(group.driftMs) > DRIFT_WARN_MS ? 'text-destructive' : 'text-muted-foreground'
            }
          >
            {t('hour.drift', { drift: formatSigned(group.driftMs) })}
          </span>
        )}
      </h2>
      <ol className="flex flex-col divide-y">{children}</ol>
    </section>
  );
}

const entryTitle = (t: HistoryT, entry: AsRunEntry) =>
  entry.source === 'live' && !entry.title ? t('liveDj') : (entry.title ?? t('untitled'));

function HistoryRow({
  row,
  t,
  timeZone,
  entries,
}: {
  row: AsRunOverlayRow;
  t: HistoryT;
  timeZone: string;
  entries: ReadonlyMap<string, AsRunEntry>;
}) {
  const { entry, plan } = row;
  const title = entry ? entryTitle(t, entry) : (plan?.title ?? t('untitled'));
  const artist = entry ? entry.artist : plan?.artists.join(', ') || null;
  const drift = entry?.driftMs ?? null;
  const showStatus = row.status !== 'aired' || row.repeat;
  return (
    <li
      className={`relative grid overflow-hidden rounded-[4px] grid-cols-[5.5rem_4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 py-2 pr-3 pl-4 text-sm sm:grid-cols-[5.5rem_4.5rem_minmax(0,1fr)_7rem] ${
        row.status === 'pending' ? 'text-muted-foreground' : ''
      }`}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${statusTone(row)}`} />
      <span className="tabular-nums" title={t('col.aired')}>
        {entry ? (
          <>
            <span className="font-medium">{formatClock(entry.startedAt, timeZone)}</span>
            {entry.endedAt && (
              <span className="block text-xs text-muted-foreground">
                → {formatClock(entry.endedAt, timeZone)}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span className="tabular-nums text-muted-foreground" title={t('col.planned')}>
        {plan ? formatClock(plan.plannedStart, timeZone) : '—'}
        {drift !== null && Math.abs(drift) >= 1000 && (
          <span
            className={`block text-xs ${Math.abs(drift) > DRIFT_WARN_MS ? 'text-destructive' : ''}`}
            title={t('drift', { drift: formatSigned(drift) })}
          >
            {formatSigned(drift)}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{title}</span>
          {artist && <span className="truncate text-muted-foreground">{artist}</span>}
          {showStatus && (
            <Badge variant={isOffPlan(row) ? 'outline' : 'secondary'}>
              {t(`status.${row.status}`)}
              {row.status === 'fallback' && entry?.fallback
                ? ` · ${t(`fallback.${entry.fallback}`)}`
                : ''}
            </Badge>
          )}
          {entry?.outcome && entry.outcome !== 'complete' && (
            <Badge variant={entry.outcome === 'skipped' ? 'destructive' : 'outline'}>
              {t(`outcome.${entry.outcome}`)}
            </Badge>
          )}
          {row.repeat && <Badge variant="outline">{t('repeat')}</Badge>}
          {entry && !entry.endedAt && <Badge>{t('onAir')}</Badge>}
        </span>
        <RowNote row={row} t={t} timeZone={timeZone} entries={entries} />
      </span>
      <span className="col-start-3 text-xs text-muted-foreground tabular-nums sm:col-start-auto sm:text-right">
        {entry?.durationMs != null ? formatDuration(entry.durationMs) : '—'}
        {plan && plan.kind !== 'live_slot' && <> / {formatDuration(plan.plannedDurationMs)}</>}
      </span>
    </li>
  );
}

/** Why the row differs from the plan, in a line. */
function RowNote({
  row,
  t,
  timeZone,
  entries,
}: {
  row: AsRunOverlayRow;
  t: HistoryT;
  timeZone: string;
  entries: ReadonlyMap<string, AsRunEntry>;
}) {
  const { entry, plan } = row;
  let note: string | null = null;
  if (row.status === 'replaced' && entry && plan) {
    note = t('plannedAs', { title: plan.title ?? t('untitled') });
  } else if (row.status === 'replaced' && !entry) {
    const what = row.replacedBy
      .map((id) => entries.get(id))
      .filter((e): e is AsRunEntry => !!e)
      .map((e) => `${entryTitle(t, e)} (${formatClock(e.startedAt, timeZone)})`);
    note = t('replacedBy', { what: what.join(', ') });
  } else if (row.status === 'transition' && entry) {
    // The voices of a rendered island (#57).
    const titles = (entry.transition?.voices ?? []).flatMap((v) => (v.title ? [v.title] : []));
    if (titles.length > 0) note = t('voices', { titles: titles.join(', ') });
  } else if (row.status === 'unplanned' && entry?.plannedStart) {
    note = t('wasPlanned', { time: formatClock(entry.plannedStart, timeZone) });
  }
  return note ? <span className="text-xs text-muted-foreground">{note}</span> : null;
}
