import type { Permission } from '@ondes/shared';
import type { LinkProps } from '@tanstack/react-router';
import { LayoutDashboardIcon, ListMusicIcon, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n/messages.ts';

// Station navigation in the sidebar. Features add one entry here when they add their route
// under `/stations/$stationId` (app/router.tsx).

type StationPath = Extract<NonNullable<LinkProps['to']>, `/stations/$stationId${string}`>;

export interface NavItem {
  /** A route under `/stations/$stationId`. */
  to: StationPath;
  label: MessageKey;
  icon: LucideIcon;
  /** Hidden from roles without it. Permissions are checked by the api regardless. */
  permission?: Permission;
}

export const stationNav: NavItem[] = [
  {
    to: '/stations/$stationId',
    label: 'shell.nav.dashboard',
    icon: LayoutDashboardIcon,
    permission: 'dashboard:read',
  },
  {
    to: '/stations/$stationId/categories',
    label: 'shell.nav.categories',
    icon: ListMusicIcon,
    permission: 'rotation:read',
  },
];
