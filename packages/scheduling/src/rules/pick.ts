import type {
  Category,
  PickUnfilled,
  RelaxedRule,
  RotationRule,
  RuleViolation,
} from '@ondes/shared';
import {
  addDays,
  localDayBounds,
  weekStart,
  zonedFields,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { type CategoryCandidate, isSchedulable } from '../categories/index.ts';
import {
  artistKeys,
  hasTag,
  nearest,
  normalizeName,
  normalizeTitle,
  type PlayedItem,
  SlotHistory,
} from './history.ts';
import { randomFor } from './random.ts';

// The rules picker (#38, ADR 0016): which member of a category fills a slot. Pure: the caller
// loads the members, the history and the rules; the same snapshot and seed always give the same
// pick. Steps:
// 1. order the schedulable members by the category's rotation order;
// 2. check every candidate against every enabled rule (the verdicts are the explanation);
// 3. take the candidates that break no active rule; if there are none, relax the active
//    breakable rule with the highest priority number, and try again (the relaxation ladder);
// 4. among the eligible, take the first in rotation order (`weighted_random`: a seeded draw
//    weighted by idle time), preferring those that meet the soft `flow` goal.

/** A category member as the picker sees it. */
export interface PickCandidate extends CategoryCandidate {
  title: string;
  artists: readonly string[];
  album: string | null;
  bpm?: number | null;
  energy?: number | null;
}

/** The category settings the picker uses (a `Category` satisfies it). */
export type PickCategory = Pick<
  Category,
  | 'id'
  | 'assetType'
  | 'rotationOrder'
  | 'searchDepthPercent'
  | 'restMinutes'
  | 'maxPlaysPerDay'
  | 'maxPlaysPerWeek'
>;

export interface PickSnapshot {
  /** The station's IANA timezone: days, weeks and clock hours are station-local. */
  timeZone: string;
  rules: readonly RotationRule[];
  /** As-run entries and planned log items, any order, any type. */
  history: readonly PlayedItem[];
  /** Last airing per asset older than `history` (song rest, rotation order). */
  lastPlayedAt?: ReadonlyMap<string, Date>;
  seed?: string;
}

export interface PickSlot<C extends PickCandidate = PickCandidate> {
  at: Date;
  category: PickCategory;
  /** The category's members (`resolveCategory`); those not schedulable at `at` are skipped. */
  candidates: readonly C[];
}

/** Why a slot stays empty: no schedulable member, or every one breaks an unbreakable rule. */
export type UnfilledSlot = PickUnfilled;

export interface CandidateVerdict<C extends PickCandidate = PickCandidate> {
  asset: C;
  /** Position in the rotation order (0 first). */
  position: number;
  lastPlayedAt: Date | null;
  violations: RuleViolation[];
  notes: RuleViolation[];
  picked: boolean;
}

export interface PickResult<C extends PickCandidate = PickCandidate> {
  /** `null`: the slot stays empty, and `unfilled` says why. */
  asset: C | null;
  /**
   * The rules the ladder dropped that the pick breaks, in ladder order, ready for
   * `log_item.relaxed_rules`. Empty when nothing was picked.
   */
  relaxed: RelaxedRule[];
  /** Set when `asset` is null. */
  unfilled: UnfilledSlot | null;
  /** Every schedulable member in rotation order, with its verdict. */
  ranked: CandidateVerdict<C>[];
}

const MINUTE = 60_000;

/** The rules that can reject a candidate, in the order the ladder relaxes them. */
export function relaxationOrder(rules: readonly RotationRule[]): RotationRule[] {
  return rules
    .filter((r) => r.enabled && r.kind !== 'flow' && r.breakable)
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function violation(
  rule: RotationRule,
  detail: string,
  values: RuleViolation['values'],
): RuleViolation {
  return { ruleId: rule.id, kind: rule.kind, detail, values };
}

/** Per-slot facts shared by every candidate. */
interface SlotContext {
  at: Date;
  timeZone: string;
  category: PickCategory;
  history: SlotHistory;
  lastPlayedAt: (assetId: string) => Date | null;
  depth: number;
  day: { startsAt: Date; endsAt: Date };
  week: { startsAt: Date; endsAt: Date };
  previous: PlayedItem | undefined;
  /** Per-slot values computed once per rule (tag counts per hour). */
  cache: Map<string, number>;
  /** Per-slot time windows computed once per rule (Intl is slow). */
  windows: Map<string, { startsAt: Date; endsAt: Date }>;
}

function sameHourYesterday(at: Date, timeZone: string, windowMinutes: number) {
  const { date, time } = zonedParts(at, timeZone);
  const [h, m] = time.split(':').map(Number) as [number, number];
  const startMin = Math.floor((h * 60 + m) / windowMinutes) * windowMinutes;
  const endMin = startMin + windowMinutes;
  const yesterday = addDays(date, -1);
  const hhmm = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const startsAt = zonedInstant(yesterday, hhmm(startMin), timeZone);
  // A window that starts in yesterday's spring-forward gap never happened: it is empty.
  // (Windows are aligned on 15 min, so one that starts in the gap lies inside it.)
  const real = zonedParts(startsAt, timeZone);
  if (real.date !== yesterday || real.time !== hhmm(startMin)) {
    return { startsAt, endsAt: startsAt };
  }
  return {
    startsAt,
    endsAt:
      endMin >= 24 * 60
        ? zonedInstant(date, '00:00', timeZone)
        : zonedInstant(yesterday, hhmm(endMin), timeZone),
  };
}

/** The station-local clock hour around `at`. */
function clockHour(at: Date, timeZone: string) {
  const f = zonedFields(at, timeZone);
  const startsAt = new Date(
    at.getTime() - (f.minute * 60 + f.second) * 1000 - (at.getTime() % 1000),
  );
  return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MINUTE) };
}

