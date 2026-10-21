import { useNavigate } from '@tanstack/react-router';
import { CheckIcon, ChevronsUpDownIcon, RadioTowerIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/ui/sidebar';
import { findStation, useOrgs } from '../auth/session.ts';
import { useI18n } from '../i18n/i18n.tsx';

/** Org/station switcher from the user's memberships (`GET /api/v1/orgs`). */
export function StationSwitcher({ stationId }: { stationId: string | undefined }) {
  const { t } = useI18n();
  const orgs = useOrgs();
  const navigate = useNavigate();
  const current = stationId ? findStation(orgs, stationId) : null;
  const hasStations = orgs.some((org) => org.stations.length > 0);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!hasStations}
            render={
              <SidebarMenuButton
                size="lg"
                aria-label={t('shell.station')}
                className="data-popup-open:bg-sidebar-accent"
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <RadioTowerIcon className="size-4" />
            </div>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-heading font-semibold">
                {current?.station.name ?? t('app.name')}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {current?.org.name ?? t('shell.stations')}
              </span>
            </div>
            {hasStations && <ChevronsUpDownIcon className="ml-auto" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-60">
            {orgs
              .filter((org) => org.stations.length > 0)
              .map((org, index) => (
                <DropdownMenuGroup key={org.id}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{org.name}</DropdownMenuLabel>
                  {org.stations.map((station) => (
                    <DropdownMenuItem
                      key={station.id}
                      onClick={() =>
                        navigate({ to: '/stations/$stationId', params: { stationId: station.id } })
                      }
                    >
                      <span className="flex-1 truncate">{station.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`role.${station.role}`)}
                      </span>
                      {station.id === stationId && <CheckIcon />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
