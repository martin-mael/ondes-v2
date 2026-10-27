import {
  auditLog,
  createOrganization,
  createStation,
  liveNowPlaying,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, EngineLiveMetadata, EngineState, RealtimeEvent } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../plugins/errors.ts';
import { createShow, createSlot } from '../shows/repo.ts';
import { createLiveMetadata, getLiveNowPlaying, type LiveMetadata } from './metadata.ts';
import { createStreamer, updateStreamer } from './repo.ts';
import { createLiveSwitcher, type LiveSwitcher } from './switching.ts';
import { fakeEngine } from './testing/fake-engine.ts';

// Live metadata (#68, ADR 0040) against a real database and an in-memory engine: the default
// on going live, the encoder's when the streamer allows it, a manual one, a handover, two
// replicas, and the sweep re-sending what the engine lost. What listeners hear on the streams
// is live-metadata.engine.int.test.ts.

const system: Actor = { type: 'system', name: 'metadata-test' };
const logger = { info: () => {}, warn: () => {}, error: () => {} };
// The show's live slot: Thursday 5 November 2026, 20:00–21:00 in Paris (19:00–20:00 UTC).
const IN_SLOT = new Date('2026-11-05T19:10:00Z');

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: StationScope;
let engine: ReturnType<typeof engineWithMetadata>;
let published: RealtimeEvent[];
const ids: Record<string, string> = {};

/** The pool's fake engine, plus the now-playing it was sent (and holds, like the template). */
function engineWithMetadata() {
  const base = fakeEngine();
  const poolState = base.state;
  const sent: EngineLiveMetadata[] = [];
  const blank = { title: '', artist: '', encoder: false };
  let held = blank;
  let heldFor: string | null = null;
  return Object.assign(base, {
    sent,
    held: () => (base.sessionId === heldFor ? held : blank),
    forget() {
      held = blank;
    },
    async state(): Promise<EngineState> {
      const s = await poolState();
      return { ...s, live: { ...s.live, now_playing: base.sessionId === heldFor ? held : blank } };
    },
    async setLiveMetadata(m: EngineLiveMetadata) {
      sent.push(m);
      heldFor = base.sessionId;
      held = { title: m.title ?? '', artist: m.artist ?? '', encoder: m.encoder };
      return base.enabled;
    },
  });
}

function replica(): { switcher: LiveSwitcher; metadata: LiveMetadata } {
  const publish = (event: RealtimeEvent) => {
    published.push(event);
  };
  return {
    switcher: createLiveSwitcher({
      db: tdb.db,
      engineFor: async () => engine,
      publish,
      logger,
      now: () => IN_SLOT,
    }),
    metadata: createLiveMetadata({
      db: tdb.db,
      engineFor: async () => engine,
      publish,
      logger,
      now: () => IN_SLOT,
    }),
  };
}
const ctx = () => ({ actor: system, scope });
const changes = () =>
  published.flatMap((e) => (e.type === 'live.metadata.changed' ? [e.data] : []));

/** Delivers what the switcher published to the metadata module, as the fanout does. */
async function deliver(metadata: LiveMetadata, from = 0) {
  for (const e of published.slice(from)) await metadata.onEvent(e);
}

function encoderEvent(sessionId: string, title: string | null, artist: string | null) {
  return {
    id: crypto.randomUUID(),
    stationId: scope.stationId,
    at: IN_SLOT.toISOString(),
    type: 'engine.live.metadata',
    data: { bootId: 'b1', seq: 7, input: 1, sessionId, streamerId: null, title, artist },
  } as RealtimeEvent;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'meta-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'meta-fm', name: 'Meta FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  const show = await createShow(db, ctx(), { name: 'Night Shift' });
  await createSlot(db, ctx(), show.id, {
    type: 'live',
    rule: { freq: 'once', date: '2026-11-05', time: '20:00' },
    durationMs: 3_600_000,
  });
  for (const [username, extra] of [
    ['nova', { displayName: 'DJ Nova', showIds: [show.id] }],
    ['guest', { displayName: 'Guest', anyTime: true }],
  ] as [string, { displayName: string; showIds?: string[]; anyTime?: boolean }][]) {
    const created = await createStreamer(db, ctx(), { username, ...extra });
    ids[username] = created.streamer.id;
  }
}, 60_000);

afterAll(() => tdb?.drop());

beforeEach(async () => {
  await tdb.db.delete(liveSession);
  await updateStreamer(tdb.db, ctx(), ids.nova ?? '', { encoderMetadata: false });
  engine = engineWithMetadata();
  published = [];
});

