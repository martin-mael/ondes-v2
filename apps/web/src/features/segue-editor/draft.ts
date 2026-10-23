import type { Lanes } from './model.ts';

// The editor's draft while the presenter records a VT (#59). The recorder is a page of its own
// (precision trim), so the editor hands its unsaved lanes over before leaving: the recorder
// plays them as the pre-roll, and the editor gets them back, with the new voice, on return.
// In memory only, per transition: a reload drops it (the editor then starts from the api).
// The editor restores it only when the recorder sends it back (`resume`, or a placed take) and
// drops it on any other visit, so a draft left behind never comes back over a segue that
// moved on. Leaving the recorder elsewhere asks first (its unsaved guard counts the draft).

export interface SegueDraft {
  lanes: Lanes;
  /** What the api had when the draft was stashed: the dirty check and the version to send. */
  saved: { lanes: Lanes; segueId: string | null; version: number | null };
}

const drafts = new Map<string, SegueDraft>();
const keyOf = (stationId: string, fromItemId: string, toItemId: string) =>
  `${stationId}:${fromItemId}:${toItemId}`;

export function stashDraft(
  stationId: string,
  fromItemId: string,
  toItemId: string,
  draft: SegueDraft,
): void {
  drafts.set(keyOf(stationId, fromItemId, toItemId), draft);
}

/** The stashed draft, left in place (the recorder reads it, the editor takes it). */
export function peekDraft(
  stationId: string,
  fromItemId: string,
  toItemId: string,
): SegueDraft | null {
  return drafts.get(keyOf(stationId, fromItemId, toItemId)) ?? null;
}

/** The stashed draft, removed. */
export function takeDraft(
  stationId: string,
  fromItemId: string,
  toItemId: string,
): SegueDraft | null {
  const key = keyOf(stationId, fromItemId, toItemId);
  const draft = drafts.get(key) ?? null;
  drafts.delete(key);
  return draft;
}
