import { type AssetCues, assetCuesSchema, type CueField, type DecodedPeaks } from '@ondes/shared';
import { useMutation } from '@tanstack/react-query';
import {
  CrosshairIcon,
  EraserIcon,
  LockIcon,
  LockOpenIcon,
  MaximizeIcon,
  PlayIcon,
  SquareIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/ui/lib/utils';
import { isApiError, request } from '../../app/api/client.ts';
import { FormAlert } from '../../app/forms.tsx';
import { DelayedSpinner, PageSkeleton } from '../../app/pending.tsx';
import type { AssetDrawerSlotProps } from '../library/drawer-slots.ts';
import { formatSamples } from '../library/format.ts';
import { type CueEditorT, useCueEditorT } from './messages.ts';
import {
  type CueDraft,
  clearPoint,
  draftOf,
  fadeRegions,
  isDirty,
  isMarkerField,
  MARKER_COLORS,
  MARKER_FIELDS,
  type MarkerField,
  moveMarker,
  patchOf,
  setLocked,
  transitionPlan,
} from './model.ts';
import { NextTrackPicker, useResolveNextTrack } from './next-track.tsx';
import { assetAudioUrl, type CuePlayer, useCuePlayer } from './player.ts';
import {
  centreView,
  clampView,
  fullView,
  usePeaks,
  WaveformEditor,
  type WaveformView,
  zoomView,
} from './waveform/index.ts';

// The cue editor (#24), in the asset drawer in place of its read-only cue list: the waveform
// with draggable markers for cue in/out, intro end, outro start and next-track start, playback
// from any marker, and a transition preview into a chosen or random song. Saving sends the
// changed points (`PUT …/cues`), locked so autocue never overwrites them. The feeder reads the
// cues from the database each time it queues the track, so they reach the engine on the next
// play (an item already queued in the engine keeps the cues it was queued with).

const LIST_FIELDS: readonly CueField[] = [
  'cueIn',
  'fadeIn',
  'introEnd',
  'outroStart',
  'crossStartNext',
  'fadeOut',
  'cueOut',
];

const WAVEFORM_HEIGHT = 112;

export function CueEditorSection({
  stationId,
  asset,
  canWrite,
  refresh,
  onDirtyChange,
}: AssetDrawerSlotProps) {
  const t = useCueEditorT();
  const peaksFile = asset.files.find((f) => f.role === 'peaks');
  const playout = asset.files.find((f) => f.role === 'playout');
  const peaks = usePeaks(stationId, asset.id, peaksFile?.sha256);
  // What's stored: the asset's cues, or a save's answer until the drawer has reloaded.
  const [stored, setStored] = useState(asset.cues);
  useEffect(() => setStored(asset.cues), [asset.cues]);
  const saved = useMemo(() => draftOf(stored), [stored]);
  const [draft, setDraft] = useState(saved);
  // A save (or another person's edit) reloads the asset: start again from what's stored.
  useEffect(() => setDraft(saved), [saved]);
  const dirty = isDirty(saved, draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const sampleRate =
    asset.cues?.sampleRate ?? peaks.data?.sampleRate ?? playout?.sampleRate ?? 44_100;
  const length = peaks.data?.lengthSamples ?? playout?.durationSamples ?? 0;

  // The waveform's window (the whole track until zoomed) and the clicked position.
  const [zoomed, setZoomed] = useState<WaveformView | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new length (playout copy) resets the zoom
  useEffect(() => setZoomed(null), [length]);
  const view = zoomed ?? fullView(length);
  const [cursor, setCursor] = useState<number | null>(null);

  const player = useCuePlayer({
    src: playout ? assetAudioUrl(stationId, asset.id, playout.sha256) : '',
    sampleRate,
    onError: () => toast.error(t('play.error')),
  });

  const save = useMutation({
    mutationFn: async () => {
      const patch = patchOf(saved, draft, sampleRate);
      if (!patch) return null;
      return request(`/stations/${stationId}/assets/${asset.id}/cues`, {
        method: 'PUT',
        body: patch,
        schema: assetCuesSchema,
      });
    },
    onSuccess: async (cues: AssetCues | null) => {
      if (cues) setStored(cues);
      toast.success(t('saved'));
      await refresh();
    },
  });

  const waveformMissing = !peaksFile || (peaks.isError && isApiError(peaks.error, 'not_found'));

  return (
    <div className="flex flex-col gap-3">
      {!canWrite && <p className="text-muted-foreground">{t('readOnly')}</p>}
      {waveformMissing ? (
        <p className="text-muted-foreground">{t('peaks.missing')}</p>
      ) : peaks.isError ? (
        <FormAlert error={peaks.error} />
      ) : peaks.isPending ? (
        <PageSkeleton className="h-[176px]" />
      ) : (
        <WaveformPanel
          peaks={peaks.data}
          draft={draft}
          canWrite={canWrite}
          title={asset.title}
          sampleRate={sampleRate}
          player={player}
          canPlay={playout !== undefined}
          view={view}
          onViewChange={setZoomed}
          cursor={cursor}
          onCursorChange={setCursor}
          onMove={(field, samples) =>
            setDraft((d) => moveMarker(d, field, samples, peaks.data.lengthSamples))
          }
          t={t}
        />
      )}
      <PointList
        saved={saved}
        draft={draft}
        sampleRate={sampleRate}
        length={length}
        canWrite={canWrite}
        canPlay={playout !== undefined && length > 0}
        player={player}
        cursor={cursor}
        onShow={(sample) => setZoomed(centreView(sample, view.toSample - view.fromSample, length))}
        onChange={setDraft}
        t={t}
      />
      {playout && length > 0 && (
        <TransitionPreview
          stationId={stationId}
          assetId={asset.id}
          draft={draft}
          length={length}
          sampleRate={sampleRate}
          player={player}
          t={t}
        />
      )}
      {!playout && <p className="text-muted-foreground">{t('play.noAudio')}</p>}
      {asset.cues?.analyzerVersion && (
        <p className="text-muted-foreground">
          {t('analyzer', { version: asset.cues.analyzerVersion })}
        </p>
      )}
      {save.isError && <FormAlert error={save.error} />}
      {canWrite && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              save.reset();
              setDraft(saved);
            }}
          >
            {t('reset')}
          </Button>
          <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <DelayedSpinner when={save.isPending} data-icon="inline-start" />
            {t('save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function WaveformPanel({
  peaks,
  draft,
  canWrite,
  title,
  sampleRate,
  player,
  canPlay,
  view,
  onViewChange,
  cursor,
  onCursorChange,
  onMove,
  t,
}: {
  peaks: DecodedPeaks;
  draft: CueDraft;
  canWrite: boolean;
  title: string;
  sampleRate: number;
  player: CuePlayer;
  canPlay: boolean;
  view: WaveformView;
  onViewChange: (view: WaveformView) => void;
  cursor: number | null;
  onCursorChange: (sample: number) => void;
  onMove: (field: MarkerField, samples: number) => void;
  t: CueEditorT;
}) {
  const length = peaks.lengthSamples;
  const setView = onViewChange;
  const centre = (view.fromSample + view.toSample) / 2;
  const playhead = player.position ?? cursor;

  const markers = MARKER_FIELDS.flatMap((field) => {
    const samples = draft[field].samples;
    return samples === null
      ? []
      : [
          {
            id: field,
            sample: samples,
            label: t(`short.${field}`),
            title: t(`field.${field}`),
            color: MARKER_COLORS[field],
            draggable: canWrite,
          },
        ];
  });
  const regions = fadeRegions(draft, length).map((r) => ({
    ...r,
    color: MARKER_COLORS[r.id === 'fadeIn' ? 'cueIn' : 'cueOut'],
  }));
  const cueIn = draft.cueIn.samples ?? 0;
  const cueOut = draft.cueOut.samples ?? length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {player.state === 'idle' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canPlay}
            onClick={() => player.playFrom(cursor ?? cueIn, cueOut)}
          >
            <PlayIcon data-icon="inline-start" />
            {t('play.start')}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={player.stop}>
            <SquareIcon data-icon="inline-start" />
            {t('play.stop')}
          </Button>
        )}
        <span className="ml-1 tabular-nums text-muted-foreground">
          {playhead === null ? '' : formatSamples(playhead, sampleRate)}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.in')}
            title={t('zoom.in')}
            onClick={() => setView(zoomView(view, 2, playhead ?? centre, length))}
          >
            <ZoomInIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.out')}
            title={t('zoom.out')}
            onClick={() => setView(zoomView(view, 0.5, centre, length))}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.all')}
            title={t('zoom.all')}
            onClick={() => setView(fullView(length))}
          >
            <MaximizeIcon />
          </Button>
        </div>
      </div>
      <WaveformEditor
        peaks={peaks}
        view={view}
        onViewChange={(next) => setView(clampView(next, length))}
        height={WAVEFORM_HEIGHT}
        markers={markers}
        regions={regions}
        playhead={playhead}
        aria-label={t('waveform', { title })}
        className="rounded-[4px] bg-muted/40"
        formatSample={(s) => formatSamples(s, sampleRate)}
        onSeek={(sample) => {
          onCursorChange(sample);
          if (player.state === 'asset') player.playFrom(sample, cueOut);
        }}
        onMarkerChange={(id, sample) => {
          if (isMarkerField(id)) onMove(id, sample);
        }}
      />
      <p className="text-[0.625rem] text-muted-foreground">{t('zoom.hint')}</p>
    </div>
  );
}

