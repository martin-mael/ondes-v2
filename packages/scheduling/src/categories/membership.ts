import type {
  AssetType,
  CategoryCounts,
  CategoryMember,
  CategoryRule,
  ComparisonOp,
  ManualEffect,
  MemberMode,
  MembershipSource,
  RuleCondition,
  RuleGroup,
  TagKey,
} from '@ondes/shared';
import { TAG_NUMBER_PATTERN } from '@ondes/shared';

// Category membership (#37): which assets of a library snapshot belong to a category. Pure:
// the caller loads the candidates (the api, the log generator) and gets members back, so
// membership follows tag edits without any stored list to refresh.

/** What membership looks at, per asset. */
export interface CategoryCandidate {
  id: string;
  type: AssetType;
  year: number | null;
  explicit: boolean;
  durationMs: number | null;
  /** Not schedulable before this instant. */
  startAt: Date | null;
  /** Not schedulable from this instant on. */
  killAt: Date | null;
  /** When the asset entered the library (new-music lifecycle, #41). */
  addedAt: Date;
  tags: readonly { key: TagKey; value: string }[];
}

/** The parts of a category membership depends on. */
export interface CategoryMembershipInput {
  assetType: AssetType;
  rule: CategoryRule | null;
  members: readonly CategoryMember[];
}

export interface ResolvedMember<C extends CategoryCandidate = CategoryCandidate> {
  asset: C;
  source: MembershipSource;
  schedulable: boolean;
}

export interface ManualEntry<C extends CategoryCandidate = CategoryCandidate> {
  asset: C;
  mode: MemberMode;
  effect: ManualEffect;
}

export interface CategoryMembership<C extends CategoryCandidate = CategoryCandidate> {
  /** In candidate order. */
  members: ResolvedMember<C>[];
  /** Manual entries found among the candidates, in candidate order. */
  manual: ManualEntry<C>[];
  counts: CategoryCounts;
}

/** Tags of one asset, keyed and lower-cased, for repeated rule checks. */
type TagIndex = Map<TagKey, Set<string>>;

function indexTags(tags: CategoryCandidate['tags']): TagIndex {
  const index: TagIndex = new Map();
  for (const tag of tags) {
    let values = index.get(tag.key);
    if (!values) {
      values = new Set();
      index.set(tag.key, values);
    }
    values.add(tag.value.trim().toLowerCase());
  }
  return index;
}

const tagNumber = new RegExp(TAG_NUMBER_PATTERN);

/** A tag value as `tag_number` reads it, or `null`. */
export function parseTagNumber(value: string): number | null {
  const trimmed = value.trim();
  return tagNumber.test(trimmed) ? Number(trimmed) : null;
}

function unreachable(value: never): never {
  throw new Error(`unknown rule node ${JSON.stringify(value)}`);
}

function compare(left: number, op: ComparisonOp, right: number): boolean {
  switch (op) {
    case 'eq':
      return left === right;
    case 'gte':
      return left >= right;
    case 'gt':
      return left > right;
    case 'lte':
      return left <= right;
    case 'lt':
      return left < right;
    default:
      return unreachable(op);
  }
}

function matchesCondition(
  condition: RuleCondition,
  asset: CategoryCandidate,
  tags: TagIndex,
): boolean {
  switch (condition.kind) {
    case 'tag': {
      const held = tags.get(condition.key);
      const wanted = condition.values.map((v) => v.trim().toLowerCase());
      if (condition.op === 'none') return !held || wanted.every((v) => !held.has(v));
      if (!held) return false;
      return condition.op === 'all'
        ? wanted.every((v) => held.has(v))
        : wanted.some((v) => held.has(v));
    }
    case 'tag_number': {
      const held = tags.get(condition.key);
      if (!held) return false;
      for (const value of held) {
        const n = parseTagNumber(value);
        if (n !== null && compare(n, condition.op, condition.value)) return true;
      }
      return false;
    }
    case 'year':
      return asset.year !== null && compare(asset.year, condition.op, condition.value);
    case 'explicit':
      return asset.explicit === condition.value;
    default:
      return unreachable(condition);
  }
}

function matchesGroup(group: RuleGroup, asset: CategoryCandidate, tags: TagIndex): boolean {
  const test = (child: RuleCondition | RuleGroup) =>
    child.kind === 'group'
      ? matchesGroup(child, asset, tags)
      : matchesCondition(child, asset, tags);
  switch (group.match) {
    case 'all':
      return group.children.every(test);
    case 'any':
      return group.children.some(test);
    default:
      return unreachable(group.match);
  }
}

/** Whether `asset` satisfies `rule` (type is not checked here: see `resolveCategory`). */
export function matchesRule(rule: CategoryRule, asset: CategoryCandidate): boolean {
  return matchesGroup(rule, asset, indexTags(asset.tags));
}

/** Inside the asset's start/kill window at `at`. */
export function isSchedulable(asset: CategoryCandidate, at: Date): boolean {
  if (asset.startAt && asset.startAt > at) return false;
  if (asset.killAt && asset.killAt <= at) return false;
  return true;
}

/**
 * Members of a category among `candidates` at instant `at`: assets of the category's type that
 * the rule matches or that are included by hand, minus the manual excludes. Manual entries for
 * assets missing from `candidates` (deleted since) are ignored silently. `at` only decides
 * which members are schedulable.
 */
export function resolveCategory<C extends CategoryCandidate>(
  category: CategoryMembershipInput,
  candidates: readonly C[],
  at: Date,
): CategoryMembership<C> {
  const manual = new Map(category.members.map((m) => [m.assetId, m.mode]));
  const members: ResolvedMember<C>[] = [];
  const entries: ManualEntry<C>[] = [];
  const counts: CategoryCounts = {
    members: 0,
    schedulable: 0,
    ruleMatches: 0,
    manualOnly: 0,
    excluded: 0,
    totalDurationMs: 0,
  };

  for (const asset of candidates) {
    const mode = manual.get(asset.id);
    const note = (effect: ManualEffect) => {
      if (mode) entries.push({ asset, mode, effect });
    };
    if (asset.type !== category.assetType) {
      note('wrong_type');
      continue;
    }
    const byRule = category.rule !== null && matchesRule(category.rule, asset);
    if (byRule) counts.ruleMatches++;
    if (mode === 'exclude') {
      if (byRule) counts.excluded++;
      note(byRule ? 'excluded' : 'redundant');
      continue;
    }
    const byHand = mode === 'include';
    if (byHand) note(byRule ? 'redundant' : 'added');
    if (!byRule && !byHand) continue;

    const schedulable = isSchedulable(asset, at);
    members.push({
      asset,
      source: byRule && byHand ? 'both' : byRule ? 'rule' : 'manual',
      schedulable,
    });
    counts.members++;
    if (schedulable) counts.schedulable++;
    if (!byRule) counts.manualOnly++;
    counts.totalDurationMs += asset.durationMs ?? 0;
  }

  return { members, manual: entries, counts };
}

/**
 * Projected turnover: with `playsPerDay` plays of the category spread over `songs` songs,
 * each one comes back about every N days. `null` when either is zero.
 */
export function projectTurnoverDays(songs: number, playsPerDay: number | undefined): number | null {
  if (!playsPerDay || playsPerDay <= 0 || songs <= 0) return null;
  return songs / playsPerDay;
}
