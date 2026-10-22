import {
  type AuditFn,
  asset,
  auditDiff,
  type Db,
  type Executor,
  episode,
  type MutationContext,
  membership,
  NotFoundError,
  type StationScope,
  show,
  showHost,
  showSlot,
  showSlotException,
  station,
  type Tx,
  user,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  expandSlots,
  findConflicts,
  isOccurrenceDate,
  MAX_MOVE_DAYS,
  occurrenceOn,
  ruleEndDate,
  ruleStartDate,
} from '@ondes/scheduling';
import {
  type Actor,
  addDays,
  type CreateEpisode,
  type CreateShow,
  type CreateShowSlot,
  createEpisodeSchema,
  createShowSchema,
  createShowSlotSchema,
  type Episode,
  type EpisodeStatus,
  type LocalDate,
  localDateOf,
  type PutSlotException,
  putSlotExceptionSchema,
  type Show,
  type ShowOccurrencesQuery,
  type ShowOccurrencesResponse,
  type ShowSlot,
  type ShowSlotChange,
  type ShowSlotDeleted,
  SLOT_MAX_MOVE_DAYS,
  type SlotException,
  showOccurrencesQuerySchema,
  type UpdateEpisode,
  type UpdateShow,
  type UpdateShowSlot,
  updateEpisodeSchema,
  updateShowSchema,
  updateShowSlotSchema,
} from '@ondes/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';

// Shows, slots, exceptions and episodes (#44, ADR 0014). Every function takes the station
// scope and filters on it; mutations run in `withAudit`. Recurrence is `@ondes/scheduling`'s:
// this file loads rows, checks references and hands slots to `expandSlots`.
//
// Episode numbers come from `show.next_episode_number`, which only grows (above every number
// used, deleted episodes included). Creating or renumbering an episode takes a `FOR UPDATE`
// lock on the show row, so concurrent writes number one after the other. An explicit number
// that's taken is a 409, never a silent renumbering.
//
// Premieres follow their occurrence: when one stops existing (slot deleted, rule or type
// changed, occurrence cancelled), the episode planned for it is detached (slot and date
// cleared, audited as `episode.detach`) and the response lists it. Refusing the change instead
// would block the programmer on every presenter's draft; a detached episode keeps its audio
// and number and is listed by `GET …/episodes?scheduled=false`.

type ShowRow = typeof show.$inferSelect;
type SlotRow = typeof showSlot.$inferSelect;
type ExceptionRow = typeof showSlotException.$inferSelect;
type EpisodeRow = typeof episode.$inferSelect;

export interface StationContext extends MutationContext {
  actor: Actor;
  scope: StationScope;
}

// --- Shows -------------------------------------------------------------------------------

async function hostsOf(db: Executor, showIds: string[]) {
  if (!showIds.length) return new Map<string, Show['hosts']>();
  const rows = await db
    .select({ showId: showHost.showId, userId: user.id, name: user.name })
    .from(showHost)
    .innerJoin(user, eq(user.id, showHost.userId))
    .where(inArray(showHost.showId, showIds))
    .orderBy(asc(showHost.createdAt), asc(user.name));
  const out = new Map<string, Show['hosts']>();
  for (const r of rows) {
    const list = out.get(r.showId) ?? [];
    list.push({ userId: r.userId, name: r.name });
    out.set(r.showId, list);
  }
  return out;
}