function countIn(times: Iterable<Date>, range: { startsAt: Date; endsAt: Date }): number {
  let n = 0;
  for (const t of times) if (t >= range.startsAt && t < range.endsAt) n++;
  return n;
}

function separationCheck(
  rule: Extract<RotationRule, { unit: 'minutes' | 'items' }>,
  clash: { minutes: number; items: number } | null,
  what: string,
): RuleViolation | null {
  if (!clash) return null;
  if (rule.unit === 'minutes' && clash.minutes < rule.value) {
    const minutes = Math.floor(clash.minutes);
    return violation(rule, `same ${what} ${minutes} min away (needs ${rule.value})`, {
      minutes,
      limit: rule.value,
    });
  }
  if (rule.unit === 'items' && clash.items < rule.value) {
    return violation(rule, `same ${what} ${clash.items} items away (needs ${rule.value})`, {
      items: clash.items,
      limit: rule.value,
    });
  }
  return null;
}

function check(
  rule: RotationRule,
  asset: PickCandidate,
  position: number,
  ctx: SlotContext,
): RuleViolation | null {
  const { history, at } = ctx;
  switch (rule.kind) {
    case 'song_rest': {
      const rest = ctx.category.restMinutes;
      if (rest <= 0) return null;
      const clash = nearest(history, history.positions('asset', asset.id), at);
      let minutes = clash?.minutes ?? Number.POSITIVE_INFINITY;
      const last = ctx.lastPlayedAt(asset.id);
      if (last) minutes = Math.min(minutes, (at.getTime() - last.getTime()) / MINUTE);
      if (minutes >= rest) return null;
      const m = Math.floor(minutes);
      return violation(rule, `played ${m} min away (rest ${rest})`, { minutes: m, limit: rest });
    }
    case 'max_plays': {
      const times = history.positions('asset', asset.id).map((p) => history.items[p]?.at as Date);
      const { maxPlaysPerDay: day, maxPlaysPerWeek: week } = ctx.category;
      if (day !== null) {
        const plays = countIn(times, ctx.day);
        if (plays >= day) {
          return violation(rule, `${plays} plays today (max ${day})`, {
            plays,
            limit: day,
            window: 'day',
          });
        }
      }
      if (week !== null) {
        const plays = countIn(times, ctx.week);
        if (plays >= week) {
          return violation(rule, `${plays} plays this week (max ${week})`, {
            plays,
            limit: week,
            window: 'week',
          });
        }
      }
      return null;
    }
    case 'search_depth':
      return position < ctx.depth
        ? null
        : violation(rule, `position ${position + 1} is past the search depth (${ctx.depth})`, {
            position: position + 1,
            limit: ctx.depth,
          });
    case 'artist_separation': {
      const kind = rule.includeFeatured ? 'artist' : 'primaryArtist';
      let minutes = Number.POSITIVE_INFINITY;
      let items = Number.POSITIVE_INFINITY;
      for (const key of artistKeys(asset.artists, rule.includeFeatured)) {
        const clash = nearest(history, history.positions(kind, key), at);
        if (!clash) continue;
        minutes = Math.min(minutes, clash.minutes);
        items = Math.min(items, clash.items);
      }
      const worst = Number.isFinite(minutes) ? { minutes, items } : null;
      return separationCheck(rule, worst, 'artist');
    }
    case 'title_separation':
      return separationCheck(
        rule,
        nearest(history, history.positions('title', normalizeTitle(asset.title)), at),
        'title',
      );
    case 'album_separation':
      if (!asset.album?.trim()) return null;
      return separationCheck(
        rule,
        nearest(history, history.positions('album', normalizeName(asset.album)), at),
        'album',
      );
    case 'same_hour_yesterday': {
      let window = ctx.windows.get(rule.id);
      if (!window) {
        window = sameHourYesterday(at, ctx.timeZone, rule.windowMinutes);
        ctx.windows.set(rule.id, window);
      }
      const times = history.positions('asset', asset.id).map((p) => history.items[p]?.at as Date);
      return countIn(times, window) > 0
        ? violation(rule, `played in the same ${rule.windowMinutes} min window yesterday`, {
            window: rule.windowMinutes,
          })
        : null;
    }
    case 'tag_run': {
      if (!hasTag(asset.tags, rule.tag)) return null;
      const before = history.preceding(rule.maxRun);
      if (before.length < rule.maxRun || !before.every((i) => hasTag(i.tags, rule.tag))) {
        return null;
      }
      return violation(
        rule,
        `would make ${rule.maxRun + 1} ${rule.tag.key}=${rule.tag.value} in a row (max ${rule.maxRun})`,
        { run: rule.maxRun + 1, limit: rule.maxRun, tag: `${rule.tag.key}=${rule.tag.value}` },
      );
    }
    case 'segue_ban':
      if (!ctx.previous || !hasTag(ctx.previous.tags, rule.from) || !hasTag(asset.tags, rule.to)) {
        return null;
      }
      return violation(
        rule,
        `${rule.to.key}=${rule.to.value} right after ${rule.from.key}=${rule.from.value}`,
        { from: `${rule.from.key}=${rule.from.value}`, to: `${rule.to.key}=${rule.to.value}` },
      );
    case 'max_tag_per_hour': {
      if (!hasTag(asset.tags, rule.tag)) return null;
      let plays = ctx.cache.get(rule.id);
      if (plays === undefined) {
        const hour = clockHour(at, ctx.timeZone);
        plays = countIn(
          history.items.filter((i) => hasTag(i.tags, rule.tag)).map((i) => i.at),
          hour,
        );
        ctx.cache.set(rule.id, plays);
      }
      return plays >= rule.max
        ? violation(
            rule,
            `${plays} ${rule.tag.key}=${rule.tag.value} already this hour (max ${rule.max})`,
            { plays, limit: rule.max, tag: `${rule.tag.key}=${rule.tag.value}` },
          )
        : null;
    }
    case 'flow': {
      const prev = ctx.previous;
      if (!prev) return null;
      if (rule.maxBpmStep !== null && prev.bpm != null && asset.bpm != null) {
        const step = Math.abs(asset.bpm - prev.bpm);
        if (step > rule.maxBpmStep) {
          return violation(rule, `BPM step ${Math.round(step)} (goal ≤ ${rule.maxBpmStep})`, {
            step: Math.round(step),
            limit: rule.maxBpmStep,
            measure: 'bpm',
          });
        }
      }
      if (rule.maxEnergyStep !== null && prev.energy != null && asset.energy != null) {
        const step = Math.abs(asset.energy - prev.energy);
        if (step > rule.maxEnergyStep) {
          return violation(rule, `energy step ${step.toFixed(2)} (goal ≤ ${rule.maxEnergyStep})`, {
            step: Math.round(step * 100) / 100,
            limit: rule.maxEnergyStep,
            measure: 'energy',
          });
        }
      }
      return null;
    }
  }
}

