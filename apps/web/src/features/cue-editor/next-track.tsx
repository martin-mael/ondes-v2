import {
  type LibraryFilter,
  type LibraryItem,
  libraryRandomResultSchema,
  samplesToSeconds,
} from '@ondes/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShuffleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { request } from '../../app/api/client.ts';
import { DelayedSpinner } from '../../app/pending.tsx';
import { assetQuery, searchQuery } from '../library/api.ts';
import type { CueEditorT } from './messages.ts';
import { assetAudioUrl, type NextTrack } from './player.ts';

// The next track of a transition preview (#24): a song of the station with a playout copy,
// found with the library search (#23) or drawn at random from the whole station
// (`POST …/library/random`). The search is the library's own query, so a library refresh
// (new uploads) refreshes it too.

/** Songs that can be listened to. */
export const nextFilter = (q: string): LibraryFilter => ({
  types: ['song'],
  playable: true,
  ...(q ? { q } : {}),
});

/** The asset has no playout copy (any more): nothing to play. */
export class NoAudioError extends Error {
  constructor() {
    super('no playout copy');
    this.name = 'NoAudioError';
  }
}

/** What the player needs of the next track: its audio and its cue-in. */
export function useResolveNextTrack(stationId: string) {
  const queryClient = useQueryClient();
  return async (assetId: string): Promise<NextTrack> => {
    const detail = await queryClient.fetchQuery(assetQuery(stationId, assetId));
    const playout = detail.files.find((f) => f.role === 'playout');
    if (!playout) throw new NoAudioError();
    const cueIn = detail.cues?.cueIn.samples;
    return {
      src: assetAudioUrl(stationId, assetId, playout.sha256),
      fromSeconds:
        cueIn != null && detail.cues ? samplesToSeconds(cueIn, detail.cues.sampleRate) : 0,
    };
  };
}

export interface PickedTrack {
  id: string;
  label: string;
}

const labelOf = (item: Pick<LibraryItem, 'artists' | 'title'>) =>
  [item.artists.join(', '), item.title].filter(Boolean).join(' – ');

const SEARCH_DEBOUNCE_MS = 250;

export function NextTrackPicker({
  stationId,
  assetId,
  value,
  onChange,
  t,
}: {
  stationId: string;
  /** The edited asset, never offered. */
  assetId: string;
  value: PickedTrack | null;
  onChange: (track: PickedTrack) => void;
  t: CueEditorT;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useInfiniteQuery(searchQuery(stationId, nextFilter(q), 'title', 'asc'));
  const items = (search.data?.pages[0]?.items ?? []).filter((item) => item.id !== assetId);
  const more = search.data?.pages[0]?.nextCursor != null;
  const random = useMutation({
    mutationFn: () =>
      request(`/stations/${stationId}/library/random`, {
        body: { filter: nextFilter(''), exclude: [assetId, ...(value ? [value.id] : [])] },
        schema: libraryRandomResultSchema,
      }),
    onSuccess: ({ item }) => {
      if (item) onChange({ id: item.id, label: labelOf(item) });
    },
  });
  const options =
    value && !items.some((i) => i.id === value.id)
      ? [value, ...items.map(toPick)]
      : items.map(toPick);
  const empty = search.isSuccess && options.length === 0;
  const id = `cue-next-${assetId}`;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{t('next.label')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          className="w-40"
          value={text}
          aria-label={t('next.search')}
          placeholder={t('next.search')}
          onChange={(event) => setText(event.target.value)}
        />
        <NativeSelect
          id={id}
          className="min-w-48 flex-1"
          value={value?.id ?? ''}
          disabled={empty}
          onChange={(event) => {
            const pick = options.find((o) => o.id === event.target.value);
            if (pick) onChange(pick);
          }}
        >
          <NativeSelectOption value="">
            {empty ? t(q ? 'next.noMatch' : 'next.none') : t('next.pick')}
          </NativeSelectOption>
          {options.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          disabled={random.isPending}
          onClick={() => random.mutate()}
        >
          {random.isPending ? (
            <DelayedSpinner when data-icon="inline-start" />
          ) : (
            <ShuffleIcon data-icon="inline-start" />
          )}
          {t('next.random')}
        </Button>
      </div>
      {more && <p className="text-[0.625rem] text-muted-foreground">{t('next.more')}</p>}
      {random.isSuccess && random.data.item === null && (
        <p className="text-muted-foreground">{t('next.none')}</p>
      )}
    </div>
  );
}

const toPick = (item: LibraryItem): PickedTrack => ({ id: item.id, label: labelOf(item) });
