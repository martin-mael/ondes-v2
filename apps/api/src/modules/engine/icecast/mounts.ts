import { z } from 'zod';
import {
  defaultStationOutputs,
  type IcecastOutput,
  icecastOutputSchema,
  mountsOutsideNamespace,
  type OutputFormat,
} from '../config/settings.ts';

// Mount plan: what Icecast serves for each station, derived from the station's engine settings
// (`outputs`). Every mount lives in the station's namespace `/<station-slug>/…` and has the
// station's own source password (passwords.ts), so stations can't take each other's mounts.
// The same plan drives the Icecast config (config.ts) and the listener stats poller (poller.ts).

/** Webroot folder of the per-mount files (fallback loop, intro): `/_ondes/<mount>.<kind>.<ext>`. */
export const STREAM_ASSETS_DIR = '_ondes';

export { defaultStationOutputs, opusOutput } from '../config/settings.ts';

const FORMAT_FILES: Record<OutputFormat, { contentType: string; extension: string }> = {
  mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
  aac: { contentType: 'audio/aac', extension: 'aac' },
  // Icecast serves webroot files by extension: `.ogg` is the one it knows as Ogg.
  opus: { contentType: 'application/ogg', extension: 'ogg' },
  vorbis: { contentType: 'application/ogg', extension: 'ogg' },
};

export type StreamAssetKind = 'fallback' | 'intro';

/** Webroot path of a mount's fallback or intro file: `/_ondes/vandale/mp3.fallback.mp3`. */
export function streamAssetPath(mount: string, format: OutputFormat, kind: StreamAssetKind) {
  return `/${STREAM_ASSETS_DIR}/${mount.replace(/^\//, '')}.${kind}.${FORMAT_FILES[format].extension}`;
}

/** One Icecast mount of one station. */
export type StreamMount = {
  stationId: string;
  orgId: string;
  slug: string;
  /** With its leading slash: `/vandale/mp3`. */
  mount: string;
  format: OutputFormat;
  bitrate: number;
  contentType: string;
  public: boolean;
  maxListeners: number;
  burstSize: number;
  queueSize: number;
  /** Webroot file listeners fall back to; the emergency loop in this mount's format. */
  fallbackFile?: string;
  /** Webroot file played to each new listener first. */
  introFile?: string;
};

/** The station columns the plan needs. */
export type StreamStation = {
  id: string;
  orgId: string;
  slug: string;
  /** `station.engine_settings`: only its `outputs` is read here. */
  engineSettings: unknown;
};

export class StationOutputsError extends Error {
  readonly stationId: string;
  readonly orgId: string;
  /** Without the station prefix, for alerts. */
  readonly reason: string;
  constructor(station: { id: string; orgId: string }, reason: string) {
    super(`station ${station.id}: ${reason}`);
    this.name = 'StationOutputsError';
    this.stationId = station.id;
    this.orgId = station.orgId;
    this.reason = reason;
  }
}

const outputsSchema = z.array(icecastOutputSchema).min(1).max(8);

/**
 * The station's outputs: `engine_settings.outputs` when set, else the defaults. Throws a
 * StationOutputsError when they are invalid or leave the station's namespace.
 */
export function stationOutputs(station: StreamStation): IcecastOutput[] {
  const settings = (station.engineSettings ?? {}) as { outputs?: unknown };
  const parsed = outputsSchema.safeParse(settings.outputs ?? defaultStationOutputs(station.slug));
  if (!parsed.success) {
    throw new StationOutputsError(station, `invalid outputs: ${z.prettifyError(parsed.error)}`);
  }
  const outside = mountsOutsideNamespace(station.slug, parsed.data);
  if (outside.length > 0) {
    throw new StationOutputsError(station, `mount "${outside[0]}" is not under "${station.slug}/"`);
  }
  const mounts = parsed.data.map((o) => o.mount);
  const dup = mounts.find((m, i) => mounts.indexOf(m) !== i);
  if (dup) throw new StationOutputsError(station, `duplicate mount "${dup}"`);
  return parsed.data;
}

export function stationMounts(station: StreamStation): StreamMount[] {
  return stationOutputs(station).map((o) => ({
    stationId: station.id,
    orgId: station.orgId,
    slug: station.slug,
    mount: `/${o.mount}`,
    format: o.format,
    bitrate: o.bitrate,
    contentType: FORMAT_FILES[o.format].contentType,
    public: o.public,
    maxListeners: o.maxListeners,
    burstSize: o.burstSize,
    queueSize: o.queueSize,
    ...(o.fallback ? { fallbackFile: streamAssetPath(o.mount, o.format, 'fallback') } : {}),
    ...(o.intro ? { introFile: streamAssetPath(o.mount, o.format, 'intro') } : {}),
  }));
}

export type MountPlan = {
  mounts: StreamMount[];
  /** Stations left out of the plan (invalid outputs): their streams are not served. */
  skipped: StationOutputsError[];
};

/**
 * Plan for every station. A station with broken settings is skipped and reported, so it can't
 * take the other stations' streams down with it.
 */
export function planMounts(stations: StreamStation[]): MountPlan {
  const mounts: StreamMount[] = [];
  const skipped: StationOutputsError[] = [];
  for (const station of [...stations].sort((a, b) => a.slug.localeCompare(b.slug))) {
    try {
      mounts.push(...stationMounts(station));
    } catch (err) {
      if (!(err instanceof StationOutputsError)) throw err;
      skipped.push(err);
    }
  }
  return { mounts, skipped };
}
