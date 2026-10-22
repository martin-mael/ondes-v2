import { createHash } from 'node:crypto';
import {
  addMembership,
  auditLog,
  claimIslandRender,
  createAsset,
  createOrganization,
  createStation,
  deleteAsset,
  island,
  logItem,
  markIslandFailed,
  markIslandRendered,
  putAssetFile,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  setLoudness,
  updateCues,
  updateStation,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { JobPublisher } from '@ondes/queue';
import type {
  Actor,
  CreateSegue,
  Island,
  IslandList,
  LogEditResult,
  RealtimeEvent,
  Segue,
  SegueList,
  SegueMediaResponse,
  Show,
  ShowSlot,
  StationRole,
} from '@ondes/shared';
import { islandStorageKey, realtimeEventSchema } from '@ondes/shared';
import { contentKey } from '@ondes/storage';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createMemoryMailer } from '../../plugins/mail.ts';
import { signUpAndLogin, TEST_AUTH_CONFIG, type TestApp } from '../auth/testing.ts';
import { libraryRoutes, runRoute } from '../library/routes.ts';
import { createSegueSync, type SegueSync } from './plugin.ts';
import { deriveIslandsFor } from './sync.ts';

// The segues API on the real app: derivation into islands, merge and split of chains,
// permissions (write vs write_own for show hosts), tenant isolation, audit rows, and
// invalidation when the log or the library changes (the event consumer's handler).

const system: Actor = { type: 'system', name: 'test' };
const SR = 44_100;
const sec = (n: number) => Math.round(n * SR);
const DATE = '2026-11-02';

let t: TestApp;
let scope: StationScope;
let stationId: string;
let otherStationId: string;
let otherScope: StationScope;
let segueSync: SegueSync;
const users: Record<string, { userId: string; cookie: string }> = {};
type Who = 'programmer' | 'host' | 'presenter' | 'viewer' | 'outsider';
const assets: Record<string, string> = {};
const items: Record<string, string> = {};
let logDayId: string;
let otherAsset: string;
let otherItem: string;

async function newAsset(s: StationScope, name: string, seconds: number | null, type = 'song') {
  const a = await createAsset(
    t.tdb.db,
    { actor: system, scope: s },
    { type: type as 'song', title: name },
  );
  if (seconds !== null) await addPlayout(s, a.id, name, seconds);
  return a.id;
}

async function addPlayout(s: StationScope, assetId: string, name: string, seconds: number) {
  const sha256 = createHash('sha256').update(`${s.stationId}:${name}`).digest('hex');
  await putAssetFile(t.tdb.db, { actor: system, scope: s }, assetId, {
    role: 'playout',
    storageKey: contentKey({ orgId: s.orgId, sha256, ext: 'flac' }),
    sha256,
    sizeBytes: 1000,
    codec: 'flac',
    sampleRate: SR,
    channels: 2,
    bitDepth: 24,
    flacBlockSize: 1024,
    durationSamples: sec(seconds),
  });
}

function call(
  who: Who,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  station = stationId,
) {
  return t.app.inject({
    method,
    url: `/api/v1/stations/${station}${url}`,
    cookies: { ondes_session: users[who]?.cookie ?? '' },
    ...(payload ? { payload } : {}),
  });
}

async function ok<T>(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

async function addItem(assetId: string, placement: object = { localDate: DATE }) {
  const res = await ok<LogEditResult>(
    await call('programmer', 'POST', '/log/items', {
      placement,
      item: { kind: 'song', assetId, plannedDurationMs: 60_000 },
    }),
    201,
  );
  if (!res.item) throw new Error('no item');
  logDayId = res.item.logDayId;
  return res.item.id;
}

/**
 * Every event the module publishes, round-tripped through JSON and the contract's schema, as a
 * subscriber would read it.
 */
const published: RealtimeEvent[] = [];
const sink = {
  publish: async (event: RealtimeEvent) => {
    published.push(realtimeEventSchema.parse(JSON.parse(JSON.stringify(event))));
  },
};
/** Every job the module enqueues (#56: `island-render` for each hash left pending). */
const enqueued: { name: string; payload: unknown }[] = [];
const jobs = {
  enqueue: async (job: { name: string }, payload: unknown) => {
    enqueued.push({ name: job.name, payload });
  },
  close: async () => {},
} as unknown as JobPublisher;
const renders = () =>
  enqueued
    .filter((j) => j.name === 'island-render')
    .map((j) => (j.payload as { hash: string }).hash);

const take = <T extends RealtimeEvent['type']>(type: T) =>
  published.filter((e): e is Extract<RealtimeEvent, { type: T }> => e.type === type);

/** `createTestApp`, with the segues module publishing to `sink`. */
async function createSegueTestApp(): Promise<TestApp> {
  const tdb = await createTestDatabase();
  const mailer = createMemoryMailer();
  const app = await buildApp({
    db: { client: tdb },
    mail: { mailer },
    auth: TEST_AUTH_CONFIG,
    fastify: { logger: false },
    segues: { events: sink, jobs },
  });
  await app.ready();
  return {
    app,
    tdb,
    outbox: mailer.outbox,
    close: async () => {
      await app.close();
      await tdb.drop();
    },
  };
}

/** What the consumer does after a log edit. */
const logUpdated = () =>
  segueSync.handleEvent({
    id: crypto.randomUUID(),
    stationId,
    at: new Date().toISOString(),
    type: 'log.updated',
    data: { from: '', to: '', days: [{ logDayId, localDate: DATE, version: 1 }], cause: 'edit' },
  } as unknown as RealtimeEvent);

/** A ducks 3 s before its end under a voice; B comes in 0.5 s before A ends. */
const lanes = (voiceAssetId: string, start = sec(-3)) => ({
  out: {
    envelope: [
      { at: sec(-3.5), gainDb: 0 },
      { at: sec(-3), gainDb: -12 },
    ],
  },
  in: {
    start: sec(-0.5),
    envelope: [
      { at: sec(2), gainDb: -12 },
      { at: sec(2.5), gainDb: 0 },
    ],
  },
  voices: [{ assetId: voiceAssetId, start }],
});

const createBody = (from: string, to: string, voice: string, start?: number): CreateSegue => ({
  fromItemId: from,
  toItemId: to,
  ...lanes(voice, start),
});

async function audits(entityId: string) {
  return t.tdb.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId))
    .orderBy(asc(auditLog.at));
}

