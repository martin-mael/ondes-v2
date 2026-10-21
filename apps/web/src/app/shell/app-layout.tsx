import { rolePermissions } from '@ondes/shared';
import { Link, Outlet, useParams } from '@tanstack/react-router';
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
  SidebarTrigger,
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
        <SidebarHeader>
          <StationSwitcher stationId={stationId} />
        </SidebarHeader>
        <SidebarContent>{stationId && <StationNav stationId={stationId} />}</SidebarContent>
        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
        </header>
        <div className="flex flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function StationNav({ stationId }: { stationId: string }) {
  const { t } = useI18n();
  const found = findStation(useOrgs(), stationId);
  if (!found) return null;
  const allowed = new Set(rolePermissions[found.station.role]);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{found.station.name}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {stationNav
            .filter((item) => !item.permission || allowed.has(item.permission))
            .map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  tooltip={t(item.label)}
                  render={
                    <Link
                      to={item.to}
                      params={{ stationId }}
                      activeOptions={{ exact: item.to === '/stations/$stationId' }}
                      activeProps={{ 'data-active': true }}
                    />
                  }
                >
                  <item.icon />
                  <span>{t(item.label)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
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
