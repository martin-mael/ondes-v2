import { z } from 'zod';
import { tagKeySchema, tagValueSchema } from './library.ts';
import { relaxedRuleSchema } from './log.ts';
import { uuidSchema } from './tenancy.ts';

// Separation and rotation rules (#38, ADR 0016). A station keeps one ordered rule set; the
// picker (@ondes/scheduling `pickForSlot`) applies it to every pick. Each rule has an id, an
// enabled flag and a priority; when no candidate satisfies them all, the picker drops the
// lowest-priority breakable rule, then the next, and records each one it dropped (the
// relaxation ladder). Mirrors packages/db/src/schema/rotation.ts (`rotation_rules`).

const ruleId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'letters, digits, - and _');

const ruleBase = {
  id: ruleId,
  enabled: z.boolean(),
  /** 1 is the most important. The ladder relaxes the highest numbers first. */
  priority: z.int().min(1).max(1000),
  /** `false`: never relaxed. A slot no candidate can fill under it stays empty. */
  breakable: z.boolean(),
};

/** Separation measured in minutes on either side of the slot, or in items before it. */
export const separationUnitSchema = z.enum(['minutes', 'items']);
export type SeparationUnit = z.infer<typeof separationUnitSchema>;

const separation = {
  unit: separationUnitSchema,
  /** Minutes or items, up to 10 080 (a week in minutes). */
  value: z
    .int()
    .min(1)
    .max(60 * 24 * 7),
};

/** A tag an asset carries (case-insensitive value). */
export const tagMatchSchema = z.object({ key: tagKeySchema, value: tagValueSchema });
export type TagMatch = z.infer<typeof tagMatchSchema>;

/**
 * - `song_rest`: a song doesn't come back before its category's `restMinutes`.
 * - `max_plays`: its category's `maxPlaysPerDay` / `maxPlaysPerWeek`, in station-local days and
 *   ISO weeks.
 * - `search_depth`: only the first `searchDepthPercent` of the category's rotation order.
 * - `artist_separation`: no artist twice within `value`. With `includeFeatured`, every credited
 *   artist counts; otherwise only the first (primary) one.
 * - `title_separation`, `album_separation`: the same title (ignoring case and a trailing
 *   bracketed version, "(Radio Edit)") or album within `value`. Missing albums never clash.
 * - `same_hour_yesterday`: not in the same station-local `windowMinutes` window as yesterday.
 * - `tag_run`: never more than `maxRun` items in a row carrying `tag`.
 * - `segue_ban`: an item carrying `to` never directly after one carrying `from`.
 * - `max_tag_per_hour`: at most `max` items carrying `tag` per station-local clock hour.
 * - `flow` (soft): prefer a song whose BPM and energy step from the previous one stays within
 *   the limits. Never rejects a song, so it is never relaxed: it only reorders the eligible ones.
 */
export const rotationRuleSchema = z.discriminatedUnion('kind', [
  z.object({ ...ruleBase, kind: z.literal('song_rest') }),
  z.object({ ...ruleBase, kind: z.literal('max_plays') }),
  z.object({ ...ruleBase, kind: z.literal('search_depth') }),
  z.object({
    ...ruleBase,
    kind: z.literal('artist_separation'),
    ...separation,
    includeFeatured: z.boolean(),
  }),
  z.object({ ...ruleBase, kind: z.literal('title_separation'), ...separation }),
  z.object({ ...ruleBase, kind: z.literal('album_separation'), ...separation }),
  z.object({
    ...ruleBase,
    kind: z.literal('same_hour_yesterday'),
    windowMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  }),
  z.object({
    ...ruleBase,
    kind: z.literal('tag_run'),
    tag: tagMatchSchema,
    maxRun: z.int().min(1).max(20),
  }),
  z.object({
    ...ruleBase,
    kind: z.literal('segue_ban'),
    from: tagMatchSchema,
    to: tagMatchSchema,
  }),
  z.object({
    ...ruleBase,
    kind: z.literal('max_tag_per_hour'),
    tag: tagMatchSchema,
    max: z.int().min(1).max(60),
  }),
  z.object({
    ...ruleBase,
    kind: z.literal('flow'),
    maxBpmStep: z.number().positive().max(200).nullable(),
    /** Energy is 0–1 (analysis). */
    maxEnergyStep: z.number().positive().max(1).nullable(),
  }),
]);
export type RotationRule = z.infer<typeof rotationRuleSchema>;
export type RotationRuleKind = RotationRule['kind'];
export const rotationRuleKinds = rotationRuleSchema.options.map(
  (o) => o.shape.kind.value,
) as RotationRuleKind[];

/** A station's rule set: ids unique, at most 50 rules. */
export const rotationRulesSchema = z
  .array(rotationRuleSchema)
  .max(50)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, 'rule ids are unique');

