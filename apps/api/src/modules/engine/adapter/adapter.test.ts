import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineAdapter, type EngineAdapter } from './adapter.ts';
import {
  EngineBadRequestError,
  EngineConflictError,
  EngineNotQueuedError,
  EngineProtocolError,
  EngineServerError,
  EngineUnauthorizedError,
  EngineUnavailableError,
  EngineUnresolvableError,
} from './errors.ts';
import { type FakeEngine, startFakeEngine } from './testing/fake-engine.ts';

const TOKEN = 'secret-token';
let engine: FakeEngine;
let adapter: EngineAdapter;

beforeEach(async () => {
  engine = await startFakeEngine({ token: TOKEN });
  adapter = createEngineAdapter({
    stationId: engine.stationId,
    baseUrl: engine.url,
    token: TOKEN,
    timeoutMs: 200,
    pushTimeoutMs: 200,
    retryDelayMs: 1,
  });
});

afterEach(() => engine.close());

describe('EngineAdapter', () => {
  it('reads health without a token and state with one', async () => {
    const noToken = createEngineAdapter({ stationId: engine.stationId, baseUrl: engine.url });
    expect(await noToken.health()).toEqual({
      status: 'ok',
      boot_id: engine.bootId,
      version: '2.4.6',
      config_version: 'cfg-1',
    });
    await expect(noToken.state()).rejects.toBeInstanceOf(EngineUnauthorizedError);
    const state = await adapter.state();
    expect(state.boot_id).toBe(engine.bootId);
    expect(state.seq).toBe(1);
  });

  it('pushes an item and a segment, removes and clears', async () => {
    const a = await adapter.push({ item_id: 'A', uri: '/media/a.flac', cue_in: 1, cross_out: 2 });
    expect(a).toMatchObject({ item_id: 'A', uri: '/media/a.flac', segment_id: null });

    const seg = await adapter.pushSegment({
      segment_id: 'island-1',
      parts: [
        { item_id: 'B', uri: '/media/b.flac', cue_out: 120.5, amplify_db: -3.5 },
        { item_id: 'VT', uri: '/media/island.flac', amplify_db: 0 },
        { item_id: 'C', uri: '/media/c.flac', cue_in: 12.3 },
      ],
      cross_in: 3,
    });
    expect(seg.requests.map((r) => r.item_id)).toEqual(['B', 'VT', 'C']);
    expect(seg.requests.every((r) => r.segment_id === 'island-1')).toBe(true);

    expect(await adapter.remove('VT')).toEqual({ removed: 3 });
    await expect(adapter.remove('island-1')).rejects.toBeInstanceOf(EngineNotQueuedError);
    expect(await adapter.clear()).toEqual({ removed: 1 });
  });

  it('maps a missing file to EngineUnresolvableError', async () => {
    const error = await adapter
      .push({ item_id: 'X', uri: '/media/missing.flac' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineUnresolvableError);
    expect(error).toMatchObject({ code: 'unresolvable', status: 422 });
    expect((error as Error).message).toContain('cannot resolve /media/missing.flac');
    await expect(
      adapter.pushSegment({
        segment_id: 's',
        parts: [
          { item_id: 'A', uri: '/media/a.flac' },
          { item_id: 'X', uri: '/media/missing.flac' },
        ],
      }),
    ).rejects.toBeInstanceOf(EngineUnresolvableError);
    expect(engine.queue).toEqual([]);
  });

  it('validates commands before sending them', async () => {
    await expect(
      adapter.push({ item_id: 'A', uri: '/media/a.flac', cue_in: 5, cue_out: 2 }),
    ).rejects.toBeInstanceOf(EngineBadRequestError);
    await expect(
      adapter.pushSegment({ segment_id: 's', parts: [{ item_id: 'A', uri: '/media/a.flac' }] }),
    ).rejects.toBeInstanceOf(EngineBadRequestError);
    expect(engine.calls).toEqual([]);
  });

  it('times out instead of waiting on a stuck engine', async () => {
    engine.delayMs = 1_000;
    const started = Date.now();
    const error = await adapter.skip().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(800);
    // Not repeatable: a skip that may have landed is never sent twice.
    expect(engine.calls.filter((c) => c === 'POST /v1/skip')).toHaveLength(1);
  });

  it('retries repeatable commands on 5xx, never pushes', async () => {
    engine.failWith = 503;
    await expect(adapter.state()).rejects.toBeInstanceOf(EngineServerError);
    expect(engine.calls.filter((c) => c === 'GET /v1/state')).toHaveLength(3);
    await expect(adapter.push({ item_id: 'A', uri: '/media/a.flac' })).rejects.toBeInstanceOf(
      EngineServerError,
    );
    expect(engine.calls.filter((c) => c === 'POST /v1/queue')).toHaveLength(1);
  });

  it('reports an unreachable engine', async () => {
    await engine.close();
    await expect(adapter.health()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it("rejects another station's engine", async () => {
    const wrong = createEngineAdapter({ stationId: 'other', baseUrl: engine.url, token: TOKEN });
    await expect(wrong.state()).rejects.toBeInstanceOf(EngineProtocolError);
  });

  it('pulls events after a seq and toggles the live gate', async () => {
    await adapter.setLive(true);
    const events = await adapter.events(1);
    expect(events.map((e) => [e.seq, e.type])).toEqual([[2, 'live.gate']]);
  });

  it('opens the gate on an input with a live session, and hangs an input up (#64)', async () => {
    await adapter.setLive(true, { input: 2, sessionId: 'session-1' });
    const [gate] = await adapter.events(1);
    expect(gate).toMatchObject({ type: 'live.gate', data: { input: 2, session_id: 'session-1' } });
    expect(await adapter.disconnectLive(1)).toBe(false);
    // Checked before sending: no input 0, and no 400 round trip.
    await expect(adapter.disconnectLive(0)).rejects.toBeInstanceOf(EngineBadRequestError);
    expect(engine.calls.filter((c) => c === 'POST /v1/live/disconnect')).toHaveLength(1);
  });

  it('maps a disabled live input to EngineConflictError', async () => {
    engine.liveDisabled = true;
    await expect(adapter.setLive(true)).rejects.toBeInstanceOf(EngineConflictError);
    // Not retried: a 409 won't change by asking again.
    expect(engine.calls.filter((c) => c === 'POST /v1/live')).toHaveLength(1);
  });
});
