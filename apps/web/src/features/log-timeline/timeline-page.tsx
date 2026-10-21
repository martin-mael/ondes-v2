import {
  type Asset,
  addDays,
  type LocalDate,
  type LogEditResult,
  type LogItem,
  type LogPlacement,
  rolePermissions,
} from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CrosshairIcon,
  PlusIcon,
  RadioIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert, useErrorMessage } from '../../app/forms.tsx';
import { asRunDayQuery, assetDetailQuery, logDayQuery, logKey, timelineApi } from './api.ts';
import { AssetPickerDialog, INSERT_KINDS, isPickKind, type PickKind } from './asset-picker.tsx';
import { DayStrip } from './day-strip.tsx';
import { type ItemAction, ItemRow, itemTitle } from './item-row.tsx';
import { type TimelineMessageKey, type TimelineT, useTimelineT } from './messages.ts';
import {
  asRunByItem,
  groupByHour,
  type HourGroup,
  isFrozen,
  itemState,
  onAirItem,
  showBlocks,
  slotMs,
  startMs,
} from './model.ts';
import { PreviewBar, PreviewProvider, usePreview } from './preview.tsx';
import {
  dayBounds,
  dayHours,
  formatClock,
  formatDuration,
  formatOffset,
  stationDate,
} from './time.ts';
import { useNow, useTimelineLive } from './use-live.ts';

// The log timeline (#51): the station's main programming screen. One station-local day at a
// time, as a zoomable strip and a list grouped by hour, with the on-air item highlighted live
// (as-run + feeder events) and edits through the log api (#100). Aired and on-air items are
// read-only; edits to the items queued in the engine reach air through the feeder's re-plan.

const route = getRouteApi('/_app/stations/$stationId/log');

type Editing =
  | { type: 'insert'; placement: LogPlacement; kind: PickKind }
  | { type: 'replace'; item: LogItem }
  | { type: 'delete'; item: LogItem }
  | null;

const EDIT_ERRORS: Partial<Record<string, TimelineMessageKey>> = {
  log_item_locked: 'error.log_item_locked',
  segment_part: 'error.segment_part',
  edit_conflict: 'error.edit_conflict',
  invalid_placement: 'error.invalid_placement',
};

export function TimelinePage() {
  const { stationId } = route.useParams();
  return (
    <PreviewProvider stationId={stationId}>
      <Timeline />
    </PreviewProvider>
  );
}