async function toShows(db: Executor, rows: ShowRow[]): Promise<Show[]> {
  const ids = rows.map((r) => r.id);
  const hosts = await hostsOf(db, ids);
  return rows.map((r) => ({
    id: r.id,
    stationId: r.stationId,
    name: r.name,
    description: r.description,
    artworkUrl: r.artworkUrl,
    colour: r.colour,
    defaultDurationMs: r.defaultDurationMs,
    defaultSlotType: r.defaultSlotType,
    tags: r.tags,
    hosts: hosts.get(r.id) ?? [],
    nextEpisodeNumber: r.nextEpisodeNumber,
    fallbackPolicy: r.fallbackPolicy,
    fallbackEpisodeId: r.fallbackEpisodeId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function showRow(db: Executor, scope: StationScope, showId: string, lock = false) {
  const query = db
    .select()
    .from(show)
    .where(and(eq(show.id, showId), whereStation(show, scope)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('show', showId);
  return row;
}

export async function listShows(db: Executor, scope: StationScope): Promise<Show[]> {
  const rows = await db
    .select()
    .from(show)
    .where(whereStation(show, scope))
    .orderBy(asc(show.name), asc(show.id));
  return toShows(db, rows);
}

export async function getShow(db: Executor, scope: StationScope, showId: string): Promise<Show> {
  const [out] = await toShows(db, [await showRow(db, scope, showId)]);
  return out as Show;
}

/** Whether `userId` hosts the show (for `show:write_own`). */
export async function isHost(
  db: Executor,
  scope: StationScope,
  showId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: showHost.userId })
    .from(showHost)
    .where(
      and(eq(showHost.showId, showId), eq(showHost.userId, userId), whereStation(showHost, scope)),
    );
  return row !== undefined;
}

/** Who may host: members of the station, or of its org at org level. By name. */
export async function listHostCandidates(
  db: Executor,
  scope: StationScope,
): Promise<Show['hosts']> {
  return db
    .selectDistinct({ userId: user.id, name: user.name })
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

/** Hosts must be members of the station, or of its org at org level. */
async function checkHosts(tx: Tx, scope: StationScope, userIds: string[]) {
  if (!userIds.length) return;
  const rows = await tx
    .selectDistinct({ userId: membership.userId })
    .from(membership)
    .where(
      and(
        inArray(membership.userId, userIds),
        eq(membership.orgId, scope.orgId),
        or(isNull(membership.stationId), eq(membership.stationId, scope.stationId)),
      ),
    );
  if (rows.length !== userIds.length) {
    throw new HttpError(422, 'invalid_host', 'a host is not a member of this station');
  }
}

async function setHosts(tx: Tx, scope: StationScope, showId: string, userIds: string[]) {
  await checkHosts(tx, scope, userIds);
  await tx.delete(showHost).where(and(eq(showHost.showId, showId), whereStation(showHost, scope)));
  if (userIds.length) {
    await tx.insert(showHost).values(
      userIds.map((userId) => ({
        showId,
        userId,
        orgId: scope.orgId,
        stationId: scope.stationId,
      })),
    );
  }
}

export async function createShow(db: Db, ctx: StationContext, input: CreateShow): Promise<Show> {
  const { hostUserIds, ...fields } = createShowSchema.parse(input);
  // A new show has no episodes yet: nothing to rerun by name.
  if (fields.fallbackEpisodeId) throw fallbackEpisodeInvalid();
  return withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(show)
      .values({ ...fields, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await setHosts(tx, ctx.scope, row.id, hostUserIds);
    await audit({
      action: 'show.create',
      entity: { type: 'show', id: row.id },
      diff: auditDiff(null, { ...row, hostUserIds }),
    });
    return getShow(tx, ctx.scope, row.id);
  });
}

export async function updateShow(
  db: Db,
  ctx: StationContext,
  showId: string,
  input: UpdateShow,
): Promise<Show> {
  const { hostUserIds, ...fields } = updateShowSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await getShow(tx, ctx.scope, showId);
    if (fields.fallbackEpisodeId)
      await checkFallbackEpisode(tx, ctx.scope, showId, fields.fallbackEpisodeId);
    if (Object.values(fields).some((v) => v !== undefined)) {
      await tx
        .update(show)
        .set(fields)
        .where(and(eq(show.id, showId), whereStation(show, ctx.scope)));
    }
    if (hostUserIds) await setHosts(tx, ctx.scope, showId, hostUserIds);
    const after = await getShow(tx, ctx.scope, showId);
    await audit({
      action: 'show.update',
      entity: { type: 'show', id: showId },
      diff: auditDiff(auditable(before), auditable(after)),
    });
    return after;
  });
}

/** The fallback episode (#47) must be one of the show's own. */
async function checkFallbackEpisode(
  db: Executor,
  scope: StationScope,
  showId: string,
  episodeId: string,
) {
  const [row] = await db
    .select({ id: episode.id })
    .from(episode)
    .where(
      and(eq(episode.id, episodeId), eq(episode.showId, showId), whereStation(episode, scope)),
    );
  if (!row) throw fallbackEpisodeInvalid();
}

const fallbackEpisodeInvalid = () =>
  new HttpError(422, 'invalid_fallback_episode', 'the fallback episode must be one of the show’s');

const auditable = ({ hosts, nextEpisodeNumber: _, updatedAt: __, ...s }: Show) => ({
  ...s,
  hostUserIds: hosts.map((h) => h.userId),
});

/** Deletes the show with its slots, exceptions and episodes (their assets stay in the library). */
export async function deleteShow(db: Db, ctx: StationContext, showId: string): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await getShow(tx, ctx.scope, showId);
    await tx.delete(show).where(and(eq(show.id, showId), whereStation(show, ctx.scope)));
    await audit({
      action: 'show.delete',
      entity: { type: 'show', id: showId },
      diff: auditDiff(auditable(before), null),
    });
  });
}

