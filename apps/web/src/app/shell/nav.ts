import type { Permission } from '@ondes/shared';
import type { LinkProps } from '@tanstack/react-router';
import {
  AudioLinesIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  ClockIcon,
  LayoutDashboardIcon,
  LibraryBigIcon,
  LifeBuoyIcon,
  ListMusicIcon,
  type LucideIcon,
  MegaphoneIcon,
  MicIcon,
  RadioTowerIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
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
    to: '/stations/$stationId/shows/calendar',
    label: 'shell.nav.calendar',
    icon: CalendarDaysIcon,
    permission: 'show:read',
  },
  {
    to: '/stations/$stationId/shows',
    label: 'shell.nav.shows',
    icon: MicIcon,
    permission: 'show:read',
  },
  {
    to: '/stations/$stationId/live',
    label: 'shell.nav.live',
    icon: RadioTowerIcon,
    permission: 'live:read',
  },
  {
    to: '/stations/$stationId/log',
    label: 'shell.nav.log',
    icon: CalendarClockIcon,
    permission: 'log:read',
  },
  {
    to: '/stations/$stationId/voice-tracks/record',
    label: 'shell.nav.recordVt',
    icon: AudioLinesIcon,
    permission: 'voice_track:write_own',
  },
  {
    to: '/stations/$stationId/promos',
    label: 'shell.nav.promos',
    icon: MegaphoneIcon,
    permission: 'voice_track:read',
  },
  {
    to: '/stations/$stationId/library',
    label: 'shell.nav.library',
    icon: LibraryBigIcon,
    permission: 'library:read',
  },
  {
    to: '/stations/$stationId/categories',
    label: 'shell.nav.categories',
    icon: ListMusicIcon,
    permission: 'rotation:read',
  },
  {
    to: '/stations/$stationId/rotation/rules',
    label: 'shell.nav.rotationRules',
    icon: SlidersHorizontalIcon,
    permission: 'rotation:read',
  },
  {
    to: '/stations/$stationId/clocks',
    label: 'shell.nav.clocks',
    icon: ClockIcon,
    permission: 'clock:read',
  },
  {
    to: '/stations/$stationId/grid',
    label: 'shell.nav.grid',
    icon: CalendarRangeIcon,
    permission: 'clock:read',
  },
  {
    to: '/stations/$stationId/settings/safety',
    label: 'shell.nav.safety',
    icon: LifeBuoyIcon,
    permission: 'engine:read',
  },
];
