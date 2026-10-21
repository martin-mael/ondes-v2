import type { AssetType, LogItemKind } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { PlayIcon, ShieldCheckIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { ListSkeleton } from '../../app/pending.tsx';
import { type RankedCandidate, timelineApi } from './api.ts';
import { ruleLabel, type TimelineT, useTimelineT } from './messages.ts';
import { usePreview } from './preview.tsx';
import { formatDuration, formatSigned } from './time.ts';

// Picking an asset to insert or to replace a log item with (#51). A replacement offers two
// sources:
// - Rules: the rules engine's candidates for the item's slot in a category (#38,
//   `POST …/rotation/pick`): the pick first, then the other candidates that respect every
//   rule, then those that break one, each with its reasons, plus the rules relaxed to fill it.
// - Library: everything of the right type; "fits the slot" asks the whole library for lengths
//   within the tolerance (#23, `POST …/library/search`) and ranks them closest first.
// When a route isn't there (404), the picker falls back to the plain library list.

/** Kinds the timeline inserts by hand: an asset, a voice track, a jingle, a bed. */
export const INSERT_KINDS = ['song', 'vt', 'jingle', 'bed'] as const;
export type PickKind = (typeof INSERT_KINDS)[number] | 'episode' | 'fill';

/** The library type an item kind plays. */
export const ASSET_TYPE_OF: Record<PickKind, AssetType> = {
  song: 'song',
  vt: 'vt',
  jingle: 'jingle',
  bed: 'bed',
  episode: 'episode',
  fill: 'bed',
};

export const isPickKind = (kind: LogItemKind): kind is PickKind => kind in ASSET_TYPE_OF;

/** What the caller needs of a picked asset; the slot is sized from its details. */
export interface PickedAsset {
  id: string;
  title: string;
}

interface Row {
  id: string;
  title: string;
  artists: string[];
  durationMs: number | null;
}

const TOLERANCES_S = [10, 30, 60, 120] as const;

type Source = 'rules' | 'library';

export function AssetPickerDialog({
  stationId,
  open,
  onOpenChange,
  title,
  initialKind,
  kinds,
  targetMs,
  at,
  exclude,
  replacing,
  pending,
  onPick,
}: {
  stationId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  initialKind: PickKind;
  /** The kinds offered. One: no kind choice. */
  kinds: readonly PickKind[];
  /** The slot to fit (replacements). */
  targetMs?: number;
  /** The slot's planned start (replacements): where the rules engine evaluates candidates. */
  at?: string;
  /** The asset being replaced: not offered. */
  exclude?: string | null;
  /** The log item being replaced: left out of the rules engine's history. */
  replacing?: string;
  pending?: boolean;
  onPick(asset: PickedAsset, kind: PickKind): void;
}) {
  const t = useTimelineT();
  const [kind, setKind] = useState<PickKind>(initialKind);
  const [source, setSource] = useState<Source>(at ? 'rules' : 'library');
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setSource(at ? 'rules' : 'library');
    }
  }, [open, initialKind, at]);
  const type = ASSET_TYPE_OF[kind];

  const categories = useQuery({
    queryKey: ['stations', stationId, 'categories'],
    queryFn: ({ signal }) => timelineApi.categories(stationId, signal),
    enabled: open && !!at,
    retry: false,
  });
  const ofType = (categories.data?.items ?? []).filter((c) => c.assetType === type);
  const rulesAvailable = !!at && ofType.length > 0;
  const shown: Source = source === 'rules' && rulesAvailable ? 'rules' : 'library';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {shown === 'rules' ? t('picker.rulesSource') : t('picker.rulesHint')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          {kinds.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="timeline-pick-kind">{t('picker.kind')}</Label>
              <NativeSelect
                id="timeline-pick-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as PickKind)}
              >
                {kinds.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {t(`kind.${k}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {rulesAvailable && (
            <fieldset className="flex gap-1">
              <legend className="sr-only">{t('picker.source')}</legend>
              {(['rules', 'library'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={shown === s ? 'secondary' : 'ghost'}
                  aria-pressed={shown === s}
                  onClick={() => setSource(s)}
                >
                  {t(s === 'rules' ? 'picker.source.rules' : 'picker.source.library')}
                </Button>
              ))}
            </fieldset>
          )}
        </div>
        {shown === 'rules' && at ? (
          <RuleSuggestions
            stationId={stationId}
            t={t}
            categories={ofType}
            at={at}
            targetMs={targetMs}
            exclude={exclude}
            replacing={replacing}
            pending={pending}
            onUnavailable={() => setSource('library')}
            onPick={(row) => onPick(row, kind)}
          />
        ) : (
          <LibraryResults
            stationId={stationId}
            t={t}
            open={open}
            type={type}
            targetMs={targetMs}
            exclude={exclude}
            pending={pending}
            onPick={(row) => onPick(row, kind)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuleSuggestions({
  stationId,
  t,
  categories,
  at,
  targetMs,
  exclude,
  replacing,
  pending,
  onUnavailable,
  onPick,
}: {
  stationId: string;
  t: TimelineT;
  categories: readonly { id: string; name: string }[];
  at: string;
  targetMs?: number;
  exclude?: string | null;
  replacing?: string;
  pending?: boolean;
  onUnavailable(): void;
  onPick(row: Row): void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const pick = useQuery({
    queryKey: ['stations', stationId, 'rotation', 'pick', categoryId, at, replacing],
    queryFn: () => timelineApi.pick(stationId, { categoryId, at }, replacing ? [replacing] : []),
    enabled: !!categoryId,
    retry: false,
  });
  const unavailable = pick.isError && isApiError(pick.error) && pick.error.status === 404;
  useEffect(() => {
    if (unavailable) onUnavailable();
  }, [unavailable, onUnavailable]);

  const ranked = rankCandidates(pick.data?.ranked ?? []).filter((c) => c.assetId !== exclude);
  const pickedDuration = pick.data?.asset?.durationMs ?? null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <Label htmlFor="timeline-pick-category">{t('picker.category')}</Label>
        <NativeSelect
          id="timeline-pick-category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          {categories.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {pick.data && pick.data.relaxed.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="font-medium">{t('picker.relaxed')}</p>
          <ul className="mt-1 list-disc pl-4">
            {pick.data.relaxed.map((r) => (
              <li key={`${r.rule}:${r.reason ?? ''}`}>
                {ruleLabel(t, r.rule)}
                {r.reason && <span className="text-muted-foreground"> · {r.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pick.isError && !unavailable && (
        <p className="text-sm text-destructive">{t('picker.pickFailed')}</p>
      )}
      <ul className="flex max-h-96 flex-col overflow-y-auto" aria-busy={pick.isFetching}>
        {pick.isPending && (
          <li className="p-2">
            <ListSkeleton rows={3} />
          </li>
        )}
        {pick.isSuccess && ranked.length === 0 && (
          <li className="p-4 text-center text-sm text-muted-foreground">{t('picker.noResults')}</li>
        )}
        {ranked.map((c) => (
          <PickRow
            key={c.assetId}
            t={t}
            row={{
              id: c.assetId,
              title: c.title,
              artists: c.artists,
              durationMs: c.picked ? pickedDuration : null,
            }}
            targetMs={targetMs}
            pending={pending}
            onPick={onPick}
          >
            {c.picked ? (
              <Badge>
                <ShieldCheckIcon data-icon="inline-start" />
                {t('picker.bestPick')}
              </Badge>
            ) : c.violations.length === 0 ? (
              <Badge variant="secondary">{t('picker.eligible')}</Badge>
            ) : null}
            {c.violations.length > 0 && (
              <ul className="w-full pl-8 text-xs text-destructive">
                {c.violations.map((v) => (
                  <li key={v.ruleId}>
                    {ruleLabel(t, v.kind)}
                    <span className="text-muted-foreground"> · {v.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </PickRow>
        ))}
      </ul>
    </>
  );
}

/** The pick first, then candidates that respect every rule, then the rest; rotation order within. */
export function rankCandidates(ranked: readonly RankedCandidate[]): RankedCandidate[] {
  const group = (c: RankedCandidate) => (c.picked ? 0 : c.violations.length === 0 ? 1 : 2);
  return [...ranked].sort((a, b) => group(a) - group(b) || a.position - b.position);
}

function LibraryResults({
  stationId,
  t,
  open,
  type,
  targetMs,
  exclude,
  pending,
  onPick,
}: {
  stationId: string;
  t: TimelineT;
  open: boolean;
  type: AssetType;
  targetMs?: number;
  exclude?: string | null;
  pending?: boolean;
  onPick(row: Row): void;
}) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [fits, setFits] = useState(targetMs !== undefined);
  const [toleranceS, setToleranceS] = useState<number>(30);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const windowed = fits && targetMs !== undefined;

  const results = useQuery({
    queryKey: ['stations', stationId, 'assets', 'pick', type, q, windowed ? toleranceS : null],
    queryFn: async ({ signal }): Promise<Row[]> => {
      if (windowed) {
        const tolerance = toleranceS * 1000;
        try {
          const page = await timelineApi.searchByDuration(
            stationId,
            { type, q, minMs: targetMs - tolerance, maxMs: targetMs + tolerance },
            signal,
          );
          return page.items;
        } catch (error) {
          // No library search on this api yet: the first page, filtered below.
          if (!isApiError(error) || error.status !== 404) throw error;
        }
      }
      const page = await timelineApi.searchAssets(
        stationId,
        { type, ...(q ? { q } : {}), limit: 200 },
        signal,
      );
      return page.items;
    },
    enabled: open,
  });
  const delta = (row: Row) =>
    targetMs === undefined || row.durationMs === null ? null : row.durationMs - targetMs;
  let rows = (results.data ?? []).filter((r) => r.id !== exclude);
  if (windowed) {
    rows = rows
      .filter((r) => {
        const d = delta(r);
        return d !== null && Math.abs(d) <= toleranceS * 1000;
      })
      .sort((a, b) => Math.abs(delta(a) ?? 0) - Math.abs(delta(b) ?? 0));
  }

  return (
    <>
      <Input
        type="search"
        autoFocus
        placeholder={t('picker.search')}
        aria-label={t('picker.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {targetMs !== undefined && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control. */}
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox checked={fits} onCheckedChange={setFits} />
            {t('picker.fits', { duration: formatDuration(targetMs) })}
          </label>
          <NativeSelect
            size="sm"
            aria-label={t('picker.tolerance')}
            value={String(toleranceS)}
            disabled={!fits}
            onChange={(e) => setToleranceS(Number(e.target.value))}
          >
            {TOLERANCES_S.map((s) => (
              <NativeSelectOption key={s} value={String(s)}>
                ± {s} s
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <ul className="flex max-h-96 flex-col overflow-y-auto" aria-busy={results.isFetching}>
        {results.isPending && (
          <li className="p-2">
            <ListSkeleton rows={3} />
          </li>
        )}
        {results.isSuccess && rows.length === 0 && (
          <li className="p-4 text-center text-sm text-muted-foreground">{t('picker.noResults')}</li>
        )}
        {rows.map((row) => (
          <PickRow
            key={row.id}
            t={t}
            row={row}
            targetMs={targetMs}
            pending={pending}
            onPick={onPick}
          />
        ))}
      </ul>
    </>
  );
}

function PickRow({
  t,
  row,
  targetMs,
  pending,
  onPick,
  children,
}: {
  t: TimelineT;
  row: Row;
  targetMs?: number;
  pending?: boolean;
  onPick(row: Row): void;
  children?: ReactNode;
}) {
  const preview = usePreview();
  const d = targetMs === undefined || row.durationMs === null ? null : row.durationMs - targetMs;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('picker.listen', { title: row.title })}
        onClick={() => preview.playAsset(row.id, row.title)}
      >
        <PlayIcon />
      </Button>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{row.title}</span>
        {row.artists.length > 0 && (
          <span className="truncate text-xs text-muted-foreground">{row.artists.join(', ')}</span>
        )}
      </span>
      {d !== null && <Badge variant="outline">{formatSigned(d)}</Badge>}
      {row.durationMs !== null && (
        <span className="text-muted-foreground tabular-nums">{formatDuration(row.durationMs)}</span>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => onPick(row)}
        aria-label={`${t('picker.choose')}: ${row.title}`}
      >
        {t('picker.choose')}
      </Button>
      {children}
    </li>
  );
}
