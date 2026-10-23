import {
  inDayparts,
  type LocalDate,
  localDateOf,
  type PromoDaypart,
  validThroughout,
} from '@ondes/shared';
import type {
  GeneratedDay,
  GeneratedItem,
  PlannedItem,
  VtPlacementContext,
} from '../generator/types.ts';
import { randomFor } from '../rules/random.ts';

// Promo placement (#60, ADR 0032): the log generator's `placeVoiceTrack` hook for `vt` slots
// with a VT pool. Pure and deterministic: cue markers and these rules only, no models.
//
// At a pool slot, the promo goes over the transition out of the song just planned (A) into the
// next item (B). The hook adds nothing to the run (a promo is a segue voice lane, ADR 0017, and
// takes no time of its own); it records the placement, and `resolvePromoPlacements` pairs it
// with A and B once the day is generated. The caller writes it and makes the default segue
// (`defaultPromoLanes`).
//
// Choosing a promo of the pool, at the slot's time:
// - eligible: enabled, in the pool, valid (the asset's `startAt`/`killAt`) from one voice length
//   before the transition to one after it, inside one of its dayparts, under its daily cap
//   (station-local day of the transition);
// - the one with the fewest plays that day for its weight (`(plays + 1) / weight`) wins, so
//   plays spread in proportion to weight; then the one placed least recently; then a seeded draw
//   (`randomFor(seed, …)`), so equal promos rotate the same way on every run.

/** A promo as the placer sees it. */
export interface PromoCandidate {
  id: string;
  assetId: string;
  poolIds: readonly string[];
  weight: number;
  maxPlaysPerDay: number | null;
  dayparts: readonly PromoDaypart[];
  startAt: Date | null;
  killAt: Date | null;
  enabled: boolean;
  /** How long the voice plays (cue-out − cue-in), in ms. */
  playMs: number;
}

/** Plays that count against caps and rotation: placements outside what is being generated. */
export interface PromoPlay {
  promoId: string;
  at: Date;
}

export interface PromoSnapshot {
  timeZone: string;
  promos: readonly PromoCandidate[];
  plays: readonly PromoPlay[];
}

/** A placement the hook made, before it is paired with the day's items. */
export interface PromoPlacementPlan {
  promoId: string;
  assetId: string;
  poolId: string;
  clockId: string;
  slotIndex: number;
  /** The transition's planned time (where the slot fell: A's planned end). */
  at: Date;
  /** A as planned: matched to the generated item by origin, start and asset. */
  after: PlannedItem;
}

/**
 * - `no_song_before`: the slot doesn't follow a song (the start of a window, a jingle, a show).
 * - `transition_taken`: A already carries a promo, or is a kept item (it may have a segue).
 * - `no_eligible_promo`: nothing in the pool can air then (expired, outside its dayparts, at
 *   its cap, disabled, or an empty pool).
 * - `no_song_after`: B isn't a song (a marker, a show, the end of the day), or A was replaced
 *   (back-timing).
 */
export type PromoIssueCode =
  | 'no_song_before'
  | 'transition_taken'
  | 'no_eligible_promo'
  | 'no_song_after';

export interface PromoIssue {
  code: PromoIssueCode;
  at: Date;
  poolId: string;
  clockId: string;
  slotIndex: number;
}

export interface PromoPlacer {
  /** The generator hook (`GeneratorExtensions.placeVoiceTrack`). */
  placeVoiceTrack(context: VtPlacementContext): PlannedItem[] | null;
  /** Placements made so far, in placement order. */
  readonly placements: readonly PromoPlacementPlan[];
  readonly issues: readonly PromoIssue[];
}

/** Item kinds a promo may sit between. */
const SONG = 'song';

