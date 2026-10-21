import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

// Client for Icecast 2.5's XML admin API: `/admin/stats`, every source and its listener count.
// Admin credentials, internal network only: Caddy never proxies `/admin`.
//
// Not `/admin/listclients` (one mount's listeners): on Icecast 2.5.0, after any listclients
// request (XML or JSON) on a mount that had a listener, the next config reload (SIGHUP)
// deadlocks the server. Reproduced every time in the pinned image; `/admin/stats` is safe.
// The counts are all we keep anyway: no listener address, user agent or id (GDPR).

export type IcecastAdminOptions = {
  /** `http://icecast:8000`. */
  url: string;
  user: string;
  password: string;
  /** Per request. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class IcecastAdminError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IcecastAdminError';
    this.status = status;
  }
}

/** One source (a live mount or a fallback file being played) in `/admin/stats`. */
export type IcecastSource = {
  mount: string;
  /**
   * Something is streaming there. A mount declared in the config is listed even with no
   * source (once the config was reloaded), without a stream start.
   */
  connected: boolean;
  listeners: number;
  listenerPeak?: number;
  maxListeners?: number;
  contentType?: string;
  serverName?: string;
  /** Sent by the source client (Liquidsoap); absent for fallback files. */
  userAgent?: string;
};

export type IcecastStats = {
  serverId?: string;
  /** All listeners on the server. */
  listeners: number;
  sources: IcecastSource[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Icecast writes non-ASCII as numeric character references (`Radi&#xF3;`).
  htmlEntities: true,
  // Keep strings as strings (server names like "007"); numbers are coerced by zod below.
  parseTagValue: false,
  isArray: (name) => name === 'source',
});

const count = z.coerce.number().int().min(0);
const text = z.union([z.string(), z.number()]).transform(String);

const sourceSchema = z.looseObject({
  '@mount': z.string(),
  listeners: count.default(0),
  listener_peak: count.optional(),
  max_listeners: count.optional().catch(undefined), // "unlimited" when not set
  'content-type': text.optional(),
  server_name: text.optional(),
  user_agent: text.optional(),
  stream_start_iso8601: text.optional(),
});

const statsSchema = z.object({
  icestats: z.looseObject({
    server_id: text.optional(),
    listeners: count.default(0),
    source: z.array(sourceSchema).default([]),
  }),
});

export function parseStats(xml: string): IcecastStats {
  const parsed = statsSchema.safeParse(parser.parse(xml));
  if (!parsed.success)
    throw new IcecastAdminError(`unexpected /admin/stats answer: ${parsed.error.message}`);
  const s = parsed.data.icestats;
  return {
    serverId: s.server_id,
    listeners: s.listeners,
    sources: s.source.map((src) => ({
      mount: src['@mount'],
      connected: src.stream_start_iso8601 !== undefined,
      listeners: src.listeners,
      listenerPeak: src.listener_peak,
      maxListeners: src.max_listeners,
      contentType: src['content-type'],
      serverName: src.server_name,
      userAgent: src.user_agent,
    })),
  };
}

export type IcecastAdmin = {
  stats(): Promise<IcecastStats>;
};

export function createIcecastAdmin(options: IcecastAdminOptions): IcecastAdmin {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString('base64')}`;

  async function get(path: string): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: { authorization: auth, accept: 'text/xml' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new IcecastAdminError(`Icecast unreachable at ${base}`, undefined, { cause: err });
    }
    const body = await res.text();
    if (!res.ok) {
      throw new IcecastAdminError(
        `Icecast ${path.split('?')[0]} answered ${res.status}`,
        res.status,
      );
    }
    return body;
  }

  return {
    async stats() {
      return parseStats(await get('/admin/stats'));
    },
  };
}
