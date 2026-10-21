import {
  asRunEntry,
  asset,
  assetAnalysis,
  auditDiff,
  type Db,
  logItem,
  rotationRules,
  station,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type PickCandidate,
  type PickSlot,
  type PlayedItem,
  pickSequence,
  resolveCategory,
} from '@ondes/scheduling';
import {
  type AssetType,
  assetTypeSchema,
  type CategoryDetail,
  DEFAULT_ROTATION_RULES,
  type PickRequest,
  type PickResponse,
  pickRequestSchema,
  type RotationRule,
  type RotationRulesSettings,
  rotationRulesSchema,
  type UpdateRotationRules,
  updateRotationRulesSchema,
} from '@ondes/shared';
import { and, eq, gte, isNotNull, lt } from 'drizzle-orm';
import { lastAiredByAsset } from '../../asrun/index.ts';
import {
  getCategory,
  type LibraryCandidate,
  loadCandidates,
  type StationContext,
} from '../repo.ts';

// Rotation rules (#38, ADR 0016): the station's rule set, and picks that load the snapshots
// (members, as-run, planned log items, rules) and run @ondes/scheduling's pure picker. The
// clock preview (#39) and the log generator (#50) call `pickSlots`, or the picker directly with
// their own history.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** History around the slots: a week for weekly caps, a day for "same hour yesterday". */
const WINDOW_MS = 8 * DAY;

const storedRules = rotationRulesSchema;

export async function getRules(
  db: Db,
  scope: StationContext['scope'],
): Promise<RotationRulesSettings> {
  const [row] = await db.select().from(rotationRules).where(whereStation(rotationRules, scope));
  if (!row) return { rules: DEFAULT_ROTATION_RULES, updatedAt: null };
  // jsonb: checked against the contract on the way out too.
  return { rules: storedRules.parse(row.rules), updatedAt: row.updatedAt };
}

export async function updateRules(
  db: Db,
  ctx: StationContext,
  input: UpdateRotationRules,
): Promise<RotationRulesSettings> {
  const { rules } = updateRotationRulesSchema.parse(input);
  await withAudit(db, ctx, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(rotationRules)
      .where(whereStation(rotationRules, ctx.scope));
    await tx
      .insert(rotationRules)
      .values({ stationId: ctx.scope.stationId, orgId: ctx.scope.orgId, rules })
      .onConflictDoUpdate({
        target: rotationRules.stationId,
        set: { rules, updatedAt: new Date() },
      });
    await audit({
      action: 'rotation_rules.update',
      entity: { type: 'station', id: ctx.scope.stationId },
      diff: auditDiff({ rules: before ? before.rules : DEFAULT_ROTATION_RULES }, { rules }),
    });
  });
  return getRules(db, ctx.scope);
}

/** A library asset with what the rules read beyond membership. */
type RulesCandidate = LibraryCandidate & PickCandidate;

async function loadRulesCandidates(db: Db, scope: StationContext['scope']) {
  const [base, extra] = await Promise.all([
    loadCandidates(db, scope),
    db
      .select({
        id: asset.id,
        album: asset.album,
        bpm: assetAnalysis.bpm,
        energy: assetAnalysis.energy,
      })
      .from(asset)
      .leftJoin(assetAnalysis, eq(assetAnalysis.assetId, asset.id))
      .where(whereStation(asset, scope)),
  ]);
  const byId = new Map(extra.map((e) => [e.id, e]));
  return base.map(
    (c): RulesCandidate => ({
      ...c,
      album: byId.get(c.id)?.album ?? null,
      bpm: byId.get(c.id)?.bpm ?? null,
      energy: byId.get(c.id)?.energy ?? null,
    }),
  );
}

const assetTypes = new Set<string>(assetTypeSchema.options);
const typeOf = (kind: string | null): AssetType | null =>
  kind && assetTypes.has(kind) ? (kind as AssetType) : null;

/**
 * What aired in `[from, now)` (as-run) and what is planned in `[now, to)` (log items with an
 * asset), as the rules see it. Tags, album and analysis come from the library.
 */
