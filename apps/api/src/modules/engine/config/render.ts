import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableStringify } from '@ondes/shared';
import { liqBool, liqFloat, liqInt, liqString } from './liquidsoap.ts';
import {
  type IcecastOutput,
  type StationEngineSettings,
  type StationEngineSettingsInput,
  stationEngineSettingsSchema,
} from './settings.ts';

/** The station template, relative to this file. Override with ENGINE_TEMPLATE_PATH. */
export const STATION_TEMPLATE_URL = new URL(
  '../../../../../../engine/templates/station.liq',
  import.meta.url,
);

const CONFIG_MARKER = '# @ondes:config';
const OUTPUTS_MARKER = '# @ondes:outputs';

export function loadStationTemplate(path = process.env.ENGINE_TEMPLATE_PATH): string {
  return readFileSync(path ?? STATION_TEMPLATE_URL, 'utf8');
}

export type RenderedStationScript = {
  /** The Liquidsoap script to run for this station. */
  script: string;
  /**
   * Content hash of the template and the settings, also baked into the script and
   * reported by the engine (`config_version` in `GET /v1/health` and `/v1/state`).
   * Same settings and template, same version: a new version means a restart is due.
   */
  version: string;
  /** The settings it was rendered from, with every default applied. */
  settings: StationEngineSettings;
};

export function configVersion(template: string, settings: StationEngineSettings): string {
  return createHash('sha256')
    .update(template)
    .update('\0')
    .update(stableStringify(settings))
    .digest('hex')
    .slice(0, 16);
}

function configBlock(s: StationEngineSettings, version: string): string {
  const { compressor, limiter } = s.processing;
  const lines: [string, string][] = [
    ['config_version', liqString(version)],
    ['station_id', liqString(s.stationId)],
    ['station_name', liqString(s.name)],
    ['control_port', liqInt(s.control.port)],
    ['metrics_port', liqInt(s.metrics.port)],
    ['metrics_enabled', liqBool(s.metrics.enabled)],
    ['events_url', liqString(s.eventsUrl ?? '')],
    ['live_input', liqBool(s.live.enabled)],
    ['live_port', liqInt(s.live.port)],
    ['live_mount', liqString(s.live.mount)],
    ['live_auth_url', liqString(s.live.authUrl ?? '')],
    ['live_buffer', liqFloat(s.live.buffer)],
    ['live_max', liqFloat(s.live.maxBuffer)],
    ['safety_dir', liqString(s.paths.safetyDir)],
    ['emergency_file', liqString(s.paths.emergencyFile)],
    ['default_cross', liqFloat(s.crossfade.duration)],
    ['blank_max', liqFloat(s.blank.maxSeconds)],
    ['blank_threshold', liqFloat(s.blank.thresholdDb)],
    ['compressor_enabled', liqBool(compressor.enabled)],
    ['compressor_threshold', liqFloat(compressor.thresholdDb)],
    ['compressor_ratio', liqFloat(compressor.ratio)],
    ['compressor_attack', liqFloat(compressor.attackMs)],
    ['compressor_release', liqFloat(compressor.releaseMs)],
    ['compressor_knee', liqFloat(compressor.kneeDb)],
    ['compressor_gain', liqFloat(compressor.gainDb)],
    ['limiter_enabled', liqBool(limiter.enabled)],
    ['limiter_threshold', liqFloat(limiter.thresholdDb)],
    ['limiter_release', liqFloat(limiter.releaseMs)],
    ['icecast_host', liqString(s.icecast.host)],
    ['icecast_port', liqInt(s.icecast.port)],
  ];
  return [
    '# Generated from the station settings by apps/api/src/modules/engine/config. Do not edit.',
    ...lines.map(([k, v]) => `${k} = ${v}`),
  ].join('\n');
}

/** Encoder expressions: compile-time in Liquidsoap, hence generated. */
function encoder(o: IcecastOutput): { format: string; mime?: string } {
  switch (o.format) {
    case 'mp3':
      return { format: `%mp3(bitrate=${liqInt(o.bitrate)}, samplerate=44100, stereo=true)` };
    case 'aac':
      // ffmpeg's native AAC encoder; fdk-aac is not free software.
      return {
        format: `%ffmpeg(format="adts", %audio(codec="aac", b="${liqInt(o.bitrate)}k"))`,
        mime: 'audio/aac',
      };
    case 'opus':
      return { format: `%ogg(%opus(bitrate=${liqInt(o.bitrate)}, samplerate=48000))` };
    case 'vorbis':
      return { format: `%ogg(%vorbis.cbr(bitrate=${liqInt(o.bitrate)}))` };
  }
}

function outputsBlock(s: StationEngineSettings): string {
  return s.outputs
    .map((o, i) => {
      const enc = encoder(o);
      const args = [
        enc.format,
        `id=${liqString(`icecast_${i}`)}`,
        'host=icecast_host',
        'port=icecast_port',
        'password=icecast_password',
        `mount=${liqString(o.mount)}`,
        ...(enc.mime ? [`format=${liqString(enc.mime)}`] : []),
        'name=station_name',
        ...(s.description !== undefined ? [`description=${liqString(s.description)}`] : []),
        ...(s.genre !== undefined ? [`genre=${liqString(s.genre)}`] : []),
        ...(s.url !== undefined ? [`url=${liqString(s.url)}`] : []),
        `public=${liqBool(o.public)}`,
        'radio',
      ];
      return `output.icecast(\n  ${args.join(',\n  ')}\n)`;
    })
    .join('\n\n');
}

function replaceMarker(template: string, marker: string, code: string): string {
  const lines = template.split('\n');
  const at = lines.filter((l) => l === marker).length;
  if (at !== 1) throw new Error(`station template must contain "${marker}" exactly once`);
  return lines.map((l) => (l === marker ? code : l)).join('\n');
}

/**
 * Renders the station's Liquidsoap script. Validates the settings (zod, defaults applied)
 * and throws a ZodError on invalid ones.
 */
export function renderStationScript(
  input: StationEngineSettingsInput,
  template: string = loadStationTemplate(),
): RenderedStationScript {
  const settings = stationEngineSettingsSchema.parse(input);
  const version = configVersion(template, settings);
  let script = replaceMarker(template, CONFIG_MARKER, configBlock(settings, version));
  script = replaceMarker(script, OUTPUTS_MARKER, outputsBlock(settings));
  return { script, version, settings };
}
