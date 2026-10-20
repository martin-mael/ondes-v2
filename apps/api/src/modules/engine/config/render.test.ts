import { describe, expect, it } from 'vitest';
import { combos } from '../../../../../../engine/tests/template/combos.ts';
import { configVersion, loadStationTemplate, renderStationScript } from './render.ts';
import { type StationEngineSettingsInput, stationEngineSettingsSchema } from './settings.ts';

const settings: StationEngineSettingsInput = {
  stationId: 'vandale',
  name: 'Vandale Radio',
  outputs: [{ mount: 'vandale.mp3', format: 'mp3', bitrate: 128 }],
};

describe('renderStationScript', () => {
  it('replaces both markers with the config and the outputs', () => {
    const { script, version } = renderStationScript(settings);
    expect(script).not.toMatch(/^# @ondes:(config|outputs)$/m);
    expect(script).toContain(`config_version = "${version}"`);
    expect(script).toContain('station_id = "vandale"');
    expect(script).toContain('compressor_enabled = true');
    expect(script).toMatch(/output\.icecast\(\n {2}%mp3\(bitrate=128, samplerate=44100/);
    expect(script).toContain('mount="vandale.mp3"');
  });

  it('defines the config before the template uses it', () => {
    const { script } = renderStationScript(settings);
    expect(script.indexOf('metrics_port = 9599')).toBeLessThan(
      script.indexOf('settings.prometheus.server.port := metrics_port'),
    );
    expect(script.indexOf('output.icecast(')).toBeGreaterThan(script.indexOf('id="blank"'));
  });

  it('generates one encoder per output format', () => {
    const { script } = renderStationScript({
      ...settings,
      outputs: [
        { mount: 'a.aac', format: 'aac', bitrate: 96 },
        { mount: 'a.opus', format: 'opus', bitrate: 64 },
        { mount: 'a.ogg', format: 'vorbis', bitrate: 128 },
      ],
    });
    expect(script).toContain('%ffmpeg(format="adts", %audio(codec="aac", b="96k"))');
    expect(script).toContain('format="audio/aac"');
    expect(script).toContain('%ogg(%opus(bitrate=64, samplerate=48000))');
    expect(script).toContain('%ogg(%vorbis.cbr(bitrate=128))');
    expect(script.match(/^output\.icecast\(/gm)).toHaveLength(3);
  });

  it('never lets settings text reach the script unescaped', () => {
    const { script } = renderStationScript({
      ...settings,
      name: 'x" #{shutdown()} "',
      description: 'a\nb',
    });
    expect(script).not.toContain('shutdown()');
    expect(script).not.toContain('a\nb');
  });

  it('versions the config by template and settings', () => {
    const template = loadStationTemplate();
    const a = renderStationScript(settings, template);
    // Key order and spelled-out defaults don't change the version.
    const b = renderStationScript(
      {
        outputs: settings.outputs,
        name: settings.name,
        stationId: 'vandale',
        live: { port: 8005 },
      },
      template,
    );
    expect(b.version).toBe(a.version);
    expect(renderStationScript({ ...settings, name: 'Other' }, template).version).not.toBe(
      a.version,
    );
    expect(renderStationScript(settings, `${template}\n# changed\n`).version).not.toBe(a.version);
    expect(a.version).toBe(configVersion(template, stationEngineSettingsSchema.parse(settings)));
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a template without its markers', () => {
    expect(() => renderStationScript(settings, 'x = 1\n')).toThrow(/@ondes:config/);
  });

  it('throws on invalid settings', () => {
    expect(() => renderStationScript({ ...settings, outputs: [] })).toThrow();
  });

  it('renders every combination checked by pnpm test:engine', () => {
    const versions = combos().map((c) => renderStationScript(c.settings).version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
