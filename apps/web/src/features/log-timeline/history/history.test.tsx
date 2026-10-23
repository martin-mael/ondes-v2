import type { AsRunOverlay, AsRunOverlayPlan, AsRunOverlayRow, LogDay } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';
import { asRunEntry, id, logItem } from '../testing.ts';
import { dayHours } from '../time.ts';
import { groupByHour, isOffPlan, nextPendingEndMs } from './model.ts';

// Log vs as-run (#53) on the whole app with a fake api: a past day opens on what aired, hour by
// hour in station time, with drift and what went off plan; the tabs switch back to the plan.

const NOW = '2026-10-21T10:01:00.000Z';
const DATE = '2026-10-20';
const base = `/stations/${stationId}`;

const plan = (start: string, title: string, more: Partial<AsRunOverlayPlan> = {}) => ({
  logItemId: id(),
  segmentId: null,
  kind: 'song' as const,
  plannedStart: start,
  plannedDurationMs: 200_000,
  timing: 'flow' as const,
  assetId: null,
  title,
  artists: ['Les Traboules'],
  ...more,
});
const row = (r: Partial<AsRunOverlayRow> & Pick<AsRunOverlayRow, 'status' | 'at'>) => ({
  plan: null,
  entry: null,
  replacedBy: [],
  repeat: false,
  ...r,
});

// 12:00 Paris = 10:00 UTC on 2026-10-20 (UTC+2).
const safety = asRunEntry({
  source: 'safety',
  title: 'Safety Loop',
  startedAt: '2026-10-20T10:03:30.000Z',
  endedAt: '2026-10-20T10:07:00.000Z',
  durationMs: 210_000,
  outcome: 'complete',
});
const rows = [
  row({
    status: 'aired',
    at: '2026-10-20T10:00:04.000Z',
    plan: plan('2026-10-20T10:00:00.000Z', 'Fourviere'),
    entry: asRunEntry({
      title: 'Fourviere',
      startedAt: '2026-10-20T10:00:04.000Z',
      endedAt: '2026-10-20T10:03:20.000Z',
      durationMs: 196_000,
      outcome: 'complete',
      driftMs: 4_000,
    }),
  }),
  row({ status: 'safety', at: safety.startedAt, entry: safety }),
  row({
    status: 'replaced',
    at: '2026-10-20T10:03:20.000Z',
    plan: plan('2026-10-20T10:03:20.000Z', 'Saone Drift'),
    replacedBy: [safety.id],
  }),
  row({
    status: 'transition',
    at: '2026-10-20T10:07:00.000Z',
    entry: asRunEntry({
      title: 'Pentes',
      startedAt: '2026-10-20T10:07:00.000Z',
      endedAt: '2026-10-20T10:07:12.000Z',
      durationMs: 12_000,
      outcome: 'complete',
      transition: {
        rendered: true,
        islandId: null,
        hash: 'spec-hash',
        segueIds: [],
        voices: [{ assetId: null, title: 'VT: la suite', offsetMs: 0, durationMs: 9_000 }],
      },
    }),
  }),
  row({
    status: 'missed',
    at: '2026-10-20T11:00:00.000Z',
    plan: plan('2026-10-20T11:00:00.000Z', 'Pentes'),
  }),
  row({
    status: 'fallback',
    at: '2026-10-20T12:00:00.000Z',
    plan: plan('2026-10-20T12:00:00.000Z', 'La Matinale', { kind: 'episode' }),
    entry: asRunEntry({
      title: 'La Matinale #11',
      kind: 'episode',
      startedAt: '2026-10-20T12:00:00.000Z',
      endedAt: '2026-10-20T13:00:00.000Z',
      durationMs: 3_600_000,
      outcome: 'complete',
      fallback: 'latest_episode',
      driftMs: 45_000,
    }),
  }),
] satisfies AsRunOverlayRow[];

const overlay: AsRunOverlay = {
  date: DATE,
  from: '2026-10-19T22:00:00.000Z',
  to: '2026-10-20T22:00:00.000Z',
  now: NOW,
  rows,
};

const day: LogDay = {
  id: '01a15ddf-0000-7000-8000-0000000000d0',
  stationId,
  localDate: DATE,
  startsAt: overlay.from,
  endsAt: overlay.to,
  status: 'published',
  version: 1,
  generatedAt: null,
  seed: null,
  generatorVersion: null,
};