// --- Slots -------------------------------------------------------------------------------

function toException(r: ExceptionRow): SlotException {
  return r.kind === 'cancelled'
    ? { date: r.date, kind: 'cancelled' }
    : {
        date: r.date,
        kind: 'moved',
        startDate: r.startDate as string,
        startTime: r.startTime as string,
        durationMs: r.durationMs,
      };
}

async function exceptionsOf(db: Executor, slotIds: string[]) {
  const out = new Map<string, SlotException[]>();
  if (!slotIds.length) return out;
  const rows = await db
    .select()
    .from(showSlotException)
    .where(inArray(showSlotException.slotId, slotIds))
    .orderBy(asc(showSlotException.date));
  for (const r of rows) {
    const list = out.get(r.slotId) ?? [];
    list.push(toException(r));
    out.set(r.slotId, list);
  }
  return out;
}

async function toSlots(db: Executor, rows: SlotRow[]): Promise<ShowSlot[]> {
  const exceptions = await exceptionsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    showId: r.showId,
    type: r.type,
    rule: r.rule,
    durationMs: r.durationMs,
    exceptions: exceptions.get(r.id) ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function slotRow(db: Executor, scope: StationScope, showId: string, slotId: string) {
  const [row] = await db
    .select()
    .from(showSlot)
    .where(
      and(eq(showSlot.id, slotId), eq(showSlot.showId, showId), whereStation(showSlot, scope)),
    );
  if (!row) throw new NotFoundError('show_slot', slotId);
  return row;
}

export async function listSlots(
  db: Executor,
  scope: StationScope,
  showId: string,
): Promise<ShowSlot[]> {
  await showRow(db, scope, showId);
  const rows = await db
    .select()
    .from(showSlot)
    .where(and(eq(showSlot.showId, showId), whereStation(showSlot, scope)))
    .orderBy(asc(showSlot.startsOn), asc(showSlot.id));
  return toSlots(db, rows);
}

export async function getSlot(
  db: Executor,
  scope: StationScope,
  showId: string,
  slotId: string,
): Promise<ShowSlot> {
  const [out] = await toSlots(db, [await slotRow(db, scope, showId, slotId)]);
  return out as ShowSlot;
}

export async function createSlot(
  db: Db,
  ctx: StationContext,
  showId: string,
  input: CreateShowSlot,
): Promise<ShowSlot> {
  const parsed = createShowSlotSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const parent = await showRow(tx, ctx.scope, showId);
    const durationMs = parsed.durationMs ?? parent.defaultDurationMs;
    if (durationMs === null) {
      throw new HttpError(422, 'duration_required', 'the show has no default duration');
    }
    const [row] = await tx
      .insert(showSlot)
      .values({
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
        showId,
        type: parsed.type ?? parent.defaultSlotType,
        rule: parsed.rule,
        startsOn: ruleStartDate(parsed.rule),
        endsOn: ruleEndDate(parsed.rule),
        durationMs,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    await audit({
      action: 'show_slot.create',
      entity: { type: 'show_slot', id: row.id },
      diff: auditDiff(null, row),
    });
    return getSlot(tx, ctx.scope, showId, row.id);
  });
}

export async function updateSlot(
  db: Db,
  ctx: StationContext,
  showId: string,
  slotId: string,
  input: UpdateShowSlot,
): Promise<ShowSlotChange> {
  const parsed = updateShowSlotSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await slotRow(tx, ctx.scope, showId, slotId);
    const rule = parsed.rule ?? before.rule;
    const [after] = await tx
      .update(showSlot)
      .set({
        ...parsed,
        ...(parsed.rule ? { startsOn: ruleStartDate(rule), endsOn: ruleEndDate(rule) } : {}),
      })
      .where(and(eq(showSlot.id, slotId), whereStation(showSlot, ctx.scope)))
      .returning();
    if (!after) throw new NotFoundError('show_slot', slotId);
    if (parsed.rule) {
      // Exceptions on dates the new rule doesn't have would never apply again.
      const stale = (await exceptionsOf(tx, [slotId]))
        .get(slotId)
        ?.filter((e) => !isOccurrenceDate(rule, e.date));
      if (stale?.length) {
        await tx.delete(showSlotException).where(
          and(
            eq(showSlotException.slotId, slotId),
            inArray(
              showSlotException.date,
              stale.map((e) => e.date),
            ),
          ),
        );
      }
    }
    await audit({
      action: 'show_slot.update',
      entity: { type: 'show_slot', id: slotId },
      diff: auditDiff(before, after),
    });
    let detachedEpisodeIds: string[] = [];
    if (parsed.rule || parsed.type) {
      const exceptions = (await exceptionsOf(tx, [slotId])).get(slotId) ?? [];
      const timezone = await stationTimezone(tx, ctx.scope);
      const slot = { ...after, exceptions };
      detachedEpisodeIds = await detachPremieres(
        tx,
        ctx.scope,
        slotId,
        audit,
        (date) => after.type === 'rerun' || occurrenceOn(slot, date, timezone) === null,
      );
    }
    return { slot: await getSlot(tx, ctx.scope, showId, slotId), detachedEpisodeIds };
  });
}

