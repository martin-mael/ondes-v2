import {
  type ClockDetail,
  type ClockPreview,
  type ClockSlot,
  clockSlotSchema,
  type DraftClockEstimate,
  draftClockEstimateSchema,
  estimateClock,
  type MyOrg,
  slotCategoryId,
} from '@ondes/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';

// Clock pages on the whole app with a fake api: list from the nav, create a clock slot by slot
// with a live timeline, reorder by buttons and by drag, warnings, and the sample hour.

const at = '2026-10-21T08:00:00.000Z';
const clockId = '01a15ddf-0000-7000-8000-0000000000a1';
const gold = '01a15ddf-0000-7000-8000-0000000000c1';
const ids = '01a15ddf-0000-7000-8000-0000000000c2';
const base = `/stations/${stationId}/clocks`;
const MIN = 60_000;

const programmerOrgs: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) => (s.id === stationId ? { ...s, role: 'programmer' } : s)),
}));

const counts = {
  members: 2,
  schedulable: 2,
  ruleMatches: 2,
  manualOnly: 0,
  excluded: 0,
  totalDurationMs: 8 * MIN,
};
const category = (id: string, name: string, color: string, assetType: string) => ({
  id,
  orgId: orgs[0]?.id,
  stationId,
  name,
  description: null,
  color,
  assetType,
  rule: null,
  rotationOrder: 'least_recently_played',
  searchDepthPercent: 100,
  restMinutes: 180,
  maxPlaysPerDay: null,
  maxPlaysPerWeek: null,
  counts,
  createdAt: at,
  updatedAt: at,
});

/** The api's estimate, with the fixture categories: songs of 4 min, IDs of 10 s. */
function estimate(draft: DraftClockEstimate) {
  const parsed = draftClockEstimateSchema.parse(draft);
  const lengths: Record<string, [number, 'song' | 'jingle']> = {
    [gold]: [4 * MIN, 'song'],
    [ids]: [10_000, 'jingle'],
  };
  return estimateClock(parsed, (slot) => {
    const id = slotCategoryId(slot);
    if (!id) return undefined;
    const ref = lengths[id];
    return ref
      ? { exists: true, durationMs: ref[0], assetType: ref[1] }
      : { exists: false, durationMs: null, assetType: null };
  });
}

const slot = (input: object): ClockSlot => clockSlotSchema.parse(input);
const savedSlots = [
  slot({ kind: 'marker', offsetMs: 0, label: 'Top' }),
  slot({ kind: 'jingle', categoryId: ids }),
  slot({ kind: 'category', categoryId: gold }),
  slot({ kind: 'vt' }),
];
const detail = (slots: ClockSlot[] = savedSlots, version = 3): ClockDetail => ({
  id: clockId,
  orgId: orgs[0]?.id ?? '',
  stationId,
  name: 'Daytime',
  description: null,
  color: '#3366ff',
  targetDurationMs: 60 * MIN,
  slots,
  version,
  estimate: estimate({ targetDurationMs: 60 * MIN, slots }),
  createdAt: new Date(at),
  updatedAt: new Date(at),
});

const asProgrammer = (routes: Record<string, ApiRoute> = {}): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: programmerOrgs }],
  [`GET /stations/${stationId}/categories`]: [
    200,
    {
      items: [
        category(gold, 'Gold', '#ffaa00', 'song'),
        category(ids, 'Station IDs', '#00aa88', 'jingle'),
      ],
    },
  ],
  [`POST ${base}/estimate`]: (body) => [200, estimate(body as DraftClockEstimate)],
  ...routes,
});

const lastCall = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).at(-1);