function idOrder(a: PickCandidate, b: PickCandidate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Members in rotation order, with their last play before the slot. */
function rotationOrder<C extends PickCandidate>(
  members: readonly C[],
  category: PickCategory,
  lastPlayedAt: (id: string) => Date | null,
): C[] {
  if (category.rotationOrder === 'sequential') {
    // Round-robin in candidate order, starting after the member that played last.
    let lastIndex = -1;
    let lastTime = Number.NEGATIVE_INFINITY;
    members.forEach((m, i) => {
      const t = lastPlayedAt(m.id)?.getTime();
      if (t !== undefined && t > lastTime) {
        lastTime = t;
        lastIndex = i;
      }
    });
    return [...members.slice(lastIndex + 1), ...members.slice(0, lastIndex + 1)];
  }
  // Least recently played first, never played before anything; ties by id.
  return [...members].sort((a, b) => {
    const ta = lastPlayedAt(a.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const tb = lastPlayedAt(b.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return ta === tb ? idOrder(a, b) : ta - tb;
  });
}

/** Idle time used as the `weighted_random` weight: never played counts as a week. */
const MAX_WEIGHT_MINUTES = 7 * 24 * 60;

function choose<C extends PickCandidate>(
  eligible: CandidateVerdict<C>[],
  slot: PickSlot<C>,
  seed: string,
): CandidateVerdict<C> | undefined {
  // The soft goal only reorders: those meeting it go first.
  const meeting = eligible.filter((v) => v.notes.length === 0);
  const pool = meeting.length > 0 ? meeting : eligible;
  if (slot.category.rotationOrder !== 'weighted_random') return pool[0];
  const weights = pool.map((v) =>
    v.lastPlayedAt
      ? Math.min(
          MAX_WEIGHT_MINUTES,
          Math.max(1, (slot.at.getTime() - v.lastPlayedAt.getTime()) / MINUTE),
        )
      : MAX_WEIGHT_MINUTES,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let draw = randomFor(seed, `${slot.category.id}@${slot.at.toISOString()}`) * total;
  for (let i = 0; i < pool.length; i++) {
    draw -= weights[i] as number;
    if (draw < 0) return pool[i];
  }
  return pool.at(-1);
}

/** Last play strictly before the slot: the history's, else the snapshot's older record. */
function lastPlayedLookup(snapshot: PickSnapshot, history: SlotHistory, at: Date) {
  const fromHistory = new Map<string, Date>();
  for (const item of history.preceding(history.insertAt)) {
    if (item.assetId) fromHistory.set(item.assetId, item.at);
  }
  return (id: string): Date | null => {
    const recent = fromHistory.get(id);
    if (recent) return recent;
    const older = snapshot.lastPlayedAt?.get(id);
    return older && older < at ? older : null;
  };
}

/** Fill one slot: the best candidate, the rules relaxed to get it, and every verdict. */
export function pickForSlot<C extends PickCandidate>(
  snapshot: PickSnapshot,
  slot: PickSlot<C>,
): PickResult<C> {
  const { category, at } = slot;
  const history = new SlotHistory(snapshot.history, category.assetType, at);
  const lastPlayedAt = lastPlayedLookup(snapshot, history, at);
  const members = slot.candidates.filter(
    (c) => c.type === category.assetType && isSchedulable(c, at),
  );
  const ordered = rotationOrder(members, category, lastPlayedAt);
  const localDate = zonedParts(at, snapshot.timeZone).date;
  const monday = weekStart(localDate);
  const ctx: SlotContext = {
    at,
    timeZone: snapshot.timeZone,
    category,
    history,
    lastPlayedAt,
    depth: Math.max(1, Math.ceil((ordered.length * category.searchDepthPercent) / 100)),
    day: localDayBounds(localDate, snapshot.timeZone),
    week: {
      startsAt: localDayBounds(monday, snapshot.timeZone).startsAt,
      endsAt: localDayBounds(addDays(monday, 7), snapshot.timeZone).startsAt,
    },
    previous: history.preceding(1)[0],
    cache: new Map(),
    windows: new Map(),
  };

  const enabled = snapshot.rules.filter((r) => r.enabled);
  const ranked: CandidateVerdict<C>[] = ordered.map((asset, position) => {
    const violations: RuleViolation[] = [];
    const notes: RuleViolation[] = [];
    for (const rule of enabled) {
      const v = check(rule, asset, position, ctx);
      if (v) (rule.kind === 'flow' ? notes : violations).push(v);
    }
    return {
      asset,
      position,
      lastPlayedAt: lastPlayedAt(asset.id),
      violations,
      notes,
      picked: false,
    };
  });

  const ladder = relaxationOrder(enabled);
  const relaxedIds = new Set<string>();
  const relaxed: RelaxedRule[] = [];
  const seed = snapshot.seed ?? 'ondes';
  for (let step = 0; step <= ladder.length; step++) {
    if (step > 0) {
      const rule = ladder[step - 1] as RotationRule;
      relaxedIds.add(rule.id);
      const blocked = ranked.filter((v) => v.violations.some((x) => x.ruleId === rule.id)).length;
      relaxed.push({
        rule: rule.kind,
        reason: `${rule.id}: blocked ${blocked} of ${ranked.length} candidates; relaxed (priority ${rule.priority})`,
      });
    }
    const eligible = ranked.filter((v) => v.violations.every((x) => relaxedIds.has(x.ruleId)));
    if (eligible.length === 0) continue;
    const pick = choose(eligible, slot, seed);
    if (!pick) break;
    pick.picked = true;
    // Only the rules the pick actually breaks count as relaxed for it.
    const broken = new Set(pick.violations.map((v) => v.ruleId));
    return {
      asset: pick.asset,
      relaxed: relaxed.filter((_, i) => broken.has((ladder[i] as RotationRule).id)),
      unfilled: null,
      ranked,
    };
  }
  // Nothing relaxed counts: no item carries it. Say which unbreakable rules held.
  const blockedBy = enabled
    .filter((r) => !r.breakable && r.kind !== 'flow')
    .map((r) => ({
      ruleId: r.id,
      kind: r.kind,
      candidates: ranked.filter((v) => v.violations.some((x) => x.ruleId === r.id)).length,
    }))
    .filter((b) => b.candidates > 0);
  return {
    asset: null,
    relaxed: [],
    unfilled: { reason: ranked.length === 0 ? 'no_candidates' : 'unbreakable_rules', blockedBy },
    ranked,
  };
}

/**
 * Fill slots in order (a clock preview, a log hour): each pick joins the history before the
 * next slot is filled, so the rules see the earlier picks.
 */
export function pickSequence<C extends PickCandidate>(
  snapshot: PickSnapshot,
  slots: readonly PickSlot<C>[],
): PickResult<C>[] {
  const history = [...snapshot.history];
  return slots.map((slot) => {
    const result = pickForSlot({ ...snapshot, history }, slot);
    if (result.asset) history.push(playedFrom(result.asset, slot.at));
    return result;
  });
}

/** A picked candidate as a history item. */
export function playedFrom(asset: PickCandidate, at: Date): PlayedItem {
  return {
    assetId: asset.id,
    type: asset.type,
    title: asset.title,
    artists: asset.artists,
    album: asset.album,
    tags: asset.tags,
    bpm: asset.bpm ?? null,
    energy: asset.energy ?? null,
    at,
  };
}
