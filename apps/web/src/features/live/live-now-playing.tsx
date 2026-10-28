import { type LiveNowPlaying, rolePermissions } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { liveApi, liveKeys, nowPlayingQuery } from './api.ts';
import { useLiveError, useLiveT } from './messages.ts';

// Live metadata (#68, ADR 0040): while a DJ is on air, what the streams show (the show and DJ,
// the DJ software's titles, or a text typed by hand) and a form to type one: at a concert, the
// artist on stage. For members with `engine:control`; renders nothing while nobody is on air.
// Kept fresh by `live.metadata.changed` and the live session events; no polling.

export function LiveNowPlayingControl({ stationId }: { stationId: string }) {
  const found = findStation(useOrgs(), stationId);
  const canControl = !!found && rolePermissions[found.station.role].includes('engine:control');
  const queryClient = useQueryClient();
  const query = useQuery({ ...nowPlayingQuery(stationId), enabled: canControl });
  const refetch = () => queryClient.invalidateQueries({ queryKey: liveKeys.nowPlaying(stationId) });
  useSseEvent('live.metadata.changed', refetch);
  useSseEvent('live.session.started', refetch);
  useSseEvent('live.session.ended', refetch);

  const nowPlaying = query.data?.nowPlaying;
  if (!canControl || !nowPlaying) return null;
  return <NowPlayingCard stationId={stationId} nowPlaying={nowPlaying} onDone={refetch} />;
}

function NowPlayingCard({
  stationId,
  nowPlaying,
  onDone,
}: {
  stationId: string;
  nowPlaying: LiveNowPlaying;
  onDone(): Promise<unknown>;
}) {
  const t = useLiveT();
  const liveError = useLiveError();
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [busy, setBusy] = useState<'set' | 'clear' | null>(null);
  const dirty = title.trim() !== '' || artist.trim() !== '';
  const { guard } = useUnsavedChanges(dirty);
  const shown = [nowPlaying.artist, nowPlaying.title].filter(Boolean).join(' – ');

  const act = async (action: 'set' | 'clear') => {
    setBusy(action);
    try {
      if (action === 'set') {
        await liveApi.setNowPlaying(stationId, { title, artist });
        setTitle('');
        setArtist('');
        toast.success(t('nowPlaying.saved'));
      } else {
        await liveApi.clearNowPlaying(stationId);
        toast.success(t('nowPlaying.cleared'));
      }
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setBusy(null);
      await onDone();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty) void act('set');
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{t('nowPlaying.title')}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground" data-testid="live-now-playing">
            {shown || t('nowPlaying.empty')}
          </span>
          <Badge variant="outline">{t(`nowPlaying.source.${nowPlaying.source}`)}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="sm:flex-1">
            <FieldLabel htmlFor="live-np-artist">{t('nowPlaying.artist')}</FieldLabel>
            <Input
              id="live-np-artist"
              value={artist}
              maxLength={200}
              placeholder={t('nowPlaying.placeholder')}
              onChange={(e) => setArtist(e.target.value)}
            />
          </Field>
          <Field className="sm:flex-1">
            <FieldLabel htmlFor="live-np-title">{t('nowPlaying.songTitle')}</FieldLabel>
            <Input
              id="live-np-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!dirty || busy !== null}>
              <DelayedSpinner when={busy === 'set'} data-icon="inline-start" />
              {t('nowPlaying.set')}
            </Button>
            {nowPlaying.source === 'manual' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => act('clear')}
              >
                <DelayedSpinner when={busy === 'clear'} data-icon="inline-start" />
                {t('nowPlaying.clear')}
              </Button>
            )}
          </div>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t('nowPlaying.help')}</p>
      </CardContent>
      {guard}
    </Card>
  );
}
