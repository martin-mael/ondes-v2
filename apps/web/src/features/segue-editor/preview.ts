import {
  clipEnvelope,
  dbToAmplitude,
  envelopeAutomation,
  type GainAutomationEvent,
  SEGUE_MAX_VOICES,
  type SegueMedia,
} from '@ondes/shared';
import { assetAudioUrl } from '../log-timeline/api.ts';
import { type Clip, clipEnd, SR } from './model.ts';

// The editor's WebAudio preview (#58): the lanes mixed as the island renderer (#56) mixes them.
// Each clip is an AudioBufferSourceNode (its playout copy, decoded at 44.1 kHz) into a GainNode
// at its static gain (`dbToAmplitude(playout gain + trim)`) into a GainNode driven by its
// envelope (`envelopeAutomation`, linear ramps in amplitude: the renderer's formula, see
// packages/shared/src/segues/gain.ts). No ducking or limiting on top: what plays is the island.

/** One clip's part of a playback started at axis position `from`. */
export interface PreviewVoice {
  key: Clip['key'];
  media: SegueMedia;
  /** Samples after the start before it sounds. */
  delay: number;
  /** First file sample it plays. */
  offset: number;
  /** Samples it plays. */
  duration: number;
  /** Static gain, linear. */
  gain: number;
  /** Envelope automation from the start (sample 0 = `from`), and the gain before its first event. */
  envelope: GainAutomationEvent[];
  envelopeStart: number;
}

/** What to schedule to play the clips from axis position `from`, and for how long. */
export function previewPlan(
  clips: readonly Clip[],
  from: number,
): { voices: PreviewVoice[]; length: number } {
  const end = Math.max(from, ...clips.map(clipEnd));
  const length = end - from;
  const voices: PreviewVoice[] = [];
  for (const c of clips) {
    const stop = clipEnd(c);
    if (stop <= from) continue;
    const begin = Math.max(c.at, from);
    const envelope = envelopeAutomation(clipEnvelope(c.envelope, -from, length));
    voices.push({
      key: c.key,
      media: c.media,
      delay: begin - from,
      offset: c.from + begin - c.at,
      duration: stop - begin,
      gain: dbToAmplitude(c.gainDb),
      envelope,
      envelopeStart: envelope[0]?.value ?? 1,
    });
  }
  return { voices, length };
}

/**
 * Decoded playout copies kept, by sha256: at most one per lane (A, B and the voices). Decoded
 * PCM is large (a 3-minute stereo song is about 60 MB of float32), so the page also drops the
 * files no lane plays any more ({@link SeguePlayer.retain}) and everything on unmount.
 */
export const BUFFER_CACHE_SIZE = SEGUE_MAX_VOICES + 2;

/** What the player needs from the platform; tests pass fakes. */
export interface PlayerDeps {
  createContext(): AudioContext;
  fetchAudio(url: string): Promise<ArrayBuffer>;
}

const browserDeps: PlayerDeps = {
  createContext: () => new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }),
  fetchAudio: async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`audio ${res.status}`);
    return res.arrayBuffer();
  },
};

/** `play` resolved without playing: a `stop()` or a newer `play()` came first. */
export type PlayResult = 'playing' | 'cancelled';

export class SeguePlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private nodes: AudioScheduledSourceNode[] = [];
  private started: { at: number; from: number; length: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onEnd: (() => void) | null = null;
  /** Bumped by every `play()` and `stop()`: a play still loading its audio checks it's current. */
  private generation = 0;
  private readonly stationId: string;
  private readonly deps: PlayerDeps;

  constructor(stationId: string, deps: PlayerDeps = browserDeps) {
    this.stationId = stationId;
    this.deps = deps;
  }

  private context(): AudioContext {
    this.ctx ??= this.deps.createContext();
    return this.ctx;
  }

  /** Fetches and decodes a playout copy (the audio route redirects to storage, CORS GET). */
  load(media: SegueMedia): Promise<AudioBuffer> {
    const cached = this.buffers.get(media.sha256);
    if (cached) {
      this.buffers.delete(media.sha256);
      this.buffers.set(media.sha256, cached);
      return cached;
    }
    const ctx = this.context();
    const loading = this.deps
      .fetchAudio(assetAudioUrl(this.stationId, media.assetId, media.sha256))
      .then((bytes) => ctx.decodeAudioData(bytes));
    loading.catch(() => {
      if (this.buffers.get(media.sha256) === loading) this.buffers.delete(media.sha256);
    });
    this.buffers.set(media.sha256, loading);
    while (this.buffers.size > BUFFER_CACHE_SIZE) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
    }
    return loading;
  }

  /** Drops the decoded files not in `sha256s` (the lanes changed). */
  retain(sha256s: Iterable<string>): void {
    const keep = new Set(sha256s);
    for (const key of [...this.buffers.keys()]) if (!keep.has(key)) this.buffers.delete(key);
  }

  /**
   * Plays the clips from axis position `from`; `onEnd` once it ran out or was stopped. While
   * the audio loads, a `stop()` or another `play()` cancels it: it resolves `cancelled` and
   * schedules nothing, so two plays never overlap.
   */
  async play(clips: readonly Clip[], from: number, onEnd: () => void): Promise<PlayResult> {
    this.stop();
    const generation = this.generation;
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    const plan = previewPlan(clips, from);
    const buffers = await Promise.all(plan.voices.map((v) => this.load(v.media)));
    if (generation !== this.generation) return 'cancelled';
    // A little lead so every node starts on the same clock tick.
    const t0 = ctx.currentTime + 0.05;
    const time = (samples: number) => t0 + samples / SR;
    plan.voices.forEach((v, i) => {
      const source = ctx.createBufferSource();
      source.buffer = buffers[i] as AudioBuffer;
      const gain = ctx.createGain();
      gain.gain.value = v.gain;
      const envelope = ctx.createGain();
      envelope.gain.value = v.envelopeStart;
      for (const e of v.envelope) {
        if (e.ramp) envelope.gain.linearRampToValueAtTime(e.value, time(e.at));
        else envelope.gain.setValueAtTime(e.value, time(e.at));
      }
      source.connect(gain).connect(envelope).connect(ctx.destination);
      source.start(time(v.delay), v.offset / SR, v.duration / SR);
      this.nodes.push(source);
    });
    this.started = { at: t0, from, length: plan.length };
    this.onEnd = onEnd;
    this.timer = setTimeout(() => this.stop(), (plan.length / SR + 0.1) * 1000);
    return 'playing';
  }

  /**
   * When the playback started: the context time `at` that axis position `from` sounds (before
   * the output latency). The VT recorder (#59) aligns its takes on it; null when stopped.
   */
  startedAt(): { at: number; from: number } | null {
    return this.started && { at: this.started.at, from: this.started.from };
  }

  /** The axis position playing now, or null when stopped. */
  position(): number | null {
    if (!this.started || !this.ctx) return null;
    const elapsed = Math.max(0, this.ctx.currentTime - this.started.at) * SR;
    return this.started.from + Math.min(elapsed, this.started.length);
  }

  /** Stops what plays, and cancels a play still loading its audio. */
  stop(): void {
    this.generation++;
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Not started yet or already stopped.
      }
      node.disconnect();
    }
    this.nodes = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const wasPlaying = this.started !== null;
    this.started = null;
    const onEnd = this.onEnd;
    this.onEnd = null;
    if (wasPlaying) onEnd?.();
  }

  /** Stops and releases the audio context and every decoded file. */
  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.buffers.clear();
  }
}
