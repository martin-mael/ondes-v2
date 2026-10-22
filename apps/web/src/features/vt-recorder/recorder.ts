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

/** The music under a take: the segue's clips from axis position `from`. */
export interface Preroll {
  clips: readonly Clip[];
  from: number;
}

export class VtRecorder {
  private ctx: AudioContext | null = null;
  private player: SeguePlayer | null = null;
  private capture: Capture | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;
  private recording: {
    startFrame: number;
    chunks: Float32Array[];
    preroll: Preroll | null;
  } | null = null;
  private take: AudioBufferSourceNode | null = null;
  private readonly stationId: string;
  private readonly deps: RecorderDeps;

  constructor(stationId: string, deps: RecorderDeps = browserDeps) {
    this.stationId = stationId;
    this.deps = deps;
  }

  private context(): AudioContext {
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

  /** Opens (or switches to) a microphone; the meter reads it from now on. Returns its id. */
  async open(deviceId?: string): Promise<string | null> {
    const stream = await this.deps.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.release();
    this.stream = stream;
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    this.capture ??= await this.deps.createCapture(ctx);
    this.capture.onChunk((frame, samples) => this.onChunk(frame, samples));
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.source.connect(this.capture.node);
    return stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null;
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
   * promise resolves once both run (`cancelled` when `stop()` came first).
   */
  async record(preroll: Preroll | null, onPrerollEnd?: () => void): Promise<PlayResult> {
    const ctx = this.context();
    if (!this.capture) throw new Error('no microphone open');
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopPlayback();
    let at = ctx.currentTime;
    if (preroll) {
      const player = this.player as SeguePlayer;
      const result = await player.play(preroll.clips, preroll.from, () => onPrerollEnd?.());
      const started = player.startedAt();
      if (result === 'cancelled' || !started) return 'cancelled';
      at = started.at;
    }
    this.recording = { startFrame: Math.round(at * ctx.sampleRate), chunks: [], preroll };
    return 'playing';
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  private onChunk(frame: number, samples: Float32Array) {
    const rec = this.recording;
    if (!rec) return;
    const skip = rec.startFrame - frame;
    if (skip >= samples.length) return;
    rec.chunks.push(skip > 0 ? samples.subarray(skip) : samples);
  }

  /** Total latency between what the presenter hears and what is captured, in seconds. */
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
    const rec = this.recording;
    this.recording = null;
    this.player?.stop();
    if (!rec || !this.ctx) return null;
    const length = rec.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(length);
    let at = 0;
    for (const chunk of rec.chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    return {
      samples,
      sampleRate: this.ctx.sampleRate,
      axisStart: rec.preroll ? rec.preroll.from - Math.round(this.latency() * AXIS_RATE) : null,
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
    this.recording = null;
    this.stopPlayback();
    this.player?.stop();
    this.release();
    void this.ctx?.close();
    this.ctx = null;
    this.player = null;
    this.capture = null;
  }
}
