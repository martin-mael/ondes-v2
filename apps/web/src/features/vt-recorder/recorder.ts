import type { Clip } from '../segue-editor/model.ts';
import { type PlayResult, SeguePlayer } from '../segue-editor/preview.ts';
import { AXIS_RATE, type Take, type Trim } from './take.ts';

// The VT recorder's audio (#59): one AudioContext for the microphone, the level meter, the
// capture and the pre-roll, so a take is placed on the segue axis by the same clock that
// played the music under it.
//
//   mic ─▶ MediaStreamSource ─┬─▶ Analyser (meter)
//                             └─▶ capture worklet (mono float blocks, stamped with their frame)
//   pre-roll: SeguePlayer on the same context (the editor's preview, the island's mix)
//
// The presenter speaks over what they hear. A captured frame entered the mic `inputLatency`
// before the context saw it, and the music they heard then was scheduled `outputLatency`
// earlier still: the take's axis start is the pre-roll's start minus both latencies.
//
// The mic is opened raw (no echo cancellation, noise suppression or automatic gain): those
// pump and colour a voice, and echo cancellation would fight the pre-roll. Headphones keep the
// music out of the take.

/** Mono float blocks from the capture node, each stamped with its first frame. */
export interface Capture {
  node: AudioNode;
  onChunk(listener: (frame: number, samples: Float32Array) => void): void;
}

/** What the recorder needs from the platform; tests pass fakes. */
export interface RecorderDeps {
  createContext(): AudioContext;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  createCapture(ctx: AudioContext): Promise<Capture>;
  fetchAudio(url: string): Promise<ArrayBuffer>;
}

const CAPTURE_PROCESSOR = `
class OndesCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage({ frame: currentFrame, samples: channel.slice(0) });
    return true;
  }
}
registerProcessor('ondes-capture', OndesCapture);
`;

const browserDeps: RecorderDeps = {
  // The device's own rate: Firefox can't connect a mic to a context at another rate, and
  // ingest resamples to 44.1 kHz anyway. Positions are converted through seconds.
  createContext: () => new AudioContext({ latencyHint: 'interactive' }),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
  createCapture: async (ctx) => {
    const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'ondes-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    // Outputs silence; connected so every browser keeps pulling it.
    node.connect(ctx.destination);
    return {
      node,
      onChunk: (listener) => {
        node.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) =>
          listener(e.data.frame, e.data.samples);
      },
    };
  },
  fetchAudio: async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`audio ${res.status}`);
    return res.arrayBuffer();
  },
};

let defaultDeps: RecorderDeps = browserDeps;

/** Tests: the platform the page's recorders get (fakes); no argument puts the browser back. */
export function setRecorderDeps(deps?: RecorderDeps): void {
  defaultDeps = deps ?? browserDeps;
}

/**
 * Longest take, in seconds. A take is held as float PCM until it is trimmed and uploaded
 * (10 min at 48 kHz is about 115 MB, its WAV about 86 MB): the recorder stops there by itself,
 * and the page warns a minute before. A VT is seconds long; this only bounds a forgotten Stop.
 */
export const MAX_TAKE_SECONDS = 600;

