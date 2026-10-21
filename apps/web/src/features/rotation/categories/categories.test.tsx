import type { CategoryDetail, CategoryPreview, MyOrg } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

// Categories pages on the whole app with a fake api: list, create with a live preview, edit
// with manual excludes, and the nav entry gated by `rotation:read`.

const at = '2026-10-21T08:00:00.000Z';
const categoryId = '01a15ddf-0000-7000-8000-0000000000c1';
const alpha = '01a15ddf-0000-7000-8000-0000000000d1';
const bravo = '01a15ddf-0000-7000-8000-0000000000d2';
const base = `/stations/${stationId}/categories`;

const programmerOrgs: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) => (s.id === stationId ? { ...s, role: 'programmer' } : s)),
}));

const asProgrammer = (routes: Record<string, ApiRoute> = {}): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: programmerOrgs }],
  [`GET /stations/${stationId}/tags`]: [
    200,
    { tags: [{ id: '01a15ddf-0000-7000-8000-0000000000e1', key: 'style', value: 'house' }] },
  ],
  ...routes,
});

const counts = {
  members: 2,
  schedulable: 2,
  ruleMatches: 2,
  manualOnly: 0,
  excluded: 0,
  totalDurationMs: 360_000,
};

const detail: CategoryDetail = {
  id: categoryId,
  orgId: orgs[0]?.id ?? '',
  stationId,
  name: 'House power',
  description: null,
  color: '#ff8800',
  assetType: 'song',
  rule: {
    kind: 'group',
    match: 'all',
    children: [{ kind: 'tag', key: 'style', op: 'any', values: ['house'] }],
  },
  rotationOrder: 'least_recently_played',
  searchDepthPercent: 100,
  restMinutes: 180,
  maxPlaysPerDay: null,
  maxPlaysPerWeek: null,
  members: [],
  counts,
  createdAt: new Date(at),
  updatedAt: new Date(at),
};

const preview = (overrides: Partial<CategoryPreview> = {}): CategoryPreview => ({
  counts,
  turnoverDays: null,
  items: [
    {
      assetId: alpha,
      title: 'Alpha',
      artists: ['A'],
      year: 1994,
      durationMs: 180_000,
      source: 'rule',
      schedulable: true,
    },
    {
      assetId: bravo,
      title: 'Bravo',
      artists: ['B'],
      year: null,
      durationMs: 180_000,
      source: 'rule',
      schedulable: true,
    },
  ],
  manual: [],
  ...overrides,
});

const previewCalls = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path === `${base}/preview`);

describe('categories', () => {
  it('lists categories with their counts, from the nav', async () => {
    const { screen, user, history } = renderApp(
      `/stations/${stationId}`,
      asProgrammer({
        [`GET ${base}`]: [
          200,
          { items: [{ ...detail, members: undefined, counts: { ...counts, schedulable: 1 } }] },
        ],
      }),
    );
    await user.click(await screen.findByRole('link', { name: 'Categories' }));
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/stations/${stationId}/categories`),
    );
    const row = (await screen.findByRole('link', { name: 'House power' })).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('Smart')).toBeVisible();
    expect(cells.getByText('1 schedulable')).toBeVisible();
    expect(cells.getByText('Least recently played')).toBeVisible();
  });

  it('hides the nav entry from roles without rotation:read', async () => {
    const { screen } = renderApp(`/stations/${stationId}`, signedIn());
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Categories' })).toBeNull();
  });

  it('creates a smart category with a live preview', async () => {
    const { screen, user, calls, history } = renderApp(
      `${base}/new`,
      asProgrammer({
        [`POST ${base}/preview`]: (body) => {
          const values = (body as { rule: CategoryDetail['rule'] }).rule?.children[0];
          const matched = values && 'values' in values && values.values.includes('house');
          return [
            200,
            matched
              ? preview({
                  turnoverDays: (body as { playsPerDay?: number }).playsPerDay ? 0.5 : null,
                })
              : preview({ counts: { ...counts, members: 0, ruleMatches: 0 }, items: [] }),
          ];
        },
        [`POST ${base}`]: [201, detail],
        [`GET ${base}/${categoryId}`]: [200, detail],
      }),
    );

    // The starting rule has no values yet: nothing is previewed until it's valid.
    await user.type(await screen.findByLabelText('Name'), 'House power');
    expect(previewCalls(calls)).toHaveLength(0);

    await user.type(screen.getByLabelText('Values, comma separated'), 'house');
    await waitFor(() => expect(screen.getByTestId('preview-members')).toHaveTextContent('2 songs'));
    expect(previewCalls(calls).at(-1)?.body).toMatchObject({
      assetType: 'song',
      rule: {
        kind: 'group',
        match: 'all',
        children: [{ kind: 'tag', key: 'style', op: 'any', values: ['house'] }],
      },
      members: [],
    });
    expect(screen.getByText('A – Alpha')).toBeVisible();

    await user.type(screen.getByLabelText('Plays per day'), '4');
    await waitFor(() =>
      expect(screen.getByTestId('preview-turnover')).toHaveTextContent(
        'Each song plays about every 0.5 days.',
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/stations/${stationId}/categories/${categoryId}`),
    );
    const create = calls.find((c) => c.method === 'POST' && c.path === base);
    expect(create?.body).toMatchObject({
      name: 'House power',
      assetType: 'song',
      rotationOrder: 'least_recently_played',
      searchDepthPercent: 100,
      restMinutes: 180,
      maxPlaysPerDay: null,
      members: [],
    });
  });

  it('refuses an empty name before calling the api', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/new`,
      asProgrammer({ [`POST ${base}/preview`]: [200, preview()] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'POST' && c.path === base)).toBe(false);
  });

  it('excludes a song from the preview and saves the manual list', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/${categoryId}`,
      asProgrammer({
        [`GET ${base}/${categoryId}`]: [200, detail],
        [`POST ${base}/preview`]: (body) => {
          const members = (body as { members: { assetId: string }[] }).members;
          return [
            200,
            members.length > 0
              ? preview({
                  counts: { ...counts, members: 1, schedulable: 1, excluded: 1 },
                  items: preview().items.slice(0, 1),
                  manual: [
                    {
                      assetId: bravo,
                      title: 'Bravo',
                      artists: ['B'],
                      mode: 'exclude',
                      effect: 'excluded',
                    },
                  ],
                })
              : preview(),
          ];
        },
        [`PATCH ${base}/${categoryId}`]: (body) => [
          200,
          { ...detail, ...(body as object), counts: { ...counts, members: 1, excluded: 1 } },
        ],
      }),
    );

    expect(await screen.findByLabelText('Name')).toHaveValue('House power');
    await user.click(await screen.findByRole('button', { name: 'Exclude Bravo' }));
    await waitFor(() => expect(screen.getByTestId('preview-members')).toHaveTextContent('1 songs'));
    const manual = within(screen.getByTestId('manual-members'));
    expect(manual.getByText('B – Bravo')).toBeVisible();
    expect(manual.getByText('Kept out')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        name: 'House power',
        members: [{ assetId: bravo, mode: 'exclude' }],
      }),
    );
  });

  it('shows a duplicate name on the name field', async () => {
    const { screen, user } = renderApp(
      `${base}/new`,
      asProgrammer({
        [`POST ${base}/preview`]: [200, preview()],
        [`POST ${base}`]: [409, { error: 'category_name_taken', message: 'taken' }],
      }),
    );
    await user.type(await screen.findByLabelText('Name'), 'House power');
    await user.click(screen.getByRole('button', { name: 'Remove the rule' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Another category already has this name.')).toBeVisible();
  });
});
