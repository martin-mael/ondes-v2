import type { LogDay, Segue, SegueMedia } from '@ondes/shared';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiRoute, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';
import { logItem } from '../log-timeline/testing.ts';

// The segue editor on the whole app with a fake api: opened from the timeline, lanes for A,
// the voice and B, the ducking preset, undo/redo, the estimated time on air in station time,
// and saves (create, update with the version, a conflict reloads).

const NOW = '2026-10-21T09:00:00.000Z';
const base = `/stations/${stationId}`;
const SR = 44_100;
const s = (n: number) => Math.round(n * SR);

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

const asset = (n: number, title: string) => ({
  id: `01a15ddf-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  type: 'song' as const,
  title,
  artists: ['Les Traboules'],
  durationMs: 200_000,
});
const vtAsset = '01a15ddf-0000-7000-8000-0000000002f1';

const a = logItem({
  plannedStart: '2026-10-21T10:00:00.000Z',
  title: null,
  asset: asset(1, 'Fourviere'),
  assetId: asset(1, 'Fourviere').id,
});
const b = logItem({
  plannedStart: '2026-10-21T10:03:20.000Z',
  title: null,
  asset: asset(2, 'Saone Drift'),
  assetId: asset(2, 'Saone Drift').id,
});

const media = (assetId: string, seconds: number): SegueMedia => ({
  assetId,
  sha256: assetId.replace(/-/g, '').padEnd(64, '0'),
  sampleRate: SR,
  durationSamples: s(seconds),
  gainDb: -2,
  cueIn: 0,
  cueOut: s(seconds),
});

const segue = (overrides: Partial<Segue> = {}): Segue => ({
  id: '01a15ddf-0000-7000-8000-0000000005e1',
  stationId,
  fromItemId: a.id,
  toItemId: b.id,
  fromAssetId: a.assetId,
  toAssetId: b.assetId,
  out: { envelope: [] },
  in: { start: -s(1), envelope: [] },
  voices: [{ assetId: vtAsset, start: -s(3), gainDb: 0, envelope: [] }],
  origin: 'manual',
  status: 'ready',
  problem: null,
  island: null,
  version: 4,
  createdBy: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...overrides,
});

const url = `${base}/log/segue?date=2026-10-21&from=${a.id}&to=${b.id}`;

function routes(existing: Segue | null, extra: Record<string, ApiRoute> = {}) {
  return {
    ...signedIn(),
    [`GET ${base}/log`]: [200, { from: day.startsAt, to: day.endsAt, days: [day], items: [a, b] }],
    [`GET ${base}/asrun`]: [200, { items: [], nextCursor: null }],
    [`GET ${base}/segues`]: [200, { items: existing ? [existing] : [] }],
    [`GET ${base}/segues/media`]: [
      200,
      {
        items: { [a.id]: media(a.assetId as string, 200), [b.id]: media(b.assetId as string, 200) },
        assets: existing ? { [vtAsset]: media(vtAsset, 5) } : {},
      },
    ],
    ...extra,
  } satisfies Record<string, ApiRoute>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('segue editor', () => {
  it('opens from the timeline on a transition', async () => {
    const { screen, user, history } = renderApp(`${base}/log?date=2026-10-21`, routes(null));
    await user.click(await screen.findByRole('button', { name: 'Actions for Fourviere' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Edit the segue into the next item' }),
    );
    expect(await screen.findByRole('heading', { name: 'Segue' })).toBeInTheDocument();
    expect(history.location.pathname).toBe(`${base}/log/segue`);
    expect(history.location.search).toContain(`from=${a.id}`);
    expect(history.location.search).toContain(`to=${b.id}`);
  });

  it('shows the lanes and the time on air in station time', async () => {
    const { screen } = renderApp(url, routes(segue()));
    expect(await screen.findByText('Outgoing')).toBeInTheDocument();
    expect(await screen.findByText('Voice 1')).toBeInTheDocument();
    expect(screen.getByText('Incoming')).toBeInTheDocument();
    expect(screen.getByText('Fourviere → Saone Drift')).toBeInTheDocument();
    // A plays 200 s from 12:00:00 Paris: B starts 1 s before its end, at 12:03:19.
    expect(await screen.findByText(/Next starts −?-1 s · on air ≈ 12:03:19/)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('No island: airs as a crossfade')).toBeInTheDocument();
  });

  it('ducks under the voice, undoes and redoes, and saves with the version', async () => {
    const put = vi.fn((body: unknown): [number, unknown] => [
      200,
      segue({ ...(body as object), version: 5 }),
    ]);
    const { screen, user } = renderApp(
      url,
      routes(segue(), { [`PUT ${base}/segues/${segue().id}`]: put }),
    );
    await screen.findByText('Voice 1');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Duck under the voice: -8 dB, 300 ms ramps',
      }),
    );
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      version: 4,
      out: {
        envelope: [
          { at: -s(3) - s(0.3), gainDb: 0 },
          { at: -s(3), gainDb: -8 },
        ],
      },
      in: { start: -s(1), envelope: [{ at: s(2), gainDb: -8 }, { gainDb: 0 }] },
    });
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('creates the segue of a new transition', async () => {
    const post = vi.fn((body: unknown): [number, unknown] => [201, segue(body as object)]);
    const { screen, user } = renderApp(url, routes(null, { [`POST ${base}/segues`]: post }));
    await screen.findByText('Not saved yet');
    expect(screen.queryByText('Voice 1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      fromItemId: a.id,
      toItemId: b.id,
      in: { start: 0 },
      voices: [],
    });
  });

  it('reloads the segue when someone else saved it meanwhile', async () => {
    let current = segue();
    const { screen, user } = renderApp(
      url,
      routes(current, {
        [`GET ${base}/segues`]: () => [200, { items: [current] }],
        [`PUT ${base}/segues/${current.id}`]: () => {
          current = segue({ version: 9, out: { envelope: [{ at: -s(1), gainDb: -3 }] } });
          return [409, { error: 'conflict', message: 'segue changed' }];
        },
      }),
    );
    await screen.findByText('Voice 1');
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'Someone saved this segue meanwhile. It was reloaded: redo your change.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('says when the transition is gone from the log', async () => {
    const { screen } = renderApp(
      `${base}/log/segue?date=2026-10-21&from=${b.id}&to=${a.id}`,
      routes(null),
    );
    expect(await screen.findByText('This transition is no longer in the log.')).toBeInTheDocument();
  });
});
