import { z } from 'zod';
import { assetTypeSchema, tagKeySchema, tagValueSchema } from './library.ts';
import { uuidSchema } from './tenancy.ts';

// Music rotation contracts: categories (#37). Mirrors packages/db/src/schema/rotation.ts.
// Rules (#38) and the new-music lifecycle (#41) add their settings next to these, as new
// optional fields or new condition kinds; they don't reshape the existing ones. Clocks (#39)
// reference a category by id.

// --- Smart rule ----------------------------------------------------------------------------

/**
 * One test on an asset. Tag values compare case-insensitively, like the tag vocabulary.
 *
 * - `tag`: `any` = carries at least one of `values` for `key`; `all` = carries every one;
 *   `none` = carries none of them.
 * - `tag_number`: some value of `key`, read as a number, compares to `value`
 *   (`energy >= 3`). Non-numeric values never match.
 * - `year`: the asset's release year compares to `value`. Assets without a year never match.
 * - `explicit`: the asset's explicit flag equals `value`.
 *
 * New kinds are added to this union; a stored rule stays valid.
 */
export const comparisonOpSchema = z.enum(['eq', 'gte', 'gt', 'lte', 'lt']);
export type ComparisonOp = z.infer<typeof comparisonOpSchema>;

export const tagConditionSchema = z.object({
  kind: z.literal('tag'),
  key: tagKeySchema,
  op: z.enum(['any', 'all', 'none']),
  values: z.array(tagValueSchema).min(1).max(50),
});
export const tagNumberConditionSchema = z.object({
  kind: z.literal('tag_number'),
  key: tagKeySchema,
  op: comparisonOpSchema,
  value: z.number().finite(),
});
export const yearConditionSchema = z.object({
  kind: z.literal('year'),
  op: comparisonOpSchema,
  value: z.int().min(1000).max(9999),
});
export const explicitConditionSchema = z.object({
  kind: z.literal('explicit'),
  value: z.boolean(),
});

export const ruleConditionSchema = z.discriminatedUnion('kind', [
  tagConditionSchema,
  tagNumberConditionSchema,
  yearConditionSchema,
  explicitConditionSchema,
]);
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/** Groups nest this deep at most (the root group is level 1). */
export const RULE_MAX_DEPTH = 3;

export interface RuleGroup {
  kind: 'group';
  /** `all`: every child matches (AND). `any`: at least one does (OR). */
  match: 'all' | 'any';
  children: (RuleCondition | RuleGroup)[];
}

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    match: z.enum(['all', 'any']),
    children: z
      .array(z.union([ruleConditionSchema, ruleGroupSchema]))
      .min(1)
      .max(50),
  }),
);

function groupDepth(group: RuleGroup): number {
  let deepest = 0;
  for (const child of group.children) {
    if (child.kind === 'group') deepest = Math.max(deepest, groupDepth(child));
  }
  return deepest + 1;
}

/** A smart rule: a boolean tree of conditions, at most `RULE_MAX_DEPTH` groups deep. */
export const categoryRuleSchema = ruleGroupSchema.refine(
  (group) => groupDepth(group) <= RULE_MAX_DEPTH,
  `rule groups nest at most ${RULE_MAX_DEPTH} deep`,
);
export type CategoryRule = RuleGroup;

// --- Category ------------------------------------------------------------------------------

/**
 * How the scheduler walks the category when it fills a slot:
 * - `least_recently_played`: the member idle the longest comes first.
 * - `weighted_random`: a random pick, weighted by the time since each member last played.
 * - `sequential`: the members in a fixed order, round-robin.
 */
export const rotationOrderSchema = z.enum([
  'least_recently_played',
  'weighted_random',
  'sequential',
]);
export type RotationOrder = z.infer<typeof rotationOrderSchema>;

/**
 * Manual membership. `include` adds the asset whatever the rule says; `exclude` keeps it out
 * even when the rule matches.
 */
export const memberModeSchema = z.enum(['include', 'exclude']);
export type MemberMode = z.infer<typeof memberModeSchema>;

export const categoryMemberSchema = z.object({
  assetId: uuidSchema,
  mode: memberModeSchema,
});
export type CategoryMember = z.infer<typeof categoryMemberSchema>;

const nameSchema = z.string().trim().min(1).max(100);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'color like #a1b2c3');

export const categorySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  stationId: uuidSchema,
  /** Unique in the station, case-insensitively. */
  name: z.string(),
  description: z.string().nullable(),
  /** Shown on clocks and the log. */
  color: z.string().nullable(),
  /** Only assets of this type are members (songs for music, jingles for an imaging rotation…). */
  assetType: assetTypeSchema,
  /** Smart membership. `null`: manual members only. */
  rule: categoryRuleSchema.nullable(),
  rotationOrder: rotationOrderSchema,
  /** Share of the ordered members the scheduler looks at, 1–100 %. */
  searchDepthPercent: z.int(),
  /** Minimum time between two plays of the same song from this category. */
  restMinutes: z.int(),
  /** `null`: no cap. */
  maxPlaysPerDay: z.int().nullable(),
  maxPlaysPerWeek: z.int().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Category = z.infer<typeof categorySchema>;

