import { LanguagesIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { useTheme } from '@/ui/theme-provider';
import { useI18n } from '../i18n/i18n.tsx';
import { type Locale, locales } from '../i18n/messages.ts';

const localeNames: Record<Locale, string> = { en: 'English', fr: 'Français' };

type Theme = ReturnType<typeof useTheme>['theme'];

export function useThemeOptions() {
  const { t } = useI18n();
  return [
    { value: 'light', label: t('shell.theme.light'), icon: SunIcon },
    { value: 'dark', label: t('shell.theme.dark'), icon: MoonIcon },
    { value: 'system', label: t('shell.theme.system'), icon: MonitorIcon },
  ] as const satisfies readonly { value: Theme; label: string; icon: unknown }[];
}

/** Theme radio items, for any dropdown menu. */
export function ThemeMenuItems() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
        {useThemeOptions().map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

export function LanguageMenuItems() {
  const { t, locale, setLocale } = useI18n();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t('shell.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
        {locales.map((value) => (
          <DropdownMenuRadioItem key={value} value={value}>
            {localeNames[value]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** Icon buttons for signed-out pages: theme and language. */
export function PreferenceButtons() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const ThemeIcon = theme === 'dark' ? MoonIcon : theme === 'light' ? SunIcon : MonitorIcon;
  return (
    <div className="flex gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={t('shell.theme')} />}
        >
          <ThemeIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <ThemeMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={t('shell.language')} />}
        >
          <LanguagesIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <LanguageMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