/**
 * Unschedules the slot's premieres whose occurrence is `gone` (slot and date cleared, one
 * `episode.detach` audit row each). Returns their ids.
 */
async function detachPremieres(
  tx: Tx,
  scope: StationScope,
  slotId: string,
  audit: AuditFn,
  gone: (date: LocalDate) => boolean,
): Promise<string[]> {
  const rows = await tx
    .select({ id: episode.id, occurrenceDate: episode.occurrenceDate })
    .from(episode)
    .where(and(eq(episode.slotId, slotId), whereStation(episode, scope)))
    .orderBy(asc(episode.occurrenceDate));
  const detached = rows.filter((r) => r.occurrenceDate !== null && gone(r.occurrenceDate));
  if (!detached.length) return [];
  await tx
    .update(episode)
    .set({ slotId: null, occurrenceDate: null })
    .where(
      and(
        inArray(
          episode.id,
          detached.map((r) => r.id),
        ),
        whereStation(episode, scope),
      ),
    );
  for (const r of detached) {
    await audit({
      action: 'episode.detach',
      entity: { type: 'episode', id: r.id },
      diff: {
        slotId: { from: slotId, to: null },
        occurrenceDate: { from: r.occurrenceDate, to: null },
      },
    });
  }
  return detached.map((r) => r.id);
}

