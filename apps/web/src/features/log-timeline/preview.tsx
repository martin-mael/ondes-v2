import type { LogItem, LogSegmentPart } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { SquareIcon, Volume2Icon } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { assetAudioUrl, assetDetailQuery, timelineApi } from './api.ts';
import { useTimelineT } from './messages.ts';
import { cueInSeconds, PREVIEW_TAIL_S, transitionPlan } from './model.ts';

// Listening in the timeline (#51): one item from its cue-in, or the transition between two
// items as the log plans it (the outgoing item's last seconds, then the incoming one from its
// cue-in at the planned start, both playing through the overlap). Two <audio> elements on the
// asset's audio route (a redirect to its playout copy). It approximates the engine's mix: no
// fades or loudness gain, but the timing is the plan's.

type Audible = Pick<LogItem, 'id' | 'assetId' | 'cueOverrides' | 'plannedDurationMs' | 'title'> & {
  asset: LogItem['asset'];
};

/** What actually sounds for an item: itself, or for an island its first/last part. */
export function audibleOf(item: LogItem, end: 'first' | 'last'): Audible | null {
  if (item.kind !== 'segment') return item.assetId ? item : null;
  const part: LogSegmentPart | undefined = end === 'first' ? item.parts[0] : item.parts.at(-1);
  if (!part?.assetId) return null;
  if (end === 'first') return part;
  // Out of an island: its last part, minus the segment's overlap into the next item.
  const crossOut = item.cueOverrides?.crossOutMs ?? 0;
  return { ...part, plannedDurationMs: Math.max(0, part.plannedDurationMs - crossOut) };
}

const titleOf = (a: Audible) => a.asset?.title ?? a.title ?? '';

interface Playing {
  label: string;
}

export interface Preview {
  playing: Playing | null;
  play(item: LogItem): void;
  playAsset(assetId: string, title: string): void;
  playTransition(from: LogItem, to: LogItem): void;
  stop(): void;
}

const PreviewContext = createContext<Preview | null>(null);

/**
 * Loads `src` and plays it from `seconds` once the browser knows the media. The handlers are
 * the element's single `on…` slots, so a new load or a stop replaces or clears them: nothing
 * piles up and nothing from an old run fires.
 */
function startAt(audio: HTMLAudioElement, src: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    audio.onloadedmetadata = () => {
      audio.onloadedmetadata = null;
      audio.currentTime = seconds;
      audio.play().then(resolve, reject);
    };
    audio.onerror = () => reject(new Error('audio error'));
    audio.src = src;
    audio.load();
  });
}

function silence(audio: HTMLAudioElement) {
  audio.onloadedmetadata = null;
  audio.onerror = null;
  audio.onended = null;
  audio.pause();
  audio.removeAttribute('src');
}

/** One listening run: a stop or a newer run aborts it, and its continuations check it. */
interface Run {
  id: number;
  abort: AbortController;
}

const live = (r: Run) => !r.abort.signal.aborted;

