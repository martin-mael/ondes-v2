import { type LocalDate, type LogItem, rolePermissions, type Segue } from '@ondes/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ArrowLeftIcon,
  MaximizeIcon,
  MicIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  RewindIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Trash2Icon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert, useErrorMessage } from '../../app/forms.tsx';
import { DelayedSpinner, PageSkeleton } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import {
  sampleToX,
  useElementWidth,
  type WaveformView,
  zoomView,
} from '../cue-editor/waveform/index.ts';
import { assetDetailQuery, logDayQuery } from '../log-timeline/api.ts';
import { AssetPickerDialog } from '../log-timeline/asset-picker.tsx';
import { hasSegue } from '../log-timeline/item-row.tsx';
import { PreviewProvider } from '../log-timeline/preview.tsx';
import { formatClock } from '../log-timeline/time.ts';
import { segueApi, segueKey, segueMediaQuery, segueQuery } from './api.ts';
import { peekDraft, stashDraft, takeDraft } from './draft.ts';
import { useHistory } from './history.ts';
import { Lane, type LaneStyle } from './lane.tsx';
import { type SegueMessageKey, type SegueT, useSegueT } from './messages.ts';
import {
  addRecordedVoice,
  addVoice,
  applyDuck,
  applyFadeOut,
  type Clip,
  clearEnvelopes,
  clipsOf,
  DUCK_PRESETS,
  emptyLanes,
  extentOf,
  islandOf,
  islandRange,
  type LaneKey,
  type LaneMedia,
  type Lanes,
  laneEnvelope,
  laneStart,
  moveLane,
  ms,
  problemOf,
  removePoint,
  removeVoice,
  SR,
  sameLanes,
  setLaneEnvelope,
  transitionStart,
  voiceIndex,
  voiceKey,
} from './model.ts';
import { Overview, Ruler } from './overview.tsx';
import { SeguePlayer } from './preview.ts';
import { clampAxisView, formatOffset, initialView, padded } from './view.ts';

// The segue editor (#58): the transition between two log items as lanes on one axis (A, the
// voices, B), with waveforms from the peaks (#22, drawn by #24's component), gain envelopes,
// ducking presets, a WebAudio preview mixed with the renderer's gain model (#56), undo/redo,
// and the estimated time on air. Saving goes through the segues api (#55), which re-derives
// the island; the renderer (#56) renders it from there. Opened from the log timeline.

const route = getRouteApi('/_app/stations/$stationId/log/segue');

const LANE_HEIGHT = 72;
const VOICE_HEIGHT = 76;
const PREROLL_S = [2, 5, 10, 20] as const;
/** Zoom per step of the toolbar buttons and keys; pinch and Ctrl-scroll zoom continuously. */
const ZOOM_STEP = 1.5;
/** Arrow keys nudge the selected lane by this much (Shift: ×10). */
const NUDGE_MS = 10;

const STYLES: Record<'out' | 'in' | 'voice', LaneStyle> = {
  out: {
    accent: 'bg-sky-500',
    wave: 'text-sky-600 dark:text-sky-400',
    line: 'stroke-sky-800 dark:stroke-sky-200',
    point: 'fill-sky-700 dark:fill-sky-300',
  },
  voice: {
    accent: 'bg-amber-500',
    wave: 'text-amber-600 dark:text-amber-400',
    line: 'stroke-amber-800 dark:stroke-amber-200',
    point: 'fill-amber-700 dark:fill-amber-300',
  },
  in: {
    accent: 'bg-emerald-500',
    wave: 'text-emerald-600 dark:text-emerald-400',
    line: 'stroke-emerald-800 dark:stroke-emerald-200',
    point: 'fill-emerald-700 dark:fill-emerald-300',
  },
};
const styleOf = (key: LaneKey) => STYLES[key === 'out' || key === 'in' ? key : 'voice'];

const titleOf = (item: LogItem) => item.asset?.title ?? item.title ?? '';

const lanesOf = (segue: Segue | null): Lanes =>
  segue ? { out: segue.out, in: segue.in, voices: segue.voices } : emptyLanes();

