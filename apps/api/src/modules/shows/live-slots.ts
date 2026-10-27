import {
  type AuditFn,
  auditDiff,
  type Executor,
  episode,
  type StationScope,
  show,
  type showSlot,
  type Tx,
  whereStation,
} from '@ondes/db';
import {
  type EpisodeStatus,
  LIVE_SLOT_DEFAULTS,
  type LocalDate,
  type SlotLive,
  type SlotLiveInput,
  type SlotType,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';

// Live slots (#65, ADR 0033): a `live` slot's settings (grace period, early-connect
// behaviour), stored on `show_slot` like a rerun slot's strategy, and the episode a live slot
// occurrence airs. The episode is created (or the planned one taken) when a DJ goes on air in
// the occurrence, numbered from the show's counter like any other (ADR 0014), and marked aired.

type SlotRow = typeof showSlot.$inferSelect;

/** The columns a live slot's settings are stored in. */
export type LiveColumns = Pick<SlotRow, 'liveGraceMs' | 'liveEarlyConnect'>;

/** A slot's settings as read. A live slot without them (written before #65) has the defaults. */
export function toSlotLive(row: Pick<SlotRow, 'type'> & LiveColumns): SlotLive | null {
  if (row.type !== 'live') return null;
  return {
    graceMs: row.liveGraceMs ?? LIVE_SLOT_DEFAULTS.graceMs,
    earlyConnect: row.liveEarlyConnect ?? LIVE_SLOT_DEFAULTS.earlyConnect,
  };
}

/**
 * The columns for a slot of `type` written with `live`: the settings go with live slots only
 * (422 otherwise); what's left out keeps the slot's current value (`before`), else the default.
 */
export function liveColumns(
  type: SlotType,
  live: SlotLiveInput | undefined,
  before?: Pick<SlotRow, 'type'> & LiveColumns,
): LiveColumns {
  if (type !== 'live') {
    if (live) throw new HttpError(422, 'not_a_live_slot', 'only a live slot has live settings');
    return { liveGraceMs: null, liveEarlyConnect: null };
  }
  const current = before ? toSlotLive(before) : null;
  return {
    liveGraceMs: live?.graceMs ?? current?.graceMs ?? LIVE_SLOT_DEFAULTS.graceMs,
    liveEarlyConnect:
      live?.earlyConnect ?? current?.earlyConnect ?? LIVE_SLOT_DEFAULTS.earlyConnect,
  };
}

/** `previous`: the planned episode's status and air time before it, to undo the start. */
export type LiveEpisode = {
  id: string;
  number: number;
  showId: string;
  created: boolean;
  previous: { status: EpisodeStatus; airedAt: Date | null } | null;
};

/**
 * The episode a live occurrence airs, marked aired from `at`: the one planned for it, or a new
 * `live` one numbered from the show's counter. Runs in the caller's transaction, under the
 * show's row lock (the same lock `createEpisode` takes, so numbers never collide). A second
 * session in the same occurrence (the DJ reconnected) gets the same episode back unchanged.
 */
export async function startLiveEpisode(
  tx: Tx,
  scope: StationScope,
  audit: AuditFn,
  occurrence: { showId: string; slotId: string; date: LocalDate },
  at: Date,
): Promise<LiveEpisode> {
  const [parent] = await tx
    .select()
    .from(show)
    .where(and(eq(show.id, occurrence.showId), whereStation(show, scope)))
    .for('update');
  if (!parent) throw new HttpError(409, 'show_gone', 'the live slot’s show no longer exists');
  const [planned] = await tx
    .select()
    .from(episode)
    .where(
      and(
        whereStation(episode, scope),
        eq(episode.slotId, occurrence.slotId),
        eq(episode.occurrenceDate, occurrence.date),
      ),
    );
  if (planned) {
    const kept = { id: planned.id, number: planned.number, showId: planned.showId, created: false };
    if (planned.status === 'aired') return { ...kept, previous: null };
    const [after] = await tx
      .update(episode)
      .set({ status: 'aired', airedAt: planned.airedAt ?? at })
      .where(eq(episode.id, planned.id))
      .returning();
    await audit({
      action: 'episode.update',
      entity: { type: 'episode', id: planned.id },
      diff: auditDiff(planned, after ?? null),
    });
    return { ...kept, previous: { status: planned.status, airedAt: planned.airedAt } };
  }
  const number = parent.nextEpisodeNumber;
  const [row] = await tx
    .insert(episode)
    .values({
      orgId: scope.orgId,
      stationId: scope.stationId,
      showId: parent.id,
      number,
      kind: 'live',
      status: 'aired',
      airedAt: at,
      slotId: occurrence.slotId,
      occurrenceDate: occurrence.date,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  await tx
    .update(show)
    .set({ nextEpisodeNumber: number + 1, updatedAt: parent.updatedAt })
    .where(eq(show.id, parent.id));
  await audit({
    action: 'episode.create',
    entity: { type: 'episode', id: row.id },
    diff: auditDiff(null, row),
  });
  return { id: row.id, number, showId: parent.id, created: true, previous: null };
}

/**
 * Undoes `startLiveEpisode` when the engine refused to put the DJ on air: a created episode is
 * deleted (its number isn't handed out again), a planned one gets its status back.
 */
export async function undoLiveEpisode(
  tx: Tx,
  scope: StationScope,
  audit: AuditFn,
  started: LiveEpisode,
): Promise<void> {
  if (started.created) {
    await tx.delete(episode).where(and(eq(episode.id, started.id), whereStation(episode, scope)));
    await audit({
      action: 'episode.delete',
      entity: { type: 'episode', id: started.id },
      diff: { status: { from: 'aired', to: null } },
    });
  } else if (started.previous) {
    await tx
      .update(episode)
      .set(started.previous)
      .where(and(eq(episode.id, started.id), whereStation(episode, scope)));
    await audit({
      action: 'episode.update',
      entity: { type: 'episode', id: started.id },
      diff: { status: { from: 'aired', to: started.previous.status } },
    });
  }
}

/**
 * A live occurrence ended with no DJ ever on air: its planned episode, if any, is `missing`
 * (the status #44 reserved for this). Returns its id, or null when there was none to mark.
 */
export async function markLiveEpisodeMissing(
  db: Executor,
  scope: StationScope,
  audit: AuditFn,
  occurrence: { slotId: string; date: LocalDate },
): Promise<string | null> {
  const [before] = await db
    .select()
    .from(episode)
    .where(
      and(
        whereStation(episode, scope),
        eq(episode.slotId, occurrence.slotId),
        eq(episode.occurrenceDate, occurrence.date),
        eq(episode.status, 'planned'),
      ),
    );
  if (!before) return null;
  const [after] = await db
    .update(episode)
    .set({ status: 'missing' })
    .where(and(eq(episode.id, before.id), eq(episode.status, 'planned')))
    .returning();
  if (!after) return null;
  await audit({
    action: 'episode.update',
    entity: { type: 'episode', id: before.id },
    diff: auditDiff(before, after),
  });
  return before.id;
}
