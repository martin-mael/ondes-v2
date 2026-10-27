import type { LiveRecording, LiveRecordingStatus } from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../../app/pending.tsx';
import { useSseEvent } from '../../../app/sse/sse.tsx';
import { formatDuration } from '../../shows/format.ts';
import { episodeRecordingQuery, liveRecordingApi } from './api.ts';
import { useLiveRecordingT } from './messages.ts';

// A live episode's recording (#67, ADR 0039), for the episode dialog: its status, how many
// parts were joined, when the retention deletes it, and "Process again" for managers.
// Self-contained (station, show, episode); refetches on `live.recording.updated`.

const statusVariant: Record<
  LiveRecordingStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  recording: 'destructive',
  pending: 'secondary',
  processing: 'secondary',
  ready: 'default',
  failed: 'destructive',
  expired: 'outline',
  skipped: 'outline',
};

export function EpisodeRecording({
  stationId,
  showId,
  episodeId,
  timezone,
  canRebuild,
}: {
  stationId: string;
  showId: string;
  episodeId: string;
  timezone: string;
  canRebuild: boolean;
}) {
  const t = useLiveRecordingT();
  const queryClient = useQueryClient();
  const query = useQuery(episodeRecordingQuery(stationId, showId, episodeId));
  const refetch = () =>
    queryClient.invalidateQueries({
      queryKey: episodeRecordingQuery(stationId, showId, episodeId).queryKey,
    });
  useSseEvent('live.recording.updated', (event) => {
    if (event.data.episodeId === episodeId) void refetch();
  });
  const rebuild = useMutation({
    mutationFn: (recordingId: string) => liveRecordingApi.rebuild(stationId, recordingId),
    onSuccess: () => {
      toast.success(t('episode.rebuilt'));
      void refetch();
    },
  });

  // Fast and small: no skeleton, the section appears once read.
  if (!query.data) return null;
  const recording = query.data.recording;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3"
      data-testid="episode-recording"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('episode.title')}</h3>
        {recording && (
          <Badge variant={statusVariant[recording.status]}>
            {t(`episode.status.${recording.status}`)}
          </Badge>
        )}
      </div>
      {recording ? (
        <RecordingDetails recording={recording} timezone={timezone} />
      ) : (
        <p className="text-muted-foreground">{t('episode.none')}</p>
      )}
      {recording?.error && <p className="text-destructive">{recording.error}</p>}
      {recording && canRebuild && ['failed', 'ready', 'skipped'].includes(recording.status) && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate(recording.id)}
          >
            <DelayedSpinner when={rebuild.isPending} />
            {t('episode.rebuild')}
          </Button>
        </div>
      )}
    </section>
  );
}

function RecordingDetails({ recording, timezone }: { recording: LiveRecording; timezone: string }) {
  const t = useLiveRecordingT();
  const { locale } = useI18n();
  const facts = [
    recording.durationMs !== null &&
      t('episode.duration', { duration: formatDuration(recording.durationMs) }),
    recording.parts.length > 1 && t('episode.parts', { count: recording.parts.length }),
    recording.buildMs !== null &&
      recording.status === 'ready' &&
      t('episode.builtIn', { seconds: Math.max(1, Math.round(recording.buildMs / 1000)) }),
    recording.expiresAt &&
      t('episode.expires', {
        date: new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium' }).format(
          new Date(recording.expiresAt),
        ),
      }),
  ].filter(Boolean);
  if (facts.length === 0) return null;
  return <p className="text-muted-foreground">{facts.join(' · ')}</p>;
}
