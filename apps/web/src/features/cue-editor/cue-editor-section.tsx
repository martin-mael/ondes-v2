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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  NextTrackPicker,
  NoAudioError,
  type PickedTrack,
  useResolveNextTrack,
} from './next-track.tsx';
import { assetAudioUrl, type CuePlayer, useCuePlayer, usePlayerPosition } from './player.ts';
import {
  centreView,
  clampView,
  fullView,
  sampleToX,
  useElementWidth,
  usePeaks,
  WaveformEditor,
  type WaveformView,
  zoomView,
} from './waveform/index.ts';

// The cue editor (#24), in the asset drawer in place of its read-only cue list: the waveform
// with draggable markers for cue in/out, intro end, outro start and next-track start, playback
// from any marker, and a transition preview into a chosen or random song. Saving sends the
// changed points (`PUT …/cues`), locked unless the person unlocked them, and `manual`, so
// autocue never overwrites them. The feeder reads the cues from the database each time it
// queues the track, so they reach the engine on the next play (an item already queued in the
// engine keeps the cues it was queued with).

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
  const peaks = usePeaks(stationId, asset.id, peaksFile?.sha256, peaksFile !== undefined);

  // What's stored (the asset's cues, or a save's answer until the drawer reloads) and the
  // person's draft. A new copy from the server (a save, a refetch, someone else's edit) only
  // replaces the draft when it has no unsaved edits: they're never lost.
  const [stored, setStored] = useState(asset.cues);
  const [draft, setDraft] = useState(() => draftOf(asset.cues));
  const saved = useMemo(() => draftOf(stored), [stored]);
  const dirty = isDirty(saved, draft);
  const latest = useRef({ saved, draft });
  latest.current = { saved, draft };
  const adopt = (cues: AssetCues | null, keepUnless?: CueDraft) => {
    const { saved: before, draft: current } = latest.current;
    const unsaved = isDirty(keepUnless ?? before, current);
    setStored(cues);
    if (!unsaved) setDraft(draftOf(cues));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: adopt reads the latest state from a ref
  useEffect(() => {
    if (asset.cues !== stored) adopt(asset.cues);
  }, [asset.cues]);
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
  const cueOut = draft.cueOut.samples ?? length;
  /** Plays from a point, and leaves the cursor there. */
  const playFrom = (sample: number) => {
    setCursor(sample);
    player.playFrom(sample, cueOut);
  };

  const save = useMutation({
    mutationFn: async (sent: CueDraft) => {
      const patch = patchOf(saved, sent, sampleRate);
      if (!patch) return null;
      return request(`/stations/${stationId}/assets/${asset.id}/cues`, {
        method: 'PUT',
        body: patch,
        schema: assetCuesSchema,
      });
    },
    onSuccess: async (cues, sent) => {
      // The draft becomes the stored copy, unless it changed while the save was in flight.
      if (cues) adopt(cues, sent);
      toast.success(t('saved'));
      await refresh();
    },
  });
  const canEdit = canWrite && !save.isPending;

  const waveformMissing = !peaksFile || (peaks.isError && isApiError(peaks.error, 'not_found'));

  return (
    <div className="flex flex-col gap-3">
      {!canWrite && <p className="text-muted-foreground">{t('readOnly')}</p>}
      {waveformMissing ? (
        <p className="text-muted-foreground">{t('peaks.missing')}</p>
      ) : peaks.isError ? (
        <div className="flex flex-col gap-1">
          <p className="text-destructive">{t('peaks.error')}</p>
          <FormAlert error={peaks.error} />
        </div>
      ) : peaks.isPending ? (
        <PageSkeleton className="h-[176px]" />
      ) : (
        <WaveformPanel
          peaks={peaks.data}
          draft={draft}
          canEdit={canEdit}
          title={asset.title}
          sampleRate={sampleRate}
          player={player}
          canPlay={playout !== undefined}
          view={view}
          onViewChange={setZoomed}
          cursor={cursor}
          onSeek={(sample) => {
            setCursor(sample);
            if (player.state === 'asset') player.playFrom(sample, cueOut);
          }}
          onPlay={() => playFrom(cursor ?? draft.cueIn.samples ?? 0)}
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
        canEdit={canEdit}
        canPlay={playout !== undefined && length > 0}
        player={player}
        cursor={cursor}
        onPlayFrom={playFrom}
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
      {stored?.analyzerVersion && (
        <p className="text-muted-foreground">
          {t('analyzer', { version: stored.analyzerVersion })}
        </p>
      )}
      {save.isError && (
        <div className="flex flex-col gap-1" role="alert">
          <p className="text-destructive">{t('save.error')}</p>
          <FormAlert error={save.error} />
        </div>
      )}
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
          <Button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(draft)}
          >
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
  canEdit,
  title,
  sampleRate,
  player,
  canPlay,
  view,
  onViewChange,
  cursor,
  onSeek,
  onPlay,
  onMove,
  t,
}: {
  peaks: DecodedPeaks;
  draft: CueDraft;
  canEdit: boolean;
  title: string;
  sampleRate: number;
  player: CuePlayer;
  canPlay: boolean;
  view: WaveformView;
  onViewChange: (view: WaveformView) => void;
  cursor: number | null;
  onSeek: (sample: number) => void;
  onPlay: () => void;
  onMove: (field: MarkerField, samples: number) => void;
  t: CueEditorT;
}) {
  const length = peaks.lengthSamples;
  const centre = (view.fromSample + view.toSample) / 2;
  const [box, width] = useElementWidth<HTMLDivElement>();

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
            draggable: canEdit,
          },
        ];
  });
  const regions = fadeRegions(draft, length).map((r) => ({
    ...r,
    color: MARKER_COLORS[r.id === 'fadeIn' ? 'cueIn' : 'cueOut'],
  }));
  const anchor = () => player.position.get() ?? cursor ?? centre;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {player.state === 'idle' ? (
          <Button type="button" size="sm" variant="outline" disabled={!canPlay} onClick={onPlay}>
            <PlayIcon data-icon="inline-start" />
            {t(cursor === null ? 'play.start' : 'play.cursor')}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={player.stop}>
            <SquareIcon data-icon="inline-start" />
            {t('play.stop')}
          </Button>
        )}
        <PositionTime player={player} cursor={cursor} sampleRate={sampleRate} />
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.in')}
            title={t('zoom.in')}
            onClick={() => onViewChange(zoomView(view, 2, anchor(), length))}
          >
            <ZoomInIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.out')}
            title={t('zoom.out')}
            onClick={() => onViewChange(zoomView(view, 0.5, centre, length))}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('zoom.all')}
            title={t('zoom.all')}
            onClick={() => onViewChange(fullView(length))}
          >
            <MaximizeIcon />
          </Button>
        </div>
      </div>
      <div ref={box} className="relative">
        <WaveformEditor
          peaks={peaks}
          view={view}
          onViewChange={(next) => onViewChange(clampView(next, length))}
          height={WAVEFORM_HEIGHT}
          markers={markers}
          regions={regions}
          // While playing, the moving playhead below takes over from the clicked position.
          playhead={player.state === 'idle' ? cursor : null}
          aria-label={t('waveform', { title })}
          className="rounded-[4px] bg-muted/40"
          formatSample={(s) => formatSamples(s, sampleRate)}
          onSeek={onSeek}
          onMarkerChange={(id, sample) => {
            if (isMarkerField(id)) onMove(id, sample);
          }}
        />
        <PlayingHead player={player} view={view} width={width} />
      </div>
      <p className="text-[0.625rem] text-muted-foreground">{t('zoom.hint')}</p>
    </div>
  );
}

