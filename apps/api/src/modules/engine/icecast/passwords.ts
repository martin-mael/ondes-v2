import { createHmac } from 'node:crypto';

// Per-station Icecast source passwords. Every mount in the generated config carries its
// station's password (`<password>` in its `<mount>` block), and Icecast 2.5 then refuses any
// other password on that mount, the global one included. So a station's engine can source its
// own mounts and nothing else, even if its settings name another station's mount.
//
// Derived, not stored: HMAC of the station id under the master password
// (`ICECAST_SOURCE_PASSWORD`, set on the api and on the Icecast container). The master is
// Icecast's global source password, which only works on undeclared mounts. It must never be
// given to an engine: engines get `icecastSourcePassword(master, stationId)`.

export function icecastSourcePassword(master: string, stationId: string): string {
  if (master.length < 16) throw new Error('ICECAST_SOURCE_PASSWORD must be at least 16 characters');
  return createHmac('sha256', master)
    .update(`ondes-icecast-source:${stationId}`)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * The source password to give a station's engine (its `ICECAST_SOURCE_PASSWORD`). When the api
 * generates Icecast's config (`ICECAST_CONFIG_PATH`), the station's derived password; with a
 * static Icecast config (the dev stack), which has no per-mount passwords, the shared one.
 */
export function engineIcecastSourcePassword(
  env: { ICECAST_CONFIG_PATH?: string; ICECAST_SOURCE_PASSWORD?: string },
  stationId: string,
): string {
  const master = env.ICECAST_SOURCE_PASSWORD;
  if (!master) throw new Error('ICECAST_SOURCE_PASSWORD is not set');
  return env.ICECAST_CONFIG_PATH ? icecastSourcePassword(master, stationId) : master;
}