const base = (id: string, priority: number) => ({ id, enabled: true, priority, breakable: true });

/**
 * A station's rules until it saves its own: the CloudRadio-style ladder, album separation
 * relaxed first, then artist, then the category's search depth, then title, then song rest
 * and play caps last.
 */
export const DEFAULT_ROTATION_RULES: RotationRule[] = [
  { ...base('max-plays', 1), kind: 'max_plays' },
  { ...base('song-rest', 2), kind: 'song_rest' },
  { ...base('title', 3), kind: 'title_separation', unit: 'minutes', value: 180 },
  { ...base('search-depth', 4), kind: 'search_depth' },
  {
    ...base('artist', 5),
    kind: 'artist_separation',
    unit: 'minutes',
    value: 70,
    includeFeatured: true,
  },
  { ...base('album', 6), kind: 'album_separation', unit: 'minutes', value: 120 },
];

export const rotationRulesSettingsSchema = z.object({
  rules: rotationRulesSchema,
  /** `null` while the station uses `DEFAULT_ROTATION_RULES`. */
  updatedAt: z.date().nullable(),
});
export type RotationRulesSettings = z.infer<typeof rotationRulesSettingsSchema>;

/** `PUT …/rotation/rules`. */
export const updateRotationRulesSchema = z.object({ rules: rotationRulesSchema });
export type UpdateRotationRules = z.input<typeof updateRotationRulesSchema>;

// --- Pick ----------------------------------------------------------------------------------

/** Why a candidate was turned down, by one rule. */
export const ruleViolationSchema = z.object({
  ruleId: z.string(),
  kind: z.string(),
  /** English, for logs and the API; the UI words it from `kind` and `values`. */
  detail: z.string(),
  /** Numbers the message needs (minutes, items, counts, limits). */
  values: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type RuleViolation = z.infer<typeof ruleViolationSchema>;

export const pickSlotInputSchema = z.object({
  categoryId: uuidSchema,
  at: z.iso.datetime({ offset: true }),
});

/** `POST …/rotation/pick`: fill these slots in order, each pick counting for the next ones. */
export const pickRequestSchema = z.object({
  slots: z.array(pickSlotInputSchema).min(1).max(100),
  /** Same seed, same snapshot: same picks. Default: a fixed seed. */
  seed: z.string().max(100).optional(),
  /** Try a draft rule set (the settings page) instead of the saved one. */
  rules: rotationRulesSchema.optional(),
  /** Include every candidate's verdict, not only the pick. */
  explain: z.boolean().default(false),
});
export type PickRequest = z.input<typeof pickRequestSchema>;

export const rankedCandidateSchema = z.object({
  assetId: uuidSchema,
  title: z.string(),
  artists: z.array(z.string()),
  /** Position in the category's rotation order (0 first). */
  position: z.int(),
  lastPlayedAt: z.date().nullable(),
  /** Every rule the candidate breaks, relaxed or not. Empty: eligible under all rules. */
  violations: z.array(ruleViolationSchema),
  /** Soft-goal notes (`flow`): they only reorder. */
  notes: z.array(ruleViolationSchema),
  picked: z.boolean(),
});
export type RankedCandidate = z.infer<typeof rankedCandidateSchema>;

/**
 * Why a slot stays empty: the category has no schedulable member at that time, or every one
 * breaks a rule that may not be relaxed (`blockedBy`: those rules, with how many they block).
 */
export const pickUnfilledSchema = z.object({
  reason: z.enum(['no_candidates', 'unbreakable_rules']),
  blockedBy: z.array(z.object({ ruleId: z.string(), kind: z.string(), candidates: z.int() })),
});
export type PickUnfilled = z.infer<typeof pickUnfilledSchema>;

export const pickOutcomeSchema = z.object({
  categoryId: uuidSchema,
  at: z.iso.datetime({ offset: true }),
  asset: z
    .object({
      id: uuidSchema,
      title: z.string(),
      artists: z.array(z.string()),
      album: z.string().nullable(),
      durationMs: z.int().nullable(),
    })
    .nullable(),
  /** Rules dropped to fill the slot that the pick breaks, in ladder order. Empty if unfilled. */
  relaxed: z.array(relaxedRuleSchema),
  /** Set when `asset` is null. */
  unfilled: pickUnfilledSchema.nullable(),
  /** Schedulable members of the category at `at`. */
  candidates: z.int(),
  /** With `explain`: candidates in rotation order. */
  ranked: z.array(rankedCandidateSchema).optional(),
});
export type PickOutcome = z.infer<typeof pickOutcomeSchema>;

export const pickResponseSchema = z.object({ picks: z.array(pickOutcomeSchema) });
export type PickResponse = z.infer<typeof pickResponseSchema>;
