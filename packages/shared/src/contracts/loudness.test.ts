import { describe, expect, it } from 'vitest';
import {
  getPlayoutGain,
  LOUDNESS_PRESETS,
  loudnessIdempotencyKey,
  loudnessPresetOf,
  type PlayoutGainAsset,
} from './loudness.ts';

const music = { loudnessTargetLufs: LOUDNESS_PRESETS.music, truePeakLimitDbtp: -1 };
const measured = (integratedLufs: number, truePeakDbtp: number | null): PlayoutGainAsset => ({
  normalizeLoudness: true,
  gainOverrideDb: null,
  loudness: { integratedLufs, truePeakDbtp },
});

describe('loudness presets', () => {
  it('maps station targets to presets', () => {
    expect(LOUDNESS_PRESETS).toEqual({ music: -16, talk: -18, ebu: -23 });
    expect(loudnessPresetOf(-16)).toBe('music');
    expect(loudnessPresetOf(-18)).toBe('talk');
    expect(loudnessPresetOf(-23)).toBe('ebu');
    expect(loudnessPresetOf(-14)).toBe('custom');
  });
});

describe('getPlayoutGain', () => {
  it('is target − integrated when the peak allows it', () => {
    expect(getPlayoutGain(measured(-20, -12), music)).toEqual({
      gainDb: 4,
      source: 'measured',
      limitedByPeak: false,
    });
    // Loud masters come down; the peak never limits a cut.
    expect(getPlayoutGain(measured(-8.4, 0.9), music)).toEqual({
      gainDb: -7.6,
      source: 'measured',
      limitedByPeak: false,
    });
  });

  it('follows the station target (presets and custom)', () => {
    const asset = measured(-20, -15);
    expect(getPlayoutGain(asset, { ...music, loudnessTargetLufs: -18 }).gainDb).toBe(2);
    expect(getPlayoutGain(asset, { ...music, loudnessTargetLufs: -23 }).gainDb).toBe(-3);
    expect(getPlayoutGain(asset, { ...music, loudnessTargetLufs: -19.5 }).gainDb).toBe(0.5);
  });

  it('clamps so that true peak + gain stays under the ceiling', () => {
    // Wants +6, but the peak is at -3 dBTP: only 2 dB of headroom under -1.
    expect(getPlayoutGain(measured(-22, -3), music)).toEqual({
      gainDb: 2,
      source: 'measured',
      limitedByPeak: true,
    });
    // A lower ceiling leaves less room.
    expect(getPlayoutGain(measured(-22, -3), { ...music, truePeakLimitDbtp: -2 }).gainDb).toBe(1);
    // Already over the ceiling: the clamp turns the boost into a cut.
    expect(getPlayoutGain(measured(-17, 0.5), music)).toEqual({
      gainDb: -1.5,
      source: 'measured',
      limitedByPeak: true,
    });
  });

  it('rounds to 0.1 dB, and down when the ceiling limits the gain', () => {
    expect(getPlayoutGain(measured(-19.34, -30), music).gainDb).toBe(3.3);
    expect(getPlayoutGain(measured(-19.36, -30), music).gainDb).toBe(3.4);
    // Float noise doesn't move a value across a step: -16 − -19.3 = 3.3000000000000007.
    expect(getPlayoutGain(measured(-19.3, -30), music).gainDb).toBe(3.3);
    // Headroom 2.37 dB: 2.3, never 2.4 (which would exceed the ceiling).
    const limited = getPlayoutGain(measured(-25, -3.37), music);
    expect(limited).toEqual({ gainDb: 2.3, source: 'measured', limitedByPeak: true });
    // Wanted 3.26 fits under a 3.27 headroom, but its rounding (3.3) wouldn't.
    expect(getPlayoutGain(measured(-19.26, -4.27), music)).toEqual({
      gainDb: 3.2,
      source: 'measured',
      limitedByPeak: true,
    });
    for (const [integrated, peak] of [
      [-30.17, -9.93],
      [-21.04, -5.06],
      [-16.01, -0.99],
    ] as const) {
      const { gainDb } = getPlayoutGain(measured(integrated, peak), music);
      expect(peak + gainDb).toBeLessThanOrEqual(music.truePeakLimitDbtp);
    }
    expect(Object.is(getPlayoutGain(measured(-16.01, -10), music).gainDb, 0)).toBe(true);
  });

  it('does not clamp an unknown true peak', () => {
    expect(getPlayoutGain(measured(-26, null), music)).toEqual({
      gainDb: 10,
      source: 'measured',
      limitedByPeak: false,
    });
  });

  it('bounds the gain to what the engine accepts', () => {
    expect(getPlayoutGain(measured(-60, -50), music).gainDb).toBe(24);
    expect(getPlayoutGain(measured(-60, null), music).gainDb).toBe(24);
  });

  it('never boosts silence, and plays unmeasured assets as they are', () => {
    expect(getPlayoutGain(measured(-70, null), music)).toEqual({
      gainDb: 0,
      source: 'unmeasured',
      limitedByPeak: false,
    });
    expect(getPlayoutGain({ ...measured(-20, -10), loudness: null }, music)).toEqual({
      gainDb: 0,
      source: 'unmeasured',
      limitedByPeak: false,
    });
  });

  it('applies a per-asset override as given', () => {
    const asset = { ...measured(-20, -3), gainOverrideDb: 5.04 };
    expect(getPlayoutGain(asset, music)).toEqual({
      gainDb: 5,
      source: 'override',
      limitedByPeak: false,
    });
    // Even without a measurement.
    expect(getPlayoutGain({ ...asset, loudness: null }, music).gainDb).toBe(5);
  });

  it('plays the file as it is when normalisation is disabled, override or not', () => {
    const disabled = { ...measured(-30, -20), normalizeLoudness: false };
    expect(getPlayoutGain(disabled, music)).toEqual({
      gainDb: 0,
      source: 'disabled',
      limitedByPeak: false,
    });
    expect(getPlayoutGain({ ...disabled, gainOverrideDb: -3 }, music).source).toBe('disabled');
  });
});

describe('loudnessIdempotencyKey', () => {
  it('names one playout copy of one asset', () => {
    const payload = {
      orgId: '0199f6a0-0000-7000-8000-000000000001',
      stationId: '0199f6a0-0000-7000-8000-000000000002',
      assetId: '0199f6a0-0000-7000-8000-000000000003',
      playoutSha256: 'a'.repeat(64),
    };
    expect(loudnessIdempotencyKey(payload)).toBe(
      `loudness:0199f6a0-0000-7000-8000-000000000003:${'a'.repeat(64)}`,
    );
  });
});
