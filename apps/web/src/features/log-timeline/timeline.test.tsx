import type { LogDay, LogItem, MyOrg } from '@ondes/shared';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';
import { asRunEntry, assetDetail, libraryAsset, logItem, playable } from './testing.ts';

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
    expect(within(current).getByText('Soft 12:00:00 · up to 1:00 late')).toBeInTheDocument();
    expect(within(row('Rue Merciere')).getByText('Cut')).toBeInTheDocument();
    expect(within(row('Saone Drift')).getByText('In the engine queue')).toBeInTheDocument();
    // Why a rule was relaxed, in the row itself.
    expect(within(row('Saone Drift')).getByText('Relaxed: Artist separation')).toBeInTheDocument();
    expect(within(row('Saone Drift')).getByText(/no other artist fits/)).toBeInTheDocument();
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
    expect(
      await within(row('Pentes')).findByText('Passed over: not in the playout cache'),
    ).toBeInTheDocument();
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
    const fits = libraryAsset('a1', 'Confluence', 203_000);
    const tooLong = libraryAsset('a2', 'Fete des Lumieres', 282_100);
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
    const fits = libraryAsset('a1', 'Confluence', 203_000);
    let body: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/assets`]: [200, { items: [fits], nextCursor: null }],
        [`GET ${base}/assets/${fits.id}`]: [200, assetDetail(fits)],
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
    const jingle = { ...libraryAsset('b1', 'Station ID', 8_000), type: 'jingle' as const };
    let body: unknown;
    let searched = '';
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/assets`]: [200, { items: [jingle], nextCursor: null }],
        [`GET ${base}/assets/${jingle.id}`]: [200, assetDetail(jingle)],
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

  it('refetches the log and the as-run after the stream reconnects', async () => {
    const { screen } = renderApp(`${base}/log`, routes('presenter'));
    await screen.findByText('Pentes');
    const source = FakeEventSource.last();
    act(() => source.open());
    const count = (part: string) =>
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes(part)).length;
    const logs = count(`${base}/log?`);
    const asruns = count(`${base}/asrun?`);
    // The connection drops (the browser retries by itself), then comes back.
    act(() => {
      source.readyState = FakeEventSource.CONNECTING;
      source.onerror?.();
    });
    act(() => source.open());
    await waitFor(() => expect(count(`${base}/log?`)).toBeGreaterThan(logs));
    expect(count(`${base}/asrun?`)).toBeGreaterThan(asruns);
  });

  it('moves an item by drag and drop, never next to the far side of what aired', async () => {
    const moves: unknown[] = [];
    const { screen } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`POST ${base}/log/items/${later.id}/move`]: (b) => {
          moves.push(b);
          return [...result(later)] as [number, unknown];
        },
      }),
    );
    await screen.findByText('Pentes');
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? '',
      get types() {
        return [...store.keys()];
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    };
    const dragged = row('Pentes');
    expect(dragged).toHaveAttribute('draggable', 'true');
    // Aired rows don't drag.
    expect(row('Rue Merciere')).toHaveAttribute('draggable', 'false');
    fireEvent.dragStart(dragged, { dataTransfer });
    const target = row('La Matinale');
    fireEvent.dragOver(target, { dataTransfer });
    // happy-dom lays nothing out: any pointer is in the lower half, so "after".
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
    await waitFor(() => expect(moves).toEqual([{ placement: { after: locked.id } }]));

    // Dropping onto the on-air row is refused: nothing lands next to what's on air.
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.drop(row('Fourviere'), { dataTransfer, clientY: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(moves).toHaveLength(1);
  });

  it('suggests replacements from the rules engine, with its reasons', async () => {
    const pick = libraryAsset('c1', 'Confluence', 203_000);
    const eligible = libraryAsset('c2', 'Ainay', 207_000);
    const breaking = libraryAsset('c3', 'Monplaisir', 218_000);
    let pickBody: unknown;
    let replaced: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/categories`]: [200, { items: [category('Power', 'song')] }],
        [`POST ${base}/rotation/pick`]: (b) => {
          pickBody = b;
          return [
            200,
            {
              picks: [
                {
                  categoryId,
                  at: later.plannedStart,
                  asset: { ...summaryOf(pick), album: null },
                  relaxed: [{ rule: 'song_rest', reason: 'blocked 3 of 3 candidates' }],
                  candidates: 3,
                  ranked: [
                    candidate(breaking, 0, false, [
                      {
                        ruleId: 'artist',
                        kind: 'artist_separation',
                        detail: 'same artist 12 min before',
                        values: {},
                      },
                    ]),
                    candidate(eligible, 2, false, []),
                    candidate(pick, 1, true, []),
                  ],
                },
              ],
            },
          ];
        },
        [`GET ${base}/assets/${pick.id}`]: [200, assetDetail(pick)],
        [`PUT ${base}/log/items/${later.id}`]: (b) => {
          replaced = b;
          return [...result(later)] as [number, unknown];
        },
      }),
    );
    await screen.findByText('Pentes');
    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace…' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Rules pick')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Rules' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(pickBody).toEqual({
      slots: [{ categoryId, at: later.plannedStart }],
      explain: true,
      ignoreLogItemIds: [later.id],
    });
    // The pick, then who respects every rule, then who breaks one (with why).
    const titles = within(dialog)
      .getAllByRole('button', { name: /^Choose: / })
      .map((b) => b.getAttribute('aria-label'));
    expect(titles).toEqual(['Choose: Confluence', 'Choose: Ainay', 'Choose: Monplaisir']);
    expect(within(dialog).getByText('Respects every rule')).toBeInTheDocument();
    expect(within(dialog).getByText('Artist separation')).toBeInTheDocument();
    expect(within(dialog).getByText(/same artist 12 min before/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('To fill this slot, the rules engine relaxed:'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Song rest')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Choose: Confluence' }));
    await waitFor(() =>
      expect(replaced).toMatchObject({
        kind: 'song',
        assetId: pick.id,
        plannedDurationMs: 203_020,
      }),
    );
  });

  it('falls back to the library when the rules engine isn’t there', async () => {
    const fits = libraryAsset('a1', 'Confluence', 203_000);
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/categories`]: [200, { items: [category('Power', 'song')] }],
        [`POST ${base}/rotation/pick`]: [404, { error: 'not_found', message: 'Route not found' }],
        [`GET ${base}/assets`]: [200, { items: [fits], nextCursor: null }],
      }),
    );
    await screen.findByText('Pentes');
    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace…' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Confluence')).toBeInTheDocument();
    expect(within(dialog).getByText('Fits the slot (3:20)')).toBeInTheDocument();
  });

  it('searches the whole library for lengths that fit, closest first', async () => {
    const near = libraryAsset('d1', 'Near', 201_000);
    const far = libraryAsset('d2', 'Far', 220_000);
    let search: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`POST ${base}/library/search`]: (b) => {
          search = b;
          return [200, { items: [far, near], nextCursor: null }];
        },
      }),
    );
    await screen.findByText('Pentes');
    await user.click(screen.getByRole('button', { name: 'Actions for Pentes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace…' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Near');
    expect(search).toEqual({
      filter: { types: ['song'], durationMs: { min: 170_000, max: 230_000 } },
      sort: 'duration',
      direction: 'asc',
      limit: 200,
    });
    const titles = within(dialog)
      .getAllByRole('button', { name: /^Choose: / })
      .map((b) => b.getAttribute('aria-label'));
    expect(titles).toEqual(['Choose: Near', 'Choose: Far']);
  });
});

