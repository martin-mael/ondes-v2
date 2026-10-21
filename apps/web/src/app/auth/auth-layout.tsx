import { Link, Outlet } from '@tanstack/react-router';
import { AudioWaveformIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { useI18n } from '../i18n/i18n.tsx';
import { PreferenceButtons } from '../shell/preferences.tsx';

/** Signed-out pages: a centered card. */
export function AuthLayout() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="flex items-center justify-between p-4">
        <Link to="/" className="flex items-center gap-2 font-heading text-sm font-semibold">
          <AudioWaveformIcon className="size-5 text-primary" />
          {t('app.name')}
        </Link>
        <PreferenceButtons />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="text-center text-xs text-muted-foreground">{footer}</div>}
    </div>
  );
}

export const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';
