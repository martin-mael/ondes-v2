import { type LocalDate, type LogItem, rolePermissions, zonedParts } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { CircleIcon, MicIcon, PlayIcon, RotateCcwIcon, SquareIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert, useErrorMessage } from '../../app/forms.tsx';
import { BackButton } from '../../app/page-header.tsx';
import { DelayedSpinner, PageSkeleton } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { fullView, WaveformEditor, type WaveformView } from '../cue-editor/waveform/index.ts';
import { logDayQuery } from '../log-timeline/api.ts';
import { hasSegue } from '../log-timeline/item-row.tsx';
import { segueMediaQuery, segueQuery } from '../segue-editor/api.ts';
import { peekDraft } from '../segue-editor/draft.ts';
import {
  type Clip,
  clipsOf,
  emptyLanes,
  type Lanes,
  sameLanes,
  transitionStart,
} from '../segue-editor/model.ts';
import { type TakeUploadPhase, takeFilename, uploadTake } from './api.ts';
import { useVtT, type VtT } from './messages.ts';
import { MAX_TAKE_SECONDS, VtRecorder } from './recorder.ts';
import {
  AXIS_RATE,
  CLIP_DBFS,
  clampTrim,
  encodeWav,
  peakDb,
  QUIET_DBFS,
  suggestTrim,
  type Take,
  type Trim,
  takePeaks,
  voiceLength,
  voiceStart,
} from './take.ts';

// The VT recorder (#59): pick a mic, watch its level, record a take, re-take, trim it on its
// waveform, then upload it as a `vt` asset (ingest measures its loudness: the playout gain
// brings it to the station's target, ADR 0025). Two entries:
// - from the segue editor (`log/segue/record`): the take is recorded over a pre-roll of the
//   segue as the editor had it (its draft is handed over), then placed back in the editor as
//   a new voice where it was spoken;
// - standalone (`voice-tracks/record`): no pre-roll, the take stays in the library (promos, #60).
// A full page: trimming is precision work.

const segueRoute = getRouteApi('/_app/stations/$stationId/log/segue/record');
const standaloneRoute = getRouteApi('/_app/stations/$stationId/voice-tracks/record');

const PREROLL_S = [5, 10, 20, 30] as const;

const titleOf = (item: LogItem) => item.asset?.title ?? item.title ?? '';

function useStation(stationId: string) {
  const station = findStation(useOrgs(), stationId)?.station;
  const permissions = station ? rolePermissions[station.role] : [];
  return {
    timeZone: station?.timezone ?? 'UTC',
    canRecord:
      permissions.includes('voice_track:write') || permissions.includes('voice_track:write_own'),
  };
}

/** Recording for a segue: the editor's draft (or the saved segue) plays as the pre-roll. */
export function SegueRecorderPage() {
  const t = useVtT();
  const { stationId } = segueRoute.useParams();
  const search = segueRoute.useSearch();
  const navigate = useNavigate();
  const { timeZone, canRecord } = useStation(stationId);
  const date = search.date ?? ('1970-01-01' as LocalDate);
  const from = search.from ?? '';
  const to = search.to ?? '';
  const valid = !!(search.date && search.from && search.to);
  const draft = useMemo(() => peekDraft(stationId, from, to), [stationId, from, to]);

  const log = useQuery({ ...logDayQuery(stationId, date, timeZone), enabled: valid });
  const segue = useQuery({ ...segueQuery(stationId, from, to), enabled: valid && !draft });
  const lanes: Lanes | null = draft
    ? draft.lanes
    : segue.data
      ? { out: segue.data.out, in: segue.data.in, voices: segue.data.voices }
      : segue.isSuccess
        ? emptyLanes()
        : null;
  const media = useQuery({
    ...segueMediaQuery(stationId, from, to, lanes?.voices.map((v) => v.assetId) ?? []),
    enabled: valid && lanes !== null,
  });

  // Back to the editor carries the draft back (`resume`); `beforeLeave` lets it through the
  // unsaved guard when only the draft is unsaved, since it isn't lost.
  const back = (beforeLeave?: () => void) => (
    <BackButton
      nativeButton={false}
      render={
        <Link
          to="/stations/$stationId/log/segue"
          params={{ stationId }}
          search={{ date: search.date, from: search.from, to: search.to, resume: true }}
          onClick={beforeLeave}
        />
      }
    >
      {t('back.segue')}
    </BackButton>
  );
  const problem = (message: React.ReactNode) => (
    <div className="flex flex-col items-start gap-4 p-6">
      {back()}
      {message}
    </div>
  );

  if (!valid) return problem(<p className="text-sm text-muted-foreground">{t('notFound')}</p>);
  if (!canRecord) return problem(<p className="text-sm text-muted-foreground">{t('forbidden')}</p>);
  if (log.isError || segue.isError) return problem(<FormAlert error={log.error ?? segue.error} />);
  if (log.isPending || !lanes || media.isPending) return <PageSkeleton />;
  const items = log.data.items;
  const i = items.findIndex((item) => item.id === from);
  const a = items[i];
  const b = items[i + 1];
  if (!a || !b || b.id !== to || !hasSegue(a) || !hasSegue(b)) {
    return problem(<p className="text-sm text-muted-foreground">{t('notFound')}</p>);
  }
  const clips = media.data
    ? clipsOf(lanes, {
        from: media.data.items[a.id] ?? null,
        to: media.data.items[b.id] ?? null,
        voices: media.data.assets,
      })
    : [];
  const music = clips.some((c) => c.key === 'out') ? clips : null;

  return (
    <Recorder
      stationId={stationId}
      title={t('title.segue')}
      subtitle={`${titleOf(a)} → ${titleOf(b)}`}
      defaultName={t('save.defaultName', { from: titleOf(a), to: titleOf(b) })}
      back={back}
      draftDirty={!!draft && !sameLanes(draft.lanes, draft.saved.lanes)}
      preroll={music && { clips: music, transitionStart: transitionStart(lanes) }}
      prerollMissing={!music}
      saveLabel={t('save.place')}
      onUploaded={(assetId, at, length, allowLeave) => {
        toast.success(t('save.placed'));
        allowLeave();
        void navigate({
          to: '/stations/$stationId/log/segue',
          params: { stationId },
          search: { date: search.date, from, to, voice: assetId, at: at ?? undefined, length },
        });
      }}
    />
  );
}

