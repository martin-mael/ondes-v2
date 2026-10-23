import type { LogItemOrigin } from '@ondes/shared';
import type { KeptReason } from '../generator/index.ts';

// What a regeneration keeps (#101, ADR 0030). The generator (#50) keeps whatever it is given as
// kept items and plans around them; this decides which current items those are. One function,
// used by the snapshot loader (what to keep) and by the day writer (its stale check), so the
// two can't disagree.

/** Items starting before `now + REGEN_FREEZE_MS` stay: the feeder holds 45 min ahead (#29). */
export const REGEN_FREEZE_MS = 60 * 60_000;

export interface KeepPolicy {
  /** Items starting before this stay (aired, on air, or already with the feeder). */
  frozenUntil?: Date | null;
  /** Keep manual edits (`origin: manual`). */
  manual?: boolean;
}

/** What the policy needs to know about a current top-level item. */
export interface KeepCandidate {
  plannedStart: Date;
  originType: LogItemOrigin['type'];
  locked: boolean;
  /** An end of a segue (ADR 0017). */
  inSegue: boolean;
  /** Carries a missing-episode fallback mark (ADR 0022). */
  hasFallbackMark: boolean;
}

/** Why `item` survives a regeneration under `policy`, most telling first; empty: it may go. */
export function keepReasons(item: KeepCandidate, policy: KeepPolicy = {}): KeptReason[] {
  const reasons: KeptReason[] = [];
  if (policy.frozenUntil && item.plannedStart.getTime() < policy.frozenUntil.getTime()) {
    reasons.push('past');
  }
  if (item.locked) reasons.push('locked');
  if (item.inSegue) reasons.push('segue');
  if (item.hasFallbackMark) reasons.push('fallback');
  if (policy.manual && item.originType === 'manual') reasons.push('manual');
  return reasons;
}

/** The regeneration policy at `now`: freeze the next hour, keep manual edits. */
export function regenPolicy(now: Date, freezeMs = REGEN_FREEZE_MS): Required<KeepPolicy> {
  return { frozenUntil: new Date(now.getTime() + freezeMs), manual: true };
}

/**
 * Where a kept item was planned by the last regeneration (`start`), and where retiming then put
 * it (`settledStart`). A kept `flow` item follows the items before it, so its written start
 * differs from the time the generator planned around; planning around the written start next
 * time would move it again, and a regeneration would never settle.
 */
export interface KeptPin {
  start: Date;
  settledStart: Date;
}

/**
 * The time to plan a kept item around: its pin while it still sits where that regeneration put
 * it, else (an edit moved it or retimed the day since) its current start.
 */
export function keptStart(plannedStart: Date, pin: KeptPin | null | undefined): Date {
  return pin && pin.settledStart.getTime() === plannedStart.getTime() ? pin.start : plannedStart;
}
