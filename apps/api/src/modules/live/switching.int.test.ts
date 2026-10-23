import {
  auditLog,
  createOrganization,
  createStation,
  liveSession,
  resolveOrgScope,
  resolveStationScope,
  type StationScope,
  streamer,
} from '@ondes/db';
import { createTestDatabase } from '@ondes/db/testing';
import type { Actor, RealtimeEvent } from '@ondes/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../plugins/errors.ts';
import { createShow, createSlot } from '../shows/repo.ts';
import { createStreamer, updateStreamer } from './repo.ts';
import { createLiveRevoker } from './revoke.ts';
import { createLiveSwitcher, type LiveSwitchEngine, type LiveSwitcher } from './switching.ts';
import { fakeEngine } from './testing/fake-engine.ts';

// Live switching (#64, ADR 0027) against a real database and an in-memory engine with a pool
// of two harbor inputs. The recorded test on the real engine is live-switching.engine.int.test.ts.

const system: Actor = { type: 'system', name: 'switching-test' };
const logger = { info: () => {}, warn: () => {}, error: () => {} };
// The show's live slot: Thursday 5 November 2026, 20:00–21:00 in Paris (19:00–20:00 UTC).
const IN_SLOT = new Date('2026-11-05T19:10:00Z');
const BEFORE_SLOT = new Date('2026-11-05T18:50:00Z');

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: StationScope;
let engine: ReturnType<typeof fakeEngine>;
let published: RealtimeEvent[];
let now: Date;
const ids: Record<string, string> = {};

function switcher(): LiveSwitcher {
  return createLiveSwitcher({
    db: tdb.db,
    engineFor: async (stationId) =>
      stationId === scope.stationId ? (engine as LiveSwitchEngine) : undefined,
    publish: (event) => {
      published.push(event);
    },
    logger,
    now: () => now,
  });
}
const ctx = () => ({ actor: system, scope });

async function sessions() {
  return tdb.db
    .select()
    .from(liveSession)
    .where(eq(liveSession.stationId, scope.stationId))
    .orderBy(liveSession.startedAt);
}

function engineEvent(type: 'engine.live.connected' | 'engine.live.disconnected', input: number) {
  const base = { id: crypto.randomUUID(), stationId: scope.stationId, at: now.toISOString() };
  const origin = { bootId: 'b1', seq: 1, input, streamerId: null };
  return (
    type === 'engine.live.connected'
      ? { ...base, type, data: { ...origin, headers: [] } }
      : { ...base, type, data: origin }
  ) as RealtimeEvent;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  const db = tdb.db;
  const org = await createOrganization(db, system, { slug: 'switch-org', name: 'Org' });
  const orgScope = await resolveOrgScope(db, org.id);
  const st = await createStation(
    db,
    { actor: system, scope: orgScope },
    { slug: 'switch-fm', name: 'FM', timezone: 'Europe/Paris' },
  );
  scope = await resolveStationScope(db, org.id, st.id);
  const show = await createShow(db, ctx(), { name: 'Night Shift' });
  await createSlot(db, ctx(), show.id, {
    type: 'live',
    rule: { freq: 'once', date: '2026-11-05', time: '20:00' },
    durationMs: 3_600_000,
  });
  for (const [username, extra] of [
    ['resident', { showIds: [show.id] }],
    ['guest', { anyTime: true }],
  ] as [string, { showIds?: string[]; anyTime?: boolean }][]) {
    const created = await createStreamer(db, ctx(), { displayName: username, username, ...extra });
    ids[username] = created.streamer.id;
  }
}, 60_000);

afterAll(() => tdb?.drop());

beforeEach(async () => {
  await tdb.db.delete(liveSession);
  engine = fakeEngine();
  published = [];
  now = IN_SLOT;
});