function PointList({
  saved,
  draft,
  sampleRate,
  length,
  canWrite,
  canPlay,
  player,
  cursor,
  onShow,
  onChange,
  t,
}: {
  saved: CueDraft;
  draft: CueDraft;
  sampleRate: number;
  length: number;
  canWrite: boolean;
  canPlay: boolean;
  player: CuePlayer;
  cursor: number | null;
  onShow: (sample: number) => void;
  onChange: (update: (draft: CueDraft) => CueDraft) => void;
  t: CueEditorT;
}) {
  const cueOut = draft.cueOut.samples ?? length;
  return (
    <ul className="flex flex-col gap-1">
      {LIST_FIELDS.map((field) => {
        const point = draft[field];
        const edited =
          point.samples !== saved[field].samples || point.locked !== saved[field].locked;
        const name = t(`field.${field}`);
        const marker = isMarkerField(field) ? field : null;
        const position = player.position ?? cursor;
        return (
          <li
            key={field}
            data-field={field}
            className="relative flex min-h-8 items-center gap-2 overflow-hidden rounded-[4px] bg-muted/30 py-1 pr-1 pl-3"
          >
            {marker && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-1"
                style={{ background: MARKER_COLORS[marker] }}
              />
            )}
            <span className="min-w-28 font-medium">{name}</span>
            <span className="tabular-nums">
              {point.samples === null ? (
                <span className="text-muted-foreground">{t('point.unset')}</span>
              ) : (
                formatSamples(point.samples, sampleRate)
              )}
            </span>
            <span className="text-muted-foreground">
              {t(point.source === 'manual' ? 'point.manual' : 'point.auto')}
            </span>
            {edited && <Badge variant="secondary">{t('point.edited')}</Badge>}
            <span className="ml-auto flex gap-0.5">
              {marker && point.samples !== null && (
                <>
                  <IconButton
                    label={t('point.show', { field: name })}
                    onClick={() => point.samples !== null && onShow(point.samples)}
                    icon={<CrosshairIcon />}
                  />
                  <IconButton
                    label={t('point.play', { field: name })}
                    disabled={!canPlay}
                    onClick={() => player.playFrom(point.samples ?? 0, cueOut)}
                    icon={<PlayIcon />}
                  />
                </>
              )}
              {canWrite && marker && (
                <IconButton
                  label={t('point.here', { field: name })}
                  disabled={position === null}
                  onClick={() =>
                    position !== null && onChange((d) => moveMarker(d, marker, position, length))
                  }
                  icon={<span className="text-[0.625rem] font-semibold">⇥</span>}
                />
              )}
              {canWrite && point.samples !== null && (
                <IconButton
                  label={t('point.clear', { field: name })}
                  onClick={() => onChange((d) => clearPoint(d, field))}
                  icon={<EraserIcon />}
                />
              )}
              {canWrite && (
                <IconButton
                  label={t(point.locked ? 'point.unlock' : 'point.lock', { field: name })}
                  pressed={point.locked}
                  onClick={() => onChange((d) => setLocked(d, field, !point.locked))}
                  icon={point.locked ? <LockIcon /> : <LockOpenIcon />}
                />
              )}
              {!canWrite && point.locked && (
                <LockIcon className="size-3" aria-label={t('point.unlock', { field: name })} />
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  label,
  icon,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(pressed && 'text-foreground')}
    >
      {icon}
    </Button>
  );
}

function TransitionPreview({
  stationId,
  assetId,
  draft,
  length,
  sampleRate,
  player,
  t,
}: {
  stationId: string;
  assetId: string;
  draft: CueDraft;
  length: number;
  sampleRate: number;
  player: CuePlayer;
  t: CueEditorT;
}) {
  const [next, setNext] = useState<string | null>(null);
  const resolve = useResolveNextTrack(stationId);
  const preview = useMutation({
    mutationFn: async (nextId: string) => {
      const track = await resolve(nextId);
      if (!track) throw new Error('no audio');
      player.playTransition(transitionPlan(draft, length, sampleRate), track);
    },
    onError: () => toast.error(t('play.error')),
  });
  return (
    <div className="flex flex-col gap-2">
      <NextTrackPicker
        stationId={stationId}
        assetId={assetId}
        value={next}
        onChange={setNext}
        t={t}
      />
      <div>
        {player.state === 'transition' ? (
          <Button type="button" variant="outline" onClick={player.stop}>
            <SquareIcon data-icon="inline-start" />
            {t('play.stop')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={next === null || preview.isPending}
            onClick={() => next && preview.mutate(next)}
          >
            <DelayedSpinner when={preview.isPending} data-icon="inline-start" />
            {!preview.isPending && <PlayIcon data-icon="inline-start" />}
            {t('next.preview')}
          </Button>
        )}
      </div>
    </div>
  );
}