beforeAll(async () => {
  t = await createSegueTestApp();
  const db = t.tdb.db;
  segueSync = createSegueSync({ db, events: sink, jobs, logger: t.app.log });
  const org = await createOrganization(db, system, { slug: 'segues-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'segues-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  stationId = st.id;
  scope = await resolveStationScope(db, org.id, st.id);

  const other = await createOrganization(db, system, { slug: 'segues-other', name: 'Other' });
  const otherOrgScope = await resolveOrgScope(db, other.id);
  const ost = await createStation(
    db,
    { actor: system, scope: otherOrgScope },
    { slug: 'segues-other-fm', name: 'Other FM', timezone: 'Europe/Paris' },
  );
  otherStationId = ost.id;
  otherScope = await resolveStationScope(db, other.id, ost.id);

  const roles: [Who, StationRole][] = [
    ['programmer', 'programmer'],
    ['host', 'presenter'],
    ['presenter', 'presenter'],
    ['viewer', 'viewer'],
  ];
  for (const [who, role] of roles) {
    users[who] = await signUpAndLogin(t, `${who}@segues.test`);
    await addMembership(
      db,
      { actor: system, scope: orgScope },
      { level: 'station', stationId, userId: users[who].userId, role },
    );
  }
  users.outsider = await signUpAndLogin(t, 'outsider@segues.test');
  await addMembership(
    db,
    { actor: system, scope: otherOrgScope },
    { level: 'org', userId: users.outsider.userId, role: 'owner' },
  );

  assets.A = await newAsset(scope, 'A', 180);
  assets.B = await newAsset(scope, 'B', 6);
  assets.C = await newAsset(scope, 'C', 150);
  assets.D = await newAsset(scope, 'D', 200);
  assets.E = await newAsset(scope, 'E', 120);
  assets.VT1 = await newAsset(scope, 'VT1', 5, 'vt');
  assets.VT2 = await newAsset(scope, 'VT2', 4, 'vt');
  assets.VT3 = await newAsset(scope, 'VT3', null, 'vt');
  otherAsset = await newAsset(otherScope, 'X', 100, 'vt');

  // A (3 min) → B (6 s) → C → D → E, in that order.
  for (const name of ['A', 'B', 'C', 'D', 'E']) {
    items[name] = await addItem(assets[name] as string);
  }
  otherItem = crypto.randomUUID();
}, 60_000);

afterAll(() => t?.close());

describe('segue CRUD and islands', () => {
  let segue: Segue;

  it('creates a segue, derives its island and audits it', async () => {
    segue = await ok<Segue>(
      await call(
        'programmer',
        'POST',
        '/segues',
        createBody(items.C as string, items.D as string, assets.VT1 as string),
      ),
      201,
    );
    expect(segue).toMatchObject({
      fromItemId: items.C,
      toItemId: items.D,
      fromAssetId: assets.C,
      toAssetId: assets.D,
      status: 'ready',
      problem: null,
      version: 1,
      origin: 'manual',
      createdBy: users.programmer?.userId,
    });
    expect(segue.voices[0]).toMatchObject({ assetId: assets.VT1, gainDb: 0, envelope: [] });
    expect(segue.island).toMatchObject({
      status: 'pending',
      segueIds: [segue.id],
      itemIds: [items.C, items.D],
      head: { itemId: items.C, hasBody: true },
      tail: { itemId: items.D, hasBody: true },
      storageKey: null,
    });
    expect((segue.island?.tail.joinSample ?? 1) % 1024).toBe(0);
    expect(segue.island?.hash).toMatch(/^[0-9a-f]{64}$/);

    const full = await ok<Island>(await call('programmer', 'GET', `/islands/${segue.island?.id}`));
    expect(full.spec.sources.map((s) => full.files[s.sha256]?.assetId)).toEqual([
      assets.C,
      assets.VT1,
      assets.D,
    ]);
    expect(full.spec.format).toMatchObject({ codec: 'flac', sampleRate: SR, blockSize: 1024 });
    const pending = await ok<IslandList>(
      await call('programmer', 'GET', '/islands?status=pending'),
    );
    expect(pending.items.map((i) => i.id)).toContain(segue.island?.id);

    expect((await audits(segue.id)).map((a) => a.action)).toEqual(['segue.create']);
  });

  it('lists segues by item, by planned range and by status', async () => {
    const byItem = await ok<SegueList>(await call('presenter', 'GET', `/segues?itemId=${items.D}`));
    expect(byItem.items.map((s) => s.id)).toEqual([segue.id]);
    const range = await ok<SegueList>(
      await call(
        'presenter',
        'GET',
        `/segues?from=${encodeURIComponent('2026-11-01T00:00:00Z')}&to=${encodeURIComponent('2026-11-03T00:00:00Z')}`,
      ),
    );
    expect(range.items.map((s) => s.id)).toEqual([segue.id]);
    const ready = await ok<SegueList>(await call('presenter', 'GET', '/segues?status=ready'));
    expect(ready.items.map((s) => s.id)).toContain(segue.id);
  });

  it('keeps one segue per transition and validates its input', async () => {
    const dup = await call(
      'programmer',
      'POST',
      '/segues',
      createBody(items.C as string, items.E as string, assets.VT1 as string),
    );
    expect(dup.statusCode, dup.body).toBe(409);
    const unsorted = await call('programmer', 'POST', '/segues', {
      ...createBody(items.D as string, items.E as string, assets.VT1 as string),
      out: {
        envelope: [
          { at: 10, gainDb: 0 },
          { at: 5, gainDb: -6 },
        ],
      },
    });
    expect(unsorted.statusCode).toBe(400);
    const same = await call(
      'programmer',
      'POST',
      '/segues',
      createBody(items.D as string, items.D as string, assets.VT1 as string),
    );
    expect(same.statusCode).toBe(422);
  });

  it('re-derives on save: a new hash goes back to pending, an unchanged one keeps its render', async () => {
    // Pretend the renderer finished.
    await t.tdb.db
      .update(island)
      .set({ status: 'ready', storageKey: 'org/x/islands/v1/h.flac', renderedAt: new Date() })
      .where(eq(island.id, segue.island?.id as string));
    const same = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, {
        ...lanes(assets.VT1 as string),
        version: 1,
      }),
    );
    expect(same.version).toBe(2);
    expect(same.island).toMatchObject({
      id: segue.island?.id,
      hash: segue.island?.hash,
      status: 'ready',
    });

    const moved = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, {
        ...lanes(assets.VT1 as string, sec(-2)),
        version: 2,
      }),
    );
    expect(moved.island?.hash).not.toBe(segue.island?.hash);
    expect(moved.island).toMatchObject({ status: 'pending', storageKey: null });

    // Back to the first audio: the row was rewritten, so it renders again (the renderer can skip
    // the work when the content-addressed file is still in storage).
    const back = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(assets.VT1 as string)),
    );
    expect(back.island?.hash).toBe(segue.island?.hash);
    expect(back.island?.status).toBe('pending');

    const stale = await call('programmer', 'PUT', `/segues/${segue.id}`, {
      ...lanes(assets.VT1 as string),
      version: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect((await audits(segue.id)).map((a) => a.action)).toEqual([
      'segue.create',
      'segue.update',
      'segue.update',
      'segue.update',
    ]);
    segue = back;
  });

  it('flags a segue that does not fit its media as invalid', async () => {
    const res = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, {
        ...lanes(assets.VT1 as string),
        in: { start: -sec(400), envelope: [] },
      }),
    );
    expect(res).toMatchObject({
      status: 'invalid',
      island: null,
      problem: { code: 'out_of_range' },
    });
    segue = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(assets.VT1 as string)),
    );
    expect(segue.status).toBe('ready');
  });
});