export function SegueEditorPage() {
  const t = useSegueT();
  const { stationId } = route.useParams();
  const search = route.useSearch();
  const station = findStation(useOrgs(), stationId)?.station;
  const timeZone = station?.timezone ?? 'UTC';
  const permissions = station ? rolePermissions[station.role] : [];
  const canWrite =
    permissions.includes('voice_track:write') || permissions.includes('voice_track:write_own');
  const date = search.date ?? ('1970-01-01' as LocalDate);
  const valid = !!(search.date && search.from && search.to);

  const log = useQuery({ ...logDayQuery(stationId, date, timeZone), enabled: valid });
  const segue = useQuery({
    ...segueQuery(stationId, search.from ?? '', search.to ?? ''),
    enabled: valid,
  });

  const back = (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={
        <Link to="/stations/$stationId/log" params={{ stationId }} search={{ date: search.date }} />
      }
    >
      <ArrowLeftIcon data-icon="inline-start" />
      {t('back')}
    </Button>
  );
  const problem = (message: React.ReactNode) => (
    <div className="flex flex-col items-start gap-4 p-6">
      {back}
      {message}
    </div>
  );

  if (!valid) return problem(<p className="text-sm text-muted-foreground">{t('notFound')}</p>);
  if (log.isPending || segue.isPending) return <PageSkeleton />;
  if (log.isError || segue.isError) return problem(<FormAlert error={log.error ?? segue.error} />);

  // B must be the top-level item right after A.
  const items = log.data.items;
  const i = items.findIndex((item) => item.id === search.from);
  const a = items[i];
  const b = items[i + 1];
  if (!a || !b || b.id !== search.to) {
    return problem(<p className="text-sm text-muted-foreground">{t('notFound')}</p>);
  }
  if (!hasSegue(a) || !hasSegue(b)) {
    return problem(<p className="text-sm text-muted-foreground">{t('notTransition')}</p>);
  }
  return (
    // The voice picker is the timeline's, whose rows have their own listen buttons.
    <PreviewProvider stationId={stationId}>
      <Editor
        stationId={stationId}
        timeZone={timeZone}
        canWrite={canWrite}
        a={a}
        b={b}
        segue={segue.data}
        back={back}
        date={date}
        placed={search.voice ? { assetId: search.voice, at: search.at ?? null } : null}
      />
    </PreviewProvider>
  );
}

/** `loading`: the audio is fetched and decoded before anything plays. */
type PlayPhase = 'idle' | 'loading' | 'playing';

interface Selection {
  lane: LaneKey | null;
  point: number | null;
}