describe('live switching', () => {
  it('puts a connected DJ on air, hands over to the next one and returns to automation', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    const first = await s.goLive(ctx(), 1);
    expect(first).toMatchObject({
      input: 1,
      trigger: 'manual',
      streamer: { id: ids.guest, displayName: 'guest' },
      endedAt: null,
    });
    expect(engine.sessionId).toBe(first.id);
    // Same input again: the open session, no new command.
    expect((await s.goLive(ctx(), 1)).id).toBe(first.id);
    expect(engine.commands).toEqual(['open 1']);

    engine.connect(2, ids.resident ?? null);
    const status = await s.status(scope, true);
    expect(status).toMatchObject({ reachable: true, onAir: 1, session: { id: first.id } });
    expect(status.inputs.map((i) => i.streamer?.displayName ?? null)).toEqual([
      'guest',
      'resident',
    ]);

    const second = await s.goLive(ctx(), 2);
    expect(engine.commands).toEqual(['open 1', 'open 2']);
    const back = await s.returnToAutomation(ctx());
    expect(back?.id).toBe(second.id);
    expect(engine.commands.at(-1)).toBe('close');

    expect((await sessions()).map((r) => [r.input, r.endReason])).toEqual([
      [1, 'handover'],
      [2, 'returned'],
    ]);
    expect(published.map((e) => e.type)).toEqual([
      'live.session.started',
      'live.session.ended',
      'live.session.started',
      'live.session.ended',
    ]);
    const audits = await tdb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityType, 'live_session'));
    expect(audits.map((a) => a.action)).toEqual([
      'live.session.start',
      'live.session.end',
      'live.session.start',
      'live.session.end',
    ]);
  });

  it('refuses an empty input, an unknown one and a streamer disabled since it connected', async () => {
    const s = switcher();
    await expect(s.goLive(ctx(), 1)).rejects.toMatchObject({ code: 'live_input_not_connected' });
    await expect(s.goLive(ctx(), 3)).rejects.toMatchObject({ code: 'live_input_unknown' });
    engine.connect(1, ids.guest ?? null);
    await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: false });
    try {
      await expect(s.goLive(ctx(), 1)).rejects.toMatchObject({ code: 'streamer_not_allowed' });
    } finally {
      await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: true });
    }
    expect(engine.commands).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it('records nothing when the engine refuses the gate', async () => {
    const s = switcher();
    engine.connect(1, null);
    engine.setLive = async () => {
      throw new Error('engine down');
    };
    await expect(s.goLive(ctx(), 1)).rejects.toThrow('engine down');
    expect(await sessions()).toEqual([]);
  });

  it('reopens the previous session when the engine refuses a handover', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    engine.connect(2, ids.resident ?? null);
    const first = await s.goLive(ctx(), 1);
    const setLive = engine.setLive;
    engine.setLive = async () => {
      throw new Error('engine down');
    };
    await expect(s.goLive(ctx(), 2)).rejects.toThrow('engine down');
    engine.setLive = setLive;
    expect((await sessions()).map((r) => [r.id, r.endedAt])).toEqual([[first.id, null]]);
  });

  it('takes over at once when a DJ connects during their live slot, not outside it', async () => {
    const s = switcher();
    // Any-time streamer outside a slot: connected, waiting, not on air (ad-hoc live is #65).
    engine.connect(2, ids.guest ?? null);
    await s.onEvent(engineEvent('engine.live.connected', 2));
    expect(engine.commands).toEqual([]);

    // The resident connects before their slot: waits; the sweep takes over once it starts.
    now = BEFORE_SLOT;
    engine.connect(1, ids.resident ?? null);
    await s.onEvent(engineEvent('engine.live.connected', 1));
    await s.sweep(scope);
    expect(engine.commands).toEqual([]);
    now = IN_SLOT;
    await s.sweep(scope);
    expect(engine.commands).toEqual(['open 1']);
    const [row] = await sessions();
    expect(row).toMatchObject({ input: 1, trigger: 'slot', streamerId: ids.resident });

    // Connecting during the slot goes on air straight from the event.
    await s.returnToAutomation(ctx());
    await tdb.db.delete(liveSession);
    engine.commands = [];
    await s.onEvent(engineEvent('engine.live.connected', 1));
    expect(engine.commands).toEqual(['open 1']);
  });

  it('opens one session when two replicas take over at the same time', async () => {
    engine.connect(1, ids.resident ?? null);
    const results = await Promise.allSettled([
      switcher().goLive(ctx(), 1, 'slot'),
      switcher().goLive(ctx(), 1, 'slot'),
    ]);
    expect((await sessions()).filter((r) => r.endedAt === null)).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected');
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
  });

  it('closes the session when the DJ on air hangs up, the engine restarts or loses it', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    engine.connect(2, ids.resident ?? null);
    await s.goLive(ctx(), 1);
    // The other DJ leaving changes nothing.
    engine.hangUp(2);
    await s.onEvent(engineEvent('engine.live.disconnected', 2));
    expect((await sessions())[0]?.endedAt).toBeNull();
    engine.hangUp(1);
    await s.onEvent(engineEvent('engine.live.disconnected', 1));
    expect((await sessions())[0]?.endReason).toBe('disconnected');
    expect(engine.enabled).toBe(false);

    engine.connect(1, ids.guest ?? null);
    await s.goLive(ctx(), 1);
    await s.onEvent({
      id: crypto.randomUUID(),
      stationId: scope.stationId,
      at: now.toISOString(),
      type: 'engine.booted',
      data: { bootId: 'b2', seq: 1, version: '2.4.6' },
    });
    expect((await sessions()).at(-1)?.endReason).toBe('engine_restarted');

    // A missed event: the sweep sees the engine without the session.
    engine.enabled = false;
    engine.connect(1, ids.guest ?? null);
    await s.goLive(ctx(), 1);
    engine.hangUp(1);
    // Not within the first seconds: the engine call of a new session may still be on the way.
    await s.sweep(scope);
    expect((await sessions()).at(-1)?.endedAt).toBeNull();
    now = new Date(now.getTime() + 11_000);
    await s.sweep(scope);
    expect((await sessions()).at(-1)?.endReason).toBe('disconnected');
  });

  it('keeps a manual return for the rest of the slot, until the DJ connects again', async () => {
    const s = switcher();
    await tdb.db
      .update(streamer)
      .set({ lastConnectedAt: new Date(IN_SLOT.getTime() - 60_000) })
      .where(eq(streamer.id, ids.resident ?? ''));
    engine.connect(1, ids.resident ?? null);
    await s.sweep(scope);
    expect(engine.commands).toEqual(['open 1']);
    now = new Date(IN_SLOT.getTime() + 5 * 60_000);
    await s.returnToAutomation(ctx());
    // The sweeps that follow, and the DJ's own events, leave the air to automation.
    for (const minutes of [6, 20, 59]) {
      now = new Date(IN_SLOT.getTime() + minutes * 60_000);
      await s.sweep(scope);
      await s.onEvent(engineEvent('engine.live.connected', 1));
    }
    expect(engine.commands).toEqual(['open 1', 'close']);
    // The DJ connects again (a new accepted login): back on air, as a new session.
    now = new Date(IN_SLOT.getTime() + 30 * 60_000);
    await tdb.db
      .update(streamer)
      .set({ lastConnectedAt: now })
      .where(eq(streamer.id, ids.resident ?? ''));
    now = new Date(now.getTime() + 1000);
    await s.sweep(scope);
    expect(engine.commands).toEqual(['open 1', 'close', 'open 1']);
    expect((await sessions()).map((r) => [r.trigger, r.endReason])).toEqual([
      ['slot', 'returned'],
      ['slot', null],
    ]);
  });

  it('gives another DJ on the same input their own session', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    const first = await s.goLive(ctx(), 1);
    // The guest left and the resident took input 1, and both events were missed.
    engine.connect(1, ids.resident ?? null);
    const second = await s.goLive(ctx(), 1);
    expect(second.id).not.toBe(first.id);
    expect(second.streamer?.id).toBe(ids.resident);
    expect((await sessions()).map((r) => [r.streamerId, r.endReason])).toEqual([
      [ids.guest, 'handover'],
      [ids.resident, null],
    ]);
    // Seen by the sweep instead: the session ends and the gate closes on the other DJ.
    engine.connect(1, ids.guest ?? null);
    now = new Date(now.getTime() + 11_000);
    await s.sweep(scope);
    expect((await sessions()).at(-1)?.endReason).toBe('disconnected');
    expect(engine.enabled).toBe(false);
  });

  it('hangs up a DJ by hand, and a revoked streamer on whichever input they hold', async () => {
    const s = switcher();
    engine.connect(1, ids.guest ?? null);
    engine.connect(2, ids.resident ?? null);
    await s.goLive(ctx(), 2);
    expect(await s.disconnect(ctx(), 1)).toBe(true);
    expect((await sessions())[0]?.endedAt).toBeNull();

    const revoker = createLiveRevoker({
      db: tdb.db,
      engineFor: async () => engine,
      logger,
      endSession: (sc, streamerId) =>
        s.endSessionOf({ actor: system, scope: sc }, streamerId, 'revoked'),
    });
    expect(await revoker.revoke(scope, ids.resident ?? '', 'disabled')).toBe(true);
    expect(engine.commands.slice(-2)).toEqual(['close', 'hang up 2']);
    expect((await sessions())[0]?.endReason).toBe('revoked');
    // Nobody left to revoke.
    expect(await revoker.revoke(scope, ids.resident ?? '', 'disabled')).toBe(false);
  });

  it("ends a revoked DJ's session even when hanging up fails, and the sweep retries", async () => {
    const revoked: string[] = [];
    let s: LiveSwitcher;
    const revoker = createLiveRevoker({
      db: tdb.db,
      engineFor: async () => engine,
      logger,
      endSession: (sc, streamerId) =>
        s.endSessionOf({ actor: system, scope: sc }, streamerId, 'revoked'),
    });
    s = createLiveSwitcher({
      db: tdb.db,
      engineFor: async () => engine as LiveSwitchEngine,
      logger,
      now: () => now,
      onNotAllowed: async (sc, streamerId, reason) => {
        revoked.push(reason);
        return revoker.revoke(sc, streamerId, reason);
      },
    });
    engine.connect(1, ids.guest ?? null);
    await s.goLive(ctx(), 1);
    const hangUp = engine.disconnectLive;
    engine.disconnectLive = async () => {
      throw new Error('engine busy');
    };
    await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: false });
    try {
      expect(await revoker.revoke(scope, ids.guest ?? '', 'disabled')).toBe(false);
      // Off air and its session ended with the right reason, though still connected.
      expect(engine.enabled).toBe(false);
      expect((await sessions())[0]?.endReason).toBe('revoked');
      expect(engine.inputs[0]?.connected).toBe(true);
      // The sweep notices the DJ is still there and revokes again, until the hang-up works.
      engine.disconnectLive = hangUp;
      await s.sweep(scope);
      expect(revoked).toEqual(['disabled']);
      expect(engine.inputs[0]?.connected).toBe(false);
    } finally {
      await updateStreamer(tdb.db, ctx(), ids.guest ?? '', { enabled: true });
    }
  });
});
