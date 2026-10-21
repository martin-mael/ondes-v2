import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronsUpDownIcon, LogOutIcon, UserIcon } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/ui/avatar';
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
import { authApi } from '../api/auth.ts';
import { resetSession, useMe } from '../auth/session.ts';
import { useI18n } from '../i18n/i18n.tsx';
import { LanguageMenuItems, ThemeMenuItems } from './preferences.tsx';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function UserMenu() {
  const { t } = useI18n();
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      await resetSession(queryClient);
      await navigate({ to: '/login' });
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <Avatar className="size-8 rounded-md">
              <AvatarFallback className="rounded-md">{initials(me.user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-medium">{me.user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{me.user.email}</DropdownMenuLabel>
              <DropdownMenuItem render={<Link to="/account" />}>
                <UserIcon />
                {t('shell.nav.account')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <ThemeMenuItems />
            <DropdownMenuSeparator />
            <LanguageMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout}>
              <LogOutIcon />
              {t('shell.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
