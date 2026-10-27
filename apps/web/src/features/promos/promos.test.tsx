import type { MyOrg, Promo, PromoPlays, VtPool } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';

// The promos page (#60) on the whole app with a fake api: pools and promos with their status,
// validity in station time and plays; creating a pool and a promo (dates typed in station
// time, an incomplete daypart left out with a calm warning); a conflicting edit; the plays view.

const at = '2026-10-20T08:00:00.000Z';
const base = `/stations/${stationId}`;
const poolId = '01a15ddf-0000-7000-8000-0000000007a1';
const promoId = '01a15ddf-0000-7000-8000-0000000007b1';
const assetId = '01a15ddf-0000-7000-8000-0000000007c1';
const placementId = '01a15ddf-0000-7000-8000-0000000007d1';
const entryId = '01a15ddf-0000-7000-8000-0000000007e1';
const placedId = '01a15ddf-0000-7000-8000-0000000007d2';
const fromItemId = '01a15ddf-0000-7000-8000-0000000007f1';
const toItemId = '01a15ddf-0000-7000-8000-0000000007f2';
const segueId = '01a15ddf-0000-7000-8000-0000000007f3';

const withRole = (role: 'programmer' | 'presenter' | 'viewer'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const pool = (overrides: Partial<VtPool> = {}): VtPool => ({
  id: poolId,
  stationId,
  name: 'Events',
  description: 'Concerts and parties',
  color: '#ff0066',
  promoCount: 1,
  activeCount: 1,
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const promo = (overrides: Partial<Promo> = {}): Promo => ({
  id: promoId,
  stationId,
  assetId,
  title: 'Concert promo',
  assetType: 'vt',
  durationMs: 20_000,
  startAt: null,
  // 23:00 in Paris.
  killAt: new Date('2026-11-05T22:00:00Z'),
  showId: null,
  showName: null,
  eventName: 'Marché Gare',
  eventAt: null,
  weight: 2,
  maxPlaysPerDay: 6,
  dayparts: [],
  poolIds: [poolId],
  enabled: true,
  status: 'active',
  plays: { airedToday: 3, aired7d: 12, airedTotal: 40, planned: 9, lastAiredAt: null },
  version: 4,
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const as = (
  role: 'programmer' | 'presenter' | 'viewer',
  routes: Record<string, ApiRoute> = {},
): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: withRole(role) }],
  [`GET ${base}/vt-pools`]: [200, { items: [pool()] }],
  [`GET ${base}/promos`]: [200, { items: [promo()] }],
  [`GET ${base}/shows`]: [200, { items: [] }],
  ...routes,
});

const promoRow = (title: HTMLElement) => title.closest('li') as HTMLElement;

const lastCall = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).at(-1);

afterEach(() => vi.unstubAllGlobals());

