import { vi } from 'vitest';
import type { Capture, RecorderDeps } from './recorder.ts';

// A fake platform for the VT recorder (#59): an AudioContext at 48 kHz whose clock stands
// still, a mic, and a capture node the test feeds by hand.

export const FAKE_RATE = 48_000;

class FakeNode {
  connect(node: unknown) {
    return node;
  }
  disconnect() {}
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  start(when: number) {
    this.started = when;
  }
  stop() {}
}

export class FakeAudioContext {
  currentTime = 2;
  sampleRate = FAKE_RATE;
  baseLatency = 0.005;
  outputLatency = 0.015;
  state = 'running';
  destination = new FakeNode();
  sources: FakeBufferSource[] = [];
  /** What the analyser reads: the meter's level. */
  level = 0.1;
  createBufferSource() {
    const node = new FakeBufferSource();
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
    const ctx = this;
    return Object.assign(new FakeNode(), {
      fftSize: 0,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(0);
        buffer[3] = -ctx.level;
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

export function fakeRecorder() {
  const ctx = new FakeAudioContext();
  let listener: ((frame: number, samples: Float32Array) => void) | null = null;
  const capture: Capture = {
    node: new FakeNode() as unknown as AudioNode,
    onChunk: (l) => {
      listener = l;
    },
  };
  const track = { getSettings: () => ({ deviceId: 'mic-2', latency: 0.01 }), stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
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
  /** The capture node delivers `seconds` of `value` from context frame `frame` on. */
  const deliver = (frame: number, seconds: number, value: number) =>
    listener?.(frame, new Float32Array(Math.round(seconds * FAKE_RATE)).fill(value));
  /** The frame a take starts at: now, or the pre-roll's start 50 ms later. */
  const startFrame = (preroll: boolean) =>
    Math.round((ctx.currentTime + (preroll ? 0.05 : 0)) * FAKE_RATE);
  return { ctx, deps, getUserMedia, track, stream, deliver, startFrame };
}
