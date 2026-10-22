// The harbor auth route (#63), apart from its handler so the engine lifecycle can render the
// URL into each station's script without importing the live module.

export const LIVE_AUTH_ROUTE = '/internal/engine/stations/:stationId/live-auth';

/** The template's `live_auth_url` for a station's engine, given the api's internal base URL. */
export function liveAuthUrl(internalBaseUrl: string, stationId: string): string {
  return (
    internalBaseUrl.replace(/\/+$/, '') +
    LIVE_AUTH_ROUTE.replace(':stationId', encodeURIComponent(stationId))
  );
}