/** The moving playhead: the only part that re-renders on every frame while playing. */
function PlayingHead({
  player,
  view,
  width,
}: {
  player: CuePlayer;
  view: WaveformView;
  width: number;
}) {
  const position = usePlayerPosition(player);
  if (player.state === 'idle' || position === null || width <= 0) return null;
  if (position < view.fromSample || position > view.toSample) return null;
  return (
    <div
      aria-hidden
      data-playing-head
      className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
      style={{ left: sampleToX(view, width, position) }}
    />
  );
}

function PositionTime({
  player,
  cursor,
  sampleRate,
}: {
  player: CuePlayer;
  cursor: number | null;
  sampleRate: number;
}) {
  const position = usePlayerPosition(player) ?? cursor;
  return (
    <span className="ml-1 tabular-nums text-muted-foreground" data-position>
      {position === null ? '' : formatSamples(position, sampleRate)}
    </span>
  );
}

function PointList({
  saved,
  draft,
  sampleRate,
  length,
  canEdit,
  canPlay,
  player,
  cursor,
  onPlayFrom,
  onShow,
  onChange,
  t,
}: {
  saved: CueDraft;
  draft: CueDraft;
  sampleRate: number;
  length: number;
  canEdit: boolean;
  canPlay: boolean;
  player: CuePlayer;
  cursor: number | null;
  onPlayFrom: (sample: number) => void;
  onShow: (sample: number) => void;
  onChange: (update: (draft: CueDraft) => CueDraft) => void;
  t: CueEditorT;
}) {
  const hasPosition = player.state !== 'idle' || cursor !== null;
  return (
    <ul className="flex flex-col gap-1">
      {LIST_FIELDS.map((field) => {
        const point = draft[field];
        const samples = point.samples;
        const edited = samples !== saved[field].samples || point.locked !== saved[field].locked;
        const name = t(`field.${field}`);
        const marker = isMarkerField(field) ? field : null;
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
              {samples === null ? (
                <span className="text-muted-foreground">{t('point.unset')}</span>
              ) : (
                formatSamples(samples, sampleRate)
              )}
            </span>
            <span className="text-muted-foreground">
              {t(point.source === 'manual' ? 'point.manual' : 'point.auto')}
            </span>
            {edited && <Badge variant="secondary">{t('point.edited')}</Badge>}
            <span className="ml-auto flex gap-0.5">
              {marker && samples !== null && (
                <>
                  <IconButton
                    label={t('point.show', { field: name })}
                    onClick={() => onShow(samples)}
                    icon={<CrosshairIcon />}
                  />
                  <IconButton
                    label={t('point.play', { field: name })}
                    disabled={!canPlay}
                    onClick={() => onPlayFrom(samples)}
                    icon={<PlayIcon />}
                  />
                </>
              )}
              {canEdit && marker && (
                <IconButton
                  label={t('point.here', { field: name })}
                  disabled={!hasPosition}
                  onClick={() => {
                    const at = player.position.get() ?? cursor;
                    if (at !== null) onChange((d) => moveMarker(d, marker, at, length));
                  }}
                  icon={<span className="text-[0.625rem] font-semibold">⇥</span>}
                />
              )}
              {canEdit && samples !== null && (
                <IconButton
                  label={t('point.clear', { field: name })}
                  onClick={() => onChange((d) => clearPoint(d, field))}
                  icon={<EraserIcon />}
                />
              )}
              {canEdit && (
                <IconButton
                  label={t(point.locked ? 'point.unlock' : 'point.lock', { field: name })}
                  pressed={point.locked}
                  onClick={() => onChange((d) => setLocked(d, field, !point.locked))}
                  icon={point.locked ? <LockIcon /> : <LockOpenIcon />}
                />
              )}
              {!canEdit && point.locked && (
                <LockIcon className="size-3" aria-label={t('point.locked', { field: name })} />
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

export function TransitionPreview({
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
  const [next, setNext] = useState<PickedTrack | null>(null);
  const resolve = useResolveNextTrack(stationId);
  const preview = useMutation({
    mutationFn: async (nextId: string) => {
      const track = await resolve(nextId);
      player.playTransition(transitionPlan(draft, length, sampleRate), track);
    },
    onError: (error) =>
      toast.error(t(error instanceof NoAudioError ? 'next.noAudio' : 'play.error')),
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
            onClick={() => next && preview.mutate(next.id)}
          >
            {preview.isPending ? (
              <DelayedSpinner when data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            {t('next.preview')}
          </Button>
        )}
      </div>
    </div>
  );
}