export function PreviewProvider({
  stationId,
  children,
}: {
  stationId: string;
  children: ReactNode;
}) {
  const t = useTimelineT();
  const queryClient = useQueryClient();
  const [playing, setPlaying] = useState<Playing | null>(null);
  const audios = useRef<[HTMLAudioElement, HTMLAudioElement] | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const run = useRef<Run>({ id: 0, abort: new AbortController() });

  const elements = useCallback(() => {
    audios.current ??= [new Audio(), new Audio()];
    return audios.current;
  }, []);

  /** Ends the current run (if any) and starts a new one. */
  const next = useCallback((): Run => {
    run.current.abort.abort();
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    for (const audio of audios.current ?? []) silence(audio);
    run.current = { id: run.current.id + 1, abort: new AbortController() };
    return run.current;
  }, []);

  const stop = useCallback(() => {
    next();
    setPlaying(null);
  }, [next]);
  // Unmount: abort pending fetches and silence both elements.
  useEffect(() => () => void next(), [next]);

  /** The asset's cues and playout version, from the cache or the api (aborted with the run). */
  const media = useCallback(
    async (assetId: string, r: Run) => {
      const key = assetDetailQuery(stationId, assetId).queryKey;
      const detail =
        queryClient.getQueryData<Awaited<ReturnType<typeof timelineApi.asset>>>(key) ??
        (await timelineApi.asset(stationId, assetId, r.abort.signal));
      queryClient.setQueryData(key, detail);
      const sha = detail.files.find((f) => f.role === 'playout')?.sha256;
      return { cues: detail.cues, url: assetAudioUrl(stationId, assetId, sha) };
    },
    [queryClient, stationId],
  );

  const failed = useCallback(
    (r: Run) => {
      if (!live(r)) return;
      toast.error(t('preview.failed'));
      stop();
    },
    [stop, t],
  );

  const playAudible = useCallback(
    (a: Audible | null) => {
      if (!a?.assetId) return;
      const assetId = a.assetId;
      const r = next();
      setPlaying({ label: t('preview.playing', { title: titleOf(a) || t('untitled') }) });
      const [audio] = elements();
      void media(assetId, r)
        .then(({ cues, url }) => {
          if (!live(r)) return;
          audio.onended = () => live(r) && stop();
          return startAt(audio, url, cueInSeconds(a, cues));
        })
        .catch(() => failed(r));
    },
    [elements, failed, media, next, stop, t],
  );
  const play = useCallback((item: LogItem) => playAudible(audibleOf(item, 'first')), [playAudible]);
  const playAsset = useCallback(
    (assetId: string, title: string) =>
      playAudible({
        id: assetId,
        assetId,
        cueOverrides: null,
        plannedDurationMs: 0,
        title,
        asset: null,
      }),
    [playAudible],
  );

  const playTransition = useCallback(
    (from: LogItem, to: LogItem) => {
      const a = audibleOf(from, 'last');
      const b = audibleOf(to, 'first');
      if (!a?.assetId || !b?.assetId) return;
      const aId = a.assetId;
      const bId = b.assetId;
      const r = next();
      setPlaying({
        label: t('preview.transition', {
          from: titleOf(a) || t('untitled'),
          to: titleOf(b) || t('untitled'),
        }),
      });
      const [outgoing, incoming] = elements();
      void Promise.all([media(aId, r), media(bId, r)])
        .then(async ([ma, mb]) => {
          if (!live(r)) return;
          const plan = transitionPlan(a, ma.cues, b, mb.cues);
          // Load the incoming file first so it starts on time.
          incoming.onerror = () => failed(r);
          incoming.src = mb.url;
          incoming.load();
          await startAt(outgoing, ma.url, plan.fromS);
          if (!live(r)) return;
          const leadMs = (plan.switchS - plan.fromS) * 1000;
          timers.current.push(
            setTimeout(() => {
              if (!live(r)) return;
              incoming.currentTime = plan.intoS;
              incoming.play().catch(() => failed(r));
            }, leadMs),
            setTimeout(() => live(r) && stop(), leadMs + PREVIEW_TAIL_S * 1000),
          );
        })
        .catch(() => failed(r));
    },
    [elements, failed, media, next, stop, t],
  );

  const value = useMemo(
    () => ({ playing, play, playAsset, playTransition, stop }),
    [playing, play, playAsset, playTransition, stop],
  );
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview(): Preview {
  const preview = useContext(PreviewContext);
  if (!preview) throw new Error('usePreview needs a <PreviewProvider>');
  return preview;
}

/** What is playing, with a stop button. Nothing when idle. */
export function PreviewBar() {
  const t = useTimelineT();
  const { playing, stop } = usePreview();
  if (!playing) return null;
  return (
    <output
      aria-live="polite"
      className="sticky bottom-4 z-10 mx-auto flex w-fit items-center gap-3 rounded-full border bg-popover px-4 py-2 text-sm shadow-md"
    >
      <Volume2Icon className="size-4 text-primary" aria-hidden />
      <span>{playing.label}</span>
      <Button size="sm" variant="outline" onClick={stop}>
        <SquareIcon data-icon="inline-start" />
        {t('preview.stop')}
      </Button>
    </output>
  );
}
