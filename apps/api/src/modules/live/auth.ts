import { timingSafeEqual } from 'node:crypto';
import { type Db, station, streamer, streamerShow, unsafeScope, withAudit } from '@ondes/db';
import {
  LIVE_EARLY_CONNECT_MS,
  type LiveAuthRefusal,
  liveAuthLogin,
  liveAuthRequestSchema,
  streamerUsernameSchema,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.ts';
import { getOccurrences } from '../shows/repo.ts';
import { statusOf } from './repo.ts';

import { eventsFor } from './standing.ts';

export { LIVE_AUTH_ROUTE, liveAuthUrl } from './url.ts';

// The harbor auth callback (#63, ADR 0023): the station template's `live_auth` POSTs every
// source login to `LIVE_AUTH_ROUTE`, and a 2xx lets the DJ connect. Internal only, like the
// events route: the engine sends its station's control token as a bearer token.
//
// A login passes when the username exists on the station, the password matches its argon2id
// hash, the streamer is enabled and not expired, and it may connect now: any time, or from
// `LIVE_EARLY_CONNECT_MS` before an allowed show's live slot until the slot ends (since #65,
// live slots only: ADR 0023 also admitted pre-recorded ones), or likewise around an event
// they're on or one listing nobody (#65).
// Connecting doesn't put the DJ on air: Node opens the live gate (#64, #65).

/** Accepted logins closer together than this are not audited again (reconnect loops). */
export const CONNECT_AUDIT_EVERY_MS = 10 * 60 * 1000;

export type LiveLoginResult =
  | { ok: true; streamerId: string }
  | { ok: false; reason: LiveAuthRefusal; streamerId?: string };

/**
 * Checks a source login against the database. Unknown usernames burn the same argon2 time as
 * known ones, so the answer time doesn't tell them apart. Accepted logins stamp
 * `last_connected_at` and are audited (at most once per `CONNECT_AUDIT_EVERY_MS`).
 */
export async function checkLiveLogin(
  db: Db,
  stationId: string,
  login: { username: string; password: string; address?: string },
  now = new Date(),
): Promise<LiveLoginResult> {
  const username = streamerUsernameSchema.safeParse(login.username);
  const [st] = username.success
    ? await db.select({ orgId: station.orgId }).from(station).where(eq(station.id, stationId))
    : [];
  if (!st || !username.success) {
    await verifyAgainstDummy(login.password);
    return { ok: false, reason: 'unknown' };
  }
  // Ids read from the station row: the bearer token already proved the caller is its engine.
  const scope = unsafeScope(st.orgId, stationId);
  const [row] = await db
    .select()
    .from(streamer)
    .where(and(eq(streamer.stationId, stationId), eq(streamer.username, username.data)));
  if (!row) {
    await verifyAgainstDummy(login.password);
    return { ok: false, reason: 'unknown' };
  }
  if (!(await verifyPassword(row.passwordHash, login.password))) {
    return { ok: false, reason: 'bad_password', streamerId: row.id };
  }
  const status = statusOf(row, now);
  if (status !== 'active') return { ok: false, reason: status, streamerId: row.id };

  if (!row.anyTime) {
    const allowed = await db
      .select({ showId: streamerShow.showId })
      .from(streamerShow)
      .where(eq(streamerShow.streamerId, row.id));
    const showIds = new Set(allowed.map((a) => a.showId));
    const { occurrences } = showIds.size
      ? await getOccurrences(db, scope, {
          from: now,
          to: new Date(now.getTime() + LIVE_EARLY_CONNECT_MS),
        })
      : { occurrences: [] };
    // Overlapping [now, now + early) = starts within the early window, or already running.
    const inSlot =
      // Live slots only (#65): a pre-recorded slot doesn't take a DJ, and admitting one there
      // would only raise an ad-hoc request, which `anyTime` streamers are for.
      occurrences.some((o) => showIds.has(o.show.id) && o.type === 'live') ||
      // Or an event they're on (or one listing nobody, where an `approval` DJ still has to be
      // approved), with the same early window (#65).
      (await eventsFor(db, scope, row.id, now)).length > 0;
    if (!inSlot) return { ok: false, reason: 'outside_slot', streamerId: row.id };
  }

  // DJ software reconnects in a loop after a network drop: audit a connection only when the
  // previous one is older than `CONNECT_AUDIT_EVERY_MS`, and just stamp the time otherwise.
  const quiet =
    row.lastConnectedAt && now.getTime() - row.lastConnectedAt.getTime() < CONNECT_AUDIT_EVERY_MS;
  if (quiet) {
    await db.update(streamer).set({ lastConnectedAt: now }).where(eq(streamer.id, row.id));
  } else {
    await withAudit(db, { actor: { type: 'system', name: 'engine' }, scope }, async (tx, audit) => {
      await tx.update(streamer).set({ lastConnectedAt: now }).where(eq(streamer.id, row.id));
      await audit({
        action: 'streamer.connect',
        entity: { type: 'streamer', id: row.id },
        diff: login.address ? { address: { from: null, to: login.address } } : {},
      });
    });
  }
  return { ok: true, streamerId: row.id };
}

/** Most recent failures kept per key, and how many keys at most (oldest touched dropped). */
const LIMITER_MAX_KEYS = 10_000;

/**
 * Brakes password guessing on the public live port: after `max` failed logins in `windowMs`
 * for one station, username and source address, that key gets one password check per
 * `probeEveryMs` instead of one per attempt (argon2 is slow on purpose). The DJ with the right
 * password still gets in within `probeEveryMs`, and other usernames from the same venue IP are
 * not affected: a brake, never a lockout (which anyone could use to lock a DJ out before their
 * show). In memory, per api replica, bounded to `LIMITER_MAX_KEYS` keys (least recently
 * touched dropped first), so a flood of addresses costs O(1) per attempt and bounded memory.
 */
export class LoginFailureLimiter {
  readonly #keys = new Map<string, { failures: number[]; lastProbe: number }>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #probeEveryMs: number;
  readonly #maxKeys: number;

  constructor(
    options: { max?: number; windowMs?: number; probeEveryMs?: number; maxKeys?: number } = {},
  ) {
    this.#max = options.max ?? 10;
    this.#windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.#probeEveryMs = options.probeEveryMs ?? 30_000;
    this.#maxKeys = options.maxKeys ?? LIMITER_MAX_KEYS;
  }

  /** One key per station, username and source address (missing address: its own bucket). */
  static key(stationId: string, username: string, address: string | undefined): string {
    return `${stationId}|${username}|${address || '(no address)'}`;
  }

  get size(): number {
    return this.#keys.size;
  }

  #entry(key: string, now: number) {
    const entry = this.#keys.get(key);
    if (!entry) return undefined;
    entry.failures = entry.failures.filter((t) => now - t < this.#windowMs);
    if (!entry.failures.length) {
      this.#keys.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * May this attempt check the password? False while braked, except one probe per
   * `probeEveryMs` (which this call uses up).
   */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.#entry(key, now);
    if (!entry || entry.failures.length < this.#max) return true;
    if (now - entry.lastProbe < this.#probeEveryMs) return false;
    entry.lastProbe = now;
    return true;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.#entry(key, now) ?? { failures: [], lastProbe: Number.NEGATIVE_INFINITY };
    entry.failures.push(now);
    if (entry.failures.length > this.#max) entry.failures.shift();
    // Re-insert: Map order is the recency order the cap evicts by.
    this.#keys.delete(key);
    this.#keys.set(key, entry);
    if (this.#keys.size > this.#maxKeys) {
      const oldest = this.#keys.keys().next().value;
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
  }

  succeed(key: string): void {
    this.#keys.delete(key);
  }
}

type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type LiveAuthRequest = {
  stationId: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

export type LiveAuthResponse = { status: number; body: Record<string, unknown> };

export type LiveAuthHandlerOptions = {
  db: Db;
  /** The station's `ENGINE_CONTROL_TOKEN` (the lifecycle's `tokenFor`); none: refused. */
  tokenFor(stationId: string): string | undefined | Promise<string | undefined>;
  limiter?: LoginFailureLimiter;
  logger: Logger;
  now?: () => Date;
};

/**
 * 200 accepts the login, anything else refuses it (the template treats a non-2xx, a timeout
 * and an error alike). 401: not the station's engine. 403: credentials refused; the reason is
 * logged, not returned.
 */
export function createLiveAuthHandler(
  options: LiveAuthHandlerOptions,
): (request: LiveAuthRequest) => Promise<LiveAuthResponse> {
  const limiter = options.limiter ?? new LoginFailureLimiter();
  const { logger } = options;
  const refused = { status: 403, body: { error: 'refused' } };

  return async ({ stationId, headers, body }) => {
    const stationToken = await options.tokenFor(stationId);
    const expected = Buffer.from(`Bearer ${stationToken ?? ''}`);
    const given = Buffer.from(String(headers.authorization ?? ''));
    if (!stationToken || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const parsed = liveAuthRequestSchema.safeParse(body);
    if (!parsed.success) {
      logger.error({ stationId }, 'Engine posted a live login that breaks the contract');
      return { status: 400, body: { error: 'invalid body' } };
    }
    const address = parsed.data.address;
    const login = { ...liveAuthLogin(parsed.data), address };
    const key = LoginFailureLimiter.key(stationId, login.username, address);
    if (!limiter.allow(key)) {
      logger.warn({ stationId, address, username: login.username }, 'Live login throttled');
      return refused;
    }
    const result = await checkLiveLogin(options.db, stationId, login, options.now?.());
    if (!result.ok) {
      if (result.reason === 'unknown' || result.reason === 'bad_password') limiter.fail(key);
      logger.warn(
        { stationId, address, username: login.username, reason: result.reason },
        'Live login refused',
      );
      return refused;
    }
    limiter.succeed(key);
    logger.info(
      { stationId, address, input: parsed.data.input, streamerId: result.streamerId },
      'Live login accepted',
    );
    // The engine keeps the id for the input's events and state (harbor pool, #64).
    return { status: 200, body: { ok: true, streamer_id: result.streamerId } };
  };
}
