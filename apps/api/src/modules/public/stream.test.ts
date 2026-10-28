import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from './snapshot.ts';
import { createPublicStream, NOW_PLAYING_EVENT, type PublicStreamOptions } from './stream.ts';

// The public now-playing stream (#74): caps, the first frame, one debounced rebuild per burst
// written to every listener, heartbeats, stream lifetime, slow listeners.

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  /** The `now_playing` frames written so far, by their id. */
  get frames() {
    return this.chunks
      .filter((c) => c.startsWith(`event: ${NOW_PLAYING_EVENT}\n`))
      .map((c) => /\nid: (.*)\n/.exec(c)?.[1]);
  }
}

const log = { debug: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

const snapshot = (etag: string, expiresAt = Date.now() + 60_000): Snapshot<unknown> => ({
  value: { etag },
  body: JSON.stringify({ etag }),
  etag,
  builtAt: Date.now(),
  expiresAt,
});

const setup = (overrides: Partial<PublicStreamOptions> = {}) => {
  let current = snapshot('a');
  const read = vi.fn(async () => current);
  const stream = createPublicStream(read, log, {
    heartbeatMs: 1_000,
    debounceMs: 250,
    maxStreamMs: 10_000,
    ...overrides,
  });
  const open = (ip = '1.1.1.1', stationId = 's1') => {
    const res = new FakeResponse();
    stream.open(stationId, ip, res as unknown as ServerResponse, { 'x-test': '1' });
    return res;
  };
  return {
    stream,
    read,
    open,
    set: (etag: string) => {
      current = snapshot(etag);
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPublicStream', () => {
  it('opens with SSE headers, a retry hint and the current snapshot', async () => {
    const { stream, open } = setup({ retryMs: 5_000 });
    const res = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'x-test': '1',
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    expect(res.chunks[0]).toBe('retry: 5000\n\n');
    expect(res.frames).toEqual(['a']);
    expect(stream.listeners).toBe(1);
    stream.close();
  });

  it('caps open streams per IP and per process, and frees a slot when one closes', () => {
    const { stream, open } = setup({ maxClients: 3, maxClientsPerIp: 2 });
    const first = open('1.1.1.1');
    open('1.1.1.1');
    expect(stream.admit('1.1.1.1')).toBe('too_many');
    expect(stream.admit('2.2.2.2')).toBe('ok');
    open('2.2.2.2');
    expect(stream.admit('3.3.3.3')).toBe('full');
    first.emit('close');
    expect(stream.listeners).toBe(2);
    expect(stream.admit('1.1.1.1')).toBe('ok');
    stream.close();
    expect(stream.listeners).toBe(0);
  });

  it('rebuilds once per burst of changes and writes the same frame to every listener', async () => {
    const { stream, read, open, set } = setup();
    const a = open();
    const b = open('2.2.2.2');
    const other = open('3.3.3.3', 's2');
    await vi.advanceTimersByTimeAsync(0);
    read.mockClear();

    set('b');
    for (let i = 0; i < 10; i++) stream.changed('s1');
    await vi.advanceTimersByTimeAsync(249);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('s1');
    expect(a.frames).toEqual(['a', 'b']);
    expect(b.frames).toEqual(['a', 'b']);
    // Another station's listener isn't touched.
    expect(other.frames).toEqual(['a']);
    stream.close();
  });

  it('writes nothing when a rebuild has the same content', async () => {
    const { stream, read, open } = setup();
    const res = open();
    await vi.advanceTimersByTimeAsync(0);
    stream.changed('s1');
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    expect(res.frames).toEqual(['a']);
    stream.close();
  });

  it('ignores changes for a station nobody listens to', async () => {
    const { stream, read } = setup();
    stream.changed('s1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).not.toHaveBeenCalled();
    stream.close();
  });

  it('sends heartbeats and ends a stream after its lifetime', async () => {
    const { stream, open } = setup({ heartbeatMs: 1_000, maxStreamMs: 5_000 });
    const res = open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(res.chunks).toContain(': ping\n\n');
    expect(res.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(res.writableEnded).toBe(true);
    expect(stream.listeners).toBe(0);
    stream.close();
  });

  it('drops a listener that is too far behind', async () => {
    const { stream, open, set } = setup({ maxBufferedBytes: 100 });
    const slow = open();
    const fast = open('2.2.2.2');
    await vi.advanceTimersByTimeAsync(0);
    slow.writableLength = 101;
    set('b');
    stream.changed('s1');
    await vi.advanceTimersByTimeAsync(250);
    expect(slow.writableEnded).toBe(true);
    expect(slow.frames).toEqual(['a']);
    expect(fast.frames).toEqual(['a', 'b']);
    expect(stream.listeners).toBe(1);
    stream.close();
  });

  it('rebuilds on its own when the snapshot expires', async () => {
    const { stream, read, open } = setup();
    let n = 0;
    read.mockImplementation(async () => snapshot(String(++n), Date.now() + 2_000));
    const res = open();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_050);
    expect(res.frames).toEqual(['1', '2']);
    stream.close();
  });
});