export function createPromoPlacer(snapshot: PromoSnapshot, options: { seed: string }): PromoPlacer {
  const placements: PromoPlacementPlan[] = [];
  const issues: PromoIssue[] = [];
  /** Plays per promo per station-local date, and each promo's latest play. */
  const perDay = new Map<string, number>();
  const latest = new Map<string, number>();
  const count = (promoId: string, date: LocalDate) => perDay.get(`${promoId}:${date}`) ?? 0;
  const record = (promoId: string, at: Date) => {
    const key = `${promoId}:${localDateOf(at, snapshot.timeZone)}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    latest.set(promoId, Math.max(latest.get(promoId) ?? -Infinity, at.getTime()));
  };
  for (const play of snapshot.plays) record(play.promoId, play.at);
  const taken = new Set<PlannedItem>();

  function choose(poolId: string, at: Date): PromoCandidate | null {
    const date = localDateOf(at, snapshot.timeZone);
    const eligible = snapshot.promos.filter(
      (p) =>
        p.enabled &&
        p.poolIds.includes(poolId) &&
        validThroughout(p, new Date(at.getTime() - p.playMs), new Date(at.getTime() + p.playMs)) &&
        inDayparts(p.dayparts, at, snapshot.timeZone) &&
        (p.maxPlaysPerDay === null || count(p.id, date) < p.maxPlaysPerDay),
    );
    let best: { promo: PromoCandidate; score: number; last: number; draw: number } | null = null;
    for (const promo of eligible) {
      const candidate = {
        promo,
        score: (count(promo.id, date) + 1) / promo.weight,
        last: latest.get(promo.id) ?? -Infinity,
        draw: randomFor(options.seed, `${poolId}:${at.toISOString()}:${promo.id}`),
      };
      if (
        !best ||
        candidate.score < best.score ||
        (candidate.score === best.score &&
          (candidate.last < best.last ||
            (candidate.last === best.last && candidate.draw < best.draw)))
      ) {
        best = candidate;
      }
    }
    return best?.promo ?? null;
  }

  return {
    placements,
    issues,
    placeVoiceTrack(context) {
      const { poolId } = context;
      // Placeholders (recorded later) aren't promos: the generator reports them.
      if (poolId === null) return null;
      const issue = (code: PromoIssueCode) => {
        issues.push({
          code,
          at: context.at,
          poolId,
          clockId: context.clockId,
          slotIndex: context.slotIndex,
        });
        return [];
      };
      const a = context.previous;
      if (!a || a.kind !== SONG || !a.assetId || a.segmentId !== null) {
        return issue('no_song_before');
      }
      if (a.keptId !== null || taken.has(a)) return issue('transition_taken');
      const promo = choose(poolId, context.at);
      if (!promo) return issue('no_eligible_promo');
      taken.add(a);
      record(promo.id, context.at);
      placements.push({
        promoId: promo.id,
        assetId: promo.assetId,
        poolId,
        clockId: context.clockId,
        slotIndex: context.slotIndex,
        at: context.at,
        after: a,
      });
      return [];
    },
  };
}

/** A placement paired with its A and B in a generated day (positions in `day.items`). */
export interface ResolvedPromoPlacement extends PromoPlacementPlan {
  fromPosition: number;
  toPosition: number;
  /** A's retimed planned end: when the transition is planned. */
  plannedAt: Date;
}

/**
 * Back-timing (#46) may move an item's `start` earlier when it drops an elastic fill before it,
 * so A is matched by origin and asset, at the start nearest to where it was planned (within
 * {@link MATCH_WINDOW_MS}: the same clock slot an hour away is another item).
 */
const MATCH_WINDOW_MS = 10 * 60_000;

const sameSlot = (planned: PlannedItem, item: GeneratedItem) =>
  item.keptId === null &&
  item.assetId === planned.assetId &&
  item.origin.type === planned.origin.type &&
  (planned.origin.type !== 'clock' ||
    (item.origin.type === 'clock' &&
      item.origin.clockId === planned.origin.clockId &&
      item.origin.slotIndex === planned.origin.slotIndex));

function findPlanned(items: readonly GeneratedItem[], planned: PlannedItem): number {
  let best = -1;
  let bestGap = MATCH_WINDOW_MS;
  for (const [i, item] of items.entries()) {
    if (!sameSlot(planned, item)) continue;
    const gap = Math.abs(item.start.getTime() - planned.start.getTime());
    if (gap <= bestGap) {
      best = i;
      bestGap = gap;
      if (gap === 0) break;
    }
  }
  return best;
}

/**
 * Pairs the day's placements with the generated items: A is the item planned as `after`, B the
 * next top-level item, which must be a song too. The others are reported `no_song_after`.
 */
export function resolvePromoPlacements(
  day: GeneratedDay,
  placements: readonly PromoPlacementPlan[],
): { placed: ResolvedPromoPlacement[]; issues: PromoIssue[] } {
  const from = day.startsAt.getTime();
  const to = day.endsAt.getTime();
  const placed: ResolvedPromoPlacement[] = [];
  const issues: PromoIssue[] = [];
  for (const p of placements) {
    if (p.at.getTime() < from || p.at.getTime() >= to) continue;
    const fromPosition = findPlanned(day.items, p.after);
    const b = fromPosition >= 0 ? day.items[fromPosition + 1] : undefined;
    if (!b || b.kind !== SONG || !b.assetId || b.segmentId !== null) {
      issues.push({
        code: 'no_song_after',
        at: p.at,
        poolId: p.poolId,
        clockId: p.clockId,
        slotIndex: p.slotIndex,
      });
      continue;
    }
    const a = day.items[fromPosition] as GeneratedItem;
    placed.push({
      ...p,
      fromPosition,
      toPosition: fromPosition + 1,
      plannedAt: new Date(a.plannedStart.getTime() + a.plannedDurationMs),
    });
  }
  return { placed, issues };
}