/** Deletes the slot and its exceptions. Its premieres are kept, unscheduled. */
export async function deleteSlot(
  db: Db,
  ctx: StationContext,
  showId: string,
  slotId: string,
): Promise<ShowSlotDeleted> {
  return withAudit(db, ctx, async (tx, audit) => {
    const before = await slotRow(tx, ctx.scope, showId, slotId);
    const detachedEpisodeIds = await detachPremieres(tx, ctx.scope, slotId, audit, () => true);
    await tx
      .delete(showSlot)
      .where(and(eq(showSlot.id, slotId), whereStation(showSlot, ctx.scope)));
    await audit({
      action: 'show_slot.delete',
      entity: { type: 'show_slot', id: slotId },
      diff: auditDiff(before, null),
    });
    return { detachedEpisodeIds };
  });
}

/** Cancels or moves one occurrence, keyed by its original local date. Replaces any earlier one. */
export async function putException(
  db: Db,
  ctx: StationContext,
  showId: string,
  slotId: string,
  date: LocalDate,
  input: PutSlotException,
): Promise<ShowSlotChange> {
  const parsed = putSlotExceptionSchema.parse(input);
  return withAudit(db, ctx, async (tx, audit) => {
    const slot = await slotRow(tx, ctx.scope, showId, slotId);
    if (!isOccurrenceDate(slot.rule, date)) {
      throw new HttpError(422, 'not_an_occurrence', `the slot doesn't air on ${date}`);
    }
    if (
      parsed.kind === 'moved' &&
      (parsed.startDate < addDays(date, -SLOT_MAX_MOVE_DAYS) ||
        parsed.startDate > addDays(date, SLOT_MAX_MOVE_DAYS))
    ) {
      throw new HttpError(
        422,
        'move_too_far',
        `an occurrence moves at most ${SLOT_MAX_MOVE_DAYS} days; cancel it and add a one-off slot`,
      );
    }
    const values =
      parsed.kind === 'cancelled'
        ? { kind: 'cancelled' as const, startDate: null, startTime: null, durationMs: null }
        : {
            kind: 'moved' as const,
            startDate: parsed.startDate,
            startTime: parsed.startTime,
            durationMs: parsed.durationMs,
          };
    const [before] = await tx
      .select()
      .from(showSlotException)
      .where(and(eq(showSlotException.slotId, slotId), eq(showSlotException.date, date)));
    const [after] = await tx
      .insert(showSlotException)
      .values({ slotId, orgId: ctx.scope.orgId, stationId: ctx.scope.stationId, date, ...values })
      .onConflictDoUpdate({
        target: [showSlotException.slotId, showSlotException.date],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await audit({
      action: 'show_slot.exception.put',
      entity: { type: 'show_slot', id: slotId },
      diff: auditDiff(before ?? null, after ?? null),
    });
    // A moved occurrence keeps its identity, and its premiere; a cancelled one loses it.
    const detachedEpisodeIds =
      parsed.kind === 'cancelled'
        ? await detachPremieres(tx, ctx.scope, slotId, audit, (d) => d === date)
        : [];
    return { slot: await getSlot(tx, ctx.scope, showId, slotId), detachedEpisodeIds };
  });
}

export async function deleteException(
  db: Db,
  ctx: StationContext,
  showId: string,
  slotId: string,
  date: LocalDate,
): Promise<ShowSlotChange> {
  return withAudit(db, ctx, async (tx, audit) => {
    await slotRow(tx, ctx.scope, showId, slotId);
    const [before] = await tx
      .delete(showSlotException)
      .where(
        and(
          eq(showSlotException.slotId, slotId),
          eq(showSlotException.date, date),
          whereStation(showSlotException, ctx.scope),
        ),
      )
      .returning();
    if (!before) throw new NotFoundError('show_slot_exception', `${slotId}/${date}`);
    await audit({
      action: 'show_slot.exception.delete',
      entity: { type: 'show_slot', id: slotId },
      diff: auditDiff(before, null),
    });
    // Restoring an occurrence detaches nothing.
    return { slot: await getSlot(tx, ctx.scope, showId, slotId), detachedEpisodeIds: [] };
  });
}

// --- Episodes ----------------------------------------------------------------------------

function toEpisode(r: EpisodeRow): Episode {
  return {
    id: r.id,
    showId: r.showId,
    number: r.number,
    title: r.title,
    description: r.description,
    tracklist: r.tracklist,
    kind: r.kind,
    assetId: r.assetId,
    status: r.status,
    airedAt: r.airedAt,
    slotId: r.slotId,
    occurrenceDate: r.occurrenceDate,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function episodeRow(db: Executor, scope: StationScope, showId: string, episodeId: string) {
  const [row] = await db
    .select()
    .from(episode)
    .where(
      and(eq(episode.id, episodeId), eq(episode.showId, showId), whereStation(episode, scope)),
    );
  if (!row) throw new NotFoundError('episode', episodeId);
  return row;
}

export async function listEpisodes(
  db: Executor,
  scope: StationScope,
  showId: string,
  filter: { status?: EpisodeStatus | undefined; scheduled?: boolean | undefined } = {},
): Promise<Episode[]> {
  await showRow(db, scope, showId);
  const { status, scheduled } = filter;
  const rows = await db
    .select()
    .from(episode)
    .where(
      and(
        eq(episode.showId, showId),
        whereStation(episode, scope),
        status ? eq(episode.status, status) : undefined,
        scheduled === undefined
          ? undefined
          : scheduled
            ? sql`${episode.slotId} is not null`
            : isNull(episode.slotId),
      ),
    )
    .orderBy(desc(episode.number));
  return rows.map(toEpisode);
}

export async function getEpisode(
  db: Executor,
  scope: StationScope,
  showId: string,
  episodeId: string,
): Promise<Episode> {
  return toEpisode(await episodeRow(db, scope, showId, episodeId));
}

/** An episode's audio is an `episode` asset of the station. */
async function checkAsset(tx: Tx, scope: StationScope, assetId: string | null | undefined) {
  if (!assetId) return;
  const [row] = await tx
    .select({ type: asset.type })
    .from(asset)
    .where(and(eq(asset.id, assetId), whereStation(asset, scope)));
  if (!row) throw new HttpError(422, 'unknown_asset', 'the asset is not in the station library');
  if (row.type !== 'episode') {
    throw new HttpError(
      422,
      'invalid_asset',
      `an episode plays an episode asset, not a ${row.type}`,
    );
  }
}

/** The premiere occurrence must be a live or pre-recorded slot of the same show, airing that day. */
async function checkOccurrence(
  tx: Tx,
  scope: StationScope,
  showId: string,
  slotId: string | null | undefined,
  date: LocalDate | null | undefined,
): Promise<SlotRow | null> {
  if (!slotId || !date) return null;
  const [row] = await tx
    .select()
    .from(showSlot)
    .where(
      and(eq(showSlot.id, slotId), eq(showSlot.showId, showId), whereStation(showSlot, scope)),
    );
  if (!row) throw new HttpError(422, 'unknown_slot', 'the slot is not one of this show');
  if (row.type === 'rerun') {
    throw new HttpError(422, 'rerun_slot', 'a rerun slot airs an existing episode');
  }
  const exceptions = (await exceptionsOf(tx, [slotId])).get(slotId) ?? [];
  if (!occurrenceOn({ ...row, exceptions }, date, await stationTimezone(tx, scope))) {
    throw new HttpError(422, 'not_an_occurrence', `the slot doesn't air on ${date}`);
  }
  return row;
}

async function stationTimezone(db: Executor, scope: StationScope): Promise<string> {
  const [row] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!row) throw new NotFoundError('station', scope.stationId);
  return row.timezone;
}

/** Attaching audio makes a planned (or missing) episode ready; detaching it, planned again. */
function nextStatus(current: EpisodeStatus, hadAsset: boolean, hasAsset: boolean): EpisodeStatus {
  if (!hadAsset && hasAsset && (current === 'planned' || current === 'missing')) return 'ready';
  if (hadAsset && !hasAsset && current === 'ready') return 'planned';
  return current;
}

/** `ready` means the audio is there (`episode_ready_asset_check`). */
function checkReady(status: EpisodeStatus, assetId: string | null) {
  if (status === 'ready' && assetId === null) {
    throw new HttpError(422, 'asset_required', 'a ready episode needs its asset');
  }
}

/** Keeps the show's counter above `number`. Called under the show lock. */
async function bumpCounter(tx: Tx, parent: ShowRow, number: number) {
  if (number < parent.nextEpisodeNumber) return;
  await tx
    .update(show)
    .set({ nextEpisodeNumber: number + 1, updatedAt: parent.updatedAt })
    .where(eq(show.id, parent.id));
}

/** Maps the unique keys of `episode` to 409s. */
function conflictOf(err: unknown): HttpError | null {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    const e = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (e.code === '23505') {
      if (e.constraint_name === 'episode_occurrence_key') {
        return new HttpError(
          409,
          'occurrence_taken',
          'another episode premieres in this occurrence',
        );
      }
      if (e.constraint_name === 'episode_asset_key') {
        return new HttpError(409, 'asset_taken', 'the asset is the audio of another episode');
      }
      return new HttpError(409, 'episode_number_taken', 'the show has an episode with this number');
    }
    current = e.cause;
  }
  return null;
}

async function mapConflicts<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw conflictOf(err) ?? err;
  }
}

