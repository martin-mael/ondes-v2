import type { Asset, AssetDetail, LogDay, LogItem, MyOrg } from '@ondes/shared';
import { act, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';
import { asRunEntry, logItem } from './testing.ts';

// The timeline on the whole app with a fake api and SSE stream: the day grouped by hour in
// station time, the on-air item from the as-run and its live updates, passed-over items,
// day navigation, and edits (move, lock, delete, replace with "fits the slot", insert)
// through the log api, with aired items read-only and viewers kept out of edits.

const NOW = '2026-10-21T10:01:00.000Z'; // 12:01 in Paris
const base = `/stations/${stationId}`;
const dayId = '01a15ddf-0000-7000-8000-0000000000d0';

const day: LogDay = {
  id: dayId,
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

const summary = (n: number, title: string) => ({
  id: `01a15ddf-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  type: 'song' as const,
  title,
  artists: ['Les Traboules'],
  durationMs: 200_000,
});

const aired = logItem({
  plannedStart: '2026-10-21T09:56:40.000Z',
  title: null,
  asset: summary(1, 'Rue Merciere'),
  assetId: summary(1, 'Rue Merciere').id,
});
const onAir = logItem({
  plannedStart: '2026-10-21T10:00:00.000Z',
  timing: 'soft',
  anchorAt: '2026-10-21T10:00:00.000Z',
  capMs: 60_000,
  title: null,
  asset: summary(2, 'Fourviere'),
  assetId: summary(2, 'Fourviere').id,
  conflict: { kind: 'overrun', ms: 3_000 },
});
const queued = logItem({
  plannedStart: '2026-10-21T10:03:20.000Z',
  title: null,
  asset: summary(3, 'Saone Drift'),
  assetId: summary(3, 'Saone Drift').id,
  relaxedRules: [{ rule: 'artist_separation', reason: 'no other artist fits' }],
});
const later = logItem({
  plannedStart: '2026-10-21T10:06:40.000Z',
  title: null,
  asset: summary(4, 'Pentes'),
  assetId: summary(4, 'Pentes').id,
});
const locked = logItem({
  plannedStart: '2026-10-21T11:00:00.000Z',
  kind: 'episode',
  title: 'La Matinale',
  locked: true,
  origin: { type: 'show', showSlotId: null },
});
const items = [aired, onAir, queued, later, locked];

const range = (list: LogItem[] = items) => ({
  from: day.startsAt,
  to: day.endsAt,
  days: [day],
  items: list,
});
const asRun = (
  list = [
    asRunEntry({
      logItemId: aired.id,
      startedAt: '2026-10-21T09:56:41.000Z',
      endedAt: '2026-10-21T10:00:00.000Z',
      outcome: 'cut',
      driftMs: 1_000,
    }),
    asRunEntry({ logItemId: onAir.id, startedAt: '2026-10-21T10:00:04.000Z', driftMs: 4_000 }),
  ],
) => ({ from: day.startsAt, to: day.endsAt, items: list, nextCursor: null });

const withRole = (role: 'programmer' | 'viewer' | 'presenter'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const result = (item: LogItem | null = null) => [200, { item, days: [day] }] as const;

function routes(
  role: 'programmer' | 'viewer' | 'presenter' = 'programmer',
  extra: Record<string, ApiRoute> = {},
): Record<string, ApiRoute> {
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: withRole(role) }],
    [`GET ${base}/log`]: [200, range()],
    [`GET ${base}/asrun`]: [200, asRun()],
    [`GET ${base}/events/access`]: [200, { permissions: ['log:read'] }],
    ...extra,
  };
}

const row = (title: string) => {
  const el = findRow(title);
  if (!el) throw new Error(`no row for ${title}`);
  return el;
};
function findRow(title: string): HTMLElement | null {
  for (const li of document.querySelectorAll<HTMLElement>('li[id^="log-item-"]')) {
    if (within(li).queryByText(title)) return li;
  }
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('log timeline', () => {
  it('shows the day by hour in station time, with the on-air item from the as-run', async () => {
    const { screen } = renderApp(`${base}/log`, routes('presenter'));
    expect(await screen.findByRole('heading', { name: 'Log' })).toBeInTheDocument();
    await screen.findByText('Fourviere', { selector: 'li span' });

    // Grouped by local hour: 11:56 sits under 11:00, the rest under 12:00 and 13:00.
    const eleven = screen.getByRole('region', { name: '11:00' });
    expect(within(eleven).getByText('Rue Merciere')).toBeInTheDocument();
    const noon = screen.getByRole('region', { name: '12:00' });
    expect(within(noon).getByText('Fourviere')).toBeInTheDocument();
    // On the hour and on the item.
    expect(within(noon).getAllByText('Overrun 0:03')).toHaveLength(2);
    expect(within(noon).getByText('1 relaxed')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('region')
        .filter((r) => /^\d\d:00$/.test(r.getAttribute('aria-label') ?? '')),
    ).toHaveLength(24);

    // Planned vs aired, drift, outcome; timing, conflict, lock, show badges.
    const current = row('Fourviere');
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(within(current).getByText('12:00:00')).toBeInTheDocument();
    expect(within(current).getByText('12:00:04')).toBeInTheDocument();
    expect(within(current).getByText('+4 s')).toBeInTheDocument();
    expect(within(current).getByText('Soft 12:00:00')).toBeInTheDocument();
    expect(within(row('Rue Merciere')).getByText('Cut')).toBeInTheDocument();
    expect(within(row('Saone Drift')).getByText('In the engine queue')).toBeInTheDocument();
    expect(within(row('La Matinale')).getByText('Locked')).toBeInTheDocument();
    expect(within(row('La Matinale')).getByText('Show')).toBeInTheDocument();

    // The on-air card and the nav entry.
    expect(screen.getByText('since 12:00:04')).toBeInTheDocument();
    expect(screen.getByText('Next: Saone Drift at 12:03')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log' })).toBeInTheDocument();
  });

  it('follows as-run and feeder events live', async () => {
    const r = routes('presenter');
    let entries = asRun().items;
    r[`GET ${base}/asrun`] = () => [200, asRun(entries)];
    const { screen } = renderApp(`${base}/log`, r);
    await screen.findByText('Fourviere', { selector: 'li span' });
    const source = FakeEventSource.last();
    act(() => source.open());

    const started = asRunEntry({ logItemId: queued.id, startedAt: '2026-10-21T10:03:19.000Z' });
    entries = [
      ...entries.map((e) => (e.endedAt ? e : { ...e, endedAt: started.startedAt })),
      started,
    ];
    act(() =>
      source.emit({
        id: '01a15ddf-0000-7000-8000-0000000000e1',
        stationId,
        at: NOW,
        type: 'asrun.started',
        data: started,
      }),
    );
    await waitFor(() => expect(row('Saone Drift')).toHaveAttribute('aria-current', 'true'));

    act(() =>
      source.emit({
        id: '01a15ddf-0000-7000-8000-0000000000e2',
        stationId,
        at: NOW,
        type: 'feeder.item.passed_over',
        data: {
          itemId: later.id,
          logDayId: dayId,
          segmentId: null,
          plannedStart: later.plannedStart,
          reason: 'not_cached',
          bootId: 'boot-1',
        },
      }),
    );
    const badge = await within(row('Pentes')).findByText('Passed over');
    expect(badge).toHaveAttribute('title', 'Passed over: not in the playout cache');
  });

  it('refetches the day on log.updated', async () => {
    const r = routes('presenter');
    let list = items;
    r[`GET ${base}/log`] = () => [200, range(list)];
    const { screen } = renderApp(`${base}/log`, r);
    await screen.findByText('Pentes');
    const source = FakeEventSource.last();
    act(() => source.open());
    list = items.filter((i) => i.id !== later.id);
    act(() =>
      source.emit({
        id: '01a15ddf-0000-7000-8000-0000000000e3',
        stationId,
        at: NOW,
        type: 'log.updated',
        data: {
          from: later.plannedStart,
          to: day.endsAt,
          days: [{ logDayId: dayId, localDate: '2026-10-21', version: 4 }],
          cause: 'edit',
        },
      }),
    );
    await waitFor(() => expect(screen.queryByText('Pentes')).not.toBeInTheDocument());
  });

  it('moves between days over the right UTC range, DST included', async () => {
    const { screen, user } = renderApp(`${base}/log?date=2026-10-24`, routes('presenter'));
    await screen.findByRole('heading', { name: 'Log' });
    await user.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      // The 25-hour day: from 00:00 CEST to the next midnight CET.
      expect(urls).toContain(
        `/api/v1${base}/log?from=2026-10-24T22%3A00%3A00.000Z&to=2026-10-25T23%3A00%3A00.000Z`,
      );
    });
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-25');
  });

  it('moves, locks and deletes upcoming items; aired items are read-only', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const record =
      (path: string, reply = result()) =>
      (body: unknown) => {
        calls.push({ path, body });
        return [...reply] as [number, unknown];
      };
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`POST ${base}/log/items/${later.id}/move`]: record('move'),
        [`PUT ${base}/log/items/${later.id}/lock`]: record('lock'),
        [`DELETE ${base}/log/items/${later.id}`]: record('delete'),
      }),
    );
    await screen.findByText('Pentes');

    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ path: 'move', body: { placement: { after: locked.id } } }),
    );
    expect(await screen.findByText('Item moved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Lock' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: 'lock', body: { locked: true } }));

    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/“Pentes” leaves the log/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.at(-1)?.path).toBe('delete'));

    // The aired item offers only listening.
    await user.click(screen.getByRole('button', { name: 'Actions for Rue Merciere' }));
    expect(await screen.findByText('Already aired or on air: read-only.')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Listen' })).toBeInTheDocument();
  });

  it('keeps locked items unchanged until unlocked, and explains api refusals', async () => {
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`PUT ${base}/log/items/${locked.id}/lock`]: [
          409,
          { error: 'edit_conflict', message: 'the log changed concurrently; retry' },
        ],
      }),
    );
    await screen.findByText('La Matinale');
    await user.click(screen.getByRole('button', { name: 'Actions for La Matinale' }));
    // A locked item can't be moved or deleted until unlocked.
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Unlock the item to change it.')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Unlock' }));
    expect(
      await screen.findByText('The log changed meanwhile. It’s reloaded: try again.'),
    ).toBeInTheDocument();
  });

  it('offers replacements that fit the slot, closest first', async () => {
    const fits = asset('a1', 'Confluence', 203_000);
    const tooLong = asset('a2', 'Fete des Lumieres', 282_100);
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/assets`]: [
          200,
          {
            items: [tooLong, fits, { ...fits, id: queued.assetId, title: 'Same' }],
            nextCursor: null,
          },
        ],
      }),
    );
    await screen.findByText('Saone Drift');

    await user.click(screen.getByRole('button', { name: 'Actions for Saone Drift' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Fits the slot (3:20)')).toBeInTheDocument();
    await within(dialog).findByText('Confluence');
    expect(within(dialog).queryByText('Fete des Lumieres')).not.toBeInTheDocument();
    // Not the asset it already plays.
    expect(within(dialog).queryByText('Same')).not.toBeInTheDocument();
    expect(within(dialog).getByText('+3 s')).toBeInTheDocument();
    // Unticking "fits" shows everything.
    await user.click(within(dialog).getByRole('checkbox'));
    expect(await within(dialog).findByText('Fete des Lumieres')).toBeInTheDocument();
  });

  it('replaces through the api, keeping timing and lock, the slot sized from the asset', async () => {
    const fits = asset('a1', 'Confluence', 203_000);
    let body: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/assets`]: [200, { items: [fits], nextCursor: null }],
        [`GET ${base}/assets/${fits.id}`]: [200, detail(fits)],
        [`PUT ${base}/log/items/${later.id}`]: (b) => {
          body = b;
          return [...result(later)] as [number, unknown];
        },
      }),
    );
    await screen.findByText('Pentes');
    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Confluence' }));
    await waitFor(() =>
      expect(body).toEqual({
        kind: 'song',
        assetId: fits.id,
        plannedDurationMs: 203_020,
        timing: 'flow',
        anchorAt: null,
        capMs: null,
        locked: false,
      }),
    );
    expect(await screen.findByText('Item replaced')).toBeInTheDocument();
  });

  it('inserts a jingle after an item', async () => {
    const jingle = { ...asset('b1', 'Station ID', 8_000), type: 'jingle' as const };
    let body: unknown;
    let searched = '';
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/assets`]: [200, { items: [jingle], nextCursor: null }],
        [`GET ${base}/assets/${jingle.id}`]: [200, detail(jingle)],
        [`POST ${base}/log/items`]: (b) => {
          body = b;
          return [201, { item: later, days: [day] }];
        },
      }),
    );
    await screen.findByText('Pentes');
    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Insert after…' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'jingle');
    await waitFor(() => {
      searched =
        vi
          .mocked(fetch)
          .mock.calls.map(([input]) => String(input))
          .filter((u) => u.includes('/assets?'))
          .at(-1) ?? '';
      expect(searched).toContain('type=jingle');
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Station ID' }));
    await waitFor(() =>
      expect(body).toEqual({
        placement: { after: later.id },
        item: { kind: 'jingle', assetId: jingle.id, plannedDurationMs: 8_020 },
      }),
    );
  });

  it('keeps viewers to reading', async () => {
    const { screen } = renderApp(`${base}/log`, routes('viewer'));
    await screen.findByText('Pentes');
    // No library access: no listening; no log:write: no edits, so no menu at all.
    expect(screen.queryByRole('button', { name: 'Actions for Pentes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to draft' })).not.toBeInTheDocument();
  });

  it('publishes a draft day', async () => {
    let status: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/log`]: [200, { ...range(), days: [{ ...day, status: 'draft' }] }],
        [`PUT ${base}/log/days/2026-10-21/status`]: (b) => {
          status = b;
          return [200, { day }];
        },
      }),
    );
    expect(
      await screen.findByText('Not on air: the engine only plays published days.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(status).toEqual({ status: 'published' }));
  });
});

function asset(suffix: string, title: string, durationMs: number): Asset {
  return {
    id: `01a15ddf-0000-7000-8000-0000000003${suffix}`,
    orgId: orgs[0]?.id ?? '',
    stationId,
    type: 'song',
    title,
    artists: ['Bellecour Sound System'],
    album: null,
    year: null,
    isrc: null,
    version: null,
    durationMs,
    explicit: false,
    startAt: null,
    killAt: null,
    notes: null,
    metadata: {},
    sourceFilename: null,
    normalizeLoudness: true,
    gainOverrideDb: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function detail(a: Asset): AssetDetail {
  return {
    ...a,
    files: [],
    cues: null,
    loudness: null,
    playoutGain: { gainDb: 0, source: 'unmeasured', limitedByPeak: false },
    analysis: null,
    tags: [],
  };
}