describe('editor media', () => {
  it('resolves A, B and voices as the island sync does, and stays in the station', async () => {
    const media = await ok<SegueMediaResponse>(
      await call(
        'presenter',
        'GET',
        `/segues/media?itemIds=${items.C},${items.D}&assetIds=${assets.VT1},${assets.VT3},${otherAsset}`,
      ),
    );
    expect(media.items[items.C as string]).toMatchObject({
      assetId: assets.C,
      sampleRate: SR,
      durationSamples: sec(150),
      cueIn: 0,
      cueOut: sec(150),
    });
    expect(typeof media.items[items.C as string]?.gainDb).toBe('number');
    expect(media.items[items.D as string]?.assetId).toBe(assets.D);
    expect(media.assets[assets.VT1 as string]).toMatchObject({ durationSamples: sec(5) });
    // No playout copy yet, and another tenant's asset: both null.
    expect(media.assets[assets.VT3 as string]).toBeNull();
    expect(media.assets[otherAsset]).toBeNull();

    expect((await call('viewer', 'GET', `/segues/media?itemIds=${items.C}`)).statusCode).toBe(403);
    expect((await call('outsider', 'GET', `/segues/media?itemIds=${items.C}`)).statusCode).toBe(
      404,
    );
    // From another station, our item resolves to nothing.
    const other = await ok<SegueMediaResponse>(
      await call('outsider', 'GET', `/segues/media?itemIds=${items.C}`, undefined, otherStationId),
    );
    expect(other.items[items.C as string]).toBeNull();
    const tooMany = await call(
      'presenter',
      'GET',
      `/segues/media?itemIds=${items.A},${items.B},${items.C}`,
    );
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('chains', () => {
  it('merges A > VT1 > B(short) > VT2 > C into one island and splits it again', async () => {
    const s1 = await ok<Segue>(
      await call(
        'programmer',
        'POST',
        '/segues',
        createBody(items.A as string, items.B as string, assets.VT1 as string),
      ),
      201,
    );
    expect(s1.island?.segueIds).toEqual([s1.id]);
    // VT2 over B's last 2.5 s: B (6 s) has no room for a body between the two islands.
    const s2 = await ok<Segue>(
      await call('programmer', 'POST', '/segues', {
        ...createBody(items.B as string, items.C as string, assets.VT2 as string, sec(-2.5)),
        out: {
          envelope: [
            { at: sec(-3), gainDb: 0 },
            { at: sec(-2.5), gainDb: -10 },
          ],
        },
      }),
      201,
    );
    // B→C joins the C→D chain too: C's body (150 s) keeps that island apart.
    expect(s2.island).toMatchObject({
      segueIds: [s1.id, s2.id],
      itemIds: [items.A, items.B, items.C],
      head: { itemId: items.A },
      tail: { itemId: items.C, hasBody: true },
    });
    const again = await ok<Segue>(await call('programmer', 'GET', `/segues/${s1.id}`));
    expect(again.island?.id).toBe(s2.island?.id);
    const cd = await ok<SegueList>(await call('programmer', 'GET', `/segues?itemId=${items.D}`));
    expect(cd.items[0]?.island?.head.itemId).toBe(items.C);

    // The first island row (head A) is reused for the merged one; deleting s2 splits it back.
    expect((await call('programmer', 'DELETE', `/segues/${s2.id}`)).statusCode).toBe(204);
    const split = await ok<Segue>(await call('programmer', 'GET', `/segues/${s1.id}`));
    expect(split.island).toMatchObject({ segueIds: [s1.id], tail: { itemId: items.B } });
    expect(split.island?.hash).toBe(s1.island?.hash);
    const islands = await ok<IslandList>(await call('programmer', 'GET', '/islands?limit=500'));
    expect(islands.items.every((i) => !i.segueIds.includes(s2.id))).toBe(true);
    expect((await audits(s2.id)).map((a) => a.action)).toEqual(['segue.create', 'segue.delete']);
  });
});

describe('invalidation', () => {
  it('detaches a segue when an item lands between A and B, and re-attaches when it leaves', async () => {
    const [segue] = (
      await ok<SegueList>(await call('programmer', 'GET', `/segues?itemId=${items.D}`))
    ).items;
    const between = await addItem(assets.E as string, { after: items.C });
    const result = await logUpdated();
    expect(result?.segues.map((s) => s.segueId)).toContain(segue?.id);
    const detached = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue?.id}`));
    expect(detached).toMatchObject({
      status: 'detached',
      island: null,
      problem: { code: 'not_consecutive' },
    });
    expect(result?.removed.map((r) => r.id)).toContain(segue?.island?.id);

    expect((await call('programmer', 'DELETE', `/log/items/${between}`)).statusCode).toBe(200);
    await logUpdated();
    const back = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue?.id}`));
    expect(back.status).toBe('ready');
    expect(back.island?.hash).toBe(segue?.island?.hash);
  });

  it('detaches when B plays another asset, until the segue is saved again', async () => {
    const [segue] = (
      await ok<SegueList>(await call('programmer', 'GET', `/segues?itemId=${items.D}`))
    ).items;
    expect(
      (
        await call('programmer', 'PUT', `/log/items/${items.D}`, {
          kind: 'song',
          assetId: assets.E,
          plannedDurationMs: 60_000,
        })
      ).statusCode,
    ).toBe(200);
    await logUpdated();
    const detached = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue?.id}`));
    expect(detached).toMatchObject({ status: 'detached', problem: { code: 'asset_changed' } });
    const saved = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue?.id}`, lanes(assets.VT1 as string)),
    );
    expect(saved).toMatchObject({ status: 'ready', toAssetId: assets.E });
    expect(saved.island?.hash).not.toBe(segue?.island?.hash);
  });

  it('keeps the voice work when A is deleted, listed as detached', async () => {
    const extra = await addItem(assets.A as string);
    const last = await addItem(assets.C as string);
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(extra, last, assets.VT2 as string)),
      201,
    );
    expect((await call('programmer', 'DELETE', `/log/items/${extra}`)).statusCode).toBe(200);
    await logUpdated();
    const detached = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(detached).toMatchObject({
      status: 'detached',
      fromItemId: null,
      toItemId: last,
      problem: { code: 'item_deleted' },
      island: null,
    });
    expect(detached.voices[0]?.assetId).toBe(assets.VT2);
    const list = await ok<SegueList>(await call('programmer', 'GET', '/segues?status=detached'));
    expect(list.items.map((s) => s.id)).toContain(segue.id);
    // Saving needs a place again.
    expect(
      (await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(assets.VT2 as string)))
        .statusCode,
    ).toBe(422);
    expect((await call('programmer', 'DELETE', `/segues/${segue.id}`)).statusCode).toBe(204);
  });

  it('waits for a voice without a playout copy, and syncs on asset.ingested', async () => {
    const a = await addItem(assets.C as string);
    const b = await addItem(assets.A as string);
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT3 as string)),
      201,
    );
    expect(segue).toMatchObject({
      status: 'waiting',
      problem: { code: 'missing_media' },
      island: null,
    });
    await addPlayout(scope, assets.VT3 as string, 'VT3', 3);
    await segueSync.handleEvent({
      id: crypto.randomUUID(),
      stationId,
      at: new Date().toISOString(),
      type: 'asset.ingested',
      data: { assetId: assets.VT3 },
    } as unknown as RealtimeEvent);
    const ready = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(ready.status).toBe('ready');
    expect(ready.island?.status).toBe('pending');
  });
});