export async function createEpisode(
  db: Db,
  ctx: StationContext,
  showId: string,
  input: CreateEpisode,
): Promise<Episode> {
  const parsed = createEpisodeSchema.parse(input);
  return mapConflicts(() =>
    withAudit(db, ctx, async (tx, audit) => {
      // Locked: concurrent writes number one after the other.
      const parent = await showRow(tx, ctx.scope, showId, true);
      await checkAsset(tx, ctx.scope, parsed.assetId);
      const slot = await checkOccurrence(
        tx,
        ctx.scope,
        showId,
        parsed.slotId,
        parsed.occurrenceDate,
      );
      const number = parsed.number ?? parent.nextEpisodeNumber;
      const status = parsed.status ?? (parsed.assetId ? 'ready' : 'planned');
      checkReady(status, parsed.assetId);
      const kind =
        parsed.kind ??
        (slot ? (slot.type === 'live' ? 'live' : 'prerecorded') : parent.defaultSlotType);
      const [row] = await tx
        .insert(episode)
        .values({
          ...parsed,
          orgId: ctx.scope.orgId,
          stationId: ctx.scope.stationId,
          showId,
          number,
          kind,
          status,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await bumpCounter(tx, parent, number);
      await audit({
        action: 'episode.create',
        entity: { type: 'episode', id: row.id },
        diff: auditDiff(null, row),
      });
      return toEpisode(row);
    }),
  );
}

export async function updateEpisode(
  db: Db,
  ctx: StationContext,
  showId: string,
  episodeId: string,
  input: UpdateEpisode,
): Promise<Episode> {
  const parsed = updateEpisodeSchema.parse(input);
  return mapConflicts(() =>
    withAudit(db, ctx, async (tx, audit) => {
      // The same lock as createEpisode, so a renumbering can't race a creation.
      const parent = await showRow(tx, ctx.scope, showId, true);
      const before = await episodeRow(tx, ctx.scope, showId, episodeId);
      if (parsed.assetId !== undefined) await checkAsset(tx, ctx.scope, parsed.assetId);
      if (parsed.slotId !== undefined) {
        await checkOccurrence(tx, ctx.scope, showId, parsed.slotId, parsed.occurrenceDate);
      }
      const assetId = parsed.assetId === undefined ? before.assetId : parsed.assetId;
      const status =
        parsed.status ?? nextStatus(before.status, before.assetId !== null, assetId !== null);
      checkReady(status, assetId);
      const [after] = await tx
        .update(episode)
        .set({ ...parsed, status })
        .where(and(eq(episode.id, episodeId), whereStation(episode, ctx.scope)))
        .returning();
      if (!after) throw new NotFoundError('episode', episodeId);
      if (parsed.number !== undefined) await bumpCounter(tx, parent, parsed.number);
      await audit({
        action: 'episode.update',
        entity: { type: 'episode', id: episodeId },
        diff: auditDiff(before, after),
      });
      return toEpisode(after);
    }),
  );
}

/** Deletes the episode. Its asset stays in the library. */
export async function deleteEpisode(
  db: Db,
  ctx: StationContext,
  showId: string,
  episodeId: string,
): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await episodeRow(tx, ctx.scope, showId, episodeId);
    await tx
      .delete(episode)
      .where(and(eq(episode.id, episodeId), whereStation(episode, ctx.scope)));
    await audit({
      action: 'episode.delete',
      entity: { type: 'episode', id: episodeId },
      diff: auditDiff(before, null),
    });
  });
}