describe('clocks', () => {
  it('lists clocks with their length and status, from the nav', async () => {
    const { screen, user, history } = renderApp(
      `/stations/${stationId}`,
      asProgrammer({ [`GET ${base}`]: [200, { items: [detail()] }] }),
    );
    await user.click(await screen.findByRole('link', { name: 'Clocks' }));
    await waitFor(() => expect(history.location.pathname).toBe(base));
    const row = (await screen.findByRole('link', { name: 'Daytime' })).closest('tr');
    const cells = within(row as HTMLElement);
    expect(cells.getByText('1:00:00')).toBeVisible();
    expect(cells.getByText('4')).toBeVisible();
    // 4:40 of 60:00.
    expect(cells.getByText('1 warning')).toBeVisible();
    expect(cells.getByRole('img', { name: 'Clock timeline' })).toBeVisible();
  });

  it('hides the nav entry from roles without clock:read', async () => {
    const { screen } = renderApp(`/stations/${stationId}`, signedIn());
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Clocks' })).toBeNull();
  });

  it('builds a new clock slot by slot, with a live timeline', async () => {
    const { screen, user, calls, history } = renderApp(
      `${base}/new`,
      asProgrammer({
        [`POST ${base}`]: [201, detail()],
        [`GET ${base}/${clockId}`]: [200, detail()],
      }),
    );
    await user.type(await screen.findByLabelText('Name'), 'Daytime');
    await user.clear(screen.getByLabelText('Length (minutes)'));
    await user.type(screen.getByLabelText('Length (minutes)'), '10');

    await user.click(screen.getByRole('button', { name: 'Timing marker' }));
    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.click(screen.getByRole('button', { name: 'Category' }));
    const second = within(screen.getByRole('listitem', { name: '2. Category' }));
    await user.selectOptions(second.getByLabelText('Category'), 'Gold');
    const third = within(screen.getByRole('listitem', { name: '3. Category' }));
    await user.selectOptions(third.getByLabelText('Category'), 'Gold');
    await user.type(third.getByLabelText('Length'), '3:30');

    // 4:00 + 3:30 of 10:00: underfilled, then a fill takes the slack.
    await waitFor(() => expect(screen.getByText('7:30 of 10:00')).toBeVisible());
    expect(screen.getByText('Underfilled by 2:30.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    await waitFor(() => expect(screen.getByText('Timing looks right.')).toBeVisible());
    expect(screen.getByText('10:00 of 10:00')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/${clockId}`));
    expect(lastCall(calls, 'POST', base)?.body).toEqual({
      name: 'Daytime',
      description: null,
      color: null,
      targetDurationMs: 10 * MIN,
      slots: [
        { kind: 'marker', label: null, durationMs: null, timing: 'hard', offsetMs: 0, capMs: null },
        { kind: 'category', label: null, durationMs: null, categoryId: gold },
        { kind: 'category', label: null, durationMs: 210_000, categoryId: gold },
        { kind: 'fill', label: null, durationMs: null, categoryId: null },
      ],
    });
  });

  it('reorders slots with the arrows and by drag, and saves the new order', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail()],
        [`PATCH ${base}/${clockId}`]: (body) => [
          200,
          detail((body as { slots: ClockSlot[] }).slots),
        ],
      }),
    );
    const vt = await screen.findByRole('listitem', { name: '4. Voice track' });
    await user.click(within(vt).getByRole('button', { name: 'Move up' }));
    expect(screen.getByRole('listitem', { name: '3. Voice track' })).toBeVisible();

    // Drag the jingle (2) onto the first slot.
    const jingle = screen.getByRole('listitem', { name: '2. Jingle / ID' });
    fireEvent.pointerDown(within(jingle).getByRole('button', { name: 'Drag to reorder' }));
    fireEvent.dragStart(jingle, { dataTransfer: { setData() {}, effectAllowed: '' } });
    const first = screen.getByRole('listitem', { name: '1. Timing marker' });
    fireEvent.dragOver(first);
    fireEvent.drop(first);
    expect(screen.getByRole('listitem', { name: '1. Jingle / ID' })).toBeVisible();

    // A jingle before the hard top-of-hour marker overruns it.
    await waitFor(() =>
      expect(screen.getByText('Slot 2: the slots before this marker run 0:10 late.')).toBeVisible(),
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastCall(calls, 'PATCH', `${base}/${clockId}`)).toBeDefined());
    const body = lastCall(calls, 'PATCH', `${base}/${clockId}`)?.body as {
      slots: ClockSlot[];
      version: number;
    };
    expect(body.version).toBe(3);
    expect(body.slots.map((s) => s.kind)).toEqual(['jingle', 'marker', 'vt', 'category']);
  });

  it('sends the saved version next time, and reports a conflicting save', async () => {
    let saves = 0;
    const { screen, user, calls } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail(savedSlots, 7)],
        [`PATCH ${base}/${clockId}`]: (body) => {
          saves++;
          return saves === 1
            ? [200, detail((body as { slots: ClockSlot[] }).slots, 4)]
            : [409, { error: 'edit_conflict', message: 'changed', details: { version: 7 } }];
        },
      }),
    );
    const name = await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toBe(1));
    await user.type(name, ' 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText(/Someone saved this clock while you were editing it/)).toBeVisible(),
    );
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    // The loaded version, then the one the first save returned.
    expect(patches.map((b) => (b as { version: number }).version)).toEqual([7, 4]);

    // Reload drops the draft for the saved clock and its version.
    await user.click(screen.getByRole('button', { name: 'Reload the clock' }));
    await waitFor(() => expect(screen.queryByText(/Someone saved this clock/)).toBeNull());
    expect(screen.getByLabelText('Name')).toHaveValue('Daytime');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves).toBe(3));
    expect(
      (lastCall(calls, 'PATCH', `${base}/${clockId}`)?.body as { version: number } | undefined)
        ?.version,
    ).toBe(7);
  });

  it('deletes the clock after confirmation', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { screen, user, calls, history } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail()],
        [`DELETE ${base}/${clockId}`]: [204],
        [`GET ${base}`]: [200, { items: [] }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith('Delete this clock? The weekly grid will lose it.');
    await waitFor(() => expect(history.location.pathname).toBe(base));
    expect(lastCall(calls, 'DELETE', `${base}/${clockId}`)).toBeDefined();
    expect(await screen.findByText('No clock yet. Create one to design an hour.')).toBeVisible();
    vi.unstubAllGlobals();
  });

  it('drops the promo category when a voice track becomes a placeholder', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [
          200,
          detail([slot({ kind: 'vt', mode: 'promo', categoryId: ids })]),
        ],
        [`PATCH ${base}/${clockId}`]: (body) => [
          200,
          detail((body as { slots: ClockSlot[] }).slots),
        ],
      }),
    );
    const vt = within(await screen.findByRole('listitem', { name: '1. Voice track' }));
    await waitFor(() => expect(vt.getByLabelText('Category')).toHaveValue(ids));
    await user.selectOptions(vt.getByLabelText('Voice track'), 'Record later');
    expect(vt.queryByLabelText('Category')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastCall(calls, 'PATCH', `${base}/${clockId}`)).toBeDefined());
    expect(
      (lastCall(calls, 'PATCH', `${base}/${clockId}`)?.body as { slots: unknown[] } | undefined)
        ?.slots,
    ).toEqual([
      { kind: 'vt', mode: 'placeholder', categoryId: null, label: null, durationMs: null },
    ]);
  });

  it('draws a promo slot from a VT pool, the category only while no pool is chosen', async () => {
    const poolId = '01a15ddf-0000-7000-8000-0000000000d1';
    const { screen, user, calls } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail([slot({ kind: 'vt', mode: 'promo' })])],
        [`GET /stations/${stationId}/vt-pools`]: [
          200,
          {
            items: [
              {
                id: poolId,
                stationId,
                name: 'Events',
                description: null,
                color: '#ff0066',
                promoCount: 2,
                activeCount: 1,
                createdAt: at,
                updatedAt: at,
              },
            ],
          },
        ],
        [`PATCH ${base}/${clockId}`]: (body) => [
          200,
          detail((body as { slots: ClockSlot[] }).slots),
        ],
      }),
    );
    const vt = within(await screen.findByRole('listitem', { name: '1. Voice track' }));
    expect(vt.getByLabelText('Category')).toBeVisible();
    await waitFor(() => expect(vt.getByRole('option', { name: 'Events' })).toBeDefined());
    await user.selectOptions(vt.getByLabelText('VT pool'), 'Events');
    expect(vt.queryByLabelText('Category')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastCall(calls, 'PATCH', `${base}/${clockId}`)).toBeDefined());
    expect(
      (
        lastCall(calls, 'PATCH', `${base}/${clockId}`)?.body as
          | { slots: { poolId: string | null; categoryId: string | null }[] }
          | undefined
      )?.slots[0],
    ).toMatchObject({ kind: 'vt', mode: 'promo', poolId, categoryId: null });
  });

  it('duplicates and removes slots', async () => {
    const { screen, user } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({ [`GET ${base}/${clockId}`]: [200, detail()] }),
    );
    const song = await screen.findByRole('listitem', { name: '3. Category' });
    await user.click(within(song).getByRole('button', { name: 'Duplicate the slot' }));
    expect(screen.getByRole('listitem', { name: '4. Category' })).toBeVisible();
    await user.click(
      within(screen.getByRole('listitem', { name: '1. Timing marker' })).getByRole('button', {
        name: 'Remove the slot',
      }),
    );
    const slots = screen.getAllByRole('listitem', { name: /^\d+\. / });
    expect(slots.map((li) => li.getAttribute('aria-label'))).toEqual([
      '1. Jingle / ID',
      '2. Category',
      '3. Category',
      '4. Voice track',
    ]);
  });

  it('generates a sample hour from the library', async () => {
    const sample: ClockPreview = {
      items: [
        {
          slotIndex: 0,
          kind: 'marker',
          startMs: 0,
          durationMs: 0,
          asset: null,
          source: null,
          problem: null,
          relaxedRules: [],
        },
        {
          slotIndex: 1,
          kind: 'jingle',
          startMs: 0,
          durationMs: 9_000,
          asset: {
            id: '01a15ddf-0000-7000-8000-0000000000d1',
            type: 'jingle',
            title: 'Vandale ID',
            artists: [],
            durationMs: 9_000,
          },
          source: 'random',
          problem: null,
          relaxedRules: [],
        },
        {
          slotIndex: 2,
          kind: 'category',
          startMs: 9_000,
          durationMs: 0,
          asset: null,
          source: null,
          problem: 'empty_category',
          relaxedRules: [],
        },
        {
          slotIndex: 3,
          kind: 'vt',
          startMs: 9_000,
          durationMs: 30_000,
          asset: null,
          source: null,
          problem: null,
          relaxedRules: [],
        },
      ],
      estimate: estimate({ targetDurationMs: 60 * MIN, slots: savedSlots }),
      airsAt: new Date(at),
      seed: 'abc',
    };
    const { screen, user, calls } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail()],
        [`POST ${base}/preview`]: [200, { ...sample, airsAt: at }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    const table = within(await screen.findByRole('table', { name: 'Sample hour' }));
    expect(table.getByText('Vandale ID')).toBeVisible();
    expect(table.getByText('Nothing to pick')).toBeVisible();
    expect(table.getByText('Top')).toBeVisible();
    expect(
      screen.getByText('Random picks from each category (rotation rules not applied).'),
    ).toBeVisible();
    expect(lastCall(calls, 'POST', `${base}/preview`)?.body).toMatchObject({
      targetDurationMs: 60 * MIN,
      slots: savedSlots,
    });
    expect(screen.getByRole('button', { name: 'Another sample' })).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();

    // Editing the clock marks the sample stale, still labelled from the clock it came from.
    await user.click(
      within(screen.getByRole('listitem', { name: '1. Timing marker' })).getByRole('button', {
        name: 'Remove the slot',
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'The clock changed since this sample: generate it again.',
    );
    expect(table.getByText('Top')).toBeVisible();
  });

  it('duplicates the clock from the editor', async () => {
    const copyId = '01a15ddf-0000-7000-8000-0000000000a2';
    const { screen, user, history } = renderApp(
      `${base}/${clockId}`,
      asProgrammer({
        [`GET ${base}/${clockId}`]: [200, detail()],
        [`POST ${base}/${clockId}/duplicate`]: [
          201,
          { ...detail(), id: copyId, name: 'Daytime (copy)' },
        ],
        [`GET ${base}/${copyId}`]: [200, { ...detail(), id: copyId, name: 'Daytime (copy)' }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/${copyId}`));
    expect(await screen.findByDisplayValue('Daytime (copy)')).toBeVisible();
  });
});