describe('permissions and tenancy', () => {
  let hostItemA: string;
  let hostItemB: string;
  let showId: string;

  beforeAll(async () => {
    const show = await ok<Show>(
      await call('programmer', 'POST', '/shows', {
        name: 'Morning',
        defaultDurationMs: 3_600_000,
        hostUserIds: [users.host?.userId],
      }),
      201,
    );
    showId = show.id;
    const slot = await ok<ShowSlot>(
      await call('programmer', 'POST', `/shows/${show.id}/slots`, {
        rule: { freq: 'once', date: DATE, time: '10:00' },
      }),
      201,
    );
    hostItemA = await addItem(assets.D as string);
    hostItemB = await addItem(assets.E as string);
    await t.tdb.db
      .update(logItem)
      .set({ originType: 'show', originShowSlotId: slot.id })
      .where(eq(logItem.id, hostItemA));
  });

  it('lets a host voice-track their show, not someone else’s', async () => {
    const own = await ok<Segue>(
      await call('host', 'POST', '/segues', createBody(hostItemA, hostItemB, assets.VT1 as string)),
      201,
    );
    expect(own.createdBy).toBe(users.host?.userId);
    await ok<Segue>(await call('host', 'PUT', `/segues/${own.id}`, lanes(assets.VT2 as string)));
    expect(
      (await call('presenter', 'PUT', `/segues/${own.id}`, lanes(assets.VT2 as string))).statusCode,
    ).toBe(403);
    expect((await call('presenter', 'DELETE', `/segues/${own.id}`)).statusCode).toBe(403);
    // Not the host's show: A → B of the music log.
    const [ab] = (await ok<SegueList>(await call('host', 'GET', `/segues?itemId=${items.A}`)))
      .items;
    expect(
      (await call('host', 'PUT', `/segues/${ab?.id}`, lanes(assets.VT2 as string))).statusCode,
    ).toBe(403);
    const elsewhere = await addItem(assets.A as string);
    const next = await addItem(assets.C as string);
    expect(
      (await call('host', 'POST', '/segues', createBody(elsewhere, next, assets.VT1 as string)))
        .statusCode,
    ).toBe(403);
    // Moving their segue off their show is refused too.
    expect(
      (
        await call('host', 'PUT', `/segues/${own.id}`, {
          ...lanes(assets.VT1 as string),
          fromItemId: elsewhere,
          toItemId: next,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('host', 'DELETE', `/segues/${own.id}`)).statusCode).toBe(204);
  });

  it('lets a creator keep editing their segue once they no longer host the show', async () => {
    const own = await ok<Segue>(
      await call('host', 'POST', '/segues', createBody(hostItemA, hostItemB, assets.VT1 as string)),
      201,
    );
    await ok<Show>(await call('programmer', 'PATCH', `/shows/${showId}`, { hostUserIds: [] }));
    // Not a host any more, but the creator: write_own still covers this segue…
    const saved = await ok<Segue>(
      await call('host', 'PUT', `/segues/${own.id}`, lanes(assets.VT2 as string)),
    );
    expect(saved.version).toBe(2);
    // …not someone else's, and not a new one on the show.
    expect(
      (await call('presenter', 'PUT', `/segues/${own.id}`, lanes(assets.VT1 as string))).statusCode,
    ).toBe(403);
    expect((await call('host', 'DELETE', `/segues/${own.id}`)).statusCode).toBe(204);
    expect(
      (
        await call(
          'host',
          'POST',
          '/segues',
          createBody(hostItemA, hostItemB, assets.VT1 as string),
        )
      ).statusCode,
    ).toBe(403);
  });

  it('refuses readers without voice_track:read and every other tenant', async () => {
    expect((await call('viewer', 'GET', '/segues?status=ready')).statusCode).toBe(403);
    expect(
      (
        await call(
          'viewer',
          'POST',
          '/segues',
          createBody(items.A as string, items.B as string, assets.VT1 as string),
        )
      ).statusCode,
    ).toBe(403);
    const [ab] = (await ok<SegueList>(await call('programmer', 'GET', `/segues?itemId=${items.A}`)))
      .items;
    // Not a member: the station itself is hidden.
    expect((await call('outsider', 'GET', `/segues/${ab?.id}`)).statusCode).toBe(404);
    // From their own station, our ids don't exist.
    expect(
      (await call('outsider', 'GET', `/segues/${ab?.id}`, undefined, otherStationId)).statusCode,
    ).toBe(404);
    expect(
      (await call('outsider', 'GET', `/islands/${ab?.island?.id}`, undefined, otherStationId))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'outsider',
          'POST',
          '/segues',
          createBody(items.A as string, items.B as string, assets.VT1 as string),
          otherStationId,
        )
      ).statusCode,
    ).toBe(404);
    const empty = await ok<IslandList>(
      await call('outsider', 'GET', '/islands', undefined, otherStationId),
    );
    expect(empty.items).toEqual([]);
    // Another tenant's voice asset, or an unknown item, in our station.
    const foreignVoice = await call(
      'programmer',
      'POST',
      '/segues',
      createBody(items.D as string, items.E as string, otherAsset),
    );
    expect(foreignVoice.statusCode, foreignVoice.body).toBe(422);
    expect(
      (
        await call(
          'programmer',
          'POST',
          '/segues',
          createBody(otherItem, items.E as string, assets.VT1 as string),
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('events', () => {
  it('publishes segue.changed and island.updated on create, island.removed on delete', async () => {
    const a = await addItem(assets.C as string);
    const b = await addItem(assets.A as string);
    published.length = 0;
    enqueued.length = 0;
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT1 as string)),
      201,
    );
    // Re-render on change (#56): one render job per pending hash, scoped to the station.
    expect(enqueued).toEqual([
      {
        name: 'island-render',
        payload: { orgId: scope.orgId, stationId, hash: segue.island?.hash },
      },
    ]);
    expect(take('segue.changed')).toEqual([
      expect.objectContaining({
        stationId,
        data: {
          segueId: segue.id,
          change: 'created',
          status: 'ready',
          problem: null,
          islandId: segue.island?.id,
          fromItemId: a,
          toItemId: b,
        },
      }),
    ]);
    expect(take('island.updated')).toEqual([
      expect.objectContaining({
        data: {
          islandId: segue.island?.id,
          hash: segue.island?.hash,
          status: 'pending',
          segueIds: [segue.id],
          headItemId: a,
          tailItemId: b,
        },
      }),
    ]);

    published.length = 0;
    expect((await call('programmer', 'DELETE', `/segues/${segue.id}`)).statusCode).toBe(204);
    expect(take('segue.changed').map((e) => e.data)).toEqual([
      {
        segueId: segue.id,
        change: 'deleted',
        status: null,
        problem: null,
        islandId: null,
        fromItemId: a,
        toItemId: b,
      },
    ]);
    expect(take('island.removed').map((e) => e.data)).toEqual([
      { islandId: segue.island?.id, hash: segue.island?.hash },
    ]);
  });

  it('publishes synced segues when the log moves under them', async () => {
    const a = await addItem(assets.C as string);
    const b = await addItem(assets.A as string);
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT1 as string)),
      201,
    );
    published.length = 0;
    expect((await call('programmer', 'DELETE', `/log/items/${a}`)).statusCode).toBe(200);
    await logUpdated();
    expect(take('segue.changed').map((e) => e.data)).toEqual([
      expect.objectContaining({
        segueId: segue.id,
        change: 'synced',
        status: 'detached',
        problem: 'item_deleted',
      }),
    ]);
    expect(take('island.removed').map((e) => e.data.islandId)).toEqual([segue.island?.id]);
  });
});

describe('invalidation triggers', () => {
  let a: string;
  let b: string;
  let segue: Segue;
  const library = (method: string, url: string, assetId: string, body?: unknown) => {
    const route = libraryRoutes.find((r) => r.method === method && r.url.endsWith(url));
    if (!route) throw new Error(`no route ${method} ${url}`);
    const user: Actor = { type: 'user', userId: users.programmer?.userId as string };
    return runRoute(
      route,
      { db: t.tdb.db, publish: sink.publish },
      async () => ({ actor: user, scope }),
      { params: { stationId, assetId }, query: {}, body },
    );
  };
  /**
   * The library refuses to delete an asset a segue or a coming log item still uses (#23,
   * 409 `asset_in_use`). A delete that happens anyway (directly in the database, an admin
   * fix) still announces `asset.deleted`: the sync must cope.
   */
  const forceDelete = async (assetId: string) => {
    await expect(library('DELETE', '/assets/:assetId', assetId)).rejects.toMatchObject({
      code: 'asset_in_use',
    });
    await deleteAsset(t.tdb.db, { actor: system, scope }, assetId);
    published.length = 0;
    return segueSync.handleEvent({
      id: crypto.randomUUID(),
      stationId,
      at: new Date().toISOString(),
      type: 'asset.deleted',
      data: { assetId },
    });
  };
  /** Library event → consumer, as the durable queue would deliver it. */
  const deliver = async (type: RealtimeEvent['type']) => {
    const events = take(type);
    expect(events).toHaveLength(1);
    published.length = 0;
    return segueSync.handleEvent(events[0] as RealtimeEvent);
  };

  beforeAll(async () => {
    assets.F = await newAsset(scope, 'F', 100);
    assets.G = await newAsset(scope, 'G', 100);
    assets.VT4 = await newAsset(scope, 'VT4', 5, 'vt');
    a = await addItem(assets.F as string);
    b = await addItem(assets.G as string);
    segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT4 as string)),
      201,
    );
    expect(segue.status).toBe('ready');
  });

  async function expectRederived() {
    const after = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(after.status).toBe('ready');
    expect(after.island?.hash).not.toBe(segue.island?.hash);
    expect(after.island?.status).toBe('pending');
    segue = after;
  }

  it('re-derives on a cue edit in the library', async () => {
    published.length = 0;
    enqueued.length = 0;
    const res = await library('PUT', '/assets/:assetId/cues', assets.F as string, {
      sampleRate: SR,
      cueOut: { samples: sec(90) },
    });
    expect(res.status).toBe(200);
    expect(take('asset.updated').map((e) => e.data)).toEqual([
      { assetId: assets.F, changes: ['cues'] },
    ]);
    const result = await deliver('asset.updated');
    expect(result?.islands.map((i) => i.id)).toEqual([segue.island?.id]);
    // The consumer's sync enqueues the new hash's render too.
    expect(renders()).toEqual(result?.islands.map((i) => i.hash));
    await expectRederived();
  });

  it('re-derives on a loudness measurement (the analysis jobs publish asset.updated)', async () => {
    await setLoudness(t.tdb.db, { actor: system, scope }, assets.G as string, {
      integratedLufs: -20,
      loudnessRangeLu: null,
      truePeakDbtp: -6,
      playoutSha256: null,
      analyzer: 'test',
      analyzerVersion: '1',
      confidence: null,
    });
    await segueSync.handleEvent({
      id: crypto.randomUUID(),
      stationId,
      at: new Date().toISOString(),
      type: 'asset.updated',
      data: { assetId: assets.G as string, changes: ['loudness'] },
    });
    await expectRederived();
  });

  it('re-derives on an asset setting (gain override)', async () => {
    published.length = 0;
    const res = await library('PATCH', '/assets/:assetId', assets.VT4 as string, {
      gainOverrideDb: -4,
    });
    expect(res.status).toBe(200);
    expect(take('asset.updated').map((e) => e.data.changes)).toEqual([['settings']]);
    await deliver('asset.updated');
    await expectRederived();
  });

  it('re-derives every island on a station loudness change, and only then', async () => {
    await updateStation(t.tdb.db, { actor: system, scope }, { loudnessTargetLufs: -18 });
    const event = (fields: string[]): RealtimeEvent => ({
      id: crypto.randomUUID(),
      stationId,
      at: new Date().toISOString(),
      type: 'station.updated',
      data: { fields },
    });
    expect(await segueSync.handleEvent(event(['name']))).toBeNull();
    const result = await segueSync.handleEvent(event(['loudnessTargetLufs']));
    expect(result?.islands.map((i) => i.id)).toContain(segue.island?.id);
    await expectRederived();
  });

  it('invalidates a segue whose voice asset is deleted', async () => {
    const vt5 = await newAsset(scope, 'VT5', 4, 'vt');
    segue = await ok<Segue>(await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(vt5)));
    expect(segue.status).toBe('ready');
    const result = await forceDelete(vt5);
    expect(result?.removed.map((r) => r.id)).toEqual([segue.island?.id]);
    const after = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(after).toMatchObject({
      status: 'invalid',
      island: null,
      problem: { code: 'missing_media', message: "voice 1's asset was deleted" },
    });
    segue = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(assets.VT4 as string)),
    );
    expect(segue.status).toBe('ready');
  });

  it('detaches a segue whose B asset is deleted', async () => {
    await forceDelete(assets.G as string);
    const after = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(after).toMatchObject({
      status: 'detached',
      toAssetId: null,
      island: null,
      problem: { code: 'asset_changed', message: "B's asset was deleted" },
    });
  });
});

