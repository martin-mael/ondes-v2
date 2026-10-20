// Settings combinations the station template is checked with (`pnpm test:engine`): every
// combination of the toggles that change the script's structure, plus every output
// format and settings full of characters that need escaping.
//
//   node engine/tests/template/combos.ts <out dir>   # writes one rendered .liq per combo
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  renderStationScript,
  type StationEngineSettingsInput,
} from '../../../apps/api/src/modules/engine/config/index.ts';

export type Combo = { name: string; settings: StationEngineSettingsInput };

const base: StationEngineSettingsInput = {
  stationId: 'vandale',
  name: 'Vandale Radio',
  eventsUrl: 'http://api:3000/internal/engine/vandale/events',
  outputs: [{ mount: 'vandale.mp3', format: 'mp3', bitrate: 128 }],
};

export function combos(): Combo[] {
  const out: Combo[] = [];
  for (const live of [true, false]) {
    for (const compressor of [true, false]) {
      for (const limiter of [true, false]) {
        out.push({
          name: `live-${live ? 'on' : 'off'}_comp-${compressor ? 'on' : 'off'}_lim-${limiter ? 'on' : 'off'}`,
          settings: {
            ...base,
            live: { enabled: live },
            processing: { compressor: { enabled: compressor }, limiter: { enabled: limiter } },
          },
        });
      }
    }
  }
  out.push({
    name: 'all-formats_webhook_escaping',
    settings: {
      stationId: 'b7f6c1d2-0d1e-4c55-9a39-5f1f0b2c9e10',
      name: 'Radio "#{shutdown()}" \\ é – 🎧',
      description: 'Lyon\'s "free" radio,\nnon-profit #{1+1}',
      genre: 'Éclectique',
      url: 'https://vandale.example.org/?a=1&b="2"',
      live: { authUrl: 'http://api:3000/internal/engine/live-auth', mount: 'dj.live' },
      paths: { safetyDir: '/media/sécurité "x"', emergencyFile: '/media/em #{x}.flac' },
      crossfade: { duration: 0.25 },
      blank: { maxSeconds: 4.5, thresholdDb: -50 },
      processing: { compressor: { gainDb: -1.5, attackMs: 0.5 } },
      outputs: [
        { mount: 'hi.mp3', format: 'mp3', bitrate: 320, public: true },
        { mount: 'mobile.aac', format: 'aac', bitrate: 64 },
        { mount: 'hi.opus', format: 'opus', bitrate: 96 },
        { mount: 'hi.ogg', format: 'vorbis', bitrate: 160 },
      ],
    },
  });
  out.push({
    name: 'no-events-url',
    settings: { ...base, eventsUrl: undefined, live: { enabled: true, port: 8100 } },
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? 'engine/tests/template/.work');
  mkdirSync(dir, { recursive: true });
  for (const c of combos()) {
    const { script, version } = renderStationScript(c.settings);
    writeFileSync(join(dir, `${c.name}.liq`), script);
    console.log(`rendered ${c.name}.liq (config ${version})`);
  }
}
