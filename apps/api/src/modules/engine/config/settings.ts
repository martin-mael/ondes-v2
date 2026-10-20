import { z } from 'zod';

/**
 * Engine settings of one station: everything the Liquidsoap script template
 * (`engine/templates/station.liq`) is rendered from. Changing them regenerates the script,
 * whose config version changes with it, and restarts the station's engine.
 *
 * Secrets are not settings: the control token, the shared live password and the Icecast
 * source password reach the engine through its container environment, so the rendered
 * script can be stored and versioned. See the template's header.
 */

const port = z.int().min(1024).max(65535);
/** Mounts, ids and similar names: no spaces, no quotes, nothing to escape. */
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const absolutePath = z.string().regex(/^\/[^\0]*$/, 'must be an absolute path');
const hostname = z.string().regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/);
const httpUrl = z.url({ protocol: /^https?$/ });

/** Encoders available in the pinned Liquidsoap image without licensed components. */
export const outputFormatSchema = z.enum(['mp3', 'aac', 'opus', 'vorbis']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

/** Bitrates (kbps) each encoder accepts. MP3 is restricted to the standard CBR steps. */
export const OUTPUT_BITRATES: Record<
  OutputFormat,
  readonly number[] | { min: number; max: number }
> = {
  mp3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  aac: { min: 32, max: 320 },
  opus: { min: 16, max: 256 },
  vorbis: { min: 64, max: 320 },
};

export function bitrateAllowed(format: OutputFormat, kbps: number): boolean {
  const allowed = OUTPUT_BITRATES[format];
  return 'min' in allowed ? kbps >= allowed.min && kbps <= allowed.max : allowed.includes(kbps);
}

export const icecastOutputSchema = z
  .object({
    /** Icecast mount, without the leading slash: `vandale.mp3`. */
    mount: name.max(64),
    format: outputFormatSchema,
    /** kbps. */
    bitrate: z.int(),
    /** Listed in the Icecast directory (YP). */
    public: z.boolean().default(false),
  })
  .refine((o) => bitrateAllowed(o.format, o.bitrate), {
    message: 'bitrate not supported by this format',
    path: ['bitrate'],
  });
export type IcecastOutput = z.output<typeof icecastOutputSchema>;

export const stationEngineSettingsSchema = z
  .object({
    /** Station id, used in event envelopes and metric labels. */
    stationId: name.max(128),
    /** Stream metadata sent to Icecast. */
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    genre: z.string().max(100).optional(),
    /** Station website, sent to Icecast. */
    url: httpUrl.optional(),

    control: z.object({ port: port.default(7000) }).prefault({}),
    metrics: z.object({ port: port.default(9599) }).prefault({}),
    /** Where the engine POSTs its events (the adapter, #28). Unset: Node pulls them. */
    eventsUrl: httpUrl.optional(),

    live: z
      .object({
        /** Listen for live DJs at all. Off: no live port, `POST /v1/live` answers 409. */
        enabled: z.boolean().default(true),
        port: port.default(8005),
        mount: name.max(64).default('live'),
        /** Node's live auth webhook. Unset: the shared ENGINE_LIVE_PASSWORD. */
        authUrl: httpUrl.optional(),
        /** Seconds buffered before a DJ can take the air, and the buffer's maximum. */
        buffer: z.number().min(1).max(30).default(5),
        maxBuffer: z.number().min(2).max(60).default(10),
      })
      .prefault({})
      .refine((l) => l.maxBuffer > l.buffer, {
        message: 'must be above buffer',
        path: ['maxBuffer'],
      }),

    /** Local paths in the station's playout cache. */
    paths: z
      .object({
        safetyDir: absolutePath.default('/media/safety'),
        emergencyFile: absolutePath.default('/media/emergency.flac'),
      })
      .prefault({}),

    /** Default crossfade, for items that don't set cross_in / cross_out. Seconds. */
    crossfade: z.object({ duration: z.number().min(0.1).max(20).default(3) }).prefault({}),

    blank: z
      .object({
        /** Seconds of silence before `blank.detected`. */
        maxSeconds: z.number().min(1).max(300).default(10),
        thresholdDb: z.number().min(-90).max(0).default(-40),
      })
      .prefault({}),

    /** Built-in processing on the final mix (live included). No licensed components. */
    processing: z
      .object({
        compressor: z
          .object({
            enabled: z.boolean().default(true),
            thresholdDb: z.number().min(-60).max(0).default(-18),
            ratio: z.number().min(1).max(20).default(3),
            attackMs: z.number().min(0.1).max(500).default(20),
            releaseMs: z.number().min(1).max(5000).default(250),
            kneeDb: z.number().min(0).max(24).default(6),
            /** Make-up gain. */
            gainDb: z.number().min(-12).max(24).default(0),
          })
          .prefault({}),
        limiter: z
          .object({
            enabled: z.boolean().default(true),
            thresholdDb: z.number().min(-20).max(0).default(-1),
            releaseMs: z.number().min(1).max(5000).default(200),
          })
          .prefault({}),
      })
      .prefault({}),

    icecast: z
      .object({
        host: hostname.default('icecast'),
        port: z.int().min(1).max(65535).default(8000),
      })
      .prefault({}),
    outputs: z.array(icecastOutputSchema).min(1).max(8),
  })
  .superRefine((s, ctx) => {
    const mounts = s.outputs.map((o) => o.mount);
    mounts.forEach((m, i) => {
      if (mounts.indexOf(m) !== i)
        ctx.addIssue({ code: 'custom', message: 'duplicate mount', path: ['outputs', i, 'mount'] });
    });
    const ports: [string, number][] = [
      ['control', s.control.port],
      ['metrics', s.metrics.port],
      ...(s.live.enabled ? [['live', s.live.port] as [string, number]] : []),
    ];
    ports.forEach(([key, p], i) => {
      if (ports.findIndex(([, q]) => q === p) !== i)
        ctx.addIssue({ code: 'custom', message: 'port already in use', path: [key, 'port'] });
    });
  });

/** What a caller passes (defaults optional). */
export type StationEngineSettingsInput = z.input<typeof stationEngineSettingsSchema>;
/** Settings with every default applied: what the template is rendered from. */
export type StationEngineSettings = z.output<typeof stationEngineSettingsSchema>;