describe('feeder and renderer helpers', () => {
  it('derives islands read-only: what may air is a ready render of the current hash', async () => {
    const [cd] = (await ok<SegueList>(await call('programmer', 'GET', `/segues?itemId=${items.D}`)))
      .items;
    const island = cd?.island;
    if (!cd || !island) throw new Error('no C → D island');
    const before = await derive([items.C as string]);
    expect(before.islands.map((i) => i.hash)).toContain(island.hash);
    expect(before.segues).toContainEqual({ segueId: cd.id, status: 'ready', problem: null });
    const mine = before.islands.find((i) => i.hash === island.hash);
    expect(mine).toMatchObject({ head: { itemId: items.C }, rendered: null });

    // The renderer stores it: now it may air.
    published.length = 0;
    const key = islandStorageKey(scope.orgId, island.hash);
    const file = { sha256: 'f'.repeat(64), sizeBytes: 12_345 };
    const rows = await markIslandRendered(
      t.tdb.db,
      scope,
      { hash: island.hash, storageKey: key, file },
      sink.publish,
    );
    expect(rows.map((r) => r.id)).toContain(island.id);
    expect(take('island.updated').map((e) => e.data)).toContainEqual(
      expect.objectContaining({ islandId: island.id, status: 'ready', hash: island.hash }),
    );
    const rendered = await derive([items.C as string]);
    expect(rendered.islands.find((i) => i.hash === island.hash)?.rendered).toEqual({
      islandId: island.id,
      storageKey: key,
      file,
    });

    // A library edit the sync hasn't seen yet: the inputs no longer match the render.
    await updateCues(t.tdb.db, { actor: system, scope }, island.tail.assetId, {
      sampleRate: SR,
      cueIn: { samples: 2048 },
    });
    const stale = await derive([items.C as string]);
    expect(stale.islands.map((i) => i.hash)).not.toContain(island.hash);
    expect(stale.islands.find((i) => i.head.itemId === items.C)?.rendered).toBeNull();
    // Nothing was written.
    const row = await ok<Island>(await call('programmer', 'GET', `/islands/${island.id}`));
    expect(row).toMatchObject({ hash: island.hash, status: 'ready', storageKey: key, file });
  });

  it('only marks a render ready while the island still has the rendered hash', async () => {
    const a = await addItem(assets.C as string);
    const b = await addItem(assets.A as string);
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT1 as string)),
      201,
    );
    const first = segue.island?.hash as string;
    const claimed = await claimIslandRender(t.tdb.db, scope, first);
    expect(claimed.map((r) => r.status)).toEqual(['rendering']);
    expect(await claimIslandRender(t.tdb.db, scope, first)).toEqual([]);

    // The presenter moves the voice while the render runs.
    const moved = await ok<Segue>(
      await call('programmer', 'PUT', `/segues/${segue.id}`, lanes(assets.VT1 as string, sec(-2))),
    );
    const second = moved.island?.hash as string;
    expect(second).not.toBe(first);
    expect(moved.island?.status).toBe('pending');

    const key = (h: string) => islandStorageKey(scope.orgId, h);
    expect(
      await markIslandRendered(t.tdb.db, scope, { hash: first, storageKey: key(first) }),
    ).toEqual([]);
    expect(await markIslandFailed(t.tdb.db, scope, { hash: first, error: 'late' })).toEqual([]);
    const still = await ok<Island>(await call('programmer', 'GET', `/islands/${moved.island?.id}`));
    expect(still).toMatchObject({ hash: second, status: 'pending', storageKey: null });

    // Another station's island with the same hash is out of reach.
    expect(
      await markIslandRendered(t.tdb.db, otherScope, { hash: second, storageKey: key(second) }),
    ).toEqual([]);
    const failed = await markIslandFailed(t.tdb.db, scope, { hash: second, error: 'decoder' });
    expect(failed.map((r) => [r.status, r.error])).toEqual([['failed', 'decoder']]);
    const done = await markIslandRendered(t.tdb.db, scope, {
      hash: second,
      storageKey: key(second),
    });
    expect(done.map((r) => r.status)).toEqual(['ready']);
  });
});

