import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIcecastAdmin, IcecastAdminError, parseStats } from './admin.ts';

// Fixtures captured from libretime/icecast:2.5.0-alpine (the pinned image).
const fixture = (name: string) =>
  readFileSync(new URL(`./testing/${name}`, import.meta.url), 'utf8');

describe('parseStats', () => {
  it('reads every source with its listener count', () => {
    const stats = parseStats(fixture('stats.xml'));
    expect(stats.serverId).toBe('Icecast 2.5.0');
    expect(stats.listeners).toBe(3);
    expect(stats.sources).toEqual([
      {
        mount: '/_ondes/vandale/mp3.fallback.mp3',
        connected: true,
        listeners: 2,
        listenerPeak: 2,
        maxListeners: undefined,
        contentType: 'audio/mpeg',
        serverName: undefined,
        userAgent: undefined,
      },
      {
        mount: '/vandale/aac',
        connected: true,
        listeners: 1,
        listenerPeak: 4,
        maxListeners: 500,
        contentType: 'audio/aac',
        serverName: 'Vandale Radió – Lyon',
        userAgent: 'Liquidsoap/2.4.6 (Unix; OCaml 5.3.0)',
      },
    ]);
  });

  it('tells a declared mount without a source from a live one', () => {
    const stats = parseStats(
      '<icestats><source mount="/vandale/mp3"><listeners>0</listeners><max_listeners>500</max_listeners></source></icestats>',
    );
    expect(stats.sources[0]).toMatchObject({
      mount: '/vandale/mp3',
      connected: false,
      maxListeners: 500,
    });
  });

  it('handles a server with no source', () => {
    expect(parseStats('<icestats><listeners>0</listeners></icestats>').sources).toEqual([]);
  });

  it('rejects something that is not Icecast stats', () => {
    expect(() => parseStats('<html>nope</html>')).toThrow(IcecastAdminError);
  });
});

describe('createIcecastAdmin', () => {
  function fakeFetch(status: number, body: string) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('sends basic auth', async () => {
    const { f, calls } = fakeFetch(200, fixture('stats.xml'));
    const admin = createIcecastAdmin({
      url: 'http://icecast:8000/',
      user: 'admin',
      password: 'pw',
      fetch: f,
    });
    await admin.stats();
    expect(calls[0]?.url).toBe('http://icecast:8000/admin/stats');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('admin:pw').toString('base64')}`,
    );
  });

  it('maps bad credentials to an error', async () => {
    const denied = createIcecastAdmin({
      url: 'http://icecast:8000',
      user: 'a',
      password: 'b',
      fetch: fakeFetch(401, 'nope').f,
    });
    await expect(denied.stats()).rejects.toMatchObject({ name: 'IcecastAdminError', status: 401 });
  });

  it('reports an unreachable server', async () => {
    const admin = createIcecastAdmin({
      url: 'http://127.0.0.1:1',
      user: 'a',
      password: 'b',
      timeoutMs: 500,
    });
    await expect(admin.stats()).rejects.toThrow(/unreachable/);
  });
});
