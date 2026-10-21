import type { PreviewPickSource } from '@ondes/shared';
import type { LibraryCandidate } from '../rotation/repo.ts';

// The clock preview's picker (#39): what fills a category slot in a sample hour. The rules
// engine (#38) provides the real picker (separation, rest, rotation order); until it does, or
// for a category it can't serve, the preview takes a random schedulable member, avoiding
// repeats within the hour while the category has fresh members left.

/** An asset already placed in the sample hour, for separation rules. */
export interface PreviewPlacement {
  asset: LibraryCandidate;
  categoryId: string | null;
  slotIndex: number;
  startsAt: Date;
}

export interface PickRequest {
  categoryId: string;
  slotIndex: number;
  /** When the slot would air. */
  at: Date;
  /** Earlier items of the sample hour, in order. */
  history: readonly PreviewPlacement[];
}

export interface Pick {
  asset: LibraryCandidate;
  relaxedRules: string[];
}

export interface PreviewPicker {
  readonly source: Exclude<PreviewPickSource, 'fixed'>;
  /** `null`: nothing schedulable to pick. */
  pick(request: PickRequest): Promise<Pick | null>;
}

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
 * Random schedulable members. `membersOf` returns a category's schedulable members (cached by
 * the caller). Assets already in the hour are skipped while others are left.
 */
export function randomPicker(
  membersOf: (categoryId: string, at: Date) => Promise<readonly LibraryCandidate[]>,
  random: () => number,
): PreviewPicker {
  return {
    source: 'random',
    async pick({ categoryId, at, history }) {
      const members = await membersOf(categoryId, at);
      if (members.length === 0) return null;
      const used = new Set(history.map((h) => h.asset.id));
      const fresh = members.filter((m) => !used.has(m.id));
      const pool = fresh.length > 0 ? fresh : members;
      const asset = pool[Math.floor(random() * pool.length)] as LibraryCandidate;
      return { asset, relaxedRules: fresh.length > 0 ? [] : ['no_repeat_in_hour'] };
    },
  };
}