const categoryId = '01a15ddf-0000-7000-8000-0000000000c1';

function category(name: string, assetType: 'song' | 'jingle') {
  return {
    id: categoryId,
    orgId: orgs[0]?.id ?? '',
    stationId,
    name,
    description: null,
    color: null,
    assetType,
    rule: null,
    rotationOrder: 'least_recently_played',
    searchDepthPercent: 100,
    restMinutes: 180,
    maxPlaysPerDay: null,
    maxPlaysPerWeek: null,
    createdAt: NOW,
    updatedAt: NOW,
    counts: {
      members: 3,
      schedulable: 3,
      ruleMatches: 0,
      manualOnly: 3,
      excluded: 0,
      totalDurationMs: 600_000,
    },
  };
}

const summaryOf = (a: {
  id: string;
  title: string;
  artists: string[];
  durationMs: number | null;
}) => ({
  id: a.id,
  title: a.title,
  artists: a.artists,
  durationMs: a.durationMs,
});

function candidate(
  a: { id: string; title: string; artists: string[] },
  position: number,
  picked: boolean,
  violations: { ruleId: string; kind: string; detail: string; values: Record<string, number> }[],
) {
  return {
    assetId: a.id,
    title: a.title,
    artists: a.artists,
    position,
    lastPlayedAt: null,
    violations,
    notes: [],
    picked,
  };
}

