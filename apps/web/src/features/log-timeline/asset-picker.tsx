import type { Asset, AssetType, LogItemKind } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Spinner } from '@/ui/spinner';
import { timelineApi } from './api.ts';
import { useTimelineT } from './messages.ts';
import { usePreview } from './preview.tsx';
import { formatDuration, formatSigned } from './time.ts';

// Library search to insert or replace a log item (#51). A replacement defaults to "fits the
// slot": assets whose length is within a tolerance of the item's planned duration, closest
// first. Rotation rules (#38) don't filter the list yet.

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

const TOLERANCES_S = [10, 30, 60, 120] as const;

export function AssetPickerDialog({
  stationId,
  open,
  onOpenChange,
  title,
  initialKind,
  kinds,
  targetMs,
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
  pending?: boolean;
  onPick(asset: Asset, kind: PickKind): void;
}) {
  const t = useTimelineT();
  const preview = usePreview();
  const [kind, setKind] = useState<PickKind>(initialKind);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [fits, setFits] = useState(targetMs !== undefined);
  const [toleranceS, setToleranceS] = useState<number>(30);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setFits(targetMs !== undefined);
    } else {
      setSearch('');
      setQ('');
    }
  }, [open, initialKind, targetMs]);

  const type = ASSET_TYPE_OF[kind];
  const results = useQuery({
    queryKey: ['stations', stationId, 'assets', 'search', type, q],
    queryFn: ({ signal }) =>
      timelineApi.searchAssets(stationId, { type, ...(q ? { q } : {}), limit: 200 }, signal),
    enabled: open,
  });
  const delta = (asset: Asset) =>
    targetMs === undefined || asset.durationMs === null ? null : asset.durationMs - targetMs;
  let items = results.data?.items ?? [];
  if (fits && targetMs !== undefined) {
    items = items
      .filter((a) => {
        const d = delta(a);
        return d !== null && Math.abs(d) <= toleranceS * 1000;
      })
      .sort((a, b) => Math.abs(delta(a) ?? 0) - Math.abs(delta(b) ?? 0));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('picker.rulesHint')}</DialogDescription>
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
          <Input
            className="min-w-48 flex-1"
            type="search"
            autoFocus
            placeholder={t('picker.search')}
            aria-label={t('picker.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
            <li className="flex justify-center p-4">
              <Spinner />
            </li>
          )}
          {results.isSuccess && items.length === 0 && (
            <li className="p-4 text-center text-sm text-muted-foreground">
              {t('picker.noResults')}
            </li>
          )}
          {items.map((asset) => {
            const d = delta(asset);
            return (
              <li
                key={asset.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('picker.listen', { title: asset.title })}
                  onClick={() => preview.playAsset(asset.id, asset.title)}
                >
                  <PlayIcon />
                </Button>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{asset.title}</span>
                  {asset.artists.length > 0 && (
                    <span className="truncate text-xs text-muted-foreground">
                      {asset.artists.join(', ')}
                    </span>
                  )}
                </span>
                {d !== null && (
                  <Badge variant="outline" title={t('picker.delta', { delta: formatSigned(d) })}>
                    {formatSigned(d)}
                  </Badge>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {asset.durationMs === null ? '–' : formatDuration(asset.durationMs)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onPick(asset, kind)}
                  aria-label={`${t('picker.choose')}: ${asset.title}`}
                >
                  {t('picker.choose')}
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
