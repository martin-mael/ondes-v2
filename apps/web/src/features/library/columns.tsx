import type { LibraryItem, LibrarySort } from '@ondes/shared';
import { CheckIcon, CircleDashedIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import type { Locale } from '../../app/i18n/messages.ts';
import { formatDate, formatDb, formatDuration } from './format.ts';
import type { LibraryMessageKey, LibraryT } from './messages.ts';

// Library table columns (#23). Which ones show is a per-browser preference (filters.ts);
// sortable ones name the api's sort key.

export interface CellContext {
  t: LibraryT;
  locale: Locale;
  now: Date;
}

export interface Column {
  id: string;
  label: LibraryMessageKey;
  /** CSS grid track. */
  width: string;
  sort?: LibrarySort;
  align?: 'right';
  render: (item: LibraryItem, ctx: CellContext) => ReactNode;
}

function validityOf(item: LibraryItem, now: Date) {
  if (item.killAt && item.killAt <= now) return 'expired' as const;
  if (item.startAt && item.startAt > now) return 'future' as const;
  return 'active' as const;
}

const muted = (text: ReactNode) => <span className="text-muted-foreground">{text}</span>;

export const COLUMNS: Column[] = [
  {
    id: 'title',
    label: 'col.title',
    width: 'minmax(14rem, 2fr)',
    sort: 'title',
    render: (item) => (
      <span className="truncate font-medium" title={item.title}>
        {item.title}
        {item.version && muted(` (${item.version})`)}
        {item.explicit && (
          <Badge variant="outline" className="ml-1 px-1 py-0 text-[0.625rem]">
            E
          </Badge>
        )}
      </span>
    ),
  },
  {
    id: 'artist',
    label: 'col.artist',
    width: 'minmax(10rem, 1.5fr)',
    sort: 'artist',
    render: (item) => <span className="truncate">{item.artists.join(', ')}</span>,
  },
  {
    id: 'album',
    label: 'col.album',
    width: 'minmax(8rem, 1fr)',
    sort: 'album',
    render: (item) => <span className="truncate">{item.album}</span>,
  },
  {
    id: 'type',
    label: 'col.type',
    width: '7rem',
    render: (item, { t }) => t(`type.${item.type}`),
  },
  {
    id: 'duration',
    label: 'col.duration',
    width: '5rem',
    sort: 'duration',
    align: 'right',
    render: (item) => <span className="tabular-nums">{formatDuration(item.durationMs)}</span>,
  },
  {
    id: 'year',
    label: 'col.year',
    width: '4.5rem',
    sort: 'year',
    align: 'right',
    render: (item) => <span className="tabular-nums">{item.year}</span>,
  },
  {
    id: 'bpm',
    label: 'col.bpm',
    width: '4.5rem',
    sort: 'bpm',
    align: 'right',
    render: (item) => <span className="tabular-nums">{item.bpm?.toFixed(0)}</span>,
  },
  {
    id: 'key',
    label: 'col.key',
    width: '4.5rem',
    render: (item) => item.musicalKey,
  },
  {
    id: 'tags',
    label: 'col.tags',
    width: 'minmax(10rem, 1.5fr)',
    render: (item) => (
      <span className="flex gap-1 overflow-hidden">
        {item.tags.map((tag) => (
          <Badge key={tag.id} variant="secondary" className="shrink-0">
            {tag.value}
          </Badge>
        ))}
      </span>
    ),
  },
  {
    id: 'loudness',
    label: 'col.loudness',
    width: '6.5rem',
    align: 'right',
    render: (item) => <span className="tabular-nums">{formatDb(item.integratedLufs, 'LUFS')}</span>,
  },
  {
    id: 'gain',
    label: 'col.gain',
    width: '5.5rem',
    align: 'right',
    render: (item) => (
      <span className="tabular-nums">
        {item.playoutGain.source === 'unmeasured' ? '' : formatDb(item.playoutGain.gainDb)}
      </span>
    ),
  },
  {
    id: 'analysis',
    label: 'col.analysis',
    width: '7rem',
    render: (item, { t }) => {
      const { loudness, cues, peaks } = item.analysis;
      const complete = loudness && cues && peaks;
      return (
        <span className="flex items-center gap-1">
          {complete ? <CheckIcon className="size-3" /> : <CircleDashedIcon className="size-3" />}
          {complete ? t('analysis.complete') : muted(t('analysis.pending'))}
        </span>
      );
    },
  },
  {
    id: 'added',
    label: 'col.added',
    width: '7rem',
    sort: 'added',
    render: (item, { locale }) => formatDate(item.createdAt, locale),
  },
  {
    id: 'lastPlayed',
    label: 'col.lastPlayed',
    width: '8rem',
    render: (item, { t, locale }) =>
      item.lastPlayedAt ? formatDate(item.lastPlayedAt, locale) : muted(t('never')),
  },
  {
    id: 'validity',
    label: 'col.validity',
    width: '7rem',
    render: (item, { t, now }) => {
      const v = validityOf(item, now);
      return v === 'active' ? muted(t('validity.active')) : t(`validity.${v}`);
    },
  },
];

export const DEFAULT_COLUMNS = [
  'title',
  'artist',
  'album',
  'type',
  'duration',
  'tags',
  'analysis',
  'added',
];

/** Visible columns in table order; unknown ids are ignored, the title always shows. */
export function visibleColumns(ids: readonly string[] | null): Column[] {
  const wanted = new Set(ids ?? DEFAULT_COLUMNS);
  wanted.add('title');
  return COLUMNS.filter((c) => wanted.has(c.id));
}