/** A standalone take (a promo): no pre-roll, uploaded to the library. */
export function VtRecorderPage() {
  const t = useVtT();
  const { stationId } = standaloneRoute.useParams();
  const navigate = useNavigate();
  const { timeZone, canRecord } = useStation(stationId);
  const back = () => (
    <BackButton
      nativeButton={false}
      render={<Link to="/stations/$stationId/library" params={{ stationId }} />}
    >
      {t('back.library')}
    </BackButton>
  );
  if (!canRecord) {
    return (
      <div className="flex flex-col items-start gap-4 p-6">
        {back()}
        <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
      </div>
    );
  }
  const now = zonedParts(new Date(), timeZone);
  return (
    <Recorder
      stationId={stationId}
      title={t('title')}
      defaultName={t('save.defaultStandalone', { date: now.date, time: now.time })}
      back={back}
      draftDirty={false}
      preroll={null}
      prerollMissing={false}
      saveLabel={t('save.library')}
      onUploaded={(_assetId, _at, _length, allowLeave) => {
        toast.success(t('save.done'));
        allowLeave();
        void navigate({ to: '/stations/$stationId/library', params: { stationId } });
      }}
    />
  );
}

type MicState =
  | { status: 'closed' }
  | { status: 'opening' }
  | { status: 'open'; deviceId: string | null }
  | { status: 'error'; message: string };

type Phase = 'idle' | 'starting' | 'recording';

/** Wakes uploads waiting on ingest when their `upload.updated` event arrives. */
const wakers = new Map<string, () => void>();

