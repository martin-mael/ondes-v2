import { localDateSchema } from '@ondes/shared';
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
import { AlertsPage, alertsSearchSchema } from '../features/alerts/alerts-page.tsx';
import { EditClockPage, NewClockPage } from '../features/clocks/clock-editor-page.tsx';
import { ClocksPage } from '../features/clocks/clocks-page.tsx';
import { CueEditorPage, cueEditorSearchSchema } from '../features/cue-editor/cue-editor-page.tsx';
import { GridPage } from '../features/grid/grid-page.tsx';
import { librarySearchParamsSchema } from '../features/library/filters.ts';
import { LibraryPage } from '../features/library/library-page.tsx';
import { LivePage } from '../features/live/live-page.tsx';
import { TimelinePage } from '../features/log-timeline/timeline-page.tsx';
import { CategoriesPage } from '../features/rotation/categories/categories-page.tsx';
import {
  EditCategoryPage,
  NewCategoryPage,
} from '../features/rotation/categories/category-editor-page.tsx';
import { RulesPage } from '../features/rotation/rules/rules-page.tsx';
import { SegueEditorPage } from '../features/segue-editor/segue-editor-page.tsx';
import { SafetyPage } from '../features/settings/safety/safety-page.tsx';
import { CalendarPage, calendarViews } from '../features/shows/calendar-page.tsx';
import { ShowPage } from '../features/shows/show-page.tsx';
import { ShowsPage } from '../features/shows/shows-page.tsx';
import { SegueRecorderPage, VtRecorderPage } from '../features/vt-recorder/vt-recorder-page.tsx';
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

// Library (#23): search, facets, bulk edits, uploads; filters and the open asset in the URL.
const libraryRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'library',
  validateSearch: librarySearchParamsSchema,
  component: LibraryPage,
});

// The cue editor (#24): one track's cue points on a full page; the library's filters ride
// along in the search params for the way back.
const cueEditorRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'library/$assetId/cues',
  validateSearch: cueEditorSearchSchema,
  component: CueEditorPage,
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

// Music rotation: separation and rotation rules (#38).
const rotationRulesRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'rotation/rules',
  component: RulesPage,
});

// Clocks (#39).
const clocksRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'clocks',
  component: ClocksPage,
});

const newClockRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'clocks/new',
  component: NewClockPage,
});

const clockRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'clocks/$clockId',
  component: EditClockPage,
});

// Weekly clock grid (#40).
const gridRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'grid',
  component: GridPage,
});

// Shows (#45): list, calendar, show page.
const showsRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'shows',
  component: ShowsPage,
});

const showsCalendarRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'shows/calendar',
  validateSearch: z.object({
    view: z.enum(calendarViews).optional().catch(undefined),
    date: localDateSchema.optional().catch(undefined),
    show: z.uuid().optional().catch(undefined),
  }),
  component: CalendarPage,
});

const showRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'shows/$showId',
  component: ShowPage,
});

// Alerts (#71): open by default, `?status=open|resolved|all&type=<alert type>`.
const alertsRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'alerts',
  validateSearch: alertsSearchSchema,
  component: AlertsPage,
});

const safetySettingsRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: '/settings/safety',
  component: SafetyPage,
});

// Live (#63): streamers (DJ credentials) and connection settings.
const liveRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'live',
  component: LivePage,
});

// The log timeline (#51): one station-local day, `?date=YYYY-MM-DD` (default: today).
const logRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'log',
  validateSearch: z.object({ date: localDateSchema.optional().catch(undefined) }),
  component: TimelinePage,
});

// The segue editor (#58): the transition from log item `from` to `to`, on station-local day
// `date` (the log the timeline shows). Opened from any transition in the timeline.
const segueRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'log/segue',
  validateSearch: z.object({
    date: localDateSchema.optional().catch(undefined),
    from: z.uuid().optional().catch(undefined),
    to: z.uuid().optional().catch(undefined),
    /** A take just recorded (#59) to place as a new voice, at axis position `at`. */
    voice: z.uuid().optional().catch(undefined),
    at: z.number().int().optional().catch(undefined),
    /** Back from the recorder (#59): restore the draft handed over to it. */
    resume: z.boolean().optional().catch(undefined),
  }),
  component: SegueEditorPage,
});

// The VT recorder (#59): a take for the transition `from` → `to`, recorded over its pre-roll,
// trimmed, uploaded as a `vt` asset and placed back in the segue editor.
const segueRecordRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'log/segue/record',
  validateSearch: z.object({
    date: localDateSchema.optional().catch(undefined),
    from: z.uuid().optional().catch(undefined),
    to: z.uuid().optional().catch(undefined),
  }),
  component: SegueRecorderPage,
});

// A standalone VT (a promo, #60), recorded without pre-roll and left in the library.
const vtRecordRoute = createRoute({
  getParentRoute: () => stationRoute,
  path: 'voice-tracks/record',
  component: VtRecorderPage,
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
    stationRoute.addChildren([
      dashboardRoute,
      alertsRoute,
      libraryRoute,
      cueEditorRoute,
      categoriesRoute,
      newCategoryRoute,
      categoryRoute,
      rotationRulesRoute,
      clocksRoute,
      newClockRoute,
      clockRoute,
      gridRoute,
      showsRoute,
      showsCalendarRoute,
      showRoute,
      safetySettingsRoute,
      liveRoute,
      logRoute,
      segueRoute,
      segueRecordRoute,
      vtRecordRoute,
    ]),
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
