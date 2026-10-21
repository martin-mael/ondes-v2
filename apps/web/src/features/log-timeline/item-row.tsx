import type { AsRunEntry, LogItem, LogSegmentPart } from '@ondes/shared';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BetweenHorizontalEndIcon,
  BetweenHorizontalStartIcon,
  EllipsisVerticalIcon,
  LockIcon,
  LockOpenIcon,
  PlayIcon,
  RadioIcon,
  RefreshCwIcon,
  Trash2Icon,
  WavesIcon,
} from 'lucide-react';
import type { DragEvent } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { KIND_COLORS } from './day-strip.tsx';
import type { TimelineT } from './messages.ts';
import { type ItemState, isAssetKind, isFrozen, type ShowBlock } from './model.ts';
import { formatClock, formatDuration, formatSigned } from './time.ts';
import type { PassedOver } from './use-live.ts';

// One log item in the day list (#51): planned and aired start, what it is, its timing and
// state badges, and its actions. Island segments list their parts underneath.

export type ItemAction =
  | 'preview'
  | 'previewTransition'
  | 'insertBefore'
  | 'insertAfter'
  | 'replace'
  | 'moveUp'
  | 'moveDown'
  | 'lock'
  | 'unlock'
  | 'delete';

export const DRAG_TYPE = 'application/x-ondes-log-item';

export function itemTitle(t: TimelineT, item: Pick<LogItem, 'asset' | 'title' | 'kind'>): string {
  return (
    item.asset?.title ?? item.title ?? (item.kind === 'marker' ? t('kind.marker') : t('untitled'))
  );
}

export interface ItemRowProps {
  item: LogItem;
  t: TimelineT;
  timeZone: string;
  state: ItemState;
  aired: AsRunEntry | undefined;
  passedOver: PassedOver | undefined;
  block: ShowBlock | undefined;
  selected: boolean;
  canWrite: boolean;
  canListen: boolean;
  /** The neighbours allow it: nothing goes before an aired or on-air item. */
  canInsertBefore: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The next item, for the transition preview. */
  next: LogItem | undefined;
  onAction(action: ItemAction, item: LogItem): void;
  onDropItem(draggedId: string, target: LogItem, where: 'before' | 'after'): void;
}

