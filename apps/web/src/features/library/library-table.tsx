import type { LibraryItem, LibrarySort, SortDirection } from '@ondes/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Spinner } from '@/ui/spinner';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Column } from './columns.tsx';
import { useLibraryT } from './messages.ts';

// The library table (#23): virtualized rows (only the visible ones are in the DOM, however
// many pages are loaded), sortable headers, row selection, and the next page fetched as the
// end comes into view.

export const ROW_HEIGHT = 36;

export interface Selection {
  isSelected(id: string): boolean;
  toggle(id: string): void;
  /** State of the header checkbox over the loaded rows. */
  page: 'none' | 'some' | 'all';
  togglePage(): void;
}

export function LibraryTable({
  items,
  columns,
  sort,
  direction,
  onSort,
  selection,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onOpen,
  openId,
}: {
  items: LibraryItem[];
  columns: Column[];
  sort: LibrarySort;
  direction: SortDirection;
  onSort: (sort: LibrarySort) => void;
  selection: Selection | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  onOpen: (id: string) => void;
  openId: string | undefined;
}) {
  const t = useLibraryT();
  const { locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => new Date(), []);
  const count = items.length + (hasNextPage ? 1 : 0);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1024, height: 800 },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? -1;

  useEffect(() => {
    if (lastIndex >= items.length - 1 && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [lastIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const template = [selection ? '2.25rem' : null, ...columns.map((c) => c.width)]
    .filter(Boolean)
    .join(' ');
  const ctx = { t, locale, now };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto rounded-md border [contain:inline-size]"
      data-testid="library-scroll"
    >
      {/* A real table, laid out as a grid: rows are positioned by the virtualizer. */}
      <table aria-rowcount={count + 1} className="block min-w-max text-xs">
        <thead className="sticky top-0 z-10 block border-b bg-muted/80 backdrop-blur">
          <tr className="grid" style={{ gridTemplateColumns: template }}>
            {selection && (
              <th className="flex items-center px-2">
                <Checkbox
                  aria-label={t('select.page')}
                  checked={selection.page === 'all'}
                  indeterminate={selection.page === 'some'}
                  onCheckedChange={() => selection.togglePage()}
                />
              </th>
            )}
            {columns.map((column) => {
              const active = column.sort === sort;
              const label = t(column.label);
              return (
                <th
                  key={column.id}
                  aria-sort={
                    active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={`flex h-9 items-center px-2 font-medium ${column.align === 'right' ? 'justify-end' : ''}`}
                >
                  {column.sort ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 hover:underline"
                      title={t('sort.by', { column: label })}
                      onClick={() => column.sort && onSort(column.sort)}
                    >
                      {label}
                      {active &&
                        (direction === 'asc' ? (
                          <ArrowUpIcon className="size-3" />
                        ) : (
                          <ArrowDownIcon className="size-3" />
                        ))}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="relative block" style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map((row) => {
            const item = items[row.index];
            if (!item) {
              return (
                <tr
                  key="loader"
                  className="absolute inset-x-0 flex"
                  style={{ top: row.start, height: ROW_HEIGHT }}
                >
                  <td className="flex items-center gap-2 px-3 text-muted-foreground">
                    <Spinner /> {t('load.more')}
                  </td>
                </tr>
              );
            }
            const selected = selection?.isSelected(item.id) ?? false;
            return (
              // A row click is a mouse shortcut; the title button opens the asset from the keyboard.
              <tr
                key={item.id}
                aria-rowindex={row.index + 2}
                aria-selected={selected}
                data-open={item.id === openId || undefined}
                className="absolute inset-x-0 grid cursor-pointer items-center border-b hover:bg-muted/50 aria-selected:bg-primary/5 data-open:bg-muted"
                style={{ top: row.start, height: ROW_HEIGHT, gridTemplateColumns: template }}
                onClick={() => onOpen(item.id)}
              >
                {selection && (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox inside is the control; this only keeps its clicks off the row.
                  <td className="flex px-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={t('select.row', { title: item.title })}
                      checked={selected}
                      onCheckedChange={() => selection.toggle(item.id)}
                    />
                  </td>
                )}
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={`flex min-w-0 px-2 ${column.align === 'right' ? 'justify-end' : ''}`}
                  >
                    {column.id === 'title' ? (
                      <button
                        type="button"
                        className="min-w-0 truncate text-left hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(item.id);
                        }}
                      >
                        {column.render(item, ctx)}
                      </button>
                    ) : (
                      column.render(item, ctx)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