function Timeline() {
  const t = useTimelineT();
  const errorMessage = useErrorMessage();
  const { stationId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const station = findStation(useOrgs(), stationId)?.station;
  const timeZone = station?.timezone ?? 'UTC';
  const permissions = station ? rolePermissions[station.role] : [];
  const canWrite = permissions.includes('log:write');
  const canListen = permissions.includes('library:read');
  const queryClient = useQueryClient();
  const preview = usePreview();

  const now = useNow();
  const today = stationDate(now, timeZone);
  const date: LocalDate = search.date ?? today;
  const live = { now, ...useTimelineLive(stationId, date, timeZone) };
  const { start: dayStart, end: dayEnd } = dayBounds(date, timeZone);

  const log = useQuery(logDayQuery(stationId, date, timeZone));
  const asRun = useQuery(asRunDayQuery(stationId, date));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  const items = useMemo(
    () => (log.data?.items ?? []).filter((i) => startMs(i) >= dayStart && startMs(i) < dayEnd),
    [log.data, dayStart, dayEnd],
  );
  const hours = useMemo(() => dayHours(date, timeZone), [date, timeZone]);
  const groups = useMemo(() => groupByHour(items, hours), [items, hours]);
  const blocks = useMemo(() => showBlocks(items), [items]);
  const entries = asRun.data ?? [];
  const aired = useMemo(() => asRunByItem(entries), [entries]);
  const onAir = onAirItem(log.data?.items ?? [], entries, live.now);
  const day = log.data?.days.find((d) => d.localDate === date) ?? null;
  const stateOf = (item: LogItem) =>
    itemState(item, { now: live.now, onAirId: onAir?.itemId ?? null, aired });

  const setDate = (next: LocalDate) =>
    void navigate({ search: (s) => ({ ...s, date: next === today ? undefined : next }) });

  const reveal = (itemId: string) => {
    setSelected(itemId);
    document
      .getElementById(`log-item-${itemId}`)
      ?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  };
  const revealHour = (hourStart: number) =>
    document.getElementById(`log-hour-${hourStart}`)?.scrollIntoView?.({ block: 'start' });

  // Opening today lands on what's on air (once per day shown).
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!log.isSuccess || landed.current === date || date !== today) return;
    landed.current = date;
    const target = onAir?.itemId ?? items.find((i) => startMs(i) >= live.now)?.id;
    if (target) {
      requestAnimationFrame(() =>
        document
          .getElementById(`log-item-${target}`)
          ?.scrollIntoView?.({ block: 'center', inline: 'nearest' }),
      );
    }
  }, [log.isSuccess, date, today, onAir?.itemId, items, live.now]);

  const done = (key: TimelineMessageKey, result: LogEditResult, touchesAir: boolean) => {
    for (const d of result.days) {
      void queryClient.invalidateQueries({ queryKey: [...logKey(stationId), d.localDate] });
    }
    toast.success(t(key), touchesAir ? { description: t('toast.onAir') } : undefined);
  };
  const failed = (error: unknown) => {
    const key = isApiError(error) ? EDIT_ERRORS[error.code] : undefined;
    toast.error(key ? t(key) : errorMessage(error));
    if (isApiError(error, 'edit_conflict')) {
      void queryClient.invalidateQueries({ queryKey: logKey(stationId) });
    }
  };
  const nearAir = (item: LogItem | undefined) => !!item && stateOf(item) === 'queued';

  const edit = useMutation({
    mutationFn: async (
      op:
        | { type: 'insert'; placement: LogPlacement; kind: PickKind; asset: Asset }
        | { type: 'replace'; item: LogItem; kind: PickKind; asset: Asset }
        | { type: 'move'; item: LogItem; placement: LogPlacement }
        | { type: 'lock'; item: LogItem; locked: boolean }
        | { type: 'delete'; item: LogItem },
    ) => {
      switch (op.type) {
        case 'insert':
        case 'replace': {
          const detail = await queryClient.fetchQuery(assetDetailQuery(stationId, op.asset.id));
          const body = {
            kind: op.kind,
            assetId: op.asset.id,
            plannedDurationMs: slotMs(op.asset.durationMs, detail.cues),
          };
          if (op.type === 'insert') {
            return timelineApi.insert(stationId, { placement: op.placement, item: body });
          }
          // A replacement keeps the item's place, timing and lock.
          const { timing, anchorAt, capMs, locked } = op.item;
          return timelineApi.replace(stationId, op.item.id, {
            ...body,
            timing,
            anchorAt,
            capMs,
            locked,
          });
        }
        case 'move':
          return timelineApi.move(stationId, op.item.id, op.placement);
        case 'lock':
          return timelineApi.lock(stationId, op.item.id, op.locked);
        case 'delete':
          return timelineApi.remove(stationId, op.item.id);
      }
    },
    onSuccess: (result, op) => {
      setEditing(null);
      const key: TimelineMessageKey =
        op.type === 'insert'
          ? 'toast.inserted'
          : op.type === 'replace'
            ? 'toast.replaced'
            : op.type === 'move'
              ? 'toast.moved'
              : op.type === 'lock'
                ? op.locked
                  ? 'toast.locked'
                  : 'toast.unlocked'
                : 'toast.deleted';
      const item = 'item' in op ? op.item : undefined;
      done(key, result, nearAir(item) || nearAir(result.item ?? undefined));
    },
    onError: failed,
  });

  const status = useMutation({
    mutationFn: (next: 'draft' | 'published') => timelineApi.setStatus(stationId, date, next),
    onSuccess: ({ day: updated }) => {
      void queryClient.invalidateQueries({ queryKey: [...logKey(stationId), date] });
      toast.success(t(updated.status === 'published' ? 'day.published.toast' : 'day.draft.toast'));
    },
    onError: failed,
  });

  const indexOf = (item: LogItem) => items.findIndex((i) => i.id === item.id);
  const onAction = (action: ItemAction, item: LogItem) => {
    const i = indexOf(item);
    const prev = items[i - 1];
    const next = items[i + 1];
    switch (action) {
      case 'preview':
        return preview.play(item);
      case 'previewTransition':
        return next && preview.playTransition(item, next);
      case 'insertBefore':
        return setEditing({ type: 'insert', placement: { before: item.id }, kind: 'song' });
      case 'insertAfter':
        return setEditing({ type: 'insert', placement: { after: item.id }, kind: 'song' });
      case 'replace':
        return setEditing({ type: 'replace', item });
      case 'moveUp':
        return prev && edit.mutate({ type: 'move', item, placement: { before: prev.id } });
      case 'moveDown':
        return next && edit.mutate({ type: 'move', item, placement: { after: next.id } });
      case 'lock':
      case 'unlock':
        return edit.mutate({ type: 'lock', item, locked: action === 'lock' });
      case 'delete':
        return setEditing({ type: 'delete', item });
    }
  };
  const onDropItem = (draggedId: string, target: LogItem, where: 'before' | 'after') => {
    const dragged = items.find((i) => i.id === draggedId);
    if (!dragged || isFrozen(stateOf(dragged))) return;
    edit.mutate({
      type: 'move',
      item: dragged,
      placement: where === 'before' ? { before: target.id } : { after: target.id },
    });
  };

  const totalMs = items.reduce((sum, i) => sum + i.plannedDurationMs, 0);
  const nextUp = onAir ? items[items.findIndex((i) => i.id === onAir.itemId) + 1] : undefined;
  const onAirLog = onAir ? (log.data?.items ?? []).find((i) => i.id === onAir.itemId) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            aria-label={t('nav.previousDay')}
            onClick={() => setDate(addDays(date, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Input
            type="date"
            className="w-36"
            aria-label={t('nav.date')}
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <Button
            size="icon"
            variant="outline"
            aria-label={t('nav.nextDay')}
            onClick={() => setDate(addDays(date, 1))}
          >
            <ChevronRightIcon />
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              landed.current = null;
              if (date !== today) setDate(today);
              else if (onAir) reveal(onAir.itemId);
            }}
          >
            <CrosshairIcon data-icon="inline-start" />
            {t('nav.now')}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {day && (
          <Badge variant={day.status === 'published' ? 'default' : 'outline'}>
            {t(day.status === 'published' ? 'day.published' : 'day.draft')}
          </Badge>
        )}
        {day?.status === 'draft' && (
          <span className="text-muted-foreground">{t('day.draftHint')}</span>
        )}
        {items.length > 0 && (
          <span className="text-muted-foreground">
            {t('day.summary', { count: items.length, duration: formatDuration(totalMs) })}
          </span>
        )}
        <span className="text-muted-foreground">
          {t('timezone', { zone: `${timeZone}, ${formatOffset(dayStart, timeZone)}` })}
        </span>
        {canWrite && day && (
          <Button
            className="ml-auto"
            size="sm"
            variant={day.status === 'published' ? 'outline' : 'default'}
            disabled={status.isPending}
            onClick={() => status.mutate(day.status === 'published' ? 'draft' : 'published')}
          >
            {t(day.status === 'published' ? 'day.unpublish' : 'day.publish')}
          </Button>
        )}
      </div>

      {date === today && (
        <OnAirCard
          t={t}
          timeZone={timeZone}
          item={onAirLog}
          source={onAir?.source ?? null}
          startedAt={onAir?.entry?.startedAt ?? onAirLog?.plannedStart ?? null}
          next={nextUp}
          onShow={reveal}
        />
      )}

      {log.isPending ? (
        <Spinner />
      ) : log.isError ? (
        isApiError(log.error, 'forbidden') ? (
          <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
        ) : (
          <FormAlert error={log.error} />
        )
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            {t('day.empty')}
            {canWrite && (
              <Button
                onClick={() =>
                  setEditing({ type: 'insert', placement: { localDate: date }, kind: 'song' })
                }
              >
                <PlusIcon data-icon="inline-start" />
                {t('day.addFirst')}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <DayStrip
            items={items}
            hours={hours}
            dayStart={dayStart}
            dayEnd={dayEnd}
            now={live.now}
            timeZone={timeZone}
            onAirId={onAir?.itemId ?? null}
            blocks={blocks}
            onSelect={(item) => reveal(item.id)}
          />
          <nav aria-label={t('nav.hour')} className="flex flex-wrap gap-1">
            {groups.map((g) => (
              <Button
                key={g.start}
                size="xs"
                variant={live.now >= g.start && live.now < g.end ? 'secondary' : 'ghost'}
                onClick={() => revealHour(g.start)}
              >
                {g.label}
              </Button>
            ))}
          </nav>
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <HourSection key={group.start} group={group} t={t} now={live.now}>
                {group.items.map((item) => {
                  const i = indexOf(item);
                  const prev = items[i - 1];
                  const next = items[i + 1];
                  const prevFrozen = prev ? isFrozen(stateOf(prev)) : false;
                  return (
                    <ItemRow
                      key={item.id}
                      item={item}
                      t={t}
                      timeZone={timeZone}
                      state={stateOf(item)}
                      aired={aired.get(item.id)}
                      passedOver={live.passedOver.get(item.id)}
                      block={blocks.get(item.id)}
                      selected={selected === item.id}
                      canWrite={canWrite}
                      canListen={canListen}
                      canInsertBefore={!prevFrozen}
                      canMoveUp={!!prev && !prevFrozen}
                      canMoveDown={!!next}
                      next={next}
                      onAction={onAction}
                      onDropItem={onDropItem}
                    />
                  );
                })}
              </HourSection>
            ))}
          </div>
          {canWrite && (
            <Button
              className="self-start"
              variant="outline"
              onClick={() =>
                setEditing({ type: 'insert', placement: { localDate: date }, kind: 'song' })
              }
            >
              <PlusIcon data-icon="inline-start" />
              {t('day.addEnd')}
            </Button>
          )}
        </>
      )}

      <AssetPickerDialog
        stationId={stationId}
        open={editing?.type === 'insert' || editing?.type === 'replace'}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          editing?.type === 'replace'
            ? t('picker.replaceTitle', { title: itemTitle(t, editing.item) })
            : t('picker.insertTitle')
        }
        initialKind={
          editing?.type === 'replace' && isPickKind(editing.item.kind) ? editing.item.kind : 'song'
        }
        kinds={
          editing?.type === 'replace' &&
          isPickKind(editing.item.kind) &&
          !(INSERT_KINDS as readonly string[]).includes(editing.item.kind)
            ? [editing.item.kind]
            : INSERT_KINDS
        }
        targetMs={editing?.type === 'replace' ? editing.item.plannedDurationMs : undefined}
        exclude={editing?.type === 'replace' ? editing.item.assetId : null}
        pending={edit.isPending}
        onPick={(asset, kind) => {
          if (editing?.type === 'insert') {
            edit.mutate({ type: 'insert', placement: editing.placement, kind, asset });
          } else if (editing?.type === 'replace') {
            edit.mutate({ type: 'replace', item: editing.item, kind, asset });
          }
        }}
      />

      <Dialog open={editing?.type === 'delete'} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete.title')}</DialogTitle>
            <DialogDescription>
              {editing?.type === 'delete' &&
                t('delete.description', { title: itemTitle(t, editing.item) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={edit.isPending}
              onClick={() => editing?.type === 'delete' && edit.mutate(editing)}
            >
              {t('delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PreviewBar />
    </div>
  );
}

function HourSection({
  group,
  t,
  now,
  children,
}: {
  group: HourGroup;
  t: TimelineT;
  now: number;
  children: React.ReactNode;
}) {
  const current = now >= group.start && now < group.end;
  return (
    <section
      id={`log-hour-${group.start}`}
      aria-label={group.label}
      className={`scroll-mt-4 rounded-md border ${current ? 'border-primary/50' : ''}`}
    >
      <h2 className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <span className="font-semibold tabular-nums">{group.label}</span>
        <span className="text-muted-foreground">
          {t('hour.total', { duration: formatDuration(group.contentMs) })}
        </span>
        {group.overrunMs > 0 && (
          <Badge variant="destructive">
            {t('hour.overrun', { duration: formatDuration(group.overrunMs) })}
          </Badge>
        )}
        {group.gapMs > 0 && (
          <Badge variant="destructive">
            {t('hour.gap', { duration: formatDuration(group.gapMs) })}
          </Badge>
        )}
        {group.relaxed > 0 && (
          <Badge variant="outline">{t('hour.relaxed', { count: group.relaxed })}</Badge>
        )}
      </h2>
      {group.items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('hour.empty')}</p>
      ) : (
        <ol className="flex flex-col divide-y">{children}</ol>
      )}
    </section>
  );
}

function OnAirCard({
  t,
  timeZone,
  item,
  source,
  startedAt,
  next,
  onShow,
}: {
  t: TimelineT;
  timeZone: string;
  item: LogItem | undefined;
  source: 'asrun' | 'plan' | null;
  startedAt: string | null;
  next: LogItem | undefined;
  onShow(itemId: string): void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <RadioIcon className="size-4 text-primary" aria-hidden />
        <span className="font-semibold">{t('onAir.title')}</span>
        {item ? (
          <>
            <span className="truncate">
              {itemTitle(t, item)}
              {item.asset?.artists.length ? (
                <span className="text-muted-foreground"> · {item.asset.artists.join(', ')}</span>
              ) : null}
            </span>
            {startedAt && (
              <span className="text-muted-foreground tabular-nums">
                {t('onAir.started', { time: formatClock(startedAt, timeZone) })}
              </span>
            )}
            {source === 'plan' && <Badge variant="outline">{t('onAir.plan')}</Badge>}
            <Button size="xs" variant="ghost" onClick={() => onShow(item.id)}>
              {t('onAir.jump')}
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">{t('onAir.none')}</span>
        )}
        {next && (
          <span className="ml-auto text-muted-foreground">
            {t('onAir.next', {
              title: itemTitle(t, next),
              time: formatClock(next.plannedStart, timeZone, false),
            })}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