describe('log timeline: fixed-time markers (#52)', () => {
  // 13:00 in Paris: a hard marker, the jingle it times (aired 0.4 s late), then a song.
  const top = logItem({
    kind: 'marker',
    title: 'Top of hour',
    plannedStart: '2026-10-21T11:00:00.000Z',
    plannedDurationMs: 0,
    timing: 'hard',
    anchorAt: '2026-10-21T11:00:00.000Z',
  });
  const id = playable({
    kind: 'jingle',
    title: 'Station ID',
    plannedStart: '2026-10-21T11:00:00.000Z',
    plannedDurationMs: 8_000,
  });
  const after = logItem({ title: 'Croix-Rousse', plannedStart: '2026-10-21T11:00:08.000Z' });
  const markerRoutes = (extra: Record<string, ApiRoute> = {}) =>
    routes('programmer', {
      [`GET ${base}/log`]: [200, range([...items.filter((i) => i !== locked), top, id, after])],
      [`GET ${base}/asrun`]: [
        200,
        asRun([
          ...asRun().items,
          asRunEntry({ logItemId: id.id, startedAt: '2026-10-21T11:00:00.400Z', driftMs: 400 }),
        ]),
      ],
      ...extra,
    });

  it('shows the item a marker times, and how close to the marker it aired', async () => {
    const { screen } = renderApp(`${base}/log`, markerRoutes());
    await screen.findByText('Top of hour');
    const marker = row('Top of hour');
    expect(within(marker).getByText('Hard 13:00:00')).toBeInTheDocument();
    expect(within(marker).getByText('Times: Station ID')).toBeInTheDocument();
    expect(within(marker).getByText('Aired ±0 s')).toBeInTheDocument();
  });

  it('adds a soft marker before the first item at its time', async () => {
    let body: unknown;
    const { screen, user } = renderApp(
      `${base}/log`,
      markerRoutes({
        [`POST ${base}/log/items`]: (b) => {
          body = b;
          return [201, { item: top, days: [day] }];
        },
      }),
    );
    await screen.findByText('Top of hour');
    await user.click(screen.getByRole('button', { name: 'Add marker' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Hour'),
      within(dialog).getByRole('option', { name: '13:00' }),
    );
    await user.clear(within(dialog).getByLabelText('Minutes:seconds'));
    await user.type(within(dialog).getByLabelText('Minutes:seconds'), '00:05');
    await user.selectOptions(within(dialog).getByLabelText('Timing'), 'soft');
    expect(within(dialog).getByText(/The item on air ends first/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Cap (seconds)'));
    await user.type(within(dialog).getByLabelText('Cap (seconds)'), '45');
    await user.type(within(dialog).getByLabelText('Label'), 'News');
    await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
    await waitFor(() =>
      expect(body).toEqual({
        placement: { before: after.id },
        item: {
          kind: 'marker',
          plannedDurationMs: 0,
          title: 'News',
          timing: 'soft',
          anchorAt: '2026-10-21T11:00:05.000Z',
          capMs: 45_000,
        },
      }),
    );
    expect(await screen.findByText('Marker added')).toBeInTheDocument();
  });

  it('edits a marker, moving it in the same write when its time moves past other items', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const record = (path: string) => (b: unknown) => {
      calls.push({ path, body: b });
      return [...result(top)] as [number, unknown];
    };
    const { screen, user } = renderApp(
      `${base}/log`,
      markerRoutes({
        [`PUT ${base}/log/items/${top.id}`]: record('replace'),
        [`POST ${base}/log/items/${top.id}/move`]: record('move'),
      }),
    );
    await screen.findByText('Top of hour');
    await user.click(screen.getByRole('button', { name: 'Actions for Top of hour' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit marker…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Minutes:seconds')).toHaveValue('00:00');
    await user.clear(within(dialog).getByLabelText('Minutes:seconds'));
    await user.type(within(dialog).getByLabelText('Minutes:seconds'), '00:10');
    await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['replace']));
    expect(calls[0]?.body).toMatchObject({
      kind: 'marker',
      timing: 'hard',
      anchorAt: '2026-10-21T11:00:10.000Z',
      title: 'Top of hour',
      locked: false,
      // Past the jingle and the song: at the end of the day's items.
      placement: { after: after.id },
    });
  });

  it('checks the cap inline, and only for a soft marker', async () => {
    let posted = 0;
    const { screen, user } = renderApp(
      `${base}/log`,
      markerRoutes({
        [`POST ${base}/log/items`]: () => {
          posted++;
          return [201, { item: top, days: [day] }];
        },
      }),
    );
    await screen.findByText('Top of hour');
    await user.click(screen.getByRole('button', { name: 'Add marker' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Hour'),
      within(dialog).getByRole('option', { name: '13:00' }),
    );
    await user.clear(within(dialog).getByLabelText('Minutes:seconds'));
    await user.type(within(dialog).getByLabelText('Minutes:seconds'), '00:05');
    await user.selectOptions(within(dialog).getByLabelText('Timing'), 'soft');
    const cap = within(dialog).getByLabelText('Cap (seconds)');
    for (const bad of ['601', '-1', '2.5', '']) {
      await user.clear(cap);
      if (bad) await user.type(cap, bad);
      await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
      expect(await within(dialog).findByText('The cap is 0 to 600 seconds.')).toBeInTheDocument();
    }
    expect(posted).toBe(0);
    // A hard marker has no cap: the bad value left in the field doesn't count.
    await user.type(cap, '999');
    await user.selectOptions(within(dialog).getByLabelText('Timing'), 'hard');
    await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
    await waitFor(() => expect(posted).toBe(1));
  });

  it('warns, without blocking, when another marker comes right after the time', async () => {
    let posted = 0;
    const { screen, user } = renderApp(
      `${base}/log`,
      markerRoutes({
        [`POST ${base}/log/items`]: () => {
          posted++;
          return [201, { item: top, days: [day] }];
        },
      }),
    );
    await screen.findByText('Top of hour');
    await user.click(screen.getByRole('button', { name: 'Add marker' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Hour'),
      within(dialog).getByRole('option', { name: '13:00' }),
    );
    // 13:00:00: it would go right before "Top of hour", and time nothing.
    await user.clear(within(dialog).getByLabelText('Minutes:seconds'));
    await user.type(within(dialog).getByLabelText('Minutes:seconds'), '00:00');
    expect(
      within(dialog).getByText(/Another marker comes right after this time/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
    await waitFor(() => expect(posted).toBe(1));
  });

  it('says on the row when a marker times nothing because another marker follows it', async () => {
    const early = logItem({
      kind: 'marker',
      title: 'Pre-top',
      plannedStart: '2026-10-21T11:00:00.000Z',
      plannedDurationMs: 0,
      timing: 'not_before',
      anchorAt: '2026-10-21T11:00:00.000Z',
    });
    const { screen } = renderApp(
      `${base}/log`,
      routes('programmer', {
        [`GET ${base}/log`]: [
          200,
          range([...items.filter((i) => i !== locked), early, top, id, after]),
        ],
      }),
    );
    await screen.findByText('Pre-top');
    expect(
      within(row('Pre-top')).getByText('Times nothing: another marker comes right after it'),
    ).toBeInTheDocument();
    expect(within(row('Top of hour')).getByText('Times: Station ID')).toBeInTheDocument();
  });

  it('refuses a time that has passed, inline', async () => {
    const { screen, user } = renderApp(`${base}/log`, markerRoutes());
    await screen.findByText('Top of hour');
    await user.click(screen.getByRole('button', { name: 'Add marker' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByLabelText('Hour'),
      within(dialog).getByRole('option', { name: '11:00' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save marker' }));
    expect(await within(dialog).findByText('This time has passed.')).toBeInTheDocument();
  });
});
