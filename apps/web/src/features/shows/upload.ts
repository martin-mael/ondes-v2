import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { invalidateShows, showsApi, type UploadProgress, uploadEpisodeAudio } from './api.ts';
import { useShowError, useShowT } from './messages.ts';

// Episode audio uploads: create the episode when the occurrence has none, upload the file,
// attach the asset. Progress shows in a toast (it survives navigation) and next to the episode
// (a small store keyed by episode id).

const progress = new Map<string, UploadProgress>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function setProgress(episodeId: string, value: UploadProgress | null) {
  if (value) progress.set(episodeId, value);
  else progress.delete(episodeId);
  emit();
}

/** The upload running for an episode, if any. */
export function useUploadProgress(episodeId: string | null | undefined): UploadProgress | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => (episodeId ? (progress.get(episodeId) ?? null) : null),
  );
}

export type UploadTarget =
  | { showId: string; episodeId: string }
  /** An occurrence without episode: a pre-recorded one is created for it first. */
  | { showId: string; slotId: string; occurrenceDate: string };

export function useEpisodeUpload(stationId: string) {
  const queryClient = useQueryClient();
  const t = useShowT();
  const showError = useShowError();

  return async (target: UploadTarget, file: File): Promise<boolean> => {
    const toastId = toast.loading(t('upload.starting', { file: file.name }));
    let episodeId: string | null = null;
    try {
      if ('episodeId' in target) {
        episodeId = target.episodeId;
      } else {
        const created = await showsApi.createEpisode(stationId, target.showId, {
          kind: 'prerecorded',
          slotId: target.slotId,
          occurrenceDate: target.occurrenceDate,
        });
        episodeId = created.id;
        await invalidateShows(queryClient, stationId);
      }
      const id = episodeId;
      const assetId = await uploadEpisodeAudio(stationId, file, (p) => {
        setProgress(id, p);
        toast.loading(
          p.phase === 'uploading'
            ? t('upload.uploading', { file: file.name, pct: p.pct })
            : t('upload.processing', { file: file.name }),
          { id: toastId },
        );
      });
      await showsApi.updateEpisode(stationId, target.showId, id, { assetId });
      toast.success(t('upload.done', { file: file.name }), { id: toastId });
      return true;
    } catch (error) {
      toast.error(t('upload.failed', { file: file.name, reason: showError(error) }), {
        id: toastId,
      });
      return false;
    } finally {
      if (episodeId) setProgress(episodeId, null);
      await invalidateShows(queryClient, stationId);
    }
  };
}

/** Audio files only, in the picker. Ingest still checks the content. */
export const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.flac,.aiff,.aif,.m4a,.ogg,.opus';
