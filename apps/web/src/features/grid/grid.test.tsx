import type { ClockGridDto, MyOrg } from '@ondes/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';
import { paint, rectangle, toCells, toDraft } from './paint.ts';

// The weekly grid page on the whole app with a fake api: paint by drag and shift-click, the
// default clock, a daypart applied in bulk, saving with the version, a conflicting save, and
// creating an override.

const at = '2026-10-21T08:00:00.000Z';
const base = `/stations/${stationId}/clock-grid`;
const music = '01a15ddf-0000-7000-8000-0000000000a1';
const morning = '01a15ddf-0000-7000-8000-0000000000a2';
const daypartId = '01a15ddf-0000-7000-8000-0000000000d1';
const overrideId = '01a15ddf-0000-7000-8000-0000000000e1';

const programmerOrgs: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) => (s.id === stationId ? { ...s, role: 'programmer' } : s)),
}));

const clock = (id: string, name: string, color: string | null) => ({
  id,
  orgId: orgs[0]?.id,
  stationId,
  name,
  description: null,
  color,
  targetDurationMs: 3_600_000,
  slots: [],
  version: 1,
  createdAt: at,
  updatedAt: at,
  estimate: { slots: [], totalMs: 0, targetMs: 3_600_000, warnings: [] },
});

function grid(partial: Partial<ClockGridDto> = {}) {
  return {
    defaultClockId: null,
    cells: [],
    version: 2,
    dayparts: [
      {
        id: daypartId,
        name: 'Breakfast',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 6,
        endHour: 9,
        createdAt: at,
        updatedAt: at,
      },
    ],
    overrides: [],
    timezone: 'Europe/Paris',
    ...partial,
  };
}

const asProgrammer = (routes: Record<string, ApiRoute> = {}): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: programmerOrgs }],
  [`GET /stations/${stationId}/clocks`]: [
    200,
    { items: [clock(music, 'Music', '#2563eb'), clock(morning, 'Morning', '#f59e0b')] },
  ],
  ...routes,
});

const lastCall = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).at(-1);

const cell = (day: string, hour: string) => new RegExp(`^${day} ${hour}: `) as unknown as string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('paint helpers', () => {
  it('paints, clears and fills rectangles', () => {
    let d = paint(toDraft([]), rectangle({ weekday: 2, hour: 8 }, { weekday: 1, hour: 6 }), music);
    expect(toCells(d)).toHaveLength(6);
    d = paint(d, [{ weekday: 1, hour: 6 }], null);
    expect(toCells(d)[0]).toEqual({ weekday: 1, hour: 7, clockId: music });
  });
});

