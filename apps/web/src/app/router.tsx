import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { CategoriesPage } from '../features/rotation/categories/categories-page.tsx';
import {
  EditCategoryPage,
  NewCategoryPage,
} from '../features/rotation/categories/category-editor-page.tsx';
import { AcceptInvitationPage } from './auth/accept-invitation-page.tsx';
import { AccountPage } from './auth/account-page.tsx';
import { AuthLayout } from './auth/auth-layout.tsx';
import { LoginPage } from './auth/login-page.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './auth/password-pages.tsx';
import { findStation, homeStation, meQuery, orgsQuery, resetSession } from './auth/session.ts';
import { SignupPage } from './auth/signup-page.tsx';
import { VerifyEmailPage } from './auth/verify-email-page.tsx';
import { DashboardPage } from './dashboard/dashboard-page.tsx';
import { isGlobalApiError, setApiErrorHandler } from './errors.ts';
import { translate } from './i18n/i18n.tsx';
import type { Locale } from './i18n/messages.ts';
import { AppLayout, NoStationsPage, NotFoundPage, StationLayout } from './shell/app-layout.tsx';

// Routes, defined in code. Signed-out pages hang under `_auth`, signed-in ones under `_app`
// (guarded), station pages under `/stations/$stationId`. A feature adds its route here with
// `getParentRoute: () => stationRoute` and a nav entry in shell/nav.ts.

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Only same-app paths: `/x`, never `//evil.example`, `https://…`, `/\evil` or paths with
 * control characters (`/\t/evil` becomes `//evil` once browsers strip the tab).
 */
const internalPath = z
  .string()
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !/\p{Cc}/u.test(value),
  )
  .optional()
  .catch(undefined);
const token = z.string().min(1).optional().catch(undefined);

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

// --- Signed out --------------------------------------------------------------------------

const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  component: AuthLayout,
});

/** Signed-in users skip sign-in and sign-up. */
const redirectIfSignedIn = async (queryClient: QueryClient, to = '/') => {
  if (await queryClient.ensureQueryData(meQuery)) throw redirect({ href: to });
};

export const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/login',
  validateSearch: z.object({
    redirect: internalPath,
    notice: z.enum(['verified', 'reset']).optional().catch(undefined),
  }),
  beforeLoad: ({ context, search }) => redirectIfSignedIn(context.queryClient, search.redirect),
  component: LoginPage,
});

const signupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/signup',
  validateSearch: z.object({ invitation: token }),
  beforeLoad: ({ context }) => redirectIfSignedIn(context.queryClient),
  component: SignupPage,
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/verify-email',
  validateSearch: z.object({ token }),
  component: VerifyEmailPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/forgot-password',
  component: ForgotPasswordPage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/reset-password',
  validateSearch: z.object({ token }),
  component: ResetPasswordPage,
});

const acceptInvitationRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/invitations/accept',
  validateSearch: z.object({ token }),
  component: AcceptInvitationPage,
});

// --- Signed in ---------------------------------------------------------------------------

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: async ({ context, location }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(orgsQuery),
  component: AppLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/',
  beforeLoad: async ({ context }) => {
    const station = homeStation(await context.queryClient.ensureQueryData(orgsQuery));
    if (station) throw redirect({ to: '/stations/$stationId', params: { stationId: station.id } });
  },
  component: NoStationsPage,
});

const accountRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/account',
  validateSearch: z.object({
    reason: z.enum(['two_factor_required']).optional().catch(undefined),
  }),
  component: AccountPage,
});

export const stationRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/stations/$stationId',
  loader: async ({ context, params }) => {
    const orgs = await context.queryClient.ensureQueryData(orgsQuery);
    if (!findStation(orgs, params.stationId)) throw notFound();
  },
  component: StationLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: '/',
  component: DashboardPage,
});

// Music rotation: categories (#37).
const categoriesRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'categories',
  component: CategoriesPage,
});

const newCategoryRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'categories/new',
  component: NewCategoryPage,
});

const categoryRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'categories/$categoryId',
  component: EditCategoryPage,
});

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([
    loginRoute,
    signupRoute,
    verifyEmailRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    acceptInvitationRoute,
  ]),
  appLayout.addChildren([
    homeRoute,
    accountRoute,
    stationRoute.addChildren([dashboardRoute, categoriesRoute, newCategoryRoute, categoryRoute]),
  ]),
]);

export function createAppRouter(
  queryClient: QueryClient,
  options: { history?: RouterHistory; locale?: () => Locale } = {},
) {
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: options.history,
    defaultPreload: 'intent',
    // Loaders read from TanStack Query, which does the caching.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });

  const t = (key: Parameters<typeof translate>[1]) => translate(options.locale?.() ?? 'en', key);
  setApiErrorHandler((error) => {
    if (!isGlobalApiError(error)) return;
    const { pathname, href } = router.state.location;
    if (error.code === 'two_factor_required') {
      if (pathname === '/account') return;
      toast.error(t('error.two_factor_required'));
      void router.navigate({ to: '/account', search: { reason: 'two_factor_required' } });
      return;
    }
    // Session expired or revoked: back to sign-in, then back here.
    if (pathname === '/login') return;
    toast.error(t('error.session_expired'));
    void resetSession(queryClient).then(() =>
      router.navigate({ to: '/login', search: { redirect: href } }),
    );
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
