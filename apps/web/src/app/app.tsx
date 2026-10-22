import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RouterHistory, RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { Toaster } from '@/ui/sonner';
import { ThemeProvider } from '@/ui/theme-provider';
import { TooltipProvider } from '@/ui/tooltip';
import { createQueryClient } from './errors.ts';
import { I18nProvider, useI18n } from './i18n/i18n.tsx';
import type { Locale } from './i18n/messages.ts';
import { createAppRouter } from './router.tsx';

export interface AppProps {
  queryClient?: QueryClient;
  /** Tests pass a memory history. */
  history?: RouterHistory;
  locale?: Locale;
}

/** The whole app: providers, then the router. */
export function App({ queryClient: givenClient, history, locale }: AppProps) {
  const [queryClient] = useState(() => givenClient ?? createQueryClient());
  return (
    <ThemeProvider storageKey="ondes.theme">
      <I18nProvider locale={locale}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AppRouter queryClient={queryClient} history={history} />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function AppRouter({
  queryClient,
  history,
}: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  const { locale } = useI18n();
  const [localeRef] = useState(() => ({ current: locale }));
  localeRef.current = locale;
  const [router] = useState(() =>
    createAppRouter(queryClient, { history, locale: () => localeRef.current }),
  );
  return <RouterProvider router={router} />;
}