function Editor({
  stationId,
  timeZone,
  canWrite,
  a,
  b,
  segue,
  back,
  date,
  placed,
}: {
  stationId: string;
  timeZone: string;
  canWrite: boolean;
  a: LogItem;
  b: LogItem;
  segue: Segue | null;
  back: React.ReactNode;
  date: LocalDate;
  /** A take just recorded (#59): added as a new voice once, then dropped from the URL. */
  placed: { assetId: string; at: number | null } | null;
}) {
  const t = useSegueT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Back from the recorder (#59): the draft handed over before leaving, with its reference.
  const [stashed] = useState(() => peekDraft(stationId, a.id, b.id));
  useEffect(() => void takeDraft(stationId, a.id, b.id), [stationId, a.id, b.id]);
  const history = useHistory<Lanes>(stashed?.lanes ?? lanesOf(segue));
  const lanes = history.state.present;
  // What the api has: the dirty check's reference and the version a save sends back.
  const [saved, setSaved] = useState<{
    lanes: Lanes;
    segueId: string | null;
    version: number | null;
  }>(
    () =>
      stashed?.saved ?? {
        lanes: lanesOf(segue),
        segueId: segue?.id ?? null,
        version: segue?.version ?? null,
      },
  );
  const dirty = !sameLanes(lanes, saved.lanes);
  const { guard, allowLeave } = useUnsavedChanges(dirty);

  const media = useQuery({
    ...segueMediaQuery(
      stationId,
      a.id,
      b.id,
      lanes.voices.map((v) => v.assetId),
    ),
    placeholderData: keepPreviousData,
  });
  const laneMedia: LaneMedia = useMemo(
    () => ({
      from: media.data?.items[a.id] ?? null,
      to: media.data?.items[b.id] ?? null,
      voices: media.data?.assets ?? {},
    }),
    [media.data, a.id, b.id],
  );
  const clips = useMemo(() => clipsOf(lanes, laneMedia), [lanes, laneMedia]);
  const extent = extentOf(clips);
  const bounds = padded(extent);
  const problem = useMemo(() => problemOf(lanes, laneMedia), [lanes, laneMedia]);
  const island = useMemo(() => {
    const plan = islandOf(lanes, laneMedia);
    return plan ? islandRange(plan, laneMedia) : null;
  }, [lanes, laneMedia]);

  // --- View, cursor, selection -----------------------------------------------------------
  const [view, setViewRaw] = useState<WaveformView>(() => initialView(transitionStart(lanes)));
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const setView = useCallback(
    (next: WaveformView) => setViewRaw(clampAxisView(next, boundsRef.current)),
    [],
  );
  const [cursor, setCursor] = useState(() => transitionStart(lanes) - ms(5000));
  const [selection, setSelection] = useState<Selection>({ lane: null, point: null });
  const [track, width] = useElementWidth<HTMLDivElement>();
  const lanesBox = useRef<HTMLDivElement>(null);

  // Pinch (Ctrl + wheel on trackpads) and Ctrl/⌘ + scroll zoom around the pointer; sideways
  // scroll (or Shift + scroll) pans. Plain vertical scroll is left to the page.
  useEffect(() => {
    const el = lanesBox.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = (track.current ?? el).getBoundingClientRect();
      setViewRaw((v) => {
        const spp = (v.toSample - v.fromSample) / Math.max(1, rect.width);
        if (e.ctrlKey || e.metaKey) {
          const anchor = v.fromSample + (e.clientX - rect.left) * spp;
          return clampAxisView(zoomView(v, Math.exp(-e.deltaY * 0.01), anchor), boundsRef.current);
        }
        const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
        if (!dx) return v;
        return clampAxisView(
          { fromSample: v.fromSample + dx * spp, toSample: v.toSample + dx * spp },
          boundsRef.current,
        );
      });
      if (e.ctrlKey || e.metaKey || e.deltaX || e.shiftKey) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [track]);

  const zoom = (factor: number) =>
    setView(
      zoomView(
        view,
        factor,
        cursor >= view.fromSample && cursor <= view.toSample
          ? cursor
          : (view.fromSample + view.toSample) / 2,
      ),
    );
  const fit = () => {
    const pad = (extent.to - extent.from) * 0.03;
    setView({ fromSample: extent.from - pad, toSample: extent.to + pad });
  };

  // --- Preview ---------------------------------------------------------------------------
  const player = useMemo(() => new SeguePlayer(stationId), [stationId]);
  useEffect(() => () => player.close(), [player]);
  // Decoded audio is large: keep only the files the lanes play now.
  useEffect(() => player.retain(clips.map((c) => c.media.sha256)), [clips, player]);
  const [phase, setPhase] = useState<PlayPhase>('idle');
  const playing = phase === 'playing';
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [preroll, setPreroll] = useState<number>(5);

  const play = async (from: number) => {
    // Playing from off screen: bring the start into view, a fifth from the left.
    if (from < view.fromSample || from > view.toSample) {
      const span = view.toSample - view.fromSample;
      setView({ fromSample: from - span / 5, toSample: from + (span * 4) / 5 });
    }
    // `player.play` stops what plays first (its `onEnd` sets idle), then loads: say so after.
    const started = player.play(clips, from, () => {
      setPhase('idle');
      setPlayhead(null);
    });
    setPhase('loading');
    try {
      // `cancelled`: a stop or a newer play came first and already set the phase.
      if ((await started) === 'playing') setPhase('playing');
    } catch {
      setPhase('idle');
      toast.error(t('audio.error'));
    }
  };
  /** Stops playback, or cancels a play still loading its audio. */
  const stop = () => {
    player.stop();
    setPhase('idle');
    setPlayhead(null);
  };
  const playBefore = () => {
    const from = transitionStart(lanes) - preroll * SR;
    setCursor(from);
    void play(from);
  };

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const at = player.position();
      setPlayhead(at);
      // Keep the playhead in sight: page the view when it runs off the right edge.
      if (at !== null) {
        setViewRaw((v) =>
          at > v.toSample
            ? clampAxisView(
                { fromSample: at, toSample: at + v.toSample - v.fromSample },
                boundsRef.current,
              )
            : v,
        );
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, player]);

  // Edits stop the preview: what plays must be what is shown.
  const edit = (next: Lanes) => {
    if (!canWrite) return;
    if (phase !== 'idle') stop();
    history.change(next);
  };

  // --- Save ------------------------------------------------------------------------------
  const errorMessage = useErrorMessage();
  // Someone else saved meanwhile: their version, while the user decides what to keep.
  const [conflict, setConflict] = useState<Lanes | null>(null);
  /**
   * On a 409: what the api has becomes the reference (its version is what the next save
   * overwrites), the user's draft and undo history stay. They keep editing theirs, or load the
   * other one as a new step (undo brings theirs back).
   */
  const takeTheirs = async () => {
    const fresh = await queryClient.fetchQuery({
      ...segueQuery(stationId, a.id, b.id),
      staleTime: 0,
    });
    setSaved({
      lanes: lanesOf(fresh),
      segueId: fresh?.id ?? null,
      version: fresh?.version ?? null,
    });
    setConflict(lanesOf(fresh));
  };
  const save = useMutation({
    mutationFn: (body: Lanes) =>
      saved.segueId
        ? segueApi.update(stationId, saved.segueId, {
            ...body,
            ...(saved.version !== null ? { version: saved.version } : {}),
          })
        : segueApi.create(stationId, { fromItemId: a.id, toItemId: b.id, ...body }),
    onSuccess: (result, body) => {
      setSaved({ lanes: body, segueId: result.id, version: result.version });
      queryClient.setQueryData(segueKey(stationId, a.id, b.id), result);
      toast.success(t('saved.toast'));
    },
    onError: async (error) => {
      if (isApiError(error) && error.status === 409) {
        await takeTheirs().catch((reloadError) => toast.error(errorMessage(reloadError)));
      } else if (isApiError(error) && error.status === 403) {
        toast.error(t('forbidden'));
      } else {
        toast.error(t('save.error', { reason: errorMessage(error) }));
      }
    },
  });
  const canSave = canWrite && dirty && !save.isPending && !problem;

  // The api re-syncs segues when the log or media move, and the renderer (#56) moves islands
  // through their states: refetch the segue to show its status.
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: segueKey(stationId, a.id, b.id) });
  useSseEvent('segue.changed', (e) => {
    if (e.data.fromItemId === a.id || e.data.toItemId === b.id) refresh();
  });
  useSseEvent('island.updated', (e) => {
    if (segue && e.data.segueIds.includes(segue.id)) refresh();
  });

  // --- Keyboard --------------------------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
      return;
    // Space on a focused button is that button's click, not play.
    if (e.key === ' ' && target?.closest('button, a, [role="menuitem"]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (!canWrite) return;
      if (e.shiftKey) history.redo();
      else history.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (canWrite) history.redo();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (canSave) save.mutate(lanes);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (phase !== 'idle') stop();
      else void play(cursor);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.lane && canWrite) {
      if (selection.point === null) return;
      e.preventDefault();
      edit(
        setLaneEnvelope(
          lanes,
          selection.lane,
          removePoint(laneEnvelope(lanes, selection.lane), selection.point),
        ),
      );
      setSelection({ lane: selection.lane, point: null });
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selection.lane && canWrite) {
      const start = laneStart(lanes, selection.lane);
      if (start === null) return;
      e.preventDefault();
      const by = ms(NUDGE_MS * (e.shiftKey ? 10 : 1)) * (e.key === 'ArrowLeft' ? -1 : 1);
      edit(moveLane(lanes, selection.lane, start + by));
    } else if (e.key === '+' || e.key === '=') {
      zoom(ZOOM_STEP);
    } else if (e.key === '-') {
      zoom(1 / ZOOM_STEP);
    } else if (e.key === 'Escape') {
      setSelection({ lane: null, point: null });
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // --- Voices ----------------------------------------------------------------------------
  const [picking, setPicking] = useState(false);

  // A take back from the recorder: one new voice (undoable), then off the URL so a reload or
  // a back navigation doesn't add it twice.
  const placing = useRef(placed);
  useEffect(() => {
    const take = placing.current;
    if (!take) return;
    placing.current = null;
    void navigate({
      to: '/stations/$stationId/log/segue',
      params: { stationId },
      search: { date, from: a.id, to: b.id },
      replace: true,
      // Same page, same draft: not a leave for the unsaved-changes guard.
      ignoreBlocker: true,
    });
    if (!canWrite || lanes.voices.some((v) => v.assetId === take.assetId)) return;
    if (lanes.voices.length >= 4) {
      toast.warning(t('record.full'));
      return;
    }
    const next = addRecordedVoice(lanes, take.assetId, take.at);
    history.change(next);
    setSelection({ lane: voiceKey(next.voices.length - 1), point: null });
  });

  /** Opens the recorder; the draft goes with it and comes back with the take. */
  const record = () => {
    if (phase !== 'idle') stop();
    stashDraft(stationId, a.id, b.id, { lanes, saved });
    allowLeave();
    void navigate({
      to: '/stations/$stationId/log/segue/record',
      params: { stationId },
      search: { date, from: a.id, to: b.id },
    });
  };

  // A voice's loudness is measured after its ingest: refetch the media for its playout gain.
  useSseEvent('asset.updated', (e) => {
    if (lanes.voices.some((v) => v.assetId === e.data.assetId)) {
      void queryClient.invalidateQueries({
        queryKey: ['stations', stationId, 'segues', 'media', a.id, b.id],
      });
    }
  });

  // --- Station time ----------------------------------------------------------------------
  const aEnd = laneMedia.from
    ? Date.parse(a.plannedStart) + ((laneMedia.from.cueOut - laneMedia.from.cueIn) / SR) * 1000
    : null;
  const onAir = (axis: number) =>
    aEnd === null ? t('timing.unknown') : formatClock(aEnd + (axis / SR) * 1000, timeZone);

  const missing = [!laneMedia.from && titleOf(a), !laneMedia.to && titleOf(b)].filter(
    (x): x is string => !!x,
  );

  const laneRow = (clip: Clip) => {
    const vi = voiceIndex(clip.key);
    const voice = vi === null ? null : lanes.voices[vi];
    const title =
      clip.key === 'out'
        ? t('lane.out')
        : clip.key === 'in'
          ? t('lane.in')
          : t('lane.voice', { n: (vi ?? 0) + 1 });
    const selected = selection.lane === clip.key;
    return (
      <div key={clip.key} className="contents">
        <LaneHeader
          stationId={stationId}
          label={title}
          title={clip.key === 'out' ? titleOf(a) : clip.key === 'in' ? titleOf(b) : undefined}
          assetId={clip.media.assetId}
          style={styleOf(clip.key)}
          height={vi === null ? LANE_HEIGHT : VOICE_HEIGHT}
          selected={selected}
          onSelect={() => setSelection({ lane: clip.key, point: null })}
        >
          {voice && vi !== null && canWrite && (
            <div className="flex items-center gap-1">
              <GainInput
                label={t('lane.gain')}
                value={voice.gainDb}
                onCommit={(gainDb) =>
                  edit({
                    ...lanes,
                    voices: lanes.voices.map((v, j) => (j === vi ? { ...v, gainDb } : v)),
                  })
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('lane.remove', { n: vi + 1 })}
                onClick={() => {
                  edit(removeVoice(lanes, vi));
                  setSelection({ lane: null, point: null });
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          )}
        </LaneHeader>
        <Lane
          stationId={stationId}
          clip={clip}
          title={title}
          view={view}
          width={width}
          height={vi === null ? LANE_HEIGHT : VOICE_HEIGHT}
          style={styleOf(clip.key)}
          t={t}
          movable={canWrite && clip.key !== 'out'}
          editable={canWrite}
          selected={selected}
          selectedPoint={selected ? selection.point : null}
          onSelect={(point) => setSelection({ lane: clip.key, point })}
          onSeek={setCursor}
          onBegin={() => {
            if (!canWrite) return;
            if (phase !== 'idle') stop();
            history.begin();
          }}
          onEnd={history.end}
          onMove={(start) => canWrite && history.change(moveLane(lanes, clip.key, start))}
          onEnvelope={(envelope) =>
            canWrite && history.change(setLaneEnvelope(lanes, clip.key, envelope))
          }
        />
      </div>
    );
  };

  const statusKey: SegueMessageKey = segue ? `status.${segue.status}` : 'status.new';
  const islandKey: SegueMessageKey = segue?.island
    ? `island.${segue.island.status}`
    : 'island.none';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {guard}
      <div className="flex flex-wrap items-center gap-3">
        {back}
        <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          {titleOf(a)} → {titleOf(b)}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={segue?.status === 'ready' ? 'secondary' : 'outline'}>
            {t(statusKey)}
          </Badge>
          {segue && (
            <Badge variant={segue.island?.status === 'failed' ? 'destructive' : 'outline'}>
              {t(islandKey)}
            </Badge>
          )}
          {canWrite && (
            <Button onClick={() => save.mutate(lanes)} disabled={!canSave}>
              <DelayedSpinner when={save.isPending} data-icon="inline-start" />
              {t('toolbar.save')}
            </Button>
          )}
        </div>
      </div>

      {missing.map((title) => (
        <Alert key={title}>
          <AlertDescription>{t('noMedia', { title })}</AlertDescription>
        </Alert>
      ))}
      {(problem ?? segue?.problem) && (
        <Alert variant="destructive">
          <AlertTitle>{t('problem.title')}</AlertTitle>
          <AlertDescription>{(problem ?? segue?.problem)?.message}</AlertDescription>
        </Alert>
      )}
      {media.isError && <FormAlert error={media.error} />}

      <Toolbar
        t={t}
        canWrite={canWrite}
        phase={phase}
        preroll={preroll}
        onPreroll={setPreroll}
        onPlay={() => (phase === 'idle' ? void play(cursor) : stop())}
        onPlayBefore={playBefore}
        canUndo={history.state.past.length > 0}
        canRedo={history.state.future.length > 0}
        onUndo={history.undo}
        onRedo={history.redo}
        onZoom={zoom}
        onFit={fit}
        onAddVoice={() => setPicking(true)}
        onRecord={record}
        canAddVoice={lanes.voices.length < 4}
        onDuck={(i) => {
          const preset = DUCK_PRESETS[i];
          if (preset) edit(applyDuck(lanes, laneMedia, preset));
        }}
        onFadeOut={() => edit(applyFadeOut(lanes, 2000))}
        onClear={() => edit(clearEnvelopes(lanes))}
      />

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
        <span>{t('cursor.at', { offset: formatOffset(cursor, 2), time: onAir(cursor) })}</span>
        <span className="text-muted-foreground">
          {t('incoming.at', {
            offset: formatOffset(lanes.in.start, 2),
            time: onAir(lanes.in.start),
          })}
        </span>
      </div>

      <Overview
        bounds={bounds}
        clips={clips}
        colors={Object.fromEntries(clips.map((c) => [c.key, styleOf(c.key).accent]))}
        island={island}
        view={view}
        cursor={playhead ?? cursor}
        t={t}
        onView={setView}
      />

      <div
        ref={lanesBox}
        id="segue-lanes"
        className="relative grid grid-cols-[9rem_1fr] gap-y-1 overflow-hidden rounded-md border"
      >
        <div className="border-b bg-muted/20" />
        <div ref={track} className="relative">
          <Ruler view={view} width={width} cursor={cursor} t={t} onSeek={setCursor} />
        </div>
        {clips.map(laneRow)}
        <div className="pointer-events-none absolute inset-y-0 right-0 left-36">
          <Cursor view={view} width={width} at={cursor} className="bg-destructive" />
          {playhead !== null && (
            <Cursor view={view} width={width} at={playhead} className="bg-primary" />
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>

      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('conflict.title')}</DialogTitle>
            <DialogDescription>{t('conflict.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (conflict) edit(conflict);
                setConflict(null);
              }}
            >
              {t('conflict.load')}
            </Button>
            <Button onClick={() => setConflict(null)}>{t('conflict.keep')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AssetPickerDialog
        stationId={stationId}
        open={picking}
        onOpenChange={setPicking}
        title={t('voice.pick')}
        initialKind="vt"
        kinds={['vt', 'jingle', 'bed']}
        onPick={(asset) => {
          setPicking(false);
          const next = addVoice(lanes, asset.id);
          edit(next);
          setSelection({ lane: voiceKey(next.voices.length - 1), point: null });
        }}
      />
    </div>
  );
}

/** A vertical line over the ruler and every lane: the cursor, the playhead. */
function Cursor({
  view,
  width,
  at,
  className,
}: {
  view: WaveformView;
  width: number;
  at: number;
  className: string;
}) {
  if (at < view.fromSample || at > view.toSample) return null;
  return (
    <div
      className={cn('absolute inset-y-0 w-px', className)}
      style={{ left: sampleToX(view, width, at) }}
    />
  );
}

function LaneHeader({
  stationId,
  label,
  title,
  assetId,
  style,
  height,
  selected,
  onSelect,
  children,
}: {
  stationId: string;
  label: string;
  /** A's and B's titles come from the log; a voice's from its asset. */
  title: string | undefined;
  assetId: string;
  style: LaneStyle;
  height: number;
  selected: boolean;
  onSelect(): void;
  children?: React.ReactNode;
}) {
  const asset = useQuery({ ...assetDetailQuery(stationId, assetId), enabled: title === undefined });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: lanes are selected from the keyboard by their controls; this is a pointer shortcut.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above.
    <div
      className={cn(
        'relative flex min-w-0 flex-col justify-center gap-1 border-r py-1 pr-2 pl-3',
        selected && 'bg-muted/50',
      )}
      style={{ height }}
      onClick={onSelect}
    >
      <span className={cn('absolute inset-y-1 left-0 w-1 rounded-[4px]', style.accent)} />
      <span className="text-xs font-medium">{label}</span>
      <span className="truncate text-xs text-muted-foreground">
        {title ?? asset.data?.title ?? ''}
      </span>
      {children}
    </div>
  );
}

function Toolbar(props: {
  t: SegueT;
  canWrite: boolean;
  phase: PlayPhase;
  preroll: number;
  onPreroll(seconds: number): void;
  onPlay(): void;
  onPlayBefore(): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onZoom(factor: number): void;
  onFit(): void;
  onAddVoice(): void;
  onRecord(): void;
  canAddVoice: boolean;
  onDuck(index: number): void;
  onFadeOut(): void;
  onClear(): void;
}) {
  const { t } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* While the audio loads the button is already Stop: a second press cancels, never overlaps. */}
      <Button onClick={props.onPlay} variant={props.phase === 'idle' ? 'default' : 'secondary'}>
        {props.phase === 'idle' ? (
          <PlayIcon data-icon="inline-start" />
        ) : (
          <SquareIcon data-icon="inline-start" />
        )}
        {props.phase === 'idle' ? t('toolbar.play') : t('toolbar.stop')}
        <DelayedSpinner when={props.phase === 'loading'} data-icon="inline-end" />
      </Button>
      <div className="flex items-center gap-1">
        <Button variant="outline" onClick={props.onPlayBefore} disabled={props.phase === 'loading'}>
          <RewindIcon data-icon="inline-start" />
          {t('toolbar.playBefore', { seconds: props.preroll })}
        </Button>
        <NativeSelect
          aria-label={t('toolbar.preroll')}
          value={String(props.preroll)}
          onChange={(e) => props.onPreroll(Number(e.target.value))}
        >
          {PREROLL_S.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {s} s
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('toolbar.zoomOut')}
          onClick={() => props.onZoom(1 / ZOOM_STEP)}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('toolbar.zoomIn')}
          onClick={() => props.onZoom(ZOOM_STEP)}
        >
          <ZoomInIcon />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t('toolbar.fit')} onClick={props.onFit}>
          <MaximizeIcon />
        </Button>
      </div>
      {props.canWrite && (
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('toolbar.undo')}
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            <Undo2Icon />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('toolbar.redo')}
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            <Redo2Icon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <SlidersHorizontalIcon data-icon="inline-start" />
              {t('toolbar.presets')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-72">
              {DUCK_PRESETS.map((p, i) => (
                <DropdownMenuItem key={`${p.depthDb}:${p.rampMs}`} onClick={() => props.onDuck(i)}>
                  {t('preset.duck', { depth: p.depthDb, ramp: p.rampMs })}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={props.onFadeOut}>{t('preset.fadeOut')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={props.onClear}>{t('preset.clear')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={props.onAddVoice} disabled={!props.canAddVoice}>
            <PlusIcon data-icon="inline-start" />
            {t('toolbar.addVoice')}
          </Button>
          <Button onClick={props.onRecord} disabled={!props.canAddVoice}>
            <MicIcon data-icon="inline-start" />
            {t('toolbar.record')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A voice's gain trim: typed as text (a lone "-" or "-1." is a draft, not 0), applied on blur
 * or Enter, clamped to the api's −60…+24 dB; Escape puts the current value back.
 */
function GainInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit(gainDb: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(',', '.').replace('−', '-'));
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(parsed)) return;
    const gainDb = Math.round(Math.max(-60, Math.min(24, parsed)) * 10) / 10;
    if (gainDb !== value) onCommit(gainDb);
  };
  return (
    <Input
      inputMode="decimal"
      aria-label={label}
      title={label}
      className="h-6 w-16 px-1 text-xs"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}
