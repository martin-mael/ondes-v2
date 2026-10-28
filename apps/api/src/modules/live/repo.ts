import { randomBytes } from 'node:crypto';
import {
  auditDiff,
  type Db,
  type Executor,
  enginePort,
  membership,
  NotFoundError,
  type StationScope,
  show,
  station,
  streamer,
  streamerShow,
  type Tx,
  user,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type Actor,
  type CreateStreamer,
  createStreamerSchema,
  type LiveConnectionInfo,
  type SetStreamerPassword,
  type Streamer,
  type StreamerStatus,
  type StreamerWithPassword,
  setStreamerPasswordSchema,
  type UpdateStreamer,
  updateStreamerSchema,
} from '@ondes/shared';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { hashPassword } from '../auth/password.ts';
import { stationEngineSettingsSchema } from '../engine/config/settings.ts';

// Live streamers (#63, ADR 0023): DJ identities and their stream credentials. Every function
// takes the station scope and filters on it; mutations run in `withAudit`, whose rows never
// carry a password or its hash. The harbor auth check is `auth.ts`.

type StreamerRow = typeof streamer.$inferSelect;

export interface StationContext {
  actor: Actor;
  scope: StationScope;
}

export function statusOf(
  row: Pick<StreamerRow, 'enabled' | 'expiresAt'>,
  now = new Date(),
): StreamerStatus {
  if (!row.enabled) return 'disabled';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

/** 24 random characters from an alphabet DJ software and Shoutcast's `user:password` accept. */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  // 256 % 56 = 32: rejection would be exact, but a 0.4 % bias on 24 chars costs < 1 bit.
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function toStreamers(db: Executor, rows: StreamerRow[]): Promise<Streamer[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const userIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
  const [shows, users] = await Promise.all([
    db
      .select({
        streamerId: streamerShow.streamerId,
        id: show.id,
        name: show.name,
        colour: show.colour,
      })
      .from(streamerShow)
      .innerJoin(show, eq(show.id, streamerShow.showId))
      .where(inArray(streamerShow.streamerId, ids))
      .orderBy(asc(show.name)),
    userIds.length
      ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
      : Promise.resolve([]),
  ]);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    stationId: r.stationId,
    displayName: r.displayName,
    username: r.username,
    user: r.userId ? (usersById.get(r.userId) ?? null) : null,
    enabled: r.enabled,
    expiresAt: r.expiresAt,
    anyTime: r.anyTime,
    adHoc: r.adHoc,
    encoderMetadata: r.encoderMetadata,
    shows: shows
      .filter((s) => s.streamerId === r.id)
      .map(({ id, name, colour }) => ({ id, name, colour })),
    status: statusOf(r, now),
    lastConnectedAt: r.lastConnectedAt,
    passwordChangedAt: r.passwordChangedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function streamerRow(db: Executor, scope: StationScope, streamerId: string) {
  const [row] = await db
    .select()
    .from(streamer)
    .where(and(eq(streamer.id, streamerId), whereStation(streamer, scope)));
  if (!row) throw new NotFoundError('streamer', streamerId);
  return row;
}

/**
 * The station's streamers, by display name. `owner`: only the ones linked to that user (a
 * presenter sees their own credentials, not their colleagues'); null: none.
 */
export async function listStreamers(
  db: Executor,
  scope: StationScope,
  owner?: string | null,
): Promise<Streamer[]> {
  if (owner === null) return [];
  const rows = await db
    .select()
    .from(streamer)
    .where(and(whereStation(streamer, scope), owner ? eq(streamer.userId, owner) : undefined))
    .orderBy(asc(streamer.displayName), asc(streamer.username));
  return toStreamers(db, rows);
}

export async function getStreamer(
  db: Executor,
  scope: StationScope,
  streamerId: string,
): Promise<Streamer> {
  const [out] = await toStreamers(db, [await streamerRow(db, scope, streamerId)]);
  if (!out) throw new NotFoundError('streamer', streamerId);
  return out;
}

/** Users a streamer can be linked to: members of the station, or of its org at org level. */
export async function listUserCandidates(db: Executor, scope: StationScope) {
  return db
    .selectDistinct({ id: user.id, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.orgId, scope.orgId),
        or(isNull(membership.stationId), eq(membership.stationId, scope.stationId)),
      ),
    )
    .orderBy(asc(user.name), asc(user.id));
}

async function checkUser(tx: Tx, scope: StationScope, userId: string | null | undefined) {
  if (!userId) return;
  const candidates = await listUserCandidates(tx, scope);
  if (!candidates.some((c) => c.id === userId)) {
    throw new HttpError(422, 'invalid_user', 'the user is not a member of this station');
  }
}

async function setShows(tx: Tx, scope: StationScope, streamerId: string, showIds: string[]) {
  if (showIds.length) {
    const found = await tx
      .select({ id: show.id })
      .from(show)
      .where(and(inArray(show.id, showIds), whereStation(show, scope)));
    if (found.length !== showIds.length) {
      throw new HttpError(422, 'invalid_show', 'a show is not one of this station');
    }
  }
  await tx
    .delete(streamerShow)
    .where(and(eq(streamerShow.streamerId, streamerId), whereStation(streamerShow, scope)));
  if (showIds.length) {
    await tx.insert(streamerShow).values(
      showIds.map((showId) => ({
        streamerId,
        showId,
        orgId: scope.orgId,
        stationId: scope.stationId,
      })),
    );
  }
}

async function showIdsOf(db: Executor, streamerId: string) {
  const rows = await db
    .select({ showId: streamerShow.showId })
    .from(streamerShow)
    .where(eq(streamerShow.streamerId, streamerId))
    .orderBy(asc(streamerShow.showId));
  return rows.map((r) => r.showId);
}

/** A unique violation of the station's usernames (not of any other unique key). */
function isUsernameTaken(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    const pg = current as { code?: string; constraint_name?: string };
    if (pg.code === '23505' && pg.constraint_name === 'streamer_station_username_key') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `withAudit`, with a duplicate username answered as 409 `streamer_username_taken`. */
async function mutate<T>(db: Db, ctx: StationContext, fn: Parameters<typeof withAudit<T>>[2]) {
  try {
    return await withAudit(db, ctx, fn);
  } catch (error) {
    if (isUsernameTaken(error)) {
      throw new HttpError(409, 'streamer_username_taken', 'this username is already used here');
    }
    throw error;
  }
}

const SECRET_FIELDS = ['passwordHash', 'passwordChangedAt', 'lastConnectedAt'] as const;

export async function createStreamer(
  db: Db,
  ctx: StationContext,
  input: CreateStreamer,
): Promise<StreamerWithPassword> {
  const body = createStreamerSchema.parse(input);
  const password = body.password ?? generatePassword();
  const passwordHash = await hashPassword(password);
  const { scope } = ctx;
  const created = await mutate(db, ctx, async (tx, audit) => {
    await checkUser(tx, scope, body.userId);
    const [row] = await tx
      .insert(streamer)
      .values({
        orgId: scope.orgId,
        stationId: scope.stationId,
        userId: body.userId ?? null,
        displayName: body.displayName,
        username: body.username,
        passwordHash,
        enabled: body.enabled ?? true,
        expiresAt: body.expiresAt ?? null,
        anyTime: body.anyTime ?? false,
        adHoc: body.adHoc ?? 'approval',
        encoderMetadata: body.encoderMetadata ?? false,
      })
      .returning();
    if (!row) throw new Error('insert returned nothing');
    const showIds = body.showIds ?? [];
    await setShows(tx, scope, row.id, showIds);
    await audit({
      action: 'streamer.create',
      entity: { type: 'streamer', id: row.id },
      diff: {
        ...auditDiff(null, row, [...SECRET_FIELDS]),
        showIds: { from: null, to: showIds },
        password: { from: null, to: 'set' },
      },
    });
    return row;
  });
  return { streamer: await getStreamer(db, scope, created.id), password };
}

export async function updateStreamer(
  db: Db,
  ctx: StationContext,
  streamerId: string,
  input: UpdateStreamer,
): Promise<Streamer> {
  const { showIds, ...fields } = updateStreamerSchema.parse(input);
  const { scope } = ctx;
  await mutate(db, ctx, async (tx, audit) => {
    const before = await streamerRow(tx, scope, streamerId);
    if (fields.userId !== undefined) await checkUser(tx, scope, fields.userId);
    let after = before;
    if (Object.values(fields).some((v) => v !== undefined)) {
      const [row] = await tx
        .update(streamer)
        .set(fields)
        .where(and(eq(streamer.id, streamerId), whereStation(streamer, scope)))
        .returning();
      if (!row) throw new NotFoundError('streamer', streamerId);
      after = row;
    }
    const diff = auditDiff(before, after, [...SECRET_FIELDS]);
    if (showIds !== undefined) {
      const previous = await showIdsOf(tx, streamerId);
      await setShows(tx, scope, streamerId, showIds);
      const next = [...showIds].sort();
      if (previous.join() !== next.join()) diff.showIds = { from: previous, to: next };
    }
    await audit({ action: 'streamer.update', entity: { type: 'streamer', id: streamerId }, diff });
  });
  return getStreamer(db, scope, streamerId);
}

/** Sets (or generates) a new password. The old one stops working at once. */
export async function setStreamerPassword(
  db: Db,
  ctx: StationContext,
  streamerId: string,
  input: SetStreamerPassword,
): Promise<StreamerWithPassword> {
  const body = setStreamerPasswordSchema.parse(input);
  const password = body.password ?? generatePassword();
  const passwordHash = await hashPassword(password);
  const { scope } = ctx;
  await mutate(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .update(streamer)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(and(eq(streamer.id, streamerId), whereStation(streamer, scope)))
      .returning({ id: streamer.id });
    if (!row) throw new NotFoundError('streamer', streamerId);
    await audit({
      action: 'streamer.password',
      entity: { type: 'streamer', id: streamerId },
      diff: { password: { from: null, to: body.password ? 'set' : 'generated' } },
    });
  });
  return { streamer: await getStreamer(db, scope, streamerId), password };
}

export async function deleteStreamer(
  db: Db,
  ctx: StationContext,
  streamerId: string,
): Promise<void> {
  const { scope } = ctx;
  await mutate(db, ctx, async (tx, audit) => {
    const before = await streamerRow(tx, scope, streamerId);
    await tx
      .delete(streamer)
      .where(and(eq(streamer.id, streamerId), whereStation(streamer, scope)));
    await audit({
      action: 'streamer.delete',
      entity: { type: 'streamer', id: streamerId },
      diff: auditDiff(before, null, [...SECRET_FIELDS]),
    });
  });
}

// --- Connection info -----------------------------------------------------------------------

/** Encoders `input.harbor` decodes from DJ software (ADR 0002, "Live"). */
const LIVE_FORMATS = ['MP3', 'Ogg Vorbis', 'Ogg Opus', 'AAC'];

/**
 * What to type into BUTT, Mixxx or OBS: the public host, the station's published live port
 * (the engine lifecycle allocates it, #35) and the mount from its engine settings.
 */
export async function connectionInfo(
  db: Executor,
  scope: StationScope,
  publicHost: string,
): Promise<LiveConnectionInfo> {
  const [row] = await db
    .select({ engineSettings: station.engineSettings })
    .from(station)
    .where(eq(station.id, scope.stationId));
  if (!row) throw new NotFoundError('station', scope.stationId);
  // Stored settings are checked when the engine renders them; a broken one falls back here.
  const liveSchema = stationEngineSettingsSchema.shape.live;
  const stored = liveSchema.safeParse((row.engineSettings as { live?: unknown }).live ?? {});
  const live = stored.success ? stored.data : liveSchema.parse({});
  const ports = await db
    .select({ port: enginePort.port, purpose: enginePort.purpose })
    .from(enginePort)
    .where(eq(enginePort.stationId, scope.stationId));
  const portOf = (purpose: string) => ports.find((p) => p.purpose === purpose)?.port ?? null;
  const icy = live.icy ? portOf('live_icy') : null;
  return {
    enabled: live.enabled,
    host: publicHost,
    port: portOf('live'),
    mount: live.mount,
    mounts: Array.from({ length: live.inputs }, (_, i) =>
      i === 0 ? live.mount : `${live.mount}-${i + 1}`,
    ),
    // Published on its own port of the pool: the client adds one to the port it's given.
    shoutcastPort: icy === null ? null : icy - 1,
    formats: LIVE_FORMATS,
  };
}