describe('live metadata', () => {
  it('sends the show, episode and DJ when a DJ goes on air, once across replicas', async () => {
    const a = replica();
    const b = replica();
    engine.connect(1, ids.nova ?? null);
    const session = await a.switcher.goLive(ctx(), 1, 'slot');
    expect(session.episode?.number).toBeTypeOf('number');
    // Both replicas receive `live.session.started`.
    await deliver(a.metadata);
    await deliver(b.metadata);

    const title = `Night Shift #${session.episode?.number}`;
    expect(changes()).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        input: 1,
        title,
        artist: 'DJ Nova',
        source: 'default',
        encoderAllowed: false,
      }),
    ]);
    expect(engine.sent).toEqual([{ title, artist: 'DJ Nova', encoder: false }]);
    expect(await getLiveNowPlaying(tdb.db, scope)).toMatchObject({ title, source: 'default' });
  });

  it("keeps the encoder's metadata off the streams unless the streamer allows it", async () => {
    const { switcher, metadata } = replica();
    engine.connect(1, ids.nova ?? null);
    const session = await switcher.goLive(ctx(), 1, 'slot');
    await deliver(metadata);
    const sent = engine.sent.length;

    await metadata.onEvent(encoderEvent(session.id, 'First Song', 'Encoder Artist'));
    expect(changes()).toHaveLength(1);
    expect(engine.sent).toHaveLength(sent);
    expect((await getLiveNowPlaying(tdb.db, scope))?.source).toBe('default');
    const [row] = await tdb.db.select().from(liveNowPlaying);
    expect(row).toMatchObject({ encoderTitle: 'First Song', encoderArtist: 'Encoder Artist' });

    // Allowed now: the last thing the encoder sent goes on air, and the engine lets it through.
    await updateStreamer(tdb.db, ctx(), ids.nova ?? '', { encoderMetadata: true });
    await metadata.refresh(scope);
    expect(changes().at(-1)).toMatchObject({
      title: 'First Song',
      artist: 'Encoder Artist',
      source: 'encoder',
      encoderAllowed: true,
    });
    expect(engine.sent.at(-1)).toEqual({
      title: 'First Song',
      artist: 'Encoder Artist',
      encoder: true,
    });

    // The next track from the encoder.
    await metadata.onEvent(encoderEvent(session.id, 'Second Song', null));
    expect(changes().at(-1)).toMatchObject({ title: 'Second Song', artist: null });

    // Metadata of another session (a late event after a handover) is ignored.
    await metadata.onEvent(encoderEvent(crypto.randomUUID(), 'Stale', null));
    expect((await getLiveNowPlaying(tdb.db, scope))?.title).toBe('Second Song');
  });

  it('a manual now-playing wins over the encoder until cleared, audited', async () => {
    await updateStreamer(tdb.db, ctx(), ids.nova ?? '', { encoderMetadata: true });
    const { switcher, metadata } = replica();
    engine.connect(1, ids.nova ?? null);
    const session = await switcher.goLive(ctx(), 1, 'slot');
    await deliver(metadata);
    await metadata.onEvent(encoderEvent(session.id, 'Encoder Song', null));

    const manual = await metadata.setManual(ctx(), {
      title: 'Live at the Marché',
      artist: ' Kiosque ',
    });
    expect(manual).toMatchObject({
      title: 'Live at the Marché',
      artist: 'Kiosque',
      source: 'manual',
    });
    expect(engine.sent.at(-1)).toEqual({
      title: 'Live at the Marché',
      artist: 'Kiosque',
      encoder: false,
    });
    await metadata.onEvent(encoderEvent(session.id, 'Ignored Song', null));
    expect((await getLiveNowPlaying(tdb.db, scope))?.title).toBe('Live at the Marché');

    const cleared = await metadata.clearManual(ctx());
    expect(cleared).toMatchObject({ title: 'Ignored Song', source: 'encoder' });
    expect(engine.sent.at(-1)?.encoder).toBe(true);

    const audits = await tdb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, session.id));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['live.now_playing.set', 'live.now_playing.clear']),
    );
    await expect(metadata.setManual(ctx(), { title: ' ', artist: '' })).rejects.toThrow();
  });

  it('follows the DJ after a handover, and says 409 when nobody is on air', async () => {
    const { switcher, metadata } = replica();
    engine.connect(1, ids.nova ?? null);
    engine.connect(2, ids.guest ?? null);
    await switcher.goLive(ctx(), 1, 'slot');
    await deliver(metadata);
    await metadata.setManual(ctx(), { title: 'Something by hand' });

    const from = published.length;
    const second = await switcher.goLive(ctx(), 2, 'manual', null);
    await deliver(metadata, from);
    // The new session's own default: the guest, unbound, has no show.
    expect(await getLiveNowPlaying(tdb.db, scope)).toMatchObject({
      sessionId: second.id,
      input: 2,
      title: null,
      artist: 'Guest',
      source: 'default',
    });
    expect(engine.sent.at(-1)).toEqual({ title: null, artist: 'Guest', encoder: false });

    await switcher.returnToAutomation(ctx());
    expect(await getLiveNowPlaying(tdb.db, scope)).toBeNull();
    const err = await metadata.setManual(ctx(), { title: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('the sweep fills in a missed session start and re-sends what the engine lost', async () => {
    const { switcher, metadata } = replica();
    engine.connect(1, ids.nova ?? null);
    const session = await switcher.goLive(ctx(), 1, 'slot');
    // `live.session.started` never arrived here.
    await metadata.sweep(scope);
    expect(changes()).toHaveLength(1);
    expect(engine.held().artist).toBe('DJ Nova');

    // Nothing changed: no event, no command.
    const sent = engine.sent.length;
    await metadata.sweep(scope);
    expect(engine.sent).toHaveLength(sent);

    // The engine lost it (a push that failed): sent again, with no new event.
    engine.forget();
    await metadata.sweep(scope);
    expect(engine.sent).toHaveLength(sent + 1);
    expect(engine.held().title).toBe(`Night Shift #${session.episode?.number}`);
    expect(changes()).toHaveLength(1);
  });
});
