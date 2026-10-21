import {
  addDays,
  daysBetween,
  type LocalDate,
  localDateOf,
  type Show,
  type ShowConflict,
  type ShowOccurrence,
  SLOT_MAX_MOVE_DAYS,
  weekStart,
  zonedFields,
  zonedInstant,
} from '@ondes/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  RadioIcon,
  UploadIcon,
} from 'lucide-react';
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { useIsMobile } from '@/ui/hooks/use-mobile';
import { cn } from '@/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Spinner } from '@/ui/spinner';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { useShowAccess } from './access.ts';
import { invalidateShows, occurrencesQuery, showsApi, showsQuery, slotsQuery } from './api.ts';
import { formatDay, formatDuration, formatMonth, formatTime } from './format.ts';
import { useShowError, useShowT } from './messages.ts';
import {
  type CalendarSelection,
  type CancelledEntry,
  OccurrenceDialog,
  useDetachedNotice,
} from './occurrence-dialog.tsx';
import { useEpisodeUpload } from './upload.ts';

// The shows calendar (#45): a week (time grid), month or list view of slot occurrences on the
// station's wall clock, with conflicts, moved and cancelled occurrences. In the week view,
// programmers drag an occurrence to move it (a `moved` exception, at most 7 days away) and
// anyone who may edit a show drops an audio file on its block to upload the episode.

const route = getRouteApi('/_app/stations/$stationId/shows/calendar');

export const calendarViews = ['week', 'month', 'list'] as const;
export type CalendarView = (typeof calendarViews)[number];

const HOUR_PX = 44;
const SNAP_MIN = 15;
const OCCURRENCE_MIME = 'application/x-ondes-occurrence';

type Entry =
  | { kind: 'occurrence'; key: string; occurrence: ShowOccurrence; conflicts: ShowConflict[] }
  | { kind: 'cancelled'; key: string; entry: CancelledEntry };

const startOf = (e: Entry) => (e.kind === 'occurrence' ? e.occurrence.startsAt : e.entry.startsAt);
const endOf = (e: Entry) => (e.kind === 'occurrence' ? e.occurrence.endsAt : e.entry.endsAt);
const colourOf = (e: Entry, shows: Map<string, Show>) =>
  (e.kind === 'occurrence' ? e.occurrence.show.colour : shows.get(e.entry.showId)?.colour) ?? null;

/** Minutes since local midnight of `instant` on the station's clock. */
const wallMinutes = (instant: Date, timezone: string) => {
  const f = zonedFields(instant, timezone);
  return f.hour * 60 + f.minute;
};

