import { describe, expect, it } from 'vitest';
import { autocueSettingsOf, DEFAULT_AUTOCUE_SETTINGS } from './autocue.ts';

describe('autocueSettingsOf', () => {
  it('uses the defaults when the station has none', () => {
    const onInvalid = (keys: string[]) => expect.unreachable(keys.join());
    expect(autocueSettingsOf({}, onInvalid)).toEqual(DEFAULT_AUTOCUE_SETTINGS);
  });

  it('keeps valid thresholds and replaces each invalid one by its default, reporting it', () => {
    const invalid: string[][] = [];
    const settings = autocueSettingsOf(
      { autocue: { overlayLu: -10, silenceLu: 5, blankSkipSeconds: 'x', newerKey: 1 } },
      (keys) => invalid.push(keys),
    );
    expect(settings).toEqual({ ...DEFAULT_AUTOCUE_SETTINGS, overlayLu: -10 });
    expect(invalid).toEqual([['silenceLu', 'blankSkipSeconds']]);
  });

  it('reports a value that is not an object', () => {
    const invalid: string[][] = [];
    expect(autocueSettingsOf({ autocue: 3 }, (keys) => invalid.push(keys))).toEqual(
      DEFAULT_AUTOCUE_SETTINGS,
    );
    expect(invalid).toEqual([['autocue']]);
  });
});
