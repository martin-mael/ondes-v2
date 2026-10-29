import {
  type LibraryFilter,
  type LibrarySort,
  type Permission,
  rolePermissions,
} from '@ondes/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
  BookmarkIcon,
  Columns3Icon,
  FilterXIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { Page, PageHeader } from '../../app/page-header.tsx';
import { ListSkeleton } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { facetsQuery, refreshFirstPage, searchQuery } from './api.ts';
import { AssetDrawer } from './asset-drawer.tsx';
import { BulkBar, type BulkTarget } from './bulk-actions.tsx';
import { COLUMNS, DEFAULT_COLUMNS, visibleColumns } from './columns.tsx';
import { FacetsPanel } from './facets-panel.tsx';
import {
  FILTER_PARAMS,
  filterOf,
  hasFilters,
  type LibrarySearchParams,
  useColumnPrefs,
  useSavedFilters,
} from './filters.ts';
import { LibraryTable, type Selection } from './library-table.tsx';
import { useLibraryT } from './messages.ts';
import { UploadPanel } from './upload-panel.tsx';
import { applyUploadEvent } from './uploads.ts';

// The library screen (#23): search box, facet filters, a virtualized table of keyset pages,
// bulk edits on a selection, uploads, and the asset drawer. Filters, sort and the open asset
// are in the URL.

const route = getRouteApi('/_app/stations/$stationId/library');

/** Most one live refresh per this long during ingest bursts. */
const REFRESH_EVERY_MS = 5_000;

/** Default sort direction per column: newest first, names A to Z, numbers high to low. */
const DEFAULT_DIRECTION: Record<LibrarySort, 'asc' | 'desc'> = {
  added: 'desc',
  title: 'asc',
  artist: 'asc',
  album: 'asc',
  year: 'desc',
  duration: 'desc',
  bpm: 'desc',
};

/** Permissions of the person's role on this station (the api checks them regardless). */
function useStationPermissions(stationId: string) {
  const found = findStation(useOrgs(), stationId);
  return useMemo(() => {
    const allowed = new Set<Permission>(found ? rolePermissions[found.station.role] : []);
    return (permission: Permission) => allowed.has(permission);
  }, [found]);
}