function routes(extra: Record<string, ApiRoute> = {}): Record<string, ApiRoute> {
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs }],
    [`GET ${base}/log`]: [
      200,
      {
        from: day.startsAt,
        to: day.endsAt,
        days: [day],
        items: [logItem({ plannedStart: '2026-10-20T10:00:00.000Z', title: 'Fourviere' })],
      },
    ],
    [`GET ${base}/asrun`]: [
      200,
      { from: day.startsAt, to: day.endsAt, items: [], nextCursor: null },
    ],
    [`GET ${base}/asrun/overlay`]: [200, overlay],
    [`GET ${base}/events/access`]: [200, { permissions: ['log:read'] }],
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('log vs as-run', () => {
  it('opens a past day on what aired, by hour, in station time', async () => {
    const { screen, calls } = renderApp(`${base}/log?date=${DATE}`, routes());
    const noon = await screen.findByRole('region', { name: '12:00' });
    expect(screen.getByRole('tab', { name: 'Plan vs aired' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(calls.some((c) => c.path === `${base}/asrun/overlay`)).toBe(true);

    // Exact air times and drift, in Paris time.
    const fourviere = within(noon).getByText('Fourviere').closest('li') as HTMLElement;
    expect(within(fourviere).getByText('12:00:04')).toBeInTheDocument();
    expect(within(fourviere).getByText('→ 12:03:20')).toBeInTheDocument();
    expect(within(fourviere).getByText('12:00:00')).toBeInTheDocument();
    expect(within(fourviere).getByText('+4 s')).toBeInTheDocument();
    // Plain aired rows carry no status badge.
    expect(within(fourviere).queryByText('Aired')).not.toBeInTheDocument();

    // Off-plan: safety took the slot of a song that never aired.
    expect(within(noon).getByText('Safety playlist')).toBeInTheDocument();
    const saone = within(noon).getByText('Saone Drift').closest('li') as HTMLElement;
    expect(within(saone).getByText('Replaced')).toBeInTheDocument();
    expect(within(saone).getByText('Its slot went to: Safety Loop (12:03:30)')).toBeInTheDocument();
    expect(within(noon).getByText('2 off plan')).toBeInTheDocument();
    // A rendered island (#57) is the planned transition, with its voice track.
    const island = within(noon).getByText('Transition').closest('li') as HTMLElement;
    expect(within(island).getByText('Voice: VT: la suite')).toBeInTheDocument();

    const one = screen.getByRole('region', { name: '13:00' });
    expect(within(one).getByText('Not aired')).toBeInTheDocument();
    const two = screen.getByRole('region', { name: '14:00' });
    expect(within(two).getByText('Fallback · latest episode')).toBeInTheDocument();
    expect(within(two).getByText('drift up to +45 s')).toBeInTheDocument();
    // Hours where nothing was planned or aired aren't listed.
    expect(screen.queryByRole('region', { name: '03:00' })).not.toBeInTheDocument();
  });

  it('switches back to the plan', async () => {
    const { screen, user } = renderApp(`${base}/log?date=${DATE}`, routes());
    await screen.findByRole('region', { name: '12:00' });
    await user.click(screen.getByRole('tab', { name: 'Plan' }));
    await waitFor(() => expect(document.querySelector('li[id^="log-item-"]')).not.toBeNull());
  });

  it('today opens on the plan; future days have no as-run tabs', async () => {
    const { screen, history } = renderApp(`${base}/log`, routes());
    expect(await screen.findByRole('tab', { name: 'Plan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    history.push(`${base}/log?date=2026-10-23`);
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Plan' })).toBeNull());
  });
});

describe('the October DST day', () => {
  // 2025-10-26 in Paris: 25 hours, 02:00 twice (UTC+2, then UTC+1).
  const dst = (start: string, title: string) =>
    row({
      status: 'aired',
      at: start,
      plan: plan(start, title),
      entry: asRunEntry({ title, startedAt: start, endedAt: start, outcome: 'complete' }),
    });
  const first = dst('2025-10-26T00:30:00.000Z', 'Premier passage');
  const second = dst('2025-10-26T01:30:00.000Z', 'Second passage');

  it('groups the two 02:00 hours apart', () => {
    const hours = dayHours('2025-10-26', 'Europe/Paris');
    expect(hours).toHaveLength(25);
    const groups = groupByHour([first, second], hours).filter((g) => g.rows.length > 0);
    expect(groups.map((g) => g.label)).toEqual(['02:00 UTC+2', '02:00 UTC+1']);
  });

  it('shows both hours, each with its exact air time', async () => {
    const dstOverlay: AsRunOverlay = {
      date: '2025-10-26',
      from: '2025-10-25T22:00:00.000Z',
      to: '2025-10-26T23:00:00.000Z',
      now: NOW,
      rows: [first, second],
    };
    const { screen } = renderApp(
      `${base}/log?date=2025-10-26`,
      routes({ [`GET ${base}/asrun/overlay`]: [200, dstOverlay] }),
    );
    const summer = await screen.findByRole('region', { name: '02:00 UTC+2' });
    const winter = screen.getByRole('region', { name: '02:00 UTC+1' });
    expect(within(summer).getByText('Premier passage')).toBeInTheDocument();
    expect(within(winter).getByText('Second passage')).toBeInTheDocument();
    expect(within(summer).getAllByText('02:30:00').length).toBeGreaterThan(0);
    expect(within(winter).getAllByText('02:30:00').length).toBeGreaterThan(0);
  });
});

describe('nextPendingEndMs', () => {
  it('is the time until the first upcoming slot ends, plus slack; null without one', () => {
    const pending = row({
      status: 'pending',
      at: '2026-10-21T10:05:00.000Z',
      plan: plan('2026-10-21T10:05:00.000Z', 'Next'),
    });
    // Planned 10:05:00 + 200 s = 10:08:20; the api's now is 10:01:00.
    expect(nextPendingEndMs({ now: NOW, rows: [pending] })).toBe(440_000 + 2_000);
    expect(nextPendingEndMs({ now: NOW, rows })).toBeNull();
  });
});

describe('groupByHour', () => {
  it('puts rows in their hour, counts off-plan rows, keeps the largest drift', () => {
    const hours = dayHours(DATE, 'Europe/Paris');
    const groups = groupByHour(rows, hours);
    const noon = groups.find((g) => g.label === '12:00');
    expect(noon?.rows).toHaveLength(4);
    expect(noon?.aired).toBe(3);
    expect(noon?.offPlan).toBe(2);
    expect(noon?.driftMs).toBe(4_000);
  });

  it('puts a row aired across midnight in the edge hour', () => {
    const hours = dayHours(DATE, 'Europe/Paris');
    const late = row({ status: 'aired', at: '2026-10-20T22:01:00.000Z' });
    expect(groupByHour([late], hours).at(-1)?.rows).toHaveLength(1);
  });

  it('a cut item counts as off plan', () => {
    const cut = row({
      status: 'aired',
      at: NOW,
      entry: asRunEntry({ outcome: 'cut', endedAt: NOW }),
    });
    expect(isOffPlan(cut)).toBe(true);
  });
});
