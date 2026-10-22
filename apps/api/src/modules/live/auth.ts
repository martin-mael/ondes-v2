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

export { LIVE_AUTH_ROUTE, liveAuthUrl } from './url.ts';

// The harbor auth callback (#63, ADR 0023): the station template's `live_auth` POSTs every
// source login to `LIVE_AUTH_ROUTE`, and a 2xx lets the DJ connect. Internal only, like the
// events route: the engine sends its station's control token as a bearer token.
//
// A login passes when the username exists on the station, the password matches its argon2id
// hash, the streamer is enabled and not expired, and it may connect now: any time, or from
// `LIVE_EARLY_CONNECT_MS` before an allowed show's slot until the slot ends (reruns excluded).
// Connecting doesn't put the DJ on air: Node opens the live gate (#64, #65).

export type LiveLoginResult =
  | { ok: true; streamerId: string }
  | { ok: false; reason: LiveAuthRefusal; streamerId?: string };

/**
 * Checks a source login against the database. Unknown usernames burn the same argon2 time as
 * known ones, so the answer time doesn't tell them apart. Accepted logins are audited.
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
    const inSlot = occurrences.some((o) => showIds.has(o.show.id) && o.type !== 'rerun');
    if (!inSlot) return { ok: false, reason: 'outside_slot', streamerId: row.id };
  }

  await withAudit(db, { actor: { type: 'system', name: 'engine' }, scope }, async (tx, audit) => {
    await tx.update(streamer).set({ lastConnectedAt: now }).where(eq(streamer.id, row.id));
    await audit({
      action: 'streamer.connect',
      entity: { type: 'streamer', id: row.id },
      diff: login.address ? { address: { from: null, to: login.address } } : {},
    });
  });
  return { ok: true, streamerId: row.id };
}

/**
 * Refuses a source address after `max` failed logins in `windowMs`, without checking the
 * password: argon2 is slow on purpose, and the live port is public. In memory, per api
 * replica: a brake on guessing, not an account lockout (a lockout would let anyone lock a DJ
 * out before their show).
 */
export class LoginFailureLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(options: { max?: number; windowMs?: number } = {}) {
    this.#max = options.max ?? 10;
    this.#windowMs = options.windowMs ?? 10 * 60 * 1000;
  }

  #recent(key: string, now: number) {
    const kept = (this.#failures.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (kept.length) this.#failures.set(key, kept);
    else this.#failures.delete(key);
    return kept;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.#recent(key, now).length >= this.#max;
  }

  fail(key: string, now = Date.now()): void {
    this.#failures.set(key, [...this.#recent(key, now), now]);
    // Bound the memory a flood of addresses can take.
    if (this.#failures.size > 10_000) {
      for (const k of this.#failures.keys()) {
        this.#recent(k, now);
        if (this.#failures.size <= 5_000) break;
      }
    }
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
    const key = `${stationId}|${address ?? ''}`;
    const login = { ...liveAuthLogin(parsed.data), address };
    if (limiter.blocked(key)) {
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
    logger.info({ stationId, address, streamerId: result.streamerId }, 'Live login accepted');
    return { status: 200, body: { ok: true } };
  };
}
