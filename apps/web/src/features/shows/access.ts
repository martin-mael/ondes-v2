import { rolePermissions, type Show } from '@ondes/shared';
import { findStation, useMe, useOrgs } from '../../app/auth/session.ts';

// What the signed-in user may do with the station's shows. The api checks again: this only
// hides what would be refused. `show:write` manages shows, slots and exceptions; hosts with
// `show:write_own` edit their own shows and episodes (routes.ts in apps/api/src/modules/shows).

export interface ShowAccess {
  /** The station's IANA timezone: every time on these pages is station-local. */
  timezone: string;
  /** Create and delete shows, edit slots, exceptions and hosts. */
  canManage: boolean;
  /** Edit the show's details and its episodes. */
  canEdit(show: Pick<Show, 'hosts'>): boolean;
  /** Attach an existing library asset (needs to search the library). */
  canSearchLibrary: boolean;
  userId: string;
}

export function useShowAccess(stationId: string): ShowAccess {
  const me = useMe();
  const found = findStation(useOrgs(), stationId);
  const allowed = new Set(found ? rolePermissions[found.station.role] : []);
  const canManage = allowed.has('show:write');
  const writeOwn = allowed.has('show:write_own');
  return {
    timezone: found?.station.timezone ?? 'UTC',
    canManage,
    canEdit: (show) => canManage || (writeOwn && show.hosts.some((h) => h.userId === me.user.id)),
    canSearchLibrary: allowed.has('library:read'),
    userId: me.user.id,
  };
}
