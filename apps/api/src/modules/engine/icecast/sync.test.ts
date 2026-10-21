import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@ondes/db';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import type { StreamStation } from './mounts.ts';
import { createIcecastConfigSync } from './sync.ts';

/** Just enough of Drizzle for the sync: a transaction, the advisory lock, the station list. */
function fakeDb(stations: () => StreamStation[]): Db {
  const tx = {
    execute: async () => [],
    select: () => ({ from: () => ({ orderBy: async () => stations() }) }),
  };
  return { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as Db;
}

const mountsIn = (path: string) =>
  (
    new XMLParser({ isArray: (n) => n === 'mount', ignoreAttributes: false }).parse(
      readFileSync(path, 'utf8'),
    ).icecast.mount as Array<Record<string, unknown>>
  ).filter((m) => m['@_type'] === 'normal');

describe('createIcecastConfigSync', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'ondes-icecast-'));
  const vandale: StreamStation = { id: 'st-1', orgId: 'org', slug: 'vandale', engineSettings: {} };

  it("puts each station's password on its mounts, the handed-over one first", async () => {
    const d = dir();
    let stored = 'stored-1';
    const sync = createIcecastConfigSync({
      db: fakeDb(() => [vandale]),
      path: join(d, 'icecast.xml'),
      config: { hostname: 'h' },
      sourcePasswordFor: () => stored,
    });
    await sync.syncNow();
    expect(mountsIn(join(d, 'icecast.xml')).map((m) => m.password)).toEqual([
      'stored-1',
      'stored-1',
    ]);
    // The lifecycle hands a new secret over before storing it.
    await sync.syncStation({ id: 'st-1', orgId: 'org' }, 'rotated');
    expect(mountsIn(join(d, 'icecast.xml'))[0]?.password).toBe('rotated');
    await sync.syncNow();
    expect(mountsIn(join(d, 'icecast.xml'))[0]?.password).toBe('rotated');
    stored = 'rotated';
    await sync.syncNow();
    stored = 'later';
    await sync.syncNow();
    // Once the lookup agreed, it's the lookup again.
    expect(mountsIn(join(d, 'icecast.xml'))[0]?.password).toBe('later');
  });

  it('keeps the last password when the lookup fails, and skips a station that never had one', async () => {
    const d = dir();
    let fail = false;
    const other: StreamStation = { id: 'st-2', orgId: 'org', slug: 'other', engineSettings: {} };
    const sync = createIcecastConfigSync({
      db: fakeDb(() => [vandale, other]),
      path: join(d, 'icecast.xml'),
      config: { hostname: 'h' },
      sourcePasswordFor: (st) => {
        if (st.id === 'st-2' || fail) throw new Error('no secret');
        return 'pw-1';
      },
    });
    expect((await sync.syncNow()).mounts.map((m) => m.mount)).toEqual([
      '/vandale/mp3',
      '/vandale/aac',
    ]);
    fail = true;
    await sync.syncNow();
    expect(mountsIn(join(d, 'icecast.xml')).map((m) => m.password)).toEqual(['pw-1', 'pw-1']);
  });

  it('configures fallback and intro only once their file exists', async () => {
    const d = dir();
    const assets = join(d, 'assets');
    const station = {
      ...vandale,
      engineSettings: {
        outputs: [{ mount: 'vandale/mp3', format: 'mp3', bitrate: 128, intro: true }],
      },
    };
    const sync = createIcecastConfigSync({
      db: fakeDb(() => [station]),
      path: join(d, 'icecast.xml'),
      config: { hostname: 'h' },
      sourcePasswordFor: () => 'pw',
      assetsDir: assets,
    });
    expect((await sync.syncNow()).mounts[0]).not.toHaveProperty('fallbackFile');
    mkdirSync(join(assets, 'vandale'), { recursive: true });
    writeFileSync(join(assets, 'vandale/mp3.fallback.mp3'), 'x');
    const [m] = (await sync.syncNow()).mounts;
    expect(m).toMatchObject({ fallbackFile: '/_ondes/vandale/mp3.fallback.mp3' });
    expect(m).not.toHaveProperty('introFile');
    expect(mountsIn(join(d, 'icecast.xml'))[0]?.['fallback-mount']).toBe(
      '/_ondes/vandale/mp3.fallback.mp3',
    );
  });
});