/** The take's samples so far: grown by doubling, so stopping needs no copy. */
class TakeBuffer {
  private data: Float32Array;
  length = 0;
  constructor(initial: number) {
    this.data = new Float32Array(Math.max(1, initial));
  }
  /** Appends up to `max` samples in total; returns false once full. */
  push(samples: Float32Array, max: number): boolean {
    const room = max - this.length;
    const part = samples.length > room ? samples.subarray(0, room) : samples;
    if (this.length + part.length > this.data.length) {
      const next = new Float32Array(
        Math.min(max, Math.max(this.data.length * 2, this.length + part.length)),
      );
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(part, this.length);
    this.length += part.length;
    return this.length < max;
  }
  samples(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

/** The music under a take: the segue's clips from axis position `from`. */
export interface Preroll {
  clips: readonly Clip[];
  from: number;
}

export class VtRecorder {
  private ctx: AudioContext | null = null;
  private player: SeguePlayer | null = null;
  private capture: Capture | null = null;
  private capturing: Promise<Capture> | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;
  private recording: {
    startFrame: number;
    buffer: TakeBuffer;
    max: number;
    preroll: Preroll | null;
    /** Read when the take starts: what the presenter heard against what was captured. */
    latency: number;
    onLimit: (() => void) | undefined;
  } | null = null;
  /** Bumped by every `open()`, `record()`, `stop()` and `close()`: awaits check they're current. */
  private openGeneration = 0;
  private recordGeneration = 0;
  private closed = false;
  private take: AudioBufferSourceNode | null = null;
  private readonly stationId: string;
  private readonly deps: RecorderDeps;

  constructor(stationId: string, deps: RecorderDeps = defaultDeps) {
    this.stationId = stationId;
    this.deps = deps;
  }

  private context(): AudioContext {
    if (this.closed) throw new Error('recorder closed');
    if (!this.ctx) {
      const ctx = this.deps.createContext();
      this.ctx = ctx;
      // The pre-roll plays on this context: one clock for what is heard and what is captured.
      this.player = new SeguePlayer(this.stationId, {
        createContext: () => ctx,
        fetchAudio: this.deps.fetchAudio,
      });
    }
    return this.ctx;
  }

  /** The audio inputs. Labels are empty until the mic was allowed once. */
  async devices(): Promise<MediaDeviceInfo[]> {
    return (await this.deps.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  }

  /**
   * Opens (or switches to) a microphone; the meter reads it from now on. Resolves with the
   * device's id, or `superseded` when `close()` or a newer `open()` came during the permission
   * prompt: that stream is stopped at once, never left live without an owner.
   */
  async open(deviceId?: string): Promise<{ deviceId: string | null } | 'superseded'> {
    const generation = ++this.openGeneration;
    const current = () => !this.closed && generation === this.openGeneration;
    const stream = await this.deps.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const drop = () => {
      for (const track of stream.getTracks()) track.stop();
      return 'superseded' as const;
    };
    if (!current()) return drop();
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (!current()) return drop();
    if (!this.capturing) {
      // One capture node per context, even when two opens race (a module registers once).
      this.capturing = this.deps.createCapture(ctx).then((capture) => {
        capture.onChunk((frame, samples) => this.onChunk(frame, samples));
        return capture;
      });
    }
    const capture = await this.capturing;
    if (!current()) return drop();
    this.capture = capture;
    this.release();
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.source.connect(this.capture.node);
    return { deviceId: stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null };
  }

  get isOpen(): boolean {
    return this.stream !== null;
  }

  /** The input's peak right now, linear (0…1), for the meter. */
  level(): number {
    if (!this.analyser || !this.meterBuffer) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let peak = 0;
    for (const v of this.meterBuffer) if (Math.abs(v) > peak) peak = Math.abs(v);
    return peak;
  }

  /**
   * Starts a take. With a pre-roll, the music starts first and the take begins with it; the
   * promise resolves once both run, or `cancelled` when `stop()` or `close()` came first (while
   * the context resumed or the music loaded): then nothing records.
   * `onLimit` runs once the take reached {@link MAX_TAKE_SECONDS}; capture has stopped by then.
   */
  async record(
    preroll: Preroll | null,
    { onPrerollEnd, onLimit }: { onPrerollEnd?: () => void; onLimit?: () => void } = {},
  ): Promise<PlayResult> {
    const ctx = this.context();
    if (!this.capture) throw new Error('no microphone open');
    const generation = ++this.recordGeneration;
    const current = () => !this.closed && generation === this.recordGeneration;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!current()) return 'cancelled';
    this.stopPlayback();
    let at = ctx.currentTime;
    if (preroll) {
      const player = this.player as SeguePlayer;
      const result = await player.play(preroll.clips, preroll.from, () => onPrerollEnd?.());
      const started = player.startedAt();
      if (!current()) {
        player.stop();
        return 'cancelled';
      }
      if (result === 'cancelled' || !started) return 'cancelled';
      at = started.at;
    }
    this.recording = {
      startFrame: Math.round(at * ctx.sampleRate),
      buffer: new TakeBuffer(30 * ctx.sampleRate),
      max: MAX_TAKE_SECONDS * ctx.sampleRate,
      preroll,
      latency: this.latency(),
      onLimit,
    };
    return 'playing';
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  private onChunk(frame: number, samples: Float32Array) {
    const rec = this.recording;
    if (!rec || rec.buffer.length >= rec.max) return;
    const skip = rec.startFrame - frame;
    if (skip >= samples.length) return;
    if (!rec.buffer.push(skip > 0 ? samples.subarray(skip) : samples, rec.max)) {
      this.player?.stop();
      rec.onLimit?.();
    }
  }

  /**
   * Seconds between the music the presenter hears and the mic frames captured with it:
   * - `inputLatency`: mic to the context (the track's `latency`, where the browser reports it);
   * - `baseLatency`: the context's own buffering between its destination node and the
   *   platform's audio subsystem;
   * - `outputLatency`: the audio subsystem to the speakers. The Web Audio spec counts it from
   *   where `baseLatency` ends, so the two add up: a sound scheduled at context time T is heard
   *   at T + base + output.
   * Read once when a take starts, the moment the presenter starts hearing the pre-roll.
   */
  latency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as
      | (MediaTrackSettings & { latency?: number })
      | undefined;
    const input = settings?.latency ?? 0;
    return input + (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0);
  }

  /** Ends the take (and its pre-roll). Null when nothing was recording. */
  stop(): Take | null {
    this.recordGeneration++;
    const rec = this.recording;
    this.recording = null;
    this.player?.stop();
    if (!rec || !this.ctx) return null;
    return {
      samples: rec.buffer.samples(),
      sampleRate: this.ctx.sampleRate,
      axisStart: rec.preroll ? rec.preroll.from - Math.round(rec.latency * AXIS_RATE) : null,
    };
  }

  /**
   * Plays the trimmed take; with `music`, over the segue's clips from 2 s before the voice,
   * as the island will mix it (the take at 0 dB: its playout gain is known after ingest).
   */
  async playTake(
    take: Take,
    trim: Trim,
    music: readonly Clip[] | null,
    onEnd: () => void,
  ): Promise<PlayResult> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopPlayback();
    const buffer = ctx.createBuffer(1, Math.max(1, trim.to - trim.from), take.sampleRate);
    buffer.copyToChannel(take.samples.slice(trim.from, trim.to), 0);
    let when = ctx.currentTime + 0.05;
    const start = take.axisStart;
    if (music && start !== null) {
      const voiceAt = start + Math.round((trim.from * AXIS_RATE) / take.sampleRate);
      const from = voiceAt - 2 * AXIS_RATE;
      const player = this.player as SeguePlayer;
      const result = await player.play(music, from, () => {});
      const started = player.startedAt();
      if (result === 'cancelled' || !started) return 'cancelled';
      when = started.at + (voiceAt - from) / AXIS_RATE;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.onended = () => {
      if (this.take !== node) return;
      this.take = null;
      this.player?.stop();
      onEnd();
    };
    node.start(when);
    this.take = node;
    return 'playing';
  }

  /** Stops a take's playback (and its music). */
  stopPlayback(): void {
    const node = this.take;
    this.take = null;
    if (node) {
      try {
        node.stop();
      } catch {
        // Not started yet.
      }
      node.disconnect();
    }
    if (!this.recording) this.player?.stop();
  }

  private release() {
    this.source?.disconnect();
    this.analyser?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.source = null;
    this.analyser = null;
    this.stream = null;
  }

  /** Stops everything, frees the mic and the audio context. */
  close(): void {
    this.closed = true;
    this.openGeneration++;
    this.recordGeneration++;
    this.recording = null;
    this.stopPlayback();
    this.player?.stop();
    this.release();
    void this.ctx?.close();
    this.ctx = null;
    this.player = null;
    this.capture = null;
    this.capturing = null;
  }
}
