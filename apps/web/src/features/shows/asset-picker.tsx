import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { showKeys, showsApi } from './api.ts';
import { formatDuration } from './format.ts';
import { useShowT } from './messages.ts';

// Picks one of the station's `episode` assets, to attach to an episode.

export function EpisodeAssetPicker({
  stationId,
  open,
  onOpenChange,
  onPick,
  pending,
}: {
  stationId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(assetId: string): void;
  pending?: boolean;
}) {
  const t = useShowT();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const results = useQuery({
    queryKey: [...showKeys.all(stationId), 'assets', q],
    queryFn: ({ signal }) => showsApi.searchEpisodeAssets(stationId, q, signal),
    enabled: open,
  });
  const items = results.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('picker.title')}</DialogTitle>
          <DialogDescription>{t('picker.description')}</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          autoFocus
          placeholder={t('picker.search')}
          aria-label={t('picker.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="flex max-h-80 flex-col overflow-y-auto" aria-busy={results.isFetching}>
          {results.isPending && (
            <li className="flex justify-center p-4">
              <Spinner />
            </li>
          )}
          {results.isSuccess && items.length === 0 && (
            <li className="p-4 text-center text-muted-foreground">{t('picker.noResults')}</li>
          )}
          {items.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
            >
              <span className="flex-1 truncate">
                {[asset.title, asset.artists.join(', ')].filter(Boolean).join(' · ')}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {asset.durationMs ? formatDuration(asset.durationMs) : '–'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => onPick(asset.id)}
                aria-label={`${t('picker.choose')}: ${asset.title}`}
              >
                {t('picker.choose')}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
