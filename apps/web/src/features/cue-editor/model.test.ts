import type { AssetCues } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  clearPoint,
  draftOf,
  fadeGain,
  fadeRegions,
  isDirty,
  moveMarker,
  patchOf,
  setLocked,
  transitionPlan,
} from './model.ts';

const SR = 44_100;
const LENGTH = SR * 200;

function cues(): AssetCues {
  const auto = (samples: number | null) => ({ samples, source: 'auto' as const, locked: false });
  return {
    assetId: '01a15ddf-0000-7000-8000-000000000001',
    sampleRate: SR,
    analyzerVersion: 'autocue/1',
    cueIn: auto(SR),
    cueOut: auto(SR * 195),
    introEnd: auto(SR * 15),
    outroStart: auto(SR * 180),
    fadeIn: auto(null),
    fadeOut: auto(SR * 4),
    crossStartNext: auto(SR * 190),
    updatedAt: new Date('2026-10-21T08:00:00.000Z'),
  };
}

describe('cue editor model', () => {
  it('starts from the stored cues, or from nothing', () => {
    expect(draftOf(cues()).cueIn).toEqual({ samples: SR, source: 'auto', locked: false });
    expect(draftOf(null).cueOut).toEqual({ samples: null, source: 'auto', locked: false });
  });

  it('keeps cue-in before and cue-out after the other markers', () => {
    const draft = draftOf(cues());
    expect(boundsOf(draft, 'cueIn', LENGTH)).toEqual([0, SR * 15]);
    expect(boundsOf(draft, 'cueOut', LENGTH)).toEqual([SR * 190, LENGTH]);
    expect(boundsOf(draft, 'introEnd', LENGTH)).toEqual([SR, SR * 195]);
    expect(moveMarker(draft, 'cueIn', SR * 60, LENGTH).cueIn).toEqual({
      samples: SR * 15,
      source: 'manual',
      locked: false,
    });
    expect(moveMarker(draft, 'crossStartNext', LENGTH, LENGTH).crossStartNext.samples).toBe(
      SR * 195,
    );
    expect(moveMarker(draft, 'cueOut', 10.6, LENGTH).cueOut.samples).toBe(SR * 190);
    // Without a cue-out, the end of the asset bounds the markers.
    expect(boundsOf(draftOf(null), 'outroStart', LENGTH)).toEqual([0, LENGTH]);
  });

  it('sends only what changed, moved points locked', () => {
    const saved = draftOf(cues());
    expect(patchOf(saved, saved, SR)).toBeNull();
    let draft = moveMarker(saved, 'cueIn', SR * 2, LENGTH);
    draft = setLocked(draft, 'fadeOut', true);
    draft = clearPoint(draft, 'introEnd');
    expect(isDirty(saved, draft)).toBe(true);
    expect(patchOf(saved, draft, SR)).toEqual({
      sampleRate: SR,
      cueIn: { samples: SR * 2, locked: true },
      introEnd: { samples: null, locked: true },
      fadeOut: { locked: true },
    });
    // Moving a point back where it was is no change.
    expect(isDirty(saved, moveMarker(draft, 'cueIn', SR, LENGTH))).toBe(true);
    const back = setLocked(
      { ...moveMarker(draft, 'cueIn', SR, LENGTH), introEnd: saved.introEnd },
      'fadeOut',
      false,
    );
    expect(isDirty(saved, back)).toBe(false);
  });

  it('places the fades from cue-in and up to cue-out', () => {
    expect(fadeRegions(draftOf(cues()), LENGTH)).toEqual([
      { id: 'fadeOut', fromSample: SR * 191, toSample: SR * 195 },
    ]);
  });

  it('plans a transition preview on the next-track start', () => {
    const plan = transitionPlan(draftOf(cues()), LENGTH, SR);
    expect(plan).toEqual({
      fromSample: SR * 184,
      switchAt: SR * 190,
      stopAt: SR * 195,
      fadeOutFrom: SR * 191,
    });
    expect(fadeGain(plan, SR * 190)).toBe(1);
    expect(fadeGain(plan, SR * 193)).toBeCloseTo(0.5);
    expect(fadeGain(plan, SR * 196)).toBe(0);
    // No next-track start: the next one starts at cue-out.
    const bare = transitionPlan(draftOf(null), LENGTH, SR);
    expect(bare.switchAt).toBe(LENGTH);
    expect(bare.fromSample).toBe(LENGTH - 6 * SR);
  });
});
