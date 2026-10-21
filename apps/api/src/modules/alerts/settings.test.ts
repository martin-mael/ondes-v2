import { silenceSettingsSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { renderStationScript, stationEngineSettingsSchema } from '../engine/config/index.ts';
import { engineBlankSettings } from './engine-alerts.ts';

// The silence settings' threshold and duration are the template's blank.detect settings:
// same defaults, same ranges, so whatever a manager saves renders.

const station = {
  stationId: 'st',
  name: 'Station',
  outputs: [{ mount: 'main.mp3', format: 'mp3' as const, bitrate: 128 }],
};

describe('silence settings vs the engine template', () => {
  it('have the same defaults', () => {
    const engine = stationEngineSettingsSchema.parse(station);
    expect(engineBlankSettings(silenceSettingsSchema.parse({}))).toEqual(engine.blank);
  });

  it.each([
    { maxSeconds: 1, thresholdDb: -90 },
    { maxSeconds: 300, thresholdDb: 0 },
    { maxSeconds: 2.5, thresholdDb: -45.5 },
  ])('accept and render the same values: %o', (blank) => {
    const settings = silenceSettingsSchema.parse(blank);
    const { script } = renderStationScript({ ...station, blank: engineBlankSettings(settings) });
    expect(script).toContain('blank_max =');
    expect(script).toContain('blank_threshold =');
  });

  it.each([{ maxSeconds: 0.5 }, { maxSeconds: 301 }, { thresholdDb: -91 }, { thresholdDb: 1 }])(
    'reject the same out-of-range values: %o',
    (blank) => {
      expect(silenceSettingsSchema.safeParse(blank).success).toBe(false);
      expect(stationEngineSettingsSchema.safeParse({ ...station, blank }).success).toBe(false);
    },
  );
});
