import type { LiveRecording, LiveRecordingStatus } from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { showKeys } from './api.ts';
import { formatDuration } from './format.ts';
import { useShowError, useShowT } from './messages.ts';
import { episodeRecordingApi, episodeRecordingQuery } from './recording.ts';

// A live episode's recording (#67, ADR 0039), for the episode dialog: its status, how many
// parts were joined, when the retention deletes it, and for managers "Process again" and,
// when a build found other audio on the episode and left it, "Use the recording".
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

const REBUILDABLE: readonly LiveRecordingStatus[] = ['failed', 'ready', 'skipped'];

export function EpisodeRecording({
  stationId,
  showId,
  episodeId,
  episodeAssetId,
  timezone,
  canManage,
}: {
  stationId: string;
  showId: string;
  episodeId: string;
  /** The episode's audio now: the recording's asset, other audio, or none. */
  episodeAssetId: string | null;
  timezone: string;
  canManage: boolean;
}) {
  const t = useShowT();
  const errorMessage = useShowError();
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
    mutationFn: (recordingId: string) => episodeRecordingApi.rebuild(stationId, recordingId),
    onSuccess: () => {
      toast.success(t('recording.rebuilt'));
      void refetch();
    },
  });
  const attach = useMutation({
    mutationFn: (recordingId: string) => episodeRecordingApi.attach(stationId, recordingId),
    onSuccess: () => {
      toast.success(t('recording.attached'));
      void refetch();
      void queryClient.invalidateQueries({ queryKey: showKeys.one(stationId, showId) });
    },
  });
  const actionError = rebuild.error ?? attach.error;

  // Fast and small: no skeleton, the section appears once read.
  if (query.isError && !query.data) {
    return (
      <section className="rounded-lg bg-muted/50 p-3" data-testid="episode-recording">
        <h3 className="text-sm font-medium">{t('recording.title')}</h3>
        <p className="text-muted-foreground">{t('recording.loadFailed')}</p>
      </section>
    );
  }
  if (!query.data) return null;
  const recording = query.data.recording;
  const otherAudio =
    recording?.status === 'ready' &&
    recording.assetId !== null &&
    episodeAssetId !== null &&
    episodeAssetId !== recording.assetId;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3"
      data-testid="episode-recording"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('recording.title')}</h3>
        {recording && (
          <Badge variant={statusVariant[recording.status]}>
            {t(`recording.status.${recording.status}`)}
          </Badge>
        )}
      </div>
      {recording ? (
        <RecordingDetails recording={recording} timezone={timezone} />
      ) : (
        <p className="text-muted-foreground">{t('recording.none')}</p>
      )}
      {recording?.error && <p className="text-destructive">{recording.error}</p>}
      {otherAudio && <p className="text-muted-foreground">{t('recording.otherAudio')}</p>}
      {actionError && <p className="text-destructive">{errorMessage(actionError)}</p>}
      {recording && canManage && (otherAudio || REBUILDABLE.includes(recording.status)) && (
        <div className="flex flex-wrap gap-2">
          {otherAudio && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={attach.isPending}
              onClick={() => attach.mutate(recording.id)}
            >
              <DelayedSpinner when={attach.isPending} />
              {t('recording.attach')}
            </Button>
          )}
          {REBUILDABLE.includes(recording.status) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={rebuild.isPending}
              onClick={() => rebuild.mutate(recording.id)}
            >
              <DelayedSpinner when={rebuild.isPending} />
              {t('recording.rebuild')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function RecordingDetails({ recording, timezone }: { recording: LiveRecording; timezone: string }) {
  const t = useShowT();
  const { locale } = useI18n();
  const facts = [
    recording.durationMs !== null &&
      t('recording.duration', { duration: formatDuration(recording.durationMs) }),
    recording.parts.length > 1 && t('recording.parts', { count: recording.parts.length }),
    recording.buildMs !== null &&
      recording.status === 'ready' &&
      t('recording.builtIn', { seconds: Math.max(1, Math.round(recording.buildMs / 1000)) }),
    recording.expiresAt &&
      t('recording.expires', {
        date: new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium' }).format(
          new Date(recording.expiresAt),
        ),
      }),
  ].filter(Boolean);
  if (facts.length === 0) return null;
  return <p className="text-muted-foreground">{facts.join(' · ')}</p>;
}