export function CalendarPage() {
  const t = useShowT();
  const { locale } = useI18n();
  const { stationId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/stations/$stationId/shows/calendar' });
  const access = useShowAccess(stationId);
  const tz = access.timezone;
  const isMobile = useIsMobile();
  const view: CalendarView = search.view ?? (isMobile ? 'list' : 'week');
  const today = localDateOf(new Date(), tz);
  const anchor = search.date ?? today;

  const range = useMemo(() => {
    if (view === 'month') {
      const first = `${anchor.slice(0, 8)}01`;
      const start = weekStart(first);
      return { start, days: 42 };
    }
    return { start: weekStart(anchor), days: 7 };
  }, [anchor, view]);
  const days = useMemo(
    () => Array.from({ length: range.days }, (_, i) => addDays(range.start, i)),
    [range],
  );
  const from = zonedInstant(range.start, '00:00', tz);
  const to = zonedInstant(addDays(range.start, range.days), '00:00', tz);

  const shows = useQuery(showsQuery(stationId));
  const showMap = useMemo(
    () => new Map((shows.data?.items ?? []).map((s) => [s.id, s])),
    [shows.data],
  );
  const occurrences = useQuery(occurrencesQuery(stationId, from, to, search.show));
  // Cancelled occurrences aren't served: they come from the slots' exceptions.
  const visibleShows = (shows.data?.items ?? []).filter(
    (s) => !search.show || s.id === search.show,
  );
  const slotLists = useQueries({
    queries: visibleShows.map((s) => slotsQuery(stationId, s.id)),
  });

  // Rebuilt each render: occurrences keep their identity across renders (query data).
  const entries = ((): Entry[] => {
    const out: Entry[] = [];
    const data = occurrences.data;
    for (const occurrence of data?.occurrences ?? []) {
      const conflicts = (data?.conflicts ?? []).filter(
        (c) =>
          (c.a.slotId === occurrence.slotId && c.a.date === occurrence.date) ||
          (c.b.slotId === occurrence.slotId && c.b.date === occurrence.date),
      );
      out.push({
        kind: 'occurrence',
        key: `${occurrence.slotId}|${occurrence.date}`,
        occurrence,
        conflicts,
      });
    }
    visibleShows.forEach((show, i) => {
      for (const slot of slotLists[i]?.data?.items ?? []) {
        for (const ex of slot.exceptions) {
          if (ex.kind !== 'cancelled') continue;
          const startsAt = zonedInstant(ex.date, slot.rule.time, tz);
          const endsAt = new Date(startsAt.getTime() + slot.durationMs);
          if (endsAt <= from || startsAt >= to) continue;
          out.push({
            kind: 'cancelled',
            key: `${slot.id}|${ex.date}|cancelled`,
            entry: {
              showId: show.id,
              showName: show.name,
              slotId: slot.id,
              date: ex.date,
              startsAt,
              endsAt,
            },
          });
        }
      }
    });
    return out.sort((a, b) => startOf(a).getTime() - startOf(b).getTime());
  })();

  const slotShowNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const o of occurrences.data?.occurrences ?? []) names.set(o.slotId, o.show.name);
    return names;
  }, [occurrences.data]);

  const [selection, setSelection] = useState<CalendarSelection>(null);
  const conflictCount = occurrences.data?.conflicts.length ?? 0;

  const go = (patch: { view?: CalendarView; date?: LocalDate; show?: string | undefined }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const step = (dir: 1 | -1) => {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number) as [number, number];
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      go({ date: d.toISOString().slice(0, 10) });
    } else {
      go({ date: addDays(anchor, 7 * dir) });
    }
  };

  const heading =
    view === 'month'
      ? formatMonth(anchor, locale)
      : `${formatDay(days[0] ?? anchor, locale)} – ${formatDay(days[6] ?? anchor, locale, { year: 'numeric' })}`;

  const select = (e: Entry) =>
    setSelection(
      e.kind === 'occurrence'
        ? { kind: 'occurrence', occurrence: e.occurrence, conflicts: e.conflicts }
        : { kind: 'cancelled', entry: e.entry },
    );
  // Keep the open dialog on fresh data after a write.
  useEffect(() => {
    if (selection?.kind !== 'occurrence') return;
    const fresh = entries.find(
      (e) =>
        e.kind === 'occurrence' &&
        e.occurrence.slotId === selection.occurrence.slotId &&
        e.occurrence.date === selection.occurrence.date,
    );
    if (fresh?.kind === 'occurrence' && fresh.occurrence !== selection.occurrence) {
      setSelection({
        kind: 'occurrence',
        occurrence: fresh.occurrence,
        conflicts: fresh.conflicts,
      });
    }
  }, [entries, selection]);

  const canEdit = (showId: string) => {
    const show = showMap.get(showId);
    return show ? access.canEdit(show) : false;
  };

  return (
    // `contain`: the shell's flex layout would otherwise widen the page to the grid's min width.
    // The week view fills the window under the shell's 3rem header; its grid scrolls inside.
    <div
      className={cn(
        'flex min-w-0 flex-col gap-4 p-4 [contain:inline-size] sm:p-6',
        view === 'week' && 'h-[calc(100svh-3rem)] min-h-[32rem]',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold">{t('calendar.title')}</h1>
          <p className="text-muted-foreground">{t('upcoming.timezone', { timezone: tz })}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <NativeSelect
            size="sm"
            aria-label={t('calendar.filter')}
            value={search.show ?? ''}
            onChange={(e) => go({ show: e.target.value || undefined })}
          >
            <NativeSelectOption value="">{t('calendar.allShows')}</NativeSelectOption>
            {shows.data?.items.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <fieldset className="flex" aria-label={t('calendar.view')}>
            {calendarViews.map((v) => (
              <Button
                key={v}
                size="sm"
                variant={v === view ? 'default' : 'outline'}
                aria-pressed={v === view}
                onClick={() => go({ view: v })}
              >
                {t(`calendar.${v}`)}
              </Button>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t('calendar.previous')}
          onClick={() => step(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button size="sm" variant="outline" onClick={() => go({ date: undefined })}>
          {t('calendar.today')}
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t('calendar.next')}
          onClick={() => step(1)}
        >
          <ChevronRightIcon />
        </Button>
        <h2 className="font-heading font-semibold first-letter:uppercase">{heading}</h2>
        {occurrences.isFetching && <Spinner className="ml-auto" />}
      </div>

      {conflictCount > 0 && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('conflict.title', { count: conflictCount })}</AlertTitle>
          <AlertDescription>
            {occurrences.data?.conflicts.map((c) => (
              <p key={`${c.a.slotId}|${c.a.date}|${c.b.slotId}|${c.b.date}`}>
                {t('conflict.line', {
                  a: slotShowNames.get(c.a.slotId) ?? '?',
                  b: slotShowNames.get(c.b.slotId) ?? '?',
                  when: `${formatDay(localDateOf(c.startsAt, tz), locale)} ${formatTime(c.startsAt, tz, locale)}`,
                  duration: formatDuration(c.overlapMs),
                })}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {occurrences.isError ? (
        <FormAlert error={occurrences.error} />
      ) : occurrences.isPending ? (
        <Spinner />
      ) : view === 'week' ? (
        <WeekGrid
          stationId={stationId}
          days={days}
          today={today}
          entries={entries}
          shows={showMap}
          timezone={tz}
          canManage={access.canManage}
          canEdit={canEdit}
          onSelect={select}
        />
      ) : view === 'month' ? (
        <MonthGrid
          days={days}
          month={anchor.slice(0, 7)}
          today={today}
          entries={entries}
          shows={showMap}
          timezone={tz}
          onSelect={select}
        />
      ) : (
        <ListView
          days={days}
          today={today}
          entries={entries}
          shows={showMap}
          timezone={tz}
          onSelect={select}
        />
      )}
      {view === 'week' &&
        (access.canManage || shows.data?.items.some((s) => access.canEdit(s))) && (
          <p className="text-muted-foreground">
            {access.canManage ? t('calendar.dragHelp') : t('calendar.dropHelp')}
          </p>
        )}

      <OccurrenceDialog
        stationId={stationId}
        selection={selection}
        onClose={() => setSelection(null)}
        timezone={tz}
        canManage={access.canManage}
        canEdit={canEdit}
        showNames={slotShowNames}
      />
    </div>
  );
}

// --- Entry block --------------------------------------------------------------------------

function EntryLabel({
  entry,
  timezone,
  compact,
}: {
  entry: Entry;
  timezone: string;
  compact?: boolean;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const time = formatTime(startOf(entry), timezone, locale);
  if (entry.kind === 'cancelled') {
    return (
      <>
        <span className="tabular-nums">{time}</span>{' '}
        <span className="line-through">{entry.entry.showName}</span>{' '}
        <span className="text-muted-foreground">({t('occurrence.cancelled')})</span>
      </>
    );
  }
  const o = entry.occurrence;
  return (
    <>
      <span className="tabular-nums">{time}</span>{' '}
      <span className="font-medium">{o.show.name}</span>
      {o.type === 'live' && (
        <RadioIcon className="ml-1 inline size-3" role="img" aria-label={t('type.live')} />
      )}
      {entry.conflicts.length > 0 && (
        <CircleAlertIcon
          className="ml-1 inline size-3 text-destructive"
          role="img"
          aria-label={t('conflict.label')}
        />
      )}
      {!compact && (
        <span className="block truncate text-muted-foreground">
          {o.episode
            ? `${t('episode.label', { number: o.episode.number })} · ${t(`status.${o.episode.status}`)}`
            : o.type === 'rerun'
              ? t('type.rerun')
              : t('calendar.noEpisode')}
          {o.moved && ` · ${t('occurrence.moved')}`}
        </span>
      )}
    </>
  );
}

/** Entry status as a dot colour: what still needs doing shows at a glance. */
function statusTone(entry: Entry): string {
  if (entry.kind === 'cancelled') return 'bg-muted-foreground/40';
  const o = entry.occurrence;
  if (o.type === 'rerun') return 'bg-muted-foreground';
  if (!o.episode) return 'bg-amber-500';
  if (o.episode.status === 'missing') return 'bg-destructive';
  if (o.episode.status === 'planned' && o.episode.kind === 'prerecorded') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function EntryButton({
  entry,
  shows,
  timezone,
  onSelect,
  className,
  style,
  compact,
  children,
  ...rest
}: {
  entry: Entry;
  shows: Map<string, Show>;
  timezone: string;
  onSelect(entry: Entry): void;
  className?: string;
  style?: React.CSSProperties;
  compact?: boolean;
  children?: ReactNode;
} & Omit<React.ComponentProps<'button'>, 'onSelect'>) {
  const colour = colourOf(entry, shows);
  const conflict = entry.kind === 'occurrence' && entry.conflicts.length > 0;
  return (
    <button
      type="button"
      data-testid="calendar-entry"
      onClick={() => onSelect(entry)}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-md border-l-4 bg-card px-1.5 py-0.5 text-left text-[0.7rem] leading-tight hover:bg-muted',
        entry.kind === 'cancelled' && 'border-dashed opacity-60',
        conflict && 'ring-2 ring-destructive',
        className,
      )}
      style={{ borderLeftColor: colour ?? 'var(--border)', ...style }}
      {...rest}
    >
      <span className="flex items-start gap-1">
        <span
          aria-hidden
          className={cn('mt-1 size-1.5 shrink-0 rounded-full', statusTone(entry))}
        />
        <span className="min-w-0 flex-1 truncate">
          <EntryLabel entry={entry} timezone={timezone} compact={compact} />
        </span>
      </span>
      {children}
    </button>
  );
}

// --- Week ---------------------------------------------------------------------------------

interface Segment {
  entry: Entry;
  top: number;
  bottom: number;
  lane: number;
  lanes: number;
}

/** The parts of `entries` on `day`, laid out side by side where they overlap. */
function daySegments(entries: Entry[], day: LocalDate, timezone: string): Segment[] {
  const dayStart = zonedInstant(day, '00:00', timezone);
  const dayEnd = zonedInstant(addDays(day, 1), '00:00', timezone);
  const segments: Segment[] = [];
  for (const entry of entries) {
    const start = startOf(entry);
    const end = endOf(entry);
    if (start >= dayEnd || end <= dayStart) continue;
    const top = start <= dayStart ? 0 : wallMinutes(start, timezone);
    const bottom = end >= dayEnd ? 1440 : wallMinutes(end, timezone) || 1440;
    segments.push({ entry, top, bottom: Math.max(bottom, top + SNAP_MIN), lane: 0, lanes: 1 });
  }
  segments.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: Segment[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((s) => s.lane + 1));
    for (const s of cluster) s.lanes = lanes;
  };
  for (const s of segments) {
    if (s.top >= clusterEnd && cluster.length) {
      close();
      cluster = [];
    }
    const used = new Set(cluster.filter((c) => c.bottom > s.top).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane += 1;
    s.lane = lane;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.bottom);
  }
  if (cluster.length) close();
  return segments;
}

function WeekGrid({
  stationId,
  days,
  today,
  entries,
  shows,
  timezone,
  canManage,
  canEdit,
  onSelect,
}: {
  stationId: string;
  days: LocalDate[];
  today: LocalDate;
  entries: Entry[];
  shows: Map<string, Show>;
  timezone: string;
  canManage: boolean;
  canEdit(showId: string): boolean;
  onSelect(entry: Entry): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const showError = useShowError();
  const queryClient = useQueryClient();
  const upload = useEpisodeUpload(stationId);
  const detachedNotice = useDetachedNotice(stationId);
  const scroller = useRef<HTMLDivElement>(null);
  const [fileTarget, setFileTarget] = useState<string | null>(null);

  useEffect(() => {
    // Open on the morning, not at midnight.
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, []);

  const dropMove = async (event: DragEvent<HTMLDivElement>, day: LocalDate) => {
    const raw = event.dataTransfer.getData(OCCURRENCE_MIME);
    if (!raw) return;
    event.preventDefault();
    const drag = JSON.parse(raw) as {
      showId: string;
      slotId: string;
      date: string;
      grabMin: number;
    };
    const rect = event.currentTarget.getBoundingClientRect();
    const rawMin = ((event.clientY - rect.top) / HOUR_PX) * 60 - (drag.grabMin || 0);
    // No pointer position (some synthetic drops): nothing sensible to move to.
    if (!Number.isFinite(rawMin)) return;
    const minutes = Math.min(
      1440 - SNAP_MIN,
      Math.max(0, Math.round(rawMin / SNAP_MIN) * SNAP_MIN),
    );
    if (Math.abs(daysBetween(drag.date, day)) > SLOT_MAX_MOVE_DAYS) {
      toast.error(t('occurrence.tooFar', { days: SLOT_MAX_MOVE_DAYS }));
      return;
    }
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    try {
      const result = await showsApi.putException(stationId, drag.showId, drag.slotId, drag.date, {
        kind: 'moved',
        startDate: day,
        startTime: time,
        durationMs: null,
      });
      toast.success(t('occurrence.movedTo', { when: `${formatDay(day, locale)} ${time}` }));
      detachedNotice(drag.showId, result.detachedEpisodeIds);
    } catch (error) {
      toast.error(showError(error));
    } finally {
      await invalidateShows(queryClient, stationId);
    }
  };

  const fileDropProps = (entry: Entry) => {
    if (entry.kind !== 'occurrence') return {};
    const o = entry.occurrence;
    const accepts =
      canEdit(o.show.id) &&
      o.type !== 'rerun' &&
      (o.episode ? o.episode.kind === 'prerecorded' : o.type === 'prerecorded');
    if (!accepts) return {};
    return {
      onDragOver: (e: DragEvent<HTMLButtonElement>) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setFileTarget(entry.key);
      },
      onDragLeave: () => setFileTarget((k) => (k === entry.key ? null : k)),
      onDrop: (e: DragEvent<HTMLButtonElement>) => {
        const file = e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        setFileTarget(null);
        void upload(
          o.episode
            ? { showId: o.show.id, episodeId: o.episode.id }
            : { showId: o.show.id, slotId: o.slotId, occurrenceDate: o.date },
          file,
        );
      },
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <div className="flex min-h-0 min-w-[48rem] flex-1 flex-col">
        <div className="grid grid-cols-[3rem_repeat(7,1fr)] border-b">
          <span />
          {days.map((day) => (
            <span
              key={day}
              className={cn(
                'px-1 py-2 text-center font-medium first-letter:uppercase',
                day === today && 'text-primary',
              )}
            >
              {formatDay(day, locale)}
            </span>
          ))}
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="relative grid grid-cols-[3rem_repeat(7,1fr)]"
            style={{ height: 24 * HOUR_PX }}
          >
            <div className="relative">
              {Array.from({ length: 24 }, (_, h) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: hours are fixed.
                  key={h}
                  className="absolute right-1 -translate-y-1/2 text-[0.65rem] text-muted-foreground tabular-nums"
                  style={{ top: h * HOUR_PX }}
                >
                  {h > 0 ? `${String(h).padStart(2, '0')}:00` : ''}
                </span>
              ))}
            </div>
            {days.map((day) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the airing's dialog moves it from the keyboard.
              <div
                key={day}
                data-testid={`day-${day}`}
                className={cn('relative border-l', day === today && 'bg-primary/5')}
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--border) ${HOUR_PX - 1}px, var(--border) ${HOUR_PX}px)`,
                }}
                onDragOver={(e) => {
                  if (canManage && e.dataTransfer.types.includes(OCCURRENCE_MIME))
                    e.preventDefault();
                }}
                onDrop={(e) => void dropMove(e, day)}
              >
                {daySegments(entries, day, timezone).map((s) => {
                  const draggable = canManage && s.entry.kind === 'occurrence';
                  return (
                    <EntryButton
                      key={s.entry.key}
                      entry={s.entry}
                      shows={shows}
                      timezone={timezone}
                      onSelect={onSelect}
                      compact={s.bottom - s.top < 45}
                      className={cn(
                        'absolute',
                        fileTarget === s.entry.key && 'bg-primary/10 ring-2 ring-primary',
                      )}
                      style={{
                        top: (s.top / 60) * HOUR_PX,
                        height: ((s.bottom - s.top) / 60) * HOUR_PX - 2,
                        left: `calc(${(s.lane / s.lanes) * 100}% + 2px)`,
                        width: `calc(${100 / s.lanes}% - 4px)`,
                      }}
                      draggable={draggable}
                      onDragStart={
                        draggable && s.entry.kind === 'occurrence'
                          ? (e) => {
                              const o = (s.entry as Extract<Entry, { kind: 'occurrence' }>)
                                .occurrence;
                              const rect = e.currentTarget.getBoundingClientRect();
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData(
                                OCCURRENCE_MIME,
                                JSON.stringify({
                                  showId: o.show.id,
                                  slotId: o.slotId,
                                  date: o.date,
                                  grabMin: ((e.clientY - rect.top) / HOUR_PX) * 60,
                                }),
                              );
                            }
                          : undefined
                      }
                      {...fileDropProps(s.entry)}
                    >
                      {fileTarget === s.entry.key && (
                        <span className="flex items-center gap-1 text-primary">
                          <UploadIcon className="size-3" />
                          {t('calendar.dropFile')}
                        </span>
                      )}
                    </EntryButton>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Month --------------------------------------------------------------------------------

function MonthGrid({
  days,
  month,
  today,
  entries,
  shows,
  timezone,
  onSelect,
}: {
  days: LocalDate[];
  month: string;
  today: LocalDate;
  entries: Entry[];
  shows: Map<string, Show>;
  timezone: string;
  onSelect(entry: Entry): void;
}) {
  const { locale } = useI18n();
  const byDay = groupByDay(entries, timezone);
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <div className="grid min-w-[48rem] grid-cols-7">
        {days.slice(0, 7).map((day) => (
          <span
            key={day}
            className="border-b px-2 py-1 text-center font-medium first-letter:uppercase"
          >
            {new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' }).format(
              new Date(`${day}T12:00:00Z`),
            )}
          </span>
        ))}
        {days.map((day) => (
          <div
            key={day}
            data-testid={`day-${day}`}
            className={cn(
              'flex min-h-28 flex-col gap-0.5 border-b border-l p-1',
              !day.startsWith(month) && 'bg-muted/40 text-muted-foreground',
            )}
          >
            <span
              className={cn('text-right tabular-nums', day === today && 'font-bold text-primary')}
            >
              {Number(day.slice(8))}
            </span>
            {(byDay.get(day) ?? []).map((entry) => (
              <EntryButton
                key={entry.key}
                entry={entry}
                shows={shows}
                timezone={timezone}
                onSelect={onSelect}
                compact
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- List ---------------------------------------------------------------------------------

function ListView({
  days,
  today,
  entries,
  shows,
  timezone,
  onSelect,
}: {
  days: LocalDate[];
  today: LocalDate;
  entries: Entry[];
  shows: Map<string, Show>;
  timezone: string;
  onSelect(entry: Entry): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const byDay = groupByDay(entries, timezone);
  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => (
        <section key={day} data-testid={`day-${day}`} className="flex flex-col gap-1">
          <h3 className={cn('font-medium first-letter:uppercase', day === today && 'text-primary')}>
            {formatDay(day, locale, { weekday: 'long' })}
          </h3>
          {(byDay.get(day) ?? []).length === 0 ? (
            <p className="text-muted-foreground">{t('calendar.nothing')}</p>
          ) : (
            (byDay.get(day) ?? []).map((entry) => (
              <EntryButton
                key={entry.key}
                entry={entry}
                shows={shows}
                timezone={timezone}
                onSelect={onSelect}
                className="py-2 text-xs"
              />
            ))
          )}
        </section>
      ))}
    </div>
  );
}

/** Entries by the local date they start on. */
function groupByDay(entries: Entry[], timezone: string) {
  const byDay = new Map<LocalDate, Entry[]>();
  for (const entry of entries) {
    const day = localDateOf(startOf(entry), timezone);
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }
  return byDay;
}
