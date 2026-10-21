import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
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
import { safetyApi } from './api.ts';
import { formatDuration } from './format.ts';
import { useSafetyT } from './messages.ts';

// Library search in a dialog: several assets (the safety playlist) or one (the emergency file).

export function AssetPicker({
  stationId,
  open,
  onOpenChange,
  mode,
  exclude = [],
  onPick,
  pending,
}: {
  stationId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  mode: 'multiple' | 'single';
  /** Already selected: not offered again. */
  exclude?: readonly string[];
  onPick(assetIds: string[]): void;
  pending?: boolean;
}) {
  const t = useSafetyT();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!open) {
      setSearch('');
      setPicked([]);
    }
  }, [open]);

  const results = useQuery({
    queryKey: ['stations', stationId, 'assets', 'search', q],
    queryFn: ({ signal }) =>
      safetyApi.searchAssets(stationId, { ...(q ? { q } : {}), limit: 50 }, signal),
    enabled: open,
  });
  const excluded = new Set(exclude);
  const items = (results.data?.items ?? []).filter((a) => !excluded.has(a.id));
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(mode === 'single' ? 'picker.titleSingle' : 'picker.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('picker.search')}</DialogDescription>
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
          {items.map((asset) => {
            const label = [asset.title, asset.artists.join(', ')].filter(Boolean).join(' · ');
            return (
              <li
                key={asset.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                {mode === 'multiple' ? (
                  // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control.
                  <label className="flex flex-1 cursor-pointer items-center gap-3">
                    <Checkbox
                      checked={picked.includes(asset.id)}
                      onCheckedChange={(on) => toggle(asset.id, on)}
                    />
                    <span className="flex-1 truncate">{label}</span>
                  </label>
                ) : (
                  <>
                    <span className="flex-1 truncate">{label}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => onPick([asset.id])}
                      aria-label={`${t('picker.choose')}: ${asset.title}`}
                    >
                      {t('picker.choose')}
                    </Button>
                  </>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {formatDuration(asset.durationMs)}
                </span>
              </li>
            );
          })}
        </ul>
        {mode === 'multiple' && (
          <DialogFooter>
            <Button disabled={picked.length === 0 || pending} onClick={() => onPick(picked)}>
              {t('picker.confirm', { count: picked.length })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