describe('promos page', () => {
  it('lists pools and promos, with status, validity in station time and plays, from the nav', async () => {
    const { screen, user, history } = renderApp(base, as('programmer'));
    await user.click(await screen.findByRole('link', { name: 'Promos' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/promos`));
    const row = within(promoRow(await screen.findByText('Concert promo')));
    expect(screen.getByText('Concerts and parties')).toBeVisible();
    expect(screen.getByText('1 of 1 promos can air now')).toBeVisible();
    expect(row.getByText('Active')).toBeVisible();
    expect(row.getByText('Events')).toBeVisible();
    expect(row.getByText(/Until .*11:00\s?PM/)).toBeVisible();
    expect(row.getByText('· Weight 2')).toBeVisible();
    expect(row.getByText('· At most 6 a day')).toBeVisible();
    expect(row.getByText('Aired 3 today · 12 in 7 days · 40 in all · 9 planned')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New promo' })).toBeVisible();
  });

  it('shows a presenter the promos without edit buttons', async () => {
    const { screen } = renderApp(`${base}/promos`, as('presenter'));
    expect(await screen.findByText('Concert promo')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New promo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Plays' })).toBeVisible();
  });

  it('hides the nav entry from roles without voice_track:read', async () => {
    const { screen } = renderApp(base, as('viewer'));
    await screen.findByRole('link', { name: 'Log' });
    expect(screen.queryByRole('link', { name: 'Promos' })).toBeNull();
  });

  it('creates a pool', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/promos`,
      as('programmer', { [`POST ${base}/vt-pools`]: [201, pool({ name: 'Station' })] }),
    );
    await user.click(await screen.findByRole('button', { name: 'New pool' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'Station');
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(lastCall(calls, 'POST', `${base}/vt-pools`)).toBeDefined());
    expect(lastCall(calls, 'POST', `${base}/vt-pools`)?.body).toEqual({
      name: 'Station',
      description: null,
      color: null,
    });
  });

  it('creates a promo: kill date in station time, an incomplete daypart left out', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/promos`,
      as('programmer', {
        [`GET ${base}/assets`]: [
          200,
          {
            items: [
              {
                id: assetId,
                stationId,
                orgId: orgs[0]?.id,
                type: 'vt',
                title: 'Concert promo',
                artists: [],
                album: null,
                year: null,
                isrc: null,
                version: null,
                durationMs: 20_000,
                explicit: false,
                startAt: null,
                killAt: null,
                notes: null,
                metadata: {},
                sourceFilename: null,
                normalizeLoudness: true,
                gainOverrideDb: null,
                createdAt: at,
                updatedAt: at,
              },
            ],
            nextCursor: null,
          },
        ],
        [`POST ${base}/promos`]: [201, promo()],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'New promo' }));
    const dialog = within(await screen.findByRole('dialog'));
    // Nothing chosen yet: the voice track is the one required field.
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    expect(dialog.getByText('Choose the voice track to promote with.')).toBeVisible();

    await user.click(dialog.getByRole('button', { name: 'Choose a voice track' }));
    await user.click(await screen.findByRole('button', { name: 'Choose: Concert promo' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const form = within(screen.getByRole('dialog'));
    const [killDate, killTime] = form.getAllByLabelText('Kill') as HTMLElement[];
    await user.type(killDate as HTMLElement, '2026-11-05');
    await user.type(killTime as HTMLElement, '23:00');
    await user.click(form.getByRole('checkbox', { name: 'Events' }));
    await user.click(form.getByRole('button', { name: 'Add a daypart' }));
    expect(
      form.getByText('Pick at least one day: this daypart is ignored until then.'),
    ).toBeVisible();
    await user.click(form.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(lastCall(calls, 'POST', `${base}/promos`)).toBeDefined());
    expect(lastCall(calls, 'POST', `${base}/promos`)?.body).toMatchObject({
      assetId,
      // 23:00 in Paris on 5 November (CET) is 22:00 UTC.
      killAt: '2026-11-05T22:00:00.000Z',
      startAt: null,
      poolIds: [poolId],
      dayparts: [],
      weight: 1,
      maxPlaysPerDay: null,
      enabled: true,
    });
  });

  it('sends its version on edit, and reloads on a conflicting save', async () => {
    let saves = 0;
    const { screen, user, calls } = renderApp(
      `${base}/promos`,
      as('programmer', {
        [`PATCH ${base}/promos/${promoId}`]: () => {
          saves++;
          return [409, { error: 'version_conflict', message: 'the promo is at version 5' }];
        },
        [`GET ${base}/promos/${promoId}`]: [200, promo({ version: 5, weight: 3 })],
      }),
    );
    const row = within(promoRow(await screen.findByText('Concert promo')));
    await user.click(row.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    const weight = dialog.getByLabelText('Weight');
    await user.clear(weight);
    await user.type(weight, '4');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toBe(1));
    expect(lastCall(calls, 'PATCH', `${base}/promos/${promoId}`)?.body).toMatchObject({
      version: 4,
      weight: 4,
    });
    expect(await dialog.findByText(/Someone saved this promo meanwhile/)).toBeVisible();
    expect(dialog.getByLabelText('Weight')).toHaveValue(3);
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toBe(2));
    expect(lastCall(calls, 'PATCH', `${base}/promos/${promoId}`)?.body).toMatchObject({
      version: 5,
    });
  });

  it('shows the plays: aired per day, planned and dropped ones with why', async () => {
    const plays: PromoPlays = {
      promoId,
      from: '2026-10-13',
      to: '2026-10-14',
      items: [
        {
          kind: 'aired',
          playedAt: new Date('2026-10-13T10:00:00Z'),
          localDate: '2026-10-13',
          placementId: null,
          placementStatus: null,
          fromItemId: null,
          toItemId: null,
          segueId: null,
          asRunEntryId: entryId,
          detail: null,
        },
        {
          kind: 'planned',
          playedAt: new Date('2026-10-14T10:00:00Z'),
          localDate: '2026-10-14',
          placementId,
          placementStatus: 'dropped',
          fromItemId: null,
          toItemId: null,
          segueId: null,
          asRunEntryId: null,
          detail: 'regenerated: its songs were replaced',
        },
        {
          kind: 'planned',
          playedAt: new Date('2026-10-14T11:00:00Z'),
          localDate: '2026-10-14',
          placementId: placedId,
          placementStatus: 'placed',
          fromItemId,
          toItemId,
          segueId,
          asRunEntryId: null,
          detail: null,
        },
      ],
      airedByDay: [
        { date: '2026-10-13', count: 1 },
        { date: '2026-10-14', count: 0 },
      ],
    };
    const { screen, user } = renderApp(
      `${base}/promos`,
      as('presenter', { [`GET ${base}/promos/${promoId}/plays`]: [200, plays] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Plays' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('Aired')).toBeVisible();
    expect(dialog.getByText('Dropped')).toBeVisible();
    expect(dialog.getByText('regenerated: its songs were replaced')).toBeVisible();
    // Station time: 12:00 in Paris (CEST).
    expect(dialog.getAllByText(/12:00/)).toHaveLength(2);
    expect(dialog.getByRole('list', { name: 'Aired per day' })).toBeVisible();
    // A placed play opens its transition in the segue editor, on its log day.
    const link = dialog.getByRole('link', { name: 'Open the segue' });
    expect(link.getAttribute('href')).toBe(
      `${base}/log/segue?date=2026-10-14&from=${fromItemId}&to=${toItemId}`,
    );
  });
});
