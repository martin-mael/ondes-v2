import type { SegueMedia } from '@ondes/shared';
import { describe, expect, it, vi } from 'vitest';
import { clipsOf, emptyLanes, SR } from '../segue-editor/model.ts';
import { type Capture, type RecorderDeps, VtRecorder } from './recorder.ts';
import { AXIS_RATE } from './take.ts';

// The recorder against a fake AudioContext and capture node: the mic opens raw, a take keeps
// only what was captured from the moment the pre-roll sounds, and its axis start is the
// pre-roll's start minus the input and output latencies.

const RATE = 48_000;

class FakeNode {
  connect(node: unknown) {
    return node;
  }
  disconnect() {}
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  start(when: number) {
    this.started = when;
  }
  stop() {}
}

class FakeContext {
  currentTime = 2;
  sampleRate = RATE;
  baseLatency = 0.005;
  outputLatency = 0.015;
  state = 'running';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  createGain() {
    return Object.assign(new FakeNode(), {
      gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} },
    });
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 0,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(0);
        buffer[3] = -0.5;
      },
    });
  }
  createBuffer(_channels: number, length: number) {
    return { length, copyToChannel() {} };
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return Promise.resolve({ bytes });
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

function setup() {
  const ctx = new FakeContext();
  let listener: ((frame: number, samples: Float32Array) => void) | null = null;
  const capture: Capture = {
    node: new FakeNode() as unknown as AudioNode,
    onChunk: (l) => (listener = l),
  };
  const track = {
    getSettings: () => ({ deviceId: 'mic-2', latency: 0.01 }),
    stop: vi.fn(),
  };
  const getUserMedia = vi.fn(async () => ({
    getAudioTracks: () => [track],
    getTracks: () => [track],
  }));
  const deps: RecorderDeps = {
    createContext: () => ctx as unknown as AudioContext,
    getUserMedia: getUserMedia as unknown as RecorderDeps['getUserMedia'],
    enumerateDevices: async () =>
      [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in' },
        { kind: 'audiooutput', deviceId: 'out', label: 'Speakers' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB mic' },
      ] as MediaDeviceInfo[],
    createCapture: async () => capture,
    fetchAudio: async () => new ArrayBuffer(8),
  };
  /** The capture node delivers `n` samples of `value` starting at context frame `frame`. */
  const deliver = (frame: number, n: number, value: number) =>
    listener?.(frame, new Float32Array(n).fill(value));
  return { ctx, deps, getUserMedia, track, deliver };
}

const A: SegueMedia = {
  assetId: '00000000-0000-4000-8000-00000000000a',
  sha256: 'a'.padEnd(64, '0'),
  sampleRate: SR,
  durationSamples: SR * 60,
  gainDb: 0,
  cueIn: 0,
  cueOut: SR * 60,
};
const clips = clipsOf(emptyLanes(), { from: A, to: null, voices: {} });

describe('VT recorder', () => {
  it('opens the chosen mic raw and lists only the inputs', async () => {
    const { deps, getUserMedia } = setup();
    const recorder = new VtRecorder('station', deps);
    expect(await recorder.open('mic-2')).toBe('mic-2');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-2' },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect((await recorder.devices()).map((d) => d.label)).toEqual(['Built-in', 'USB mic']);
    expect(recorder.level()).toBe(0.5);
  });

  it('keeps what was captured from the pre-roll start, placed before it by the latency', async () => {
    const { ctx, deps, deliver } = setup();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    const from = -10 * AXIS_RATE;
    expect(await recorder.record({ clips, from })).toBe('playing');
    // The player starts its sources 50 ms after "now": the take starts there too.
    const startFrame = Math.round((ctx.currentTime + 0.05) * RATE);
    deliver(startFrame - 256, 128, 0.1); // before: dropped
    deliver(startFrame - 64, 128, 0.2); // straddles the start: its last 64 kept
    deliver(startFrame + 64, 128, 0.3);
    const take = recorder.stop();
    expect(take?.sampleRate).toBe(RATE);
    expect(take?.samples.length).toBe(64 + 128);
    expect(take?.samples[0]).toBeCloseTo(0.2);
    expect(take?.samples[64]).toBeCloseTo(0.3);
    // Input 10 ms + base 5 ms + output 15 ms = 30 ms.
    expect(take?.axisStart).toBe(from - Math.round(0.03 * AXIS_RATE));
    // Nothing is kept once stopped.
    deliver(startFrame + 1000, 128, 0.4);
    expect(recorder.stop()).toBeNull();
  });

  it('records without pre-roll from now, with no place on an axis', async () => {
    const { ctx, deps, deliver } = setup();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    await recorder.record(null);
    deliver(Math.round(ctx.currentTime * RATE), 480, 0.1);
    const take = recorder.stop();
    expect(take?.samples.length).toBe(480);
    expect(take?.axisStart).toBeNull();
  });

  it('plays the take over the music, the voice where it was recorded', async () => {
    const { ctx, deps } = setup();
    const recorder = new VtRecorder('station', deps);
    const take = { samples: new Float32Array(RATE), sampleRate: RATE, axisStart: -5 * AXIS_RATE };
    const trim = { from: RATE / 2, to: RATE };
    await recorder.playTake(take, trim, clips, () => {});
    // The music starts 2 s before the voice; the voice (0.5 s into the take) 2 s after it.
    const [music, voice] = ctx.sources;
    expect(music?.started).toBeCloseTo(ctx.currentTime + 0.05);
    expect(voice?.started).toBeCloseTo(ctx.currentTime + 0.05 + 2);
  });

  it('frees the mic on close', async () => {
    const { deps, track } = setup();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    recorder.close();
    expect(track.stop).toHaveBeenCalled();
    expect(recorder.isOpen).toBe(false);
  });
});