describe('concurrency', () => {
  it('serialises saves with the event consumer: no deadlock, no 500', async () => {
    const a = await addItem(assets.C as string);
    const b = await addItem(assets.A as string);
    const segue = await ok<Segue>(
      await call('programmer', 'POST', '/segues', createBody(a, b, assets.VT1 as string)),
      201,
    );
    for (let round = 0; round < 8; round++) {
      const [put, del] = await Promise.all([
        call(
          'programmer',
          'PUT',
          `/segues/${segue.id}`,
          lanes(assets.VT1 as string, sec(-3) + round),
        ),
        segueSync.sync(scope, { segueIds: [segue.id], logDayIds: [logDayId], orphans: true }),
        logUpdated(),
        call(
          'programmer',
          'PUT',
          `/segues/${segue.id}`,
          lanes(assets.VT1 as string, sec(-2) - round),
        ),
      ]).then(([p1, , , p2]) => [p1, p2] as const);
      for (const res of [put, del]) expect([200, 409], res.body).toContain(res.statusCode);
    }
    const final = await ok<Segue>(await call('programmer', 'GET', `/segues/${segue.id}`));
    expect(final.status).toBe('ready');
    expect(final.island?.segueIds).toEqual([segue.id]);
  });
});

const derive = (itemIds: string[]) => deriveIslandsFor(t.tdb.db, scope, itemIds);