export function ItemRow(props: ItemRowProps) {
  const { item, t, timeZone, state, aired, block, selected, canWrite } = props;
  const frozen = isFrozen(state);
  const editable = canWrite && !frozen;
  const title = itemTitle(t, item);
  const artists = item.asset?.artists.join(', ');
  const missing = isAssetKind(item.kind) && item.kind !== 'segment' && !item.asset;

  const onDragOver = (e: DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e: DragEvent<HTMLLIElement>) => {
    const dragged = e.dataTransfer.getData(DRAG_TYPE);
    if (!editable || !dragged || dragged === item.id) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    props.onDropItem(dragged, item, e.clientY < box.top + box.height / 2 ? 'before' : 'after');
  };

  return (
    <li
      id={`log-item-${item.id}`}
      data-state={state}
      aria-current={state === 'on_air' ? 'true' : undefined}
      draggable={editable && !item.locked}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      title={editable && !item.locked ? t('action.dragHint') : undefined}
      className={[
        'group/row relative grid grid-cols-[4.5rem_4.5rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-1.5 text-sm sm:grid-cols-[4.5rem_4.5rem_minmax(0,1fr)_auto_3.5rem_auto]',
        state === 'aired' ? 'text-muted-foreground' : '',
        state === 'on_air' ? 'bg-primary/10 ring-1 ring-primary/40 ring-inset' : '',
        selected ? 'bg-accent' : '',
        block ? 'border-l-4 border-l-indigo-500/70' : 'border-l-4 border-l-transparent',
        block?.first ? 'mt-1' : '',
      ].join(' ')}
    >
      <span className="tabular-nums" title={t('col.planned')}>
        {formatClock(item.plannedStart, timeZone)}
      </span>
      <span className="tabular-nums" title={t('col.actual')}>
        {aired ? (
          <>
            {formatClock(aired.startedAt, timeZone)}
            {aired.driftMs !== null && Math.abs(aired.driftMs) >= 1000 && (
              <span
                className={`block text-[0.625rem] ${Math.abs(aired.driftMs) > 30_000 ? 'text-destructive' : 'text-muted-foreground'}`}
                title={t('drift', { drift: formatSigned(aired.driftMs) })}
              >
                {formatSigned(aired.driftMs)}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`inline-block size-2 shrink-0 rounded-full ${KIND_COLORS[item.kind]}`}
          />
          <span className="text-xs text-muted-foreground">{t(`kind.${item.kind}`)}</span>
          <span className={`truncate font-medium ${missing ? 'text-destructive' : ''}`}>
            {title}
          </span>
          {state === 'on_air' && (
            <Badge>
              <RadioIcon data-icon="inline-start" />
              {t('state.on_air')}
            </Badge>
          )}
        </span>
        {artists && <span className="truncate pl-4 text-xs text-muted-foreground">{artists}</span>}
        {item.kind === 'segment' && <SegmentParts t={t} parts={item.parts} timeZone={timeZone} />}
      </span>
      <ItemBadges {...props} missing={missing} />
      <span className="hidden text-right tabular-nums text-muted-foreground sm:block">
        {formatDuration(item.plannedDurationMs)}
      </span>
      <ItemMenu {...props} title={title} editable={editable} />
    </li>
  );
}

function ItemBadges({
  item,
  t,
  timeZone,
  state,
  aired,
  passedOver,
  block,
  missing,
}: ItemRowProps & { missing: boolean }) {
  return (
    <span className="col-span-2 col-start-3 flex flex-wrap items-center justify-end gap-1 sm:col-span-1 sm:col-start-auto">
      {item.timing !== 'flow' && item.anchorAt && (
        <Badge
          variant="secondary"
          title={
            item.capMs !== null
              ? t('timing.cap', { duration: formatDuration(item.capMs) })
              : undefined
          }
        >
          {t(`timing.${item.timing}`, { time: formatClock(item.anchorAt, timeZone) })}
        </Badge>
      )}
      {item.conflict && (
        <Badge variant="destructive">
          {t(item.conflict.kind === 'overrun' ? 'badge.overrun' : 'badge.gap', {
            duration: formatDuration(item.conflict.ms),
          })}
        </Badge>
      )}
      {item.relaxedRules.length > 0 && (
        <Badge
          variant="outline"
          title={item.relaxedRules
            .map((r) => (r.reason ? `${r.rule}: ${r.reason}` : r.rule))
            .join('\n')}
        >
          {t('badge.relaxed')}
        </Badge>
      )}
      {item.locked && (
        <Badge variant="outline">
          <LockIcon data-icon="inline-start" />
          {t('badge.locked')}
        </Badge>
      )}
      {block?.first && <Badge variant="outline">{t('badge.show')}</Badge>}
      {item.origin.type === 'manual' && <Badge variant="ghost">{t('badge.manual')}</Badge>}
      {missing && <Badge variant="destructive">{t('badge.missing')}</Badge>}
      {state === 'queued' && (
        <Badge variant="secondary" title={t('state.queuedHint')}>
          {t('state.queued')}
        </Badge>
      )}
      {aired?.outcome && aired.outcome !== 'complete' && (
        <Badge variant={aired.outcome === 'skipped' ? 'destructive' : 'outline'}>
          {t(`outcome.${aired.outcome}`)}
        </Badge>
      )}
      {passedOver && !aired && (
        <Badge variant="destructive" title={t(`passedOver.${passedOver.reason}`)}>
          {t('passedOver.title')}
        </Badge>
      )}
    </span>
  );
}

function SegmentParts({
  t,
  parts,
  timeZone,
}: {
  t: TimelineT;
  parts: readonly LogSegmentPart[];
  timeZone: string;
}) {
  return (
    <ul className="mt-1 flex flex-col gap-0.5 border-l pl-3 text-xs text-muted-foreground">
      {parts.map((part) => (
        <li key={part.id} className="flex gap-2">
          <span className="tabular-nums">{formatClock(part.plannedStart, timeZone)}</span>
          <span>{t(`kind.${part.kind}`)}</span>
          <span className="truncate text-foreground/80">{itemTitle(t, part)}</span>
          <span className="ml-auto tabular-nums">{formatDuration(part.plannedDurationMs)}</span>
        </li>
      ))}
    </ul>
  );
}

function ItemMenu({
  item,
  t,
  title,
  editable,
  canListen,
  canInsertBefore,
  canMoveUp,
  canMoveDown,
  next,
  onAction,
}: ItemRowProps & { title: string; editable: boolean }) {
  const audible = item.kind === 'segment' ? item.parts.length > 0 : !!item.assetId;
  const nextAudible = next && (next.kind === 'segment' ? next.parts.length > 0 : !!next.assetId);
  const changeable = editable && !item.locked;
  if (!editable && !(canListen && audible)) return <span className="hidden sm:block" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={t('action.menu', { title })} />}
      >
        <EllipsisVerticalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {canListen && audible && (
          <DropdownMenuItem onClick={() => onAction('preview', item)}>
            <PlayIcon />
            {t('action.preview')}
          </DropdownMenuItem>
        )}
        {canListen && audible && nextAudible && (
          <DropdownMenuItem onClick={() => onAction('previewTransition', item)}>
            <WavesIcon />
            {t('action.previewTransition')}
          </DropdownMenuItem>
        )}
        {!editable ? (
          <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{t('action.frozen')}</p>
        ) : (
          <>
            <DropdownMenuSeparator />
            {canInsertBefore && (
              <DropdownMenuItem onClick={() => onAction('insertBefore', item)}>
                <BetweenHorizontalStartIcon />
                {t('action.insertBefore')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onAction('insertAfter', item)}>
              <BetweenHorizontalEndIcon />
              {t('action.insertAfter')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!changeable || item.kind === 'segment'}
              onClick={() => onAction('replace', item)}
            >
              <RefreshCwIcon />
              {t('action.replace')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!changeable || !canMoveUp}
              onClick={() => onAction('moveUp', item)}
            >
              <ArrowUpIcon />
              {t('action.moveUp')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!changeable || !canMoveDown}
              onClick={() => onAction('moveDown', item)}
            >
              <ArrowDownIcon />
              {t('action.moveDown')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction(item.locked ? 'unlock' : 'lock', item)}>
              {item.locked ? <LockOpenIcon /> : <LockIcon />}
              {t(item.locked ? 'action.unlock' : 'action.lock')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!changeable}
              onClick={() => onAction('delete', item)}
            >
              <Trash2Icon />
              {t('action.delete')}
            </DropdownMenuItem>
            {item.locked && (
              <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                {t('action.lockedHint')}
              </p>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
