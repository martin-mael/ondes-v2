import { librarySearchPageSchema, samplesToSeconds } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShuffleIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { request } from '../../app/api/client.ts';
import { assetQuery, libraryKeys } from '../library/api.ts';
import type { CueEditorT } from './messages.ts';
import { assetAudioUrl, type NextTrack } from './player.ts';

// The next track of a transition preview (#24): a song from the library, chosen or random.

/** Songs a transition can go into: the 100 most recently added, but this one. */
export const nextCandidatesQuery = (stationId: string) => ({
  queryKey: [...libraryKeys.all(stationId), 'cue-editor', 'next-candidates'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request(`/stations/${stationId}/library/search`, {
      body: { filter: { types: ['song'] }, sort: 'added', direction: 'desc', limit: 100 },
      schema: librarySearchPageSchema,
      signal,
    }),
  staleTime: 60_000,
});

/** What the player needs of the next track: its audio and its cue-in. */
export function useResolveNextTrack(stationId: string) {
  const queryClient = useQueryClient();
  return async (assetId: string): Promise<NextTrack | null> => {
    const detail = await queryClient.fetchQuery(assetQuery(stationId, assetId));
    const playout = detail.files.find((f) => f.role === 'playout');
    if (!playout) return null;
    const cueIn = detail.cues?.cueIn.samples;
    return {
      src: assetAudioUrl(stationId, assetId, playout.sha256),
      fromSeconds:
        cueIn != null && detail.cues ? samplesToSeconds(cueIn, detail.cues.sampleRate) : 0,
    };
  };
}

export function NextTrackPicker({
  stationId,
  assetId,
  value,
  onChange,
  t,
}: {
  stationId: string;
  /** The edited asset, left out of the list. */
  assetId: string;
  value: string | null;
  onChange: (assetId: string) => void;
  t: CueEditorT;
}) {
  const candidates = useQuery(nextCandidatesQuery(stationId));
  const items = (candidates.data?.items ?? []).filter((item) => item.id !== assetId);
  const random = () => {
    const pool = items.filter((item) => item.id !== value);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) onChange(pick.id);
  };
  const empty = candidates.isSuccess && items.length === 0;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <Label htmlFor={`cue-next-${assetId}`}>{t('next.label')}</Label>
        <NativeSelect
          id={`cue-next-${assetId}`}
          className="w-full"
          value={value ?? ''}
          disabled={empty || !candidates.isSuccess}
          onChange={(event) => event.target.value && onChange(event.target.value)}
        >
          <NativeSelectOption value="">
            {empty ? t('next.none') : t('next.pick')}
          </NativeSelectOption>
          {items.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {[item.artists.join(', '), item.title].filter(Boolean).join(' – ')}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <Button type="button" variant="outline" onClick={random} disabled={items.length === 0}>
        <ShuffleIcon data-icon="inline-start" />
        {t('next.random')}
      </Button>
    </div>
  );
}