describe('weekly grid page', () => {
  it('is in the station nav and warns about hours without a clock', async () => {
    const { screen, user, history } = renderApp(
      `/stations/${stationId}`,
      asProgrammer({ [`GET ${base}`]: [200, grid()] }),
    );
    await user.click(await screen.findByRole('link', { name: 'Weekly grid' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${stationId}/grid`));
    expect(
      await screen.findByText('168 hours have no clock: choose a default clock.'),
    ).toBeVisible();
    expect(screen.getByText('Hours in station time (Europe/Paris).')).toBeVisible();
  });

  it('paints by dragging and shift-click, applies a daypart and saves with the version', async () => {
    const { screen, user, calls } = renderApp(
      `/stations/${stationId}/grid`,
      asProgrammer({
        [`GET ${base}`]: [200, grid()],
        [`PUT ${base}`]: (body) => [200, grid({ ...(body as Partial<ClockGridDto>), version: 3 })],
      }),
    );
    const mon7 = await screen.findByRole('button', { name: cell('Monday', '07:00') });
    const mon8 = screen.getByRole('button', { name: cell('Monday', '08:00') });
    // The brush starts on the first clock. Drag from Monday 07:00 down to 08:00.
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(mon8);
    fireEvent.pointerDown(mon7, { button: 0 });
    fireEvent.pointerMove(mon7, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(screen.getByRole('button', { name: 'Monday 07:00: Music' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Monday 08:00: Music' })).toBeVisible();

    // Shift-click Wednesday 08:00 with the Morning brush: Monday–Wednesday 07–08.
    await user.click(screen.getByRole('button', { name: 'Morning' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: cell('Wednesday', '08:00') }), {
      button: 0,
      shiftKey: true,
    });
    expect(screen.getByRole('button', { name: 'Tuesday 07:00: Morning' })).toBeVisible();

    // Default clock, then the Breakfast daypart painted with Music.
    await user.selectOptions(screen.getByLabelText('Default clock'), 'Music');
    expect(screen.queryByText(/have no clock/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Music' }));
    await user.click(screen.getByRole('button', { name: 'Paint Breakfast with Music' }));
    expect(screen.getByRole('button', { name: 'Friday 06:00: Music' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Saturday 06:00: default (Music)' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save grid' }));
    await waitFor(() => expect(lastCall(calls, 'PUT', base)).toBeDefined());
    const body = lastCall(calls, 'PUT', base)?.body as {
      version: number;
      defaultClockId: string;
      cells: { weekday: number; hour: number; clockId: string }[];
    };
    expect(body.version).toBe(2);
    expect(body.defaultClockId).toBe(music);
    // Breakfast (15 hours) covers the painted 07–08 cells of Monday–Wednesday.
    expect(body.cells).toHaveLength(15);
    expect(body.cells.every((c) => c.clockId === music)).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save grid' })).toBeDisabled());
  });

  it('clears an hour pressed with its own clock, and reports a conflicting save', async () => {
    const { screen, user } = renderApp(
      `/stations/${stationId}/grid`,
      asProgrammer({
        [`GET ${base}`]: [
          200,
          grid({ defaultClockId: music, cells: [{ weekday: 1, hour: 7, clockId: morning }] }),
        ],
        [`PUT ${base}`]: [409, { error: 'edit_conflict', message: 'changed', details: {} }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Monday 07:00: Morning' }), {
      button: 0,
    });
    fireEvent.pointerUp(window);
    expect(screen.getByRole('button', { name: 'Monday 07:00: default (Music)' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save grid' }));
    expect(await screen.findByText(/Someone saved the grid/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload the grid' })).toBeVisible();
  });

  it('creates an override and lists it with its clock', async () => {
    let overrides: ClockGridDto['overrides'] = [];
    const { screen, user, calls } = renderApp(
      `/stations/${stationId}/grid`,
      asProgrammer({
        [`GET ${base}`]: () => [200, grid({ defaultClockId: music, overrides })],
        [`POST ${base}/overrides`]: (body) => {
          const created = { ...(body as object), id: overrideId, createdAt: at, updatedAt: at };
          overrides = [created as unknown as ClockGridDto['overrides'][number]];
          return [201, created];
        },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'New override' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'Christmas');
    fireEvent.change(dialog.getByLabelText('From'), { target: { value: '2026-12-24' } });
    fireEvent.change(dialog.getByLabelText('To (included)'), { target: { value: '2026-12-26' } });
    await user.selectOptions(dialog.getByLabelText('Clock'), 'Morning');
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(lastCall(calls, 'POST', `${base}/overrides`)).toBeDefined());
    expect(lastCall(calls, 'POST', `${base}/overrides`)?.body).toEqual({
      name: 'Christmas',
      startsOn: '2026-12-24',
      endsOn: '2026-12-26',
      startHour: 0,
      endHour: 24,
      clockId: morning,
    });
    expect(await screen.findByText('Christmas')).toBeVisible();
    expect(screen.getByText(/Dec 24, 2026 – .* · all day · Morning/)).toBeVisible();
  });

  it('is read-only without clock:write', async () => {
    const { screen } = renderApp(
      `/stations/${stationId}/grid`,
      asProgrammer({
        'GET /orgs': [
          200,
          {
            orgs: orgs.map((org) => ({
              ...org,
              stations: org.stations.map((s) =>
                s.id === stationId ? { ...s, role: 'viewer' as const } : s,
              ),
            })),
          },
        ],
        [`GET ${base}`]: [200, grid({ defaultClockId: music })],
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Monday 07:00: default (Music)' }),
    ).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save grid' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New override' })).toBeNull();
  });
});