export async function loadHistory(
  db: Db,
  scope: StationContext['scope'],
  library: ReadonlyMap<string, RulesCandidate>,
  from: Date,
  to: Date,
  now: Date,
): Promise<PlayedItem[]> {
  const [aired, planned] = await Promise.all([
    from < now
      ? db
          .select({
            assetId: asRunEntry.assetId,
            kind: asRunEntry.kind,
            title: asRunEntry.title,
            artists: asRunEntry.artists,
            at: asRunEntry.startedAt,
          })
          .from(asRunEntry)
          .where(
            and(
              whereStation(asRunEntry, scope),
              gte(asRunEntry.startedAt, from),
              lt(asRunEntry.startedAt, now < to ? now : to),
            ),
          )
      : [],
    to > now
      ? db
          .select({
            assetId: logItem.assetId,
            kind: logItem.kind,
            title: logItem.title,
            at: logItem.plannedStart,
          })
          .from(logItem)
          .where(
            and(
              whereStation(logItem, scope),
              isNotNull(logItem.assetId),
              gte(logItem.plannedStart, from > now ? from : now),
              lt(logItem.plannedStart, to),
            ),
          )
      : [],
  ]);
  const item = (
    row: { assetId: string | null; kind: string | null; title: string | null; at: Date },
    artists: readonly string[] | null,
  ): PlayedItem => {
    const known = row.assetId ? library.get(row.assetId) : undefined;
    return {
      assetId: row.assetId,
      type: known?.type ?? typeOf(row.kind),
      title: row.title ?? known?.title ?? null,
      artists: artists && artists.length > 0 ? artists : (known?.artists ?? []),
      album: known?.album ?? null,
      tags: known?.tags ?? [],
      bpm: known?.bpm ?? null,
      energy: known?.energy ?? null,
      at: row.at,
    };
  };
  return [...aired.map((r) => item(r, r.artists)), ...planned.map((r) => item(r, null))];
}

/** Older airings of these assets, for song rest beyond the history window. */
async function lastAiredBefore(
  db: Db,
  scope: StationContext['scope'],
  assetIds: string[],
  before: Date,
): Promise<Map<string, Date>> {
  return lastAiredByAsset(db, scope, assetIds, before);
}

function separationMs(rules: readonly RotationRule[]): number {
  let max = 0;
  for (const r of rules) {
    if ('unit' in r && r.unit === 'minutes') max = Math.max(max, r.value * MINUTE);
  }
  return max;
}

export interface PickOptions {
  now?: Date;
  /**
   * Items placed by the caller and not stored yet (a clock preview's earlier slots, a log being
   * generated), added to the loaded history.
   */
  history?: readonly PlayedItem[];
}

/**
 * `POST …/rotation/pick`: fill the slots in order with the station's rules (or draft ones),
 * against what aired and what is planned around them. In-process callers (clock preview, log
 * generator) pass their unsaved picks as `options.history`.
 */
export async function pickSlots(
  db: Db,
  scope: StationContext['scope'],
  input: PickRequest,
  options: PickOptions = {},
): Promise<PickResponse> {
  const now = options.now ?? new Date();
  const request = pickRequestSchema.parse(input);
  const rules = request.rules ?? (await getRules(db, scope)).rules;
  const categoryIds = [...new Set(request.slots.map((s) => s.categoryId))];
  const categories = new Map<string, CategoryDetail>();
  // getCategory throws NotFoundError (404) for a category of another station.
  for (const id of categoryIds) categories.set(id, await getCategory(db, scope, id, now));

  const [[tz], library] = await Promise.all([
    db.select({ timezone: station.timezone }).from(station).where(eq(station.id, scope.stationId)),
    loadRulesCandidates(db, scope),
  ]);
  const libraryById = new Map(library.map((c) => [c.id, c]));
  const membersOf = new Map<string, RulesCandidate[]>();
  for (const [id, category] of categories) {
    membersOf.set(
      id,
      resolveCategory(category, library, now).members.map((m) => m.asset),
    );
  }

  const times = request.slots.map((s) => new Date(s.at).getTime());
  const span = Math.max(WINDOW_MS, separationMs(rules));
  const from = new Date(Math.min(...times) - span);
  const to = new Date(Math.max(...times) + span);
  const memberIds = [...new Set([...membersOf.values()].flat().map((m) => m.id))];
  const [loaded, lastPlayedAt] = await Promise.all([
    loadHistory(db, scope, libraryById, from, to, now),
    lastAiredBefore(db, scope, memberIds, from),
  ]);

  const history = [...loaded, ...(options.history ?? [])];
  const slots: PickSlot<RulesCandidate>[] = request.slots.map((s) => ({
    at: new Date(s.at),
    category: categories.get(s.categoryId) as CategoryDetail,
    candidates: membersOf.get(s.categoryId) ?? [],
  }));
  const results = pickSequence(
    {
      timeZone: tz?.timezone ?? 'UTC',
      rules,
      history,
      lastPlayedAt,
      seed: request.seed ?? 'ondes',
    },
    slots,
  );

  return {
    picks: results.map((result, i) => {
      const slot = request.slots[i] as (typeof request.slots)[number];
      const picked = result.asset;
      return {
        categoryId: slot.categoryId,
        at: new Date(slot.at).toISOString(),
        asset: picked
          ? {
              id: picked.id,
              title: picked.title,
              artists: [...picked.artists],
              album: picked.album,
              durationMs: picked.durationMs,
            }
          : null,
        relaxed: result.relaxed,
        candidates: result.ranked.length,
        ...(request.explain
          ? {
              ranked: result.ranked.map((v) => ({
                assetId: v.asset.id,
                title: v.asset.title,
                artists: [...v.asset.artists],
                position: v.position,
                lastPlayedAt: v.lastPlayedAt,
                violations: v.violations,
                notes: v.notes,
                picked: v.picked,
              })),
            }
          : {}),
      };
    }),
  };
}