export function LibraryPage() {
  const t = useLibraryT();
  const { stationId } = route.useParams();
  const params = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const allowed = useStationPermissions(stationId);
  const canWrite = allowed('library:write');

  const update = useCallback(
    (patch: Partial<LibrarySearchParams>) =>
      navigate({
        search: (prev) =>
          Object.fromEntries(
            Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined),
          ) as LibrarySearchParams,
        replace: true,
      }),
    [navigate],
  );

  const sort = params.sort ?? 'added';
  const direction = params.dir ?? DEFAULT_DIRECTION[sort];
  const filterKey = JSON.stringify(FILTER_PARAMS.map((k) => params[k]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when a filter param changes, not on every render.
  const filter = useMemo(() => filterOf(params), [filterKey]);

  const search = useInfiniteQuery(searchQuery(stationId, filter, sort, direction));
  const facets = useQuery(facetsQuery(stationId, filter));
  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const total = facets.data?.total;

  // --- Selection -------------------------------------------------------------------------
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** "All matching", as the person saw it: the filter and its count at that moment. */
  const [allMatching, setAllMatching] = useState<{ filter: LibraryFilter; count: number } | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts a new selection.
  useEffect(() => {
    setPicked(new Set());
    setAllMatching(null);
  }, [filterKey]);
  // Picks that left the list (deleted, or no longer matching after a refetch) are dropped, so
  // the count shown is what a bulk edit would touch.
  useEffect(() => {
    setPicked((current) => {
      const loaded = new Set(items.map((i) => i.id));
      const kept = [...current].filter((id) => loaded.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [items]);
  const clearSelection = () => {
    setPicked(new Set());
    setAllMatching(null);
  };
  const allLoadedPicked = items.length > 0 && items.every((i) => picked.has(i.id));
  const selection: Selection | null = canWrite
    ? {
        isSelected: (id) => allMatching !== null || picked.has(id),
        toggle: (id) => {
          if (allMatching) {
            // Leaving "all matching": keep the loaded rows but this one.
            setAllMatching(null);
            setPicked(new Set(items.map((i) => i.id).filter((i) => i !== id)));
            return;
          }
          const next = new Set(picked);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          setPicked(next);
        },
        page: allMatching || allLoadedPicked ? 'all' : picked.size > 0 ? 'some' : 'none',
        togglePage: () => {
          if (allMatching || allLoadedPicked) clearSelection();
          else setPicked(new Set(items.map((i) => i.id)));
        },
      }
    : null;
  const bulkTarget: BulkTarget | null = allMatching
    ? {
        selection: { filter: allMatching.filter, expectedCount: allMatching.count },
        count: allMatching.count,
      }
    : picked.size > 0
      ? { selection: { ids: [...picked] }, count: picked.size }
      : null;
  const everyLoadedPicked = !allMatching && allLoadedPicked;

  // --- Live updates ----------------------------------------------------------------------
  // New assets (ingest bursts): at most one refresh every few seconds, of the first page and
  // the counts only. Later pages are dropped rather than refetched; scrolling loads them again.
  const lastRefresh = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    const wait = Math.max(0, lastRefresh.current + REFRESH_EVERY_MS - Date.now());
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      lastRefresh.current = Date.now();
      void refreshFirstPage(queryClient, stationId);
    }, wait);
  }, [queryClient, stationId]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useSseEvent('asset.ingested', refreshSoon);
  useSseEvent('upload.updated', (event) => {
    applyUploadEvent(stationId, event.data);
  });

  // --- Search box (debounced into the URL) -----------------------------------------------
  const [q, setQ] = useState(params.q ?? '');
  useEffect(() => setQ(params.q ?? ''), [params.q]);
  useEffect(() => {
    if (q === (params.q ?? '')) return;
    const timer = setTimeout(() => update({ q: q || undefined }), 250);
    return () => clearTimeout(timer);
  }, [q, params.q, update]);

  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [columnIds, setColumnIds] = useColumnPrefs();
  const columns = visibleColumns(columnIds);

  if (search.isError && isApiError(search.error, 'forbidden')) {
    return <p className="p-6 text-sm text-muted-foreground">{t('forbidden')}</p>;
  }

  const countLabel =
    total === undefined
      ? ''
      : total === 1
        ? t('results.one')
        : t('results', { count: total.toLocaleString() });

  return (
    // The search is the page's main control: it sits in the header bar, between the title and
    // the actions. The list and the filters fill the window below and scroll inside.
    <Page
      fill
      className="gap-3"
      header={
        <PageHeader
          title={t('title')}
          actions={
            <>
              <SavedFilters stationId={stationId} params={params} apply={update} />
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  <Columns3Icon data-icon="inline-start" />
                  {t('columns.menu')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    {COLUMNS.filter((c) => c.id !== 'title').map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column.id}
                        checked={columns.some((c) => c.id === column.id)}
                        onCheckedChange={(checked) => {
                          const current = columns.map((c) => c.id);
                          setColumnIds(
                            checked
                              ? [...current, column.id]
                              : current.filter((id) => id !== column.id),
                          );
                        }}
                      >
                        {t(column.label)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setColumnIds([...DEFAULT_COLUMNS])}>
                    {t('columns.reset')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {canWrite && (
                <Button onClick={() => setUploadsOpen(!uploadsOpen)}>
                  <UploadIcon data-icon="inline-start" />
                  {t('upload.button')}
                </Button>
              )}
            </>
          }
        >
          <div className="relative min-w-64 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label={t('search.placeholder')}
              placeholder={t('search.placeholder')}
              className="pl-7"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {countLabel}
          </span>
        </PageHeader>
      }
    >
      {uploadsOpen && canWrite && (
        <UploadPanel
          stationId={stationId}
          onOpenAsset={(asset) => update({ asset })}
          onClose={() => setUploadsOpen(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="hidden w-56 shrink-0 flex-col gap-2 overflow-y-auto pr-1 md:flex">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('facets.title')}</h2>
            {hasFilters(params) && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => update(Object.fromEntries(FILTER_PARAMS.map((k) => [k, undefined])))}
              >
                <FilterXIcon data-icon="inline-start" />
                {t('facets.clear')}
              </Button>
            )}
          </div>
          <FacetsPanel facets={facets.data} params={params} update={update} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-2">
          {bulkTarget && (
            <BulkBar
              stationId={stationId}
              target={bulkTarget}
              label={
                allMatching
                  ? t('selected.all', { count: bulkTarget.count.toLocaleString() })
                  : t('selected', { count: bulkTarget.count.toLocaleString() })
              }
              onClear={clearSelection}
              onDone={clearSelection}
            />
          )}
          {everyLoadedPicked && total !== undefined && total > items.length && (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => {
                setAllMatching({ filter, count: total });
                setPicked(new Set());
              }}
            >
              {t('select.all', { count: total.toLocaleString() })}
            </Button>
          )}
          {search.isPending ? (
            <ListSkeleton />
          ) : search.isError ? (
            <FormAlert error={search.error} />
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">
              {hasFilters(params) ? t('empty') : t('empty.library')}
            </p>
          ) : (
            <LibraryTable
              items={items}
              columns={columns}
              sort={sort}
              direction={direction}
              onSort={(next) =>
                update(
                  next === sort
                    ? { sort: next, dir: direction === 'asc' ? 'desc' : 'asc' }
                    : { sort: next, dir: undefined },
                )
              }
              selection={selection}
              hasNextPage={search.hasNextPage}
              isFetchingNextPage={search.isFetchingNextPage}
              fetchNextPage={() => void search.fetchNextPage()}
              onOpen={(asset) => update({ asset })}
              openId={params.asset}
            />
          )}
        </main>
      </div>

      <AssetDrawer
        stationId={stationId}
        assetId={params.asset}
        allowed={allowed}
        onClose={() => update({ asset: undefined })}
      />
    </Page>
  );
}

function SavedFilters({
  stationId,
  params,
  apply,
}: {
  stationId: string;
  params: LibrarySearchParams;
  apply: (patch: Partial<LibrarySearchParams>) => void;
}) {
  const t = useLibraryT();
  const { saved, save, remove } = useSavedFilters(stationId);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          <BookmarkIcon data-icon="inline-start" />
          {t('saved.menu')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('saved.local')}</DropdownMenuLabel>
            {saved.length === 0 && <DropdownMenuItem disabled>{t('saved.none')}</DropdownMenuItem>}
            {saved.map((entry) => (
              <DropdownMenuItem
                key={entry.name}
                onClick={() => {
                  // Replace every filter, keep the open asset.
                  const cleared = Object.fromEntries(
                    [...FILTER_PARAMS, 'sort', 'dir'].map((k) => [k, undefined]),
                  );
                  apply({ ...cleared, ...entry.params });
                }}
              >
                <span className="flex-1 truncate">{entry.name}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('saved.delete', { name: entry.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(entry.name);
                  }}
                >
                  <Trash2Icon />
                </Button>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasFilters(params)} onClick={() => setNaming(true)}>
            {t('saved.save')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="sm:max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              save(name.trim(), params);
              toast.success(t('saved.saved'));
              setName('');
              setNaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('saved.save')}</DialogTitle>
              <DialogDescription>{t('saved.local')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1">
              <Label htmlFor="saved-filter-name">{t('saved.name')}</Label>
              <Input
                id="saved-filter-name"
                placeholder={t('saved.namePlaceholder')}
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(false)}>
                <XIcon data-icon="inline-start" />
                {t('upload.cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {t('bulk.apply')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
