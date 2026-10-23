import type { SegueMedia } from '@ondes/shared';
import { describe, expect, it, vi } from 'vitest';
import { clipsOf, emptyLanes, SR } from '../segue-editor/model.ts';
import { MAX_TAKE_SECONDS, VtRecorder } from './recorder.ts';
import { AXIS_RATE } from './take.ts';
import { fakeRecorder, FAKE_RATE as RATE } from './testing.ts';

// The recorder against a fake AudioContext and capture node: the mic opens raw, a take keeps
// only what was captured from the moment the pre-roll sounds, its axis start is the pre-roll's
// start minus the latencies read when it started, and nothing outlives a close or a stop.

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
    const { deps, getUserMedia } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    expect(await recorder.open('mic-2')).toEqual({ deviceId: 'mic-2' });
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
    expect(recorder.level()).toBeCloseTo(0.1);
  });

  it('stops a mic granted after the page closed, or after a newer choice', async () => {
    const { deps, track, stream } = fakeRecorder();
    let grant: (s: unknown) => void = () => {};
    deps.getUserMedia = vi.fn(
      () => new Promise((resolve) => (grant = resolve)),
    ) as unknown as typeof deps.getUserMedia;
    const recorder = new VtRecorder('station', deps);
    const opening = recorder.open();
    recorder.close();
    grant(stream);
    expect(await opening).toBe('superseded');
    expect(track.stop).toHaveBeenCalled();
    expect(recorder.isOpen).toBe(false);

    // Two opens racing: the first answer to arrive is dropped when a newer one was asked.
    const second = fakeRecorder();
    const grants: ((s: unknown) => void)[] = [];
    second.deps.getUserMedia = vi.fn(
      () => new Promise((resolve) => grants.push(resolve)),
    ) as unknown as typeof deps.getUserMedia;
    const other = new VtRecorder('station', second.deps);
    const older = other.open('mic-1');
    const newer = other.open('mic-2');
    grants[0]?.(second.stream);
    expect(await older).toBe('superseded');
    grants[1]?.(second.stream);
    expect(await newer).toEqual({ deviceId: 'mic-2' });
  });

  it('keeps what was captured from the pre-roll start, placed before it by the latency', async () => {
    const { ctx, deps, deliver, startFrame } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    const from = -10 * AXIS_RATE;
    expect(await recorder.record({ clips, from })).toBe('playing');
    // The latency is the one when the take started, not when it stopped.
    ctx.outputLatency = 0.5;
    const start = startFrame(true);
    deliver(start - 256, 128 / RATE, 0.1); // before: dropped
    deliver(start - 64, 128 / RATE, 0.2); // straddles the start: its last 64 kept
    deliver(start + 64, 128 / RATE, 0.3);
    const take = recorder.stop();
    expect(take?.sampleRate).toBe(RATE);
    expect(take?.samples.length).toBe(64 + 128);
    expect(take?.samples[0]).toBeCloseTo(0.2);
    expect(take?.samples[64]).toBeCloseTo(0.3);
    // Input 10 ms + base 5 ms + output 15 ms = 30 ms.
    expect(take?.axisStart).toBe(from - Math.round(0.03 * AXIS_RATE));
    // Nothing is kept once stopped.
    deliver(start + 1000, 128 / RATE, 0.4);
    expect(recorder.stop()).toBeNull();
  });

  it('records without pre-roll from now, with no place on an axis', async () => {
    const { deps, deliver, startFrame } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    await recorder.record(null);
    deliver(startFrame(false), 0.01, 0.1);
    const take = recorder.stop();
    expect(take?.samples.length).toBe(480);
    expect(take?.axisStart).toBeNull();
  });

  it('records nothing when stopped while the context resumes', async () => {
    const { ctx, deps, deliver, startFrame } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    ctx.state = 'suspended';
    let resumed: () => void = () => {};
    ctx.resume = () => new Promise<void>((resolve) => (resumed = resolve));
    const starting = recorder.record(null);
    expect(recorder.stop()).toBeNull();
    resumed();
    expect(await starting).toBe('cancelled');
    expect(recorder.isRecording).toBe(false);
    deliver(startFrame(false), 0.01, 0.1);
    expect(recorder.stop()).toBeNull();
  });

  it(`stops by itself at ${MAX_TAKE_SECONDS / 60} minutes`, async () => {
    const { deps, deliver, startFrame } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    const onLimit = vi.fn();
    await recorder.record(null, { onLimit });
    const start = startFrame(false);
    for (let s = 0; s < MAX_TAKE_SECONDS - 60; s += 60) deliver(start + s * RATE, 60, 0.1);
    deliver(start + (MAX_TAKE_SECONDS - 60) * RATE, 59, 0.1);
    expect(onLimit).not.toHaveBeenCalled();
    // The block that crosses the limit is cut at it.
    deliver(start + (MAX_TAKE_SECONDS - 1) * RATE, 2, 0.1);
    expect(onLimit).toHaveBeenCalledOnce();
    deliver(start + (MAX_TAKE_SECONDS + 1) * RATE, 1, 0.1);
    expect(recorder.stop()?.samples.length).toBe(MAX_TAKE_SECONDS * RATE);
  });

  it('plays the take over the music, the voice where it was recorded', async () => {
    const { ctx, deps } = fakeRecorder();
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
    const { deps, track } = fakeRecorder();
    const recorder = new VtRecorder('station', deps);
    await recorder.open();
    recorder.close();
    expect(track.stop).toHaveBeenCalled();
    expect(recorder.isOpen).toBe(false);
  });
});