function Recorder({
  stationId,
  title,
  subtitle,
  defaultName,
  back,
  draftDirty,
  preroll,
  prerollMissing,
  saveLabel,
  onUploaded,
}: {
  stationId: string;
  title: string;
  subtitle?: string;
  defaultName: string;
  /** The back link; `beforeLeave` runs on its click. */
  back: (beforeLeave?: () => void) => React.ReactNode;
  /** The segue editor's draft that came along is unsaved: leaving elsewhere loses it. */
  draftDirty: boolean;
  /** The segue's clips and where its transition starts, or null to record without music. */
  preroll: { clips: readonly Clip[]; transitionStart: number } | null;
  prerollMissing: boolean;
  saveLabel: string;
  onUploaded(
    assetId: string,
    voiceStart: number | null,
    length: number,
    allowLeave: () => void,
  ): void;
}) {
  const t = useVtT();
  const errorMessage = useErrorMessage();
  // Made in an effect, not a memo: a closed recorder stays closed, and StrictMode's remount
  // must get a fresh one.
  const [recorder, setRecorder] = useState<VtRecorder | null>(null);
  useEffect(() => {
    const next = new VtRecorder(stationId);
    setRecorder(next);
    return () => next.close();
  }, [stationId]);

  // --- Microphone ------------------------------------------------------------------------
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const [mic, setMic] = useState<MicState>({ status: 'closed' });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const openMic = async (deviceId?: string) => {
    if (!recorder) return;
    setMic({ status: 'opening' });
    try {
      const opened = await recorder.open(deviceId);
      // Closed (left the page) or a newer choice won: that one sets the state.
      if (opened === 'superseded') return;
      setMic({ status: 'open', deviceId: opened.deviceId });
      setDevices(await recorder.devices().catch(() => []));
    } catch (error) {
      const denied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setMic({
        status: 'error',
        message: denied
          ? t('mic.denied')
          : t('mic.error', { reason: error instanceof Error ? error.message : String(error) }),
      });
    }
  };

  // --- Recording -------------------------------------------------------------------------
  const [prerollS, setPrerollS] = useState<number>(10);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [trim, setTrim] = useState<Trim>({ from: 0, to: 0 });
  const [view, setView] = useState<WaveformView>(fullView(1));

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 200);
    return () => clearInterval(timer);
  }, [phase]);

  const finish = () => {
    const next = recorder?.stop();
    setPhase('idle');
    if (!next) return;
    setTake(next);
    setTrim(suggestTrim(next.samples, next.sampleRate));
    setView(fullView(next.samples.length));
  };

  const finishRef = useRef(finish);
  finishRef.current = finish;

  const start = async () => {
    if (!recorder) return;
    stopTake();
    setElapsed(0);
    setPhase('starting');
    try {
      const music = preroll && {
        clips: preroll.clips,
        from: preroll.transitionStart - prerollS * AXIS_RATE,
      };
      const result = await recorder.record(music, {
        onLimit: () => {
          finishRef.current();
          toast.info(t('record.limitReached', { minutes: MAX_TAKE_SECONDS / 60 }));
        },
      });
      if (result === 'playing') setPhase('recording');
    } catch {
      recorder.stop();
      setPhase('idle');
      toast.error(t('record.audioError'));
    }
  };

  // --- Take playback ---------------------------------------------------------------------
  const [listening, setListening] = useState<'take' | 'music' | null>(null);
  const stopTake = () => {
    recorder?.stopPlayback();
    setListening(null);
  };
  const listen = async (withMusic: boolean) => {
    if (!take || !recorder) return;
    stopTake();
    setListening(withMusic ? 'music' : 'take');
    try {
      const result = await recorder.playTake(
        take,
        trim,
        withMusic ? (preroll?.clips ?? null) : null,
        () => setListening(null),
      );
      if (result === 'cancelled') setListening(null);
    } catch {
      setListening(null);
      toast.error(t('record.audioError'));
    }
  };

  // --- Upload ----------------------------------------------------------------------------
  const [name, setName] = useState(defaultName);
  const [upload, setUpload] = useState<TakeUploadPhase | null>(null);
  const uploading = upload !== null;
  const holdsWork = take !== null || phase !== 'idle';
  const { guard, allowLeave } = useUnsavedChanges(holdsWork || draftDirty);
  useSseEvent('upload.updated', (e) => wakers.get(e.data.id)?.());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const save = async () => {
    if (!take || uploading) return;
    stopTake();
    const bytes = encodeWav(take.samples, take.sampleRate, trim);
    const file = new File([bytes.buffer as ArrayBuffer], takeFilename(name || defaultName), {
      type: 'audio/wav',
    });
    const controller = new AbortController();
    abort.current = controller;
    setUpload({ phase: 'uploading', pct: 0 });
    try {
      const assetId = await uploadTake(stationId, file, setUpload, {
        signal: controller.signal,
        waitForChange: (uploadId, ms, signal) =>
          new Promise<void>((resolve, reject) => {
            const done = () => {
              clearTimeout(timer);
              wakers.delete(uploadId);
              resolve();
            };
            const timer = setTimeout(done, ms);
            wakers.set(uploadId, done);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              wakers.delete(uploadId);
              reject(signal.reason);
            });
          }),
      });
      onUploaded(assetId, voiceStart(take, trim), voiceLength(take, trim), allowLeave);
    } catch (error) {
      if (controller.signal.aborted) return;
      setUpload(null);
      if (isApiError(error) && error.code === 'still_processing') {
        toast.warning(t('save.stillProcessing'));
      } else {
        toast.error(t('save.error', { reason: errorMessage(error) }));
      }
    }
  };

  // --- Checks (calm warnings, never a block) ---------------------------------------------
  const keptPeak = take ? peakDb(take.samples, trim.from, trim.to) : null;
  const empty = take !== null && take.samples.length === 0;
  const recording = phase !== 'idle';
  const open = mic.status === 'open';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {guard}
      <div className="flex flex-wrap items-center gap-3">
        {back(() => {
          // Only the draft is unsaved: it goes back with this link, nothing is lost.
          if (!holdsWork) allowLeave();
        })}
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        {subtitle && <p className="min-w-0 truncate text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-sm font-medium">{t('mic.title')}</h2>
        {!supported ? (
          <Alert>
            <AlertDescription>{t('mic.unsupported')}</AlertDescription>
          </Alert>
        ) : (
          <>
            {mic.status === 'error' && (
              <Alert variant="destructive">
                <AlertDescription>{mic.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {!open ? (
                <Button onClick={() => void openMic()} disabled={mic.status === 'opening'}>
                  <MicIcon data-icon="inline-start" />
                  {t('mic.allow')}
                  <DelayedSpinner when={mic.status === 'opening'} data-icon="inline-end" />
                </Button>
              ) : (
                <NativeSelect
                  aria-label={t('mic.device')}
                  value={mic.deviceId ?? ''}
                  disabled={recording}
                  onChange={(e) => void openMic(e.target.value || undefined)}
                >
                  {devices.length === 0 && (
                    <NativeSelectOption value="">{t('mic.default')}</NativeSelectOption>
                  )}
                  {devices.map((d, i) => (
                    <NativeSelectOption key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `${t('mic.device')} ${i + 1}`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              <Meter source={open ? recorder : null} label={t('mic.level')} />
            </div>
            {preroll && <p className="text-xs text-muted-foreground">{t('mic.headphones')}</p>}
          </>
        )}
      </section>

      {prerollMissing && (
        <Alert>
          <AlertDescription>{t('record.noMusic')}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {recording ? (
          <Button variant="destructive" onClick={finish}>
            <SquareIcon data-icon="inline-start" />
            {t('record.stop')}
            <DelayedSpinner when={phase === 'starting'} data-icon="inline-end" />
          </Button>
        ) : (
          <Button onClick={() => void start()} disabled={!open || uploading}>
            {take ? (
              <RotateCcwIcon data-icon="inline-start" />
            ) : (
              <CircleIcon data-icon="inline-start" />
            )}
            {take ? t('record.retake') : t('record.start')}
          </Button>
        )}
        {preroll && (
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label={t('record.preroll')}
              value={String(prerollS)}
              disabled={recording}
              onChange={(e) => setPrerollS(Number(e.target.value))}
            >
              {PREROLL_S.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s} s
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="text-sm text-muted-foreground">
              {t('record.prerollHint', { seconds: prerollS })}
            </span>
          </div>
        )}
        {phase === 'recording' && (
          <span className="flex items-center gap-2 text-sm tabular-nums" role="status">
            <span className="size-2 rounded-full bg-destructive" />
            {t('record.recording', { time: formatTime(elapsed) })}
          </span>
        )}
        {phase === 'recording' && elapsed >= MAX_TAKE_SECONDS - 60 && (
          <span className="text-sm text-muted-foreground">
            {t('record.limitSoon', { time: formatTime(MAX_TAKE_SECONDS) })}
          </span>
        )}
      </div>

      {take && !recording && (
        <TakePanel
          t={t}
          take={take}
          trim={trim}
          view={view}
          onView={setView}
          onTrim={(next) => setTrim(clampTrim(next, take.samples.length, take.sampleRate))}
          listening={listening}
          canPlayMusic={!!preroll && take.axisStart !== null}
          onListen={(withMusic) => void listen(withMusic)}
          onStop={stopTake}
          empty={empty}
          keptPeak={keptPeak}
        />
      )}

      {take && !recording && !empty && (
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full max-w-md">
            <FieldLabel htmlFor="vt-name">{t('save.name')}</FieldLabel>
            <Input
              id="vt-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button onClick={() => void save()} disabled={uploading}>
            <DelayedSpinner when={uploading} data-icon="inline-start" />
            {saveLabel}
          </Button>
          {upload && (
            <span className="pb-2 text-sm text-muted-foreground tabular-nums" role="status">
              {upload.phase === 'uploading'
                ? t('save.uploading', { pct: upload.pct })
                : t('save.processing')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TakePanel({
  t,
  take,
  trim,
  view,
  onView,
  onTrim,
  listening,
  canPlayMusic,
  onListen,
  onStop,
  empty,
  keptPeak,
}: {
  t: VtT;
  take: Take;
  trim: Trim;
  view: WaveformView;
  onView(view: WaveformView): void;
  onTrim(trim: Trim): void;
  listening: 'take' | 'music' | null;
  canPlayMusic: boolean;
  onListen(withMusic: boolean): void;
  onStop(): void;
  empty: boolean;
  keptPeak: number | null;
}) {
  const peaks = useMemo(() => takePeaks(take.samples, take.sampleRate), [take]);
  const seconds = (n: number) => formatTime(n / take.sampleRate, true);
  if (empty) {
    return (
      <Alert>
        <AlertDescription>{t('take.empty')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">{t('take.title')}</h2>
        <span className="text-sm text-muted-foreground tabular-nums">
          {t('take.length', {
            length: seconds(trim.to - trim.from),
            total: seconds(take.samples.length),
          })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {listening ? (
            <Button variant="secondary" onClick={onStop}>
              <SquareIcon data-icon="inline-start" />
              {t('take.stop')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onListen(false)}>
                <PlayIcon data-icon="inline-start" />
                {t('take.play')}
              </Button>
              {canPlayMusic && (
                <Button variant="outline" onClick={() => onListen(true)}>
                  <PlayIcon data-icon="inline-start" />
                  {t('take.playMusic')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <WaveformEditor
        peaks={peaks}
        view={view}
        onViewChange={onView}
        height={160}
        aria-label={t('take.waveform')}
        className="rounded-md border text-amber-600 dark:text-amber-400"
        regions={[
          { id: 'before', fromSample: 0, toSample: trim.from, color: 'var(--muted-foreground)' },
          {
            id: 'after',
            fromSample: trim.to,
            toSample: take.samples.length,
            color: 'var(--muted-foreground)',
          },
        ]}
        markers={[
          {
            id: 'in',
            sample: trim.from,
            label: t('take.in'),
            title: t('take.inTitle'),
            color: 'var(--chart-2)',
          },
          {
            id: 'out',
            sample: trim.to,
            label: t('take.out'),
            title: t('take.outTitle'),
            color: 'var(--chart-5)',
          },
        ]}
        onMarkerChange={(id, sample) =>
          onTrim(id === 'in' ? { ...trim, from: sample } : { ...trim, to: sample })
        }
        formatSample={seconds}
      />
      <p className="text-xs text-muted-foreground">{t('take.trim')}</p>
      {keptPeak !== null && keptPeak >= CLIP_DBFS && (
        <Alert>
          <AlertDescription>{t('take.clipping')}</AlertDescription>
        </Alert>
      )}
      {keptPeak !== null && keptPeak < QUIET_DBFS && (
        <Alert>
          <AlertDescription>{t('take.quiet')}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">{t('take.loudness')}</p>
    </section>
  );
}

/** The input level, −60…0 dBFS, with a peak hold. Drawn from its own frame loop. */
function Meter({ source, label }: { source: { level(): number } | null; label: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!source) return;
    let held = 0;
    let heldAt = 0;
    let level = 0;
    let frame = requestAnimationFrame(function tick(now) {
      const peak = source.level();
      // Fast attack, slow release, like a PPM.
      level = peak > level ? peak : level * 0.92;
      if (peak >= held || now - heldAt > 1500) {
        held = peak;
        heldAt = now;
      }
      const pct = (amp: number) =>
        amp <= 0 ? 0 : Math.max(0, Math.min(100, ((20 * Math.log10(amp) + 60) / 60) * 100));
      if (bar.current) bar.current.style.width = `${pct(level)}%`;
      if (hold.current) {
        hold.current.style.left = `${pct(held)}%`;
        hold.current.dataset.clip = String(held >= 10 ** (CLIP_DBFS / 20));
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [source]);
  return (
    <div
      title={label}
      aria-hidden
      className="relative h-3 w-64 max-w-full overflow-hidden rounded-[4px] bg-muted"
    >
      <div
        ref={bar}
        className="absolute inset-y-0 left-0 w-0 bg-linear-to-r from-emerald-500 from-70% via-amber-500 via-90% to-red-500"
        style={{ backgroundSize: '16rem 100%' }}
      />
      <div
        ref={hold}
        className="absolute inset-y-0 w-0.5 bg-foreground data-[clip=true]:bg-red-600"
      />
    </div>
  );
}

/** `m:ss`, or `m:ss.t` with tenths. */
function formatTime(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${m}:${sec}`;
}
