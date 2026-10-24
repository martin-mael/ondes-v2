import type { LogDay, LogDiffItem, LogRegenPreviewResponse, MyOrg } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

// Regenerating from the timeline (#101) on the whole app with a fake api: the dry-run's diff in
// station time, applying it with the versions the preview saw, a stale preview, viewers.

const NOW = '2026-10-21T10:01:00.000Z'; // 12:01 in Paris
const base = `/stations/${stationId}`;
const day: LogDay = {
  id: '01a15ddf-0000-7000-8000-0000000000d0',
  stationId,
  localDate: '2026-10-21',
  startsAt: '2026-10-20T22:00:00.000Z',
  endsAt: '2026-10-21T22:00:00.000Z',
  status: 'published',
  version: 3,
  generatedAt: null,
  seed: null,
  generatorVersion: null,
};

const item = (start: string, title: string, more: Partial<LogDiffItem> = {}): LogDiffItem => ({
  id: null,
  kind: 'song',
  plannedStart: start,
  plannedDurationMs: 200_000,
  assetId: null,
  asset: {
    id: '01a15ddf-0000-7000-8000-000000000301',
    type: 'song',
    title,
    artists: ['Les Traboules'],
    durationMs: 200_000,
  },
  episodeId: null,
  liveSlotId: null,
  title: null,
  timing: 'flow',
  origin: { type: 'clock', clockId: null, slotIndex: 1 },
  relaxedRules: [],
  conflict: null,
  ...more,
});

const preview: LogRegenPreviewResponse = {
  frozenUntil: '2026-10-21T11:01:00.000Z',
  totals: { added: 1, removed: 1, moved: 1, relaxed: 1, issues: 1 },
  days: [
    {
      localDate: '2026-10-21',
      logDayId: day.id,
      version: 3,
      change: 'changed',
      // 14:00 and 14:03 in Paris.
      added: [item('2026-10-21T12:00:00.000Z', 'Croix-Rousse')],
      removed: [
        item('2026-10-21T12:00:00.000Z', 'Rue Merciere', {
          id: '01a15ddf-0000-7000-8000-000000000401',
        }),
      ],
      moved: [
        {
          item: item('2026-10-21T12:03:20.000Z', 'Pentes', {
            id: '01a15ddf-0000-7000-8000-000000000402',
          }),
          fromStart: '2026-10-21T12:03:00.000Z',
          shiftMs: 20_000,
        },
      ],
      relaxed: [
        {
          item: item('2026-10-21T12:00:00.000Z', 'Croix-Rousse', {
            relaxedRules: [{ rule: 'artist_separation' }],
          }),
          new: true,
        },
      ],
      kept: { past: 12, locked: 1 },
      unchangedCount: 300,
      items: [],
      issues: [{ code: 'no_clock', at: '2026-10-21T20:00:00.000Z' }],
    },
  ],
};

const withRole = (role: 'programmer' | 'viewer'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

function routes(role: 'programmer' | 'viewer', extra: Record<string, ApiRoute> = {}) {
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: withRole(role) }],
    [`GET ${base}/log`]: [200, { from: day.startsAt, to: day.endsAt, days: [day], items: [] }],
    [`GET ${base}/asrun`]: [
      200,
      { from: day.startsAt, to: day.endsAt, items: [], nextCursor: null },
    ],
    [`GET ${base}/events/access`]: [200, { permissions: ['log:read'] }],
    [`POST ${base}/log/regen/preview`]: [200, preview],
    ...extra,
  } satisfies Record<string, ApiRoute>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('regenerate', () => {
  it('previews the changes in station time, then applies them with the versions it saw', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`POST ${base}/log/regen`]: [202, { localDates: ['2026-10-21'], jobs: 1 }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Regenerate the log' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview changes' }));

    const section = await within(dialog).findByRole('region', { name: '2026-10-21' });
    expect(within(dialog).getByText('Items before 13:01 stay as they are.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('1 added · 1 removed · 1 moved · 1 with relaxed rules'),
    ).toBeInTheDocument();
    expect(within(section).getByText('Added (1)')).toBeInTheDocument();
    expect(within(section).getAllByText('Les Traboules – Croix-Rousse')).toHaveLength(2);
    expect(within(section).getAllByText('14:00').length).toBeGreaterThan(0);
    expect(within(section).getByText('Les Traboules – Rue Merciere')).toBeInTheDocument();
    expect(within(section).getByText('+20 s')).toBeInTheDocument();
    expect(within(section).getByText('No clock for this hour')).toBeInTheDocument();
    expect(
      within(section).getByText(/13 kept \(12 aired or soon on air, 1 locked\)/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === `${base}/log/regen/preview`)?.body).toEqual({
      from: '2026-10-21',
      to: '2026-10-21',
    });

    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === `${base}/log/regen`)?.body,
      ).toEqual({
        from: '2026-10-21',
        to: '2026-10-21',
        expectedVersions: { '2026-10-21': 3 },
      }),
    );
    expect(
      await screen.findByText('Regeneration queued: the log updates in a moment'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says so when the log changed since the preview', async () => {
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`POST ${base}/log/regen`]: [
          409,
          { error: 'log_regen_stale', message: 'stale', details: { localDates: ['2026-10-21'] } },
        ],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Regenerate the log' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview changes' }));
    await within(dialog).findByRole('region', { name: '2026-10-21' });
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    expect(
      await screen.findByText('The log changed since the preview. Preview again.'),
    ).toBeInTheDocument();
  });

  it('asks before closing with a preview not applied', async () => {
    const { screen, user } = renderApp(`${base}/log`, routes('programmer'));
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Regenerate the log' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview changes' }));
    await within(dialog).findByRole('region', { name: '2026-10-21' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('dialog', { name: 'Leave without saving?' }),
    ).toBeInTheDocument();
  });

  it('is not offered to viewers', async () => {
    const { screen } = renderApp(`${base}/log`, routes('viewer'));
    expect(await screen.findByRole('heading', { name: 'Log' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });
});