// --- Occurrences -------------------------------------------------------------------------

/**
 * Every slot occurrence overlapping `[from, to)`, with its show, the episode planned for it,
 * and the overlapping pairs among them. Slots are loaded by their date span, widened like
 * `expandSlots` widens its window (a day-long slot from two days back, a move up to a week).
 */
export async function getOccurrences(
  db: Executor,
  scope: StationScope,
  input: ShowOccurrencesQuery,
): Promise<ShowOccurrencesResponse> {
  const query = showOccurrencesQuerySchema.parse(input);
  const timezone = await stationTimezone(db, scope);
  const first = addDays(localDateOf(query.from, timezone), -2 - MAX_MOVE_DAYS);
  const last = addDays(localDateOf(query.to, timezone), MAX_MOVE_DAYS);
  const rows = await db
    .select({ slot: showSlot, show: { id: show.id, name: show.name, colour: show.colour } })
    .from(showSlot)
    .innerJoin(show, eq(show.id, showSlot.showId))
    .where(
      and(
        whereStation(showSlot, scope),
        query.showId ? eq(showSlot.showId, query.showId) : undefined,
        lte(showSlot.startsOn, last),
        or(isNull(showSlot.endsOn), gte(showSlot.endsOn, first)),
      ),
    );
  const slotIds = rows.map((r) => r.slot.id);
  const exceptions = await exceptionsOf(db, slotIds);
  const slots = rows.map((r) => ({
    ...r.slot,
    show: r.show,
    exceptions: exceptions.get(r.slot.id) ?? [],
  }));
  const occurrences = expandSlots(slots, query, timezone);

  const episodes = slotIds.length
    ? await db
        .select()
        .from(episode)
        .where(
          and(
            whereStation(episode, scope),
            inArray(episode.slotId, slotIds),
            sql`${episode.occurrenceDate} between ${first} and ${last}`,
          ),
        )
    : [];
  const byOccurrence = new Map(episodes.map((e) => [`${e.slotId}/${e.occurrenceDate}`, e]));

  return {
    timezone,
    occurrences: occurrences.map((o) => {
      const e = byOccurrence.get(`${o.slot.id}/${o.date}`);
      return {
        slotId: o.slot.id,
        date: o.date,
        show: o.slot.show,
        type: o.slot.type,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        durationMs: o.durationMs,
        moved: o.moved,
        episode: e
          ? {
              id: e.id,
              number: e.number,
              title: e.title,
              kind: e.kind,
              assetId: e.assetId,
              status: e.status,
            }
          : null,
      };
    }),
    conflicts: findConflicts(occurrences).map((c) => ({
      a: { slotId: c.a.slot.id, date: c.a.date },
      b: { slotId: c.b.slot.id, date: c.b.date },
      startsAt: c.from,
      endsAt: c.to,
      overlapMs: c.overlapMs,
    })),
  };
}
