import { createHmac } from 'node:crypto';

// Per-station Icecast source passwords. Every mount in the generated config carries its
// station's password (`<password>` in its `<mount>` block), and Icecast 2.5 then refuses any
// other password on that mount, the global one included. So a station's engine can source its
// own mounts and nothing else, even if its settings name another station's mount.
//
// With the engine lifecycle (#35), the password is the station's stored secret
// (`secretsFor(scope).icecastSourcePassword`, the one its engine gets). Without it (the api
// alone, tests), it is derived: an HMAC of the station id under `ICECAST_SOURCE_SECRET`.

export function icecastSourcePassword(secret: string, stationId: string): string {
  if (secret.length < 16) throw new Error('ICECAST_SOURCE_SECRET must be at least 16 characters');
  return createHmac('sha256', secret)
    .update(`ondes-icecast-source:${stationId}`)
    .digest('base64url')
    .slice(0, 32);
}