const categoryFields = {
  name: nameSchema,
  description: z.string().trim().max(2000).nullable(),
  color: colorSchema.nullable(),
  assetType: assetTypeSchema,
  rule: categoryRuleSchema.nullable(),
  rotationOrder: rotationOrderSchema,
  searchDepthPercent: z.int().min(1).max(100),
  restMinutes: z
    .int()
    .min(0)
    .max(60 * 24 * 365),
  maxPlaysPerDay: z.int().min(1).max(1000).nullable(),
  maxPlaysPerWeek: z.int().min(1).max(7000).nullable(),
  /** Replaces the manual include/exclude list. One entry per asset. */
  members: z
    .array(categoryMemberSchema)
    .max(10_000)
    .refine(
      (members) => new Set(members.map((m) => m.assetId)).size === members.length,
      'an asset is listed once',
    ),
};

export const CATEGORY_DEFAULTS = {
  assetType: 'song',
  rotationOrder: 'least_recently_played',
  searchDepthPercent: 100,
  restMinutes: 180,
} as const satisfies Partial<Category>;

export const createCategorySchema = z.object({
  ...categoryFields,
  description: categoryFields.description.optional(),
  color: categoryFields.color.optional(),
  assetType: categoryFields.assetType.optional(),
  rule: categoryFields.rule.optional(),
  rotationOrder: categoryFields.rotationOrder.optional(),
  searchDepthPercent: categoryFields.searchDepthPercent.optional(),
  restMinutes: categoryFields.restMinutes.optional(),
  maxPlaysPerDay: categoryFields.maxPlaysPerDay.optional(),
  maxPlaysPerWeek: categoryFields.maxPlaysPerWeek.optional(),
  members: categoryFields.members.optional(),
});
export type CreateCategory = z.input<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object(categoryFields)
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), 'empty update');
export type UpdateCategory = z.input<typeof updateCategorySchema>;

// --- Membership and preview ------------------------------------------------------------------

/** Why an asset is a member: the rule, a manual include, or both. */
export const membershipSourceSchema = z.enum(['rule', 'manual', 'both']);
export type MembershipSource = z.infer<typeof membershipSourceSchema>;

export const categoryCountsSchema = z.object({
  /** Members: rule matches and manual includes, minus excludes. */
  members: z.int(),
  /** Members the scheduler may pick now (inside their start/kill window). */
  schedulable: z.int(),
  /** Assets the rule matches, before excludes. */
  ruleMatches: z.int(),
  /** Manual includes that the rule doesn't match. */
  manualOnly: z.int(),
  /** Rule matches kept out by a manual exclude. */
  excluded: z.int(),
  /** Total length of the members with a known duration. */
  totalDurationMs: z.int(),
});
export type CategoryCounts = z.infer<typeof categoryCountsSchema>;

export const categoryListItemSchema = categorySchema.extend({ counts: categoryCountsSchema });
export type CategoryListItem = z.infer<typeof categoryListItemSchema>;
export const categoryListSchema = z.object({ items: z.array(categoryListItemSchema) });
export type CategoryList = z.infer<typeof categoryListSchema>;

export const categoryDetailSchema = categorySchema.extend({
  members: z.array(categoryMemberSchema),
  counts: categoryCountsSchema,
});
export type CategoryDetail = z.infer<typeof categoryDetailSchema>;

export const previewMemberSchema = z.object({
  assetId: uuidSchema,
  title: z.string(),
  artists: z.array(z.string()),
  year: z.int().nullable(),
  durationMs: z.int().nullable(),
  source: membershipSourceSchema,
  schedulable: z.boolean(),
});
export type PreviewMember = z.infer<typeof previewMemberSchema>;

/**
 * What a manual entry does, given the rule:
 * - `added`: an include the rule doesn't match (a manual-only member).
 * - `redundant`: an include the rule matches anyway, or an exclude it doesn't match.
 * - `excluded`: an exclude that keeps a rule match out.
 * - `wrong_type`: an asset of another type than the category's (never a member).
 */
export const manualEffectSchema = z.enum(['added', 'redundant', 'excluded', 'wrong_type']);
export type ManualEffect = z.infer<typeof manualEffectSchema>;

export const previewManualSchema = z.object({
  assetId: uuidSchema,
  title: z.string(),
  artists: z.array(z.string()),
  mode: memberModeSchema,
  effect: manualEffectSchema,
});
export type PreviewManual = z.infer<typeof previewManualSchema>;

export const categoryPreviewSchema = z.object({
  counts: categoryCountsSchema,
  /** "Each song plays every ~X days", from `playsPerDay`; `null` without it or without members. */
  turnoverDays: z.number().nullable(),
  /** Members, by artist then title, from `offset`. */
  items: z.array(previewMemberSchema),
  /** Every manual entry, by artist then title, with its effect (not paged). */
  manual: z.array(previewManualSchema),
});
export type CategoryPreview = z.infer<typeof categoryPreviewSchema>;

const previewPaging = {
  /** Expected plays of the category per day, for the turnover projection (clocks, #39). */
  playsPerDay: z.coerce.number().positive().max(10_000).optional(),
  limit: z.coerce.number().int().min(0).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/** `GET …/categories/:id/preview` query string. */
export const categoryPreviewQuerySchema = z.object(previewPaging);
export type CategoryPreviewQuery = z.input<typeof categoryPreviewQuerySchema>;

/** `POST …/categories/preview`: a draft category, saved or not (the editor's live preview). */
export const draftPreviewSchema = z.object({
  assetType: categoryFields.assetType.default(CATEGORY_DEFAULTS.assetType),
  rule: categoryFields.rule.default(null),
  members: categoryFields.members.default([]),
  ...previewPaging,
});
export type DraftPreview = z.input<typeof draftPreviewSchema>;
