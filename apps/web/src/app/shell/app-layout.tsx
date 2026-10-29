import { rolePermissions } from '@ondes/shared';
import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { RadioTowerIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '@/ui/sidebar';
import { findStation, lastStation, useOrgs } from '../auth/session.ts';
import { useI18n } from '../i18n/i18n.tsx';
import { SseProvider } from '../sse/sse.tsx';
import { stationNav } from './nav.ts';
import { StationSwitcher } from './station-switcher.tsx';
import { UserMenu } from './user-menu.tsx';

/** Signed-in layout: sidebar (switcher, station nav, user menu) and the page. */
export function AppLayout() {
  const { stationId } = useParams({ strict: false });
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        {/* As tall as a page's header bar, with the same rule under it: one band across. */}
        <SidebarHeader className="h-16 justify-center border-b">
          <StationSwitcher stationId={stationId} />
        </SidebarHeader>
        <SidebarContent>{stationId && <StationNav stationId={stationId} />}</SidebarContent>
        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      {/* No bar of its own: each page's header is the bar (app/page-header.tsx). */}
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

function StationNav({ stationId }: { stationId: string }) {
  const { t } = useI18n();
  const found = findStation(useOrgs(), stationId);
  const pathname = useLocation({ select: (location) => location.pathname });
  if (!found) return null;
  const allowed = new Set(rolePermissions[found.station.role]);
  const groups = stationNav
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.permission || allowed.has(item.permission)),
    }))
    .filter((group) => group.items.length > 0);
  // The deepest entry containing the current page is the active one, so the calendar
  // (`/shows/calendar`) doesn't also light up the shows entry (`/shows`).
  const active = groups
    .flatMap((group) => group.items)
    .map((item) => ({ to: item.to, path: item.to.replace('$stationId', stationId) }))
    .filter(({ path }) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.to;
  return groups.map((group) => (
    <SidebarGroup key={group.label}>
      <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {group.items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                tooltip={t(item.label)}
                isActive={item.to === active}
                render={<Link to={item.to} params={{ stationId }} />}
              >
                <item.icon />
                <span>{t(item.label)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  ));
}

/** `/stations/$stationId`: opens the station's event stream for every page below. */
export function StationLayout() {
  const { stationId } = useParams({ from: '/_app/stations/$stationId' });
  useEffect(() => lastStation.set(stationId), [stationId]);
  return (
    <SseProvider key={stationId} stationId={stationId}>
      <Outlet />
    </SseProvider>
  );
}

/** `/` for a user without any station. */
export function NoStationsPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <RadioTowerIcon className="size-10 text-muted-foreground" />
      <h1 className="font-heading text-lg font-semibold">{t('shell.noStations.title')}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t('shell.noStations.description')}</p>
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm text-muted-foreground">{t('shell.notFound')}</p>
      <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
        {t('shell.home')}
      </Button>
    </div>
  );
}
