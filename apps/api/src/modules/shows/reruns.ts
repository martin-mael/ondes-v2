import {
  type Executor,
  episode,
  pickEpisode,
  type StationScope,
  type showSlot,
  type Tx,
  whereStation,
} from '@ondes/db';
import type { LocalDate, SlotRerun, SlotRerunInput, SlotType } from '@ondes/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';

// Reruns (#48, ADR 0028). A `rerun` slot airs an existing episode of its show again: it never
// copies it (an asset is one episode's audio, ADR 0014). Which one is the slot's strategy,
// resolved per occurrence by `pickEpisode` (@ondes/db), the same query #47's `resolveFallback`
// uses for its episode policies. The log generator (#50) calls @ondes/db's `resolveRerun` and
// plans an `episode` item with the resolved episode's id and asset and `origin_show_slot_id` =
// the rerun slot; the as-run marks it as a rerun from that (asrun/repo.ts).

type SlotRow = typeof showSlot.$inferSelect;

/** The columns a slot's strategy is stored in. */
export type RerunColumns = Pick<SlotRow, 'rerunStrategy' | 'rerunEpisodeId'>;

/** A slot's strategy as read. A rerun slot without one (written before #48) reruns the latest. */
export function toSlotRerun(row: Pick<SlotRow, 'type'> & RerunColumns): SlotRerun | null {
  if (row.type !== 'rerun') return null;
  return row.rerunStrategy === 'episode'
    ? { strategy: 'episode', episodeId: row.rerunEpisodeId }
    : { strategy: 'latest_episode' };
}

/**
 * The columns for a slot of `type` written with `rerun`: the strategy goes with rerun slots
 * only (422 otherwise), defaults to the latest episode, and its episode is one of the show's.
 */
export async function rerunColumns(
  tx: Tx,
  scope: StationScope,
  showId: string,
  type: SlotType,
  rerun: SlotRerunInput | undefined,
): Promise<RerunColumns> {
  if (type !== 'rerun') {
    if (rerun) {
      throw new HttpError(422, 'not_a_rerun_slot', 'only a rerun slot has a rerun strategy');
    }
    return { rerunStrategy: null, rerunEpisodeId: null };
  }
  if (!rerun || rerun.strategy === 'latest_episode') {
    return { rerunStrategy: 'latest_episode', rerunEpisodeId: null };
  }
  const [row] = await tx
    .select({ id: episode.id })
    .from(episode)
    .where(
      and(
        whereStation(episode, scope),
        eq(episode.id, rerun.episodeId),
        eq(episode.showId, showId),
      ),
    );
  if (!row) throw new HttpError(422, 'unknown_episode', 'the episode is not one of this show');
  return { rerunStrategy: 'episode', rerunEpisodeId: row.id };
}

export type RerunOccurrence = {
  slotId: string;
  slot: Pick<SlotRow, 'showId' | 'type'> & RerunColumns;
  /** The occurrence's original local date: episodes premiered before it count as aired. */
  occurrenceDate: LocalDate;
};

/**
 * The episode each rerun occurrence airs now (null: nothing to rerun yet), keyed
 * `slotId/date`. Occurrences that resolve the same way (same show, strategy and date) are
 * resolved once.
 */
export async function resolveReruns(
  db: Executor,
  scope: StationScope,
  occurrences: RerunOccurrence[],
): Promise<Map<string, typeof episode.$inferSelect | null>> {
  const out = new Map<string, string | null>();
  const memo = new Map<string, Promise<{ episodeId: string } | null>>();
  for (const o of occurrences) {
    const rerun = toSlotRerun(o.slot);
    if (!rerun) continue;
    const episodeId = rerun.strategy === 'episode' ? rerun.episodeId : null;
    const key = `${o.slot.showId}/${rerun.strategy}/${episodeId}/${o.occurrenceDate}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = pickEpisode(db, scope, {
        showId: o.slot.showId,
        strategy: rerun.strategy,
        episodeId,
        excludeEpisodeId: null,
        occurrenceDate: o.occurrenceDate,
      });
      memo.set(key, pending);
    }
    out.set(`${o.slotId}/${o.occurrenceDate}`, (await pending)?.episodeId ?? null);
  }
  const ids = [...new Set([...out.values()].filter((id): id is string => id !== null))];
  const rows = ids.length
    ? await db
        .select()
        .from(episode)
        .where(and(whereStation(episode, scope), inArray(episode.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map([...out].map(([k, id]) => [k, id ? (byId.get(id) ?? null) : null]));
}
