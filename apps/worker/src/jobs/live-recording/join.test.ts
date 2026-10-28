import { describe, expect, it } from 'vitest';
import { concatList, isPartFile, joinTimeoutMs } from './join.ts';

describe('live recording join', () => {
  it('only opens the engine own file names', () => {
    expect(isPartFile('live-1793134494-969898-12.flac')).toBe(true);
    for (const name of [
      '../etc/passwd',
      'live-1/../../x-1.flac',
      'live-a-1.wav',
      '.live-a-1.flac',
      'live-a-1.flac\n',
    ])
      expect(isPartFile(name)).toBe(false);
  });

  it("quotes paths for ffmpeg's concat list", () => {
    expect(concatList(['/r/a.flac', "/r/it's.flac"])).toBe(
      "file '/r/a.flac'\nfile '/r/it'\\''s.flac'\n",
    );
  });

  it('gives a 2-hour show minutes, not hours', () => {
    expect(joinTimeoutMs(7200)).toBe(120_000 + 1_440_000);
  });
});
