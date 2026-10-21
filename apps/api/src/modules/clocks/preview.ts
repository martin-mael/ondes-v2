import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db, StationScope } from '@ondes/db';
import type { AssetType, ClockPreviewAsset, PreviewPickSource, TagKey } from '@ondes/shared';
import type { LibraryCandidate } from '../rotation/repo.ts';

// The clock preview's picker (#39): what fills the category slots of a sample hour. The rules
// engine (#38, `pickSlots`) is the real picker: rest, separation and rotation order against
// what aired and what is planned. Without it, the preview takes a random schedulable member,
// avoiding repeats within the hour while the category has fresh members left.
//
// Slots are picked in one batch, in play order, each at its estimated air time; the hour's
// fixed items (asset slots) go along as history so the rules see them too.

/** A picking slot: its category and when it would air. */
export interface PickRequest {
  categoryId: string;
  slotIndex: number;
  at: Date;
}

/** An asset slot of the hour, placed at its air time. */
export interface FixedPlacement {
  asset: LibraryCandidate;
  at: Date;
}

export interface Pick {
  asset: ClockPreviewAsset;
  relaxedRules: string[];
}

export interface PreviewPicker {
  readonly source: Exclude<PreviewPickSource, 'fixed'>;
  /** One result per request, in order; `null`: nothing to pick. */
  pickAll(
    requests: readonly PickRequest[],
    fixed: readonly FixedPlacement[],
  ): Promise<(Pick | null)[]>;
}

const summary = (asset: LibraryCandidate): ClockPreviewAsset => ({
  id: asset.id,
  type: asset.type,
  title: asset.title,
  artists: asset.artists,
  durationMs: asset.durationMs,
});

// --- Random fallback -----------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32), seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random members. `membersOf(categoryId, at)` returns the category's members schedulable at
 * `at`. Assets already in the hour (fixed or picked) are skipped while others are left.
 */
export function randomPicker(
  membersOf: (categoryId: string, at: Date) => Promise<readonly LibraryCandidate[]>,
  random: () => number,
): PreviewPicker {
  return {
    source: 'random',
    async pickAll(requests, fixed) {
      const used = new Set(fixed.map((f) => f.asset.id));
      const out: (Pick | null)[] = [];
      for (const { categoryId, at } of requests) {
        const members = await membersOf(categoryId, at);
        if (members.length === 0) {
          out.push(null);
          continue;
        }
        const fresh = members.filter((m) => !used.has(m.id));
        const pool = fresh.length > 0 ? fresh : members;
        const asset = pool[Math.floor(random() * pool.length)] as LibraryCandidate;
        used.add(asset.id);
        out.push({
          asset: summary(asset),
          relaxedRules: fresh.length > 0 ? [] : ['no_repeat_in_hour'],
        });
      }
      return out;
    },
  };
}

// --- Rules engine (#38) --------------------------------------------------------------------

/** An item the rules count as aired or planned (`PlayedItem` in @ondes/scheduling, #38). */
export interface PlayedItemInput {
  assetId: string | null;
  type: AssetType | null;
  title: string | null;
  artists: readonly string[];
  album: string | null;
  tags: readonly { key: TagKey; value: string }[];
  at: Date;
}

/** #38's `pickSlots` (apps/api/src/modules/rotation/rules/repo.ts), as the preview calls it. */
export type PickSlotsFn = (
  db: Db,
  scope: StationScope,
  input: { slots: { categoryId: string; at: string }[]; seed?: string },
  options?: { history?: readonly PlayedItemInput[] },
) => Promise<{
  picks: {
    asset: {
      id: string;
      title: string;
      artists: string[];
      durationMs: number | null;
    } | null;
    relaxed: { rule: string; reason?: string }[];
  }[];
}>;

/**
 * #38's picker: one `pickSlots` call for the whole hour, which chains the picks (each counts
 * for the next slots). `assetTypeOf` gives a category's asset type, which `pickSlots` doesn't
 * return.
 */
export function rulesPicker(
  pickSlots: PickSlotsFn,
  db: Db,
  scope: StationScope,
  options: { seed: string; assetTypeOf: (categoryId: string) => AssetType },
): PreviewPicker {
  return {
    source: 'rules',
    async pickAll(requests, fixed) {
      if (requests.length === 0) return [];
      const { picks } = await pickSlots(
        db,
        scope,
        {
          slots: requests.map((r) => ({ categoryId: r.categoryId, at: r.at.toISOString() })),
          seed: options.seed,
        },
        {
          history: fixed.map(({ asset, at }) => ({
            assetId: asset.id,
            type: asset.type,
            title: asset.title,
            artists: asset.artists,
            album: null,
            tags: asset.tags,
            at,
          })),
        },
      );
      return requests.map((request, i) => {
        const pick = picks[i];
        if (!pick?.asset) return null;
        return {
          asset: {
            id: pick.asset.id,
            type: options.assetTypeOf(request.categoryId),
            title: pick.asset.title,
            artists: pick.asset.artists,
            durationMs: pick.asset.durationMs,
          },
          relaxedRules: pick.relaxed.map((r) => r.rule),
        };
      });
    },
  };
}

const rulesModule = new URL('../rotation/rules/repo.ts', import.meta.url);
let found: Promise<PickSlotsFn | undefined> | undefined;

/**
 * #38's `pickSlots`, if this build has it. #38 (PR #153) and this module land separately, so
 * it's looked up at runtime: until the rules module exists, previews use random picks.
 * TODO(#38): once both are on main, import `pickSlots` statically and drop the lookup.
 */
export function findPickSlots(): Promise<PickSlotsFn | undefined> {
  found ??= existsSync(fileURLToPath(rulesModule))
    ? import(rulesModule.href).then((mod: { pickSlots?: unknown }) =>
        typeof mod.pickSlots === 'function' ? (mod.pickSlots as PickSlotsFn) : undefined,
      )
    : Promise.resolve(undefined);
  return found;
}
