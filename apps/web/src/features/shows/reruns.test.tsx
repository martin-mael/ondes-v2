import type { Episode, MyOrg, Show, ShowOccurrence, ShowSlot } from '@ondes/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';

// Reruns (#48) on the show page with a fake api: a rerun slot's strategy, what each rerun
// airing plays again, and "Schedule a rerun" on an episode with audio.

const at = '2026-10-20T08:00:00.000Z';
const showId = '01a15ddf-0000-7000-8000-0000000048a1';
const slotId = '01a15ddf-0000-7000-8000-0000000048b1';
const rerunSlotId = '01a15ddf-0000-7000-8000-0000000048b2';
const airedId = '01a15ddf-0000-7000-8000-0000000048c1';
const plannedId = '01a15ddf-0000-7000-8000-0000000048c2';
const assetId = '01a15ddf-0000-7000-8000-0000000048e1';
const base = `/stations/${stationId}`;
const showBase = `${base}/shows/${showId}`;
const DAY = 24 * 3600 * 1000;

const withRole = (role: 'programmer' | 'presenter'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const show: Show = {
  id: showId,
  stationId,
  name: 'La Matinale',
  description: null,
  artworkUrl: null,
  colour: '#1e90ff',
  defaultDurationMs: 3_600_000,
  defaultSlotType: 'prerecorded',
  tags: [],
  hosts: [],
  nextEpisodeNumber: 13,
  fallbackPolicy: 'latest_episode',
  fallbackEpisodeId: null,
  createdAt: new Date(at),
  updatedAt: new Date(at),
};

const slot = (overrides: Partial<ShowSlot> = {}): ShowSlot => ({
  id: slotId,
  showId,
  type: 'prerecorded',
  rule: {
    freq: 'weekly',
    startDate: '2026-09-01',
    until: null,
    interval: 1,
    byDay: ['we'],
    time: '20:00',
  },
  durationMs: 3_600_000,
  rerun: null,
  exceptions: [],
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const episode = (overrides: Partial<Episode> = {}): Episode => ({
  id: airedId,
  showId,
  number: 11,
  title: 'Best of',
  description: null,
  tracklist: [],
  kind: 'prerecorded',
  assetId,
  status: 'aired',
  airedAt: new Date(at),
  slotId,
  occurrenceDate: '2026-10-14',
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const unscheduledId = '01a15ddf-0000-7000-8000-0000000048c3';
const episodes = [
  episode(),
  episode({ id: plannedId, number: 12, title: null, assetId: null, status: 'planned' }),
  // Audio, but never aired nor planned: not rerunnable.
  episode({
    id: unscheduledId,
    number: 13,
    title: 'Pilot',
    assetId: '01a15ddf-0000-7000-8000-0000000048e2',
    status: 'ready',
    airedAt: null,
    slotId: null,
    occurrenceDate: null,
  }),
];

const occurrence = (days: number, overrides: Partial<ShowOccurrence> = {}): ShowOccurrence => {
  const startsAt = new Date(Date.now() + days * DAY);
  return {
    slotId: rerunSlotId,
    date: startsAt.toISOString().slice(0, 10),
    show: { id: showId, name: 'La Matinale', colour: '#1e90ff' },
    type: 'rerun',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    durationMs: 3_600_000,
    moved: false,
    episode: null,
    ...overrides,
  };
};

const routes = (
  role: 'programmer' | 'presenter',
  extra: Record<string, ApiRoute> = {},
): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: withRole(role) }],
  [`GET ${showBase}`]: [200, show],
  [`GET ${showBase}/slots`]: [
    200,
    {
      items: [
        slot(),
        slot({
          id: rerunSlotId,
          type: 'rerun',
          rerun: { strategy: 'episode', episodeId: airedId },
        }),
      ],
    },
  ],
  [`GET ${showBase}/episodes`]: [200, { items: episodes }],
  [`GET ${base}/show-occurrences`]: [
    200,
    {
      timezone: 'Europe/Paris',
      occurrences: [
        occurrence(1, {
          rerunOf: {
            id: airedId,
            number: 11,
            title: 'Best of',
            kind: 'prerecorded',
            assetId,
            status: 'aired',
          },
        }),
        occurrence(8, { rerunOf: null }),
      ],
      conflicts: [],
    },
  ],
  ...extra,
});

describe('reruns', () => {
  it('shows what each rerun airs again, and the slot’s strategy', async () => {
    const { screen } = renderApp(showBase, routes('presenter'));
    expect(await screen.findByText('Rerun of episode 11 · Best of')).toBeVisible();
    expect(screen.getByText('Nothing to rerun yet: no earlier episode has audio.')).toBeVisible();
    expect(await screen.findByText(/Reruns episode 11/)).toBeVisible();
    // Scheduling a rerun adds a slot: programmers only.
    expect(screen.queryByRole('button', { name: 'Schedule a rerun of episode 11' })).toBeNull();
  });

  it('schedules a rerun of an episode with audio, on the station’s clock', async () => {
    const { screen, user, calls } = renderApp(
      showBase,
      routes('programmer', {
        [`POST ${showBase}/episodes/${airedId}/reruns`]: (body) => [
          201,
          slot({
            id: '01a15ddf-0000-7000-8000-0000000048b9',
            type: 'rerun',
            rule: { freq: 'once', ...(body as { date: string; time: string }) },
            rerun: { strategy: 'episode', episodeId: airedId },
          }),
        ],
      }),
    );
    // Only aired episodes: not one without audio, nor one that never aired.
    await screen.findByRole('button', { name: 'Schedule a rerun of episode 11' });
    expect(screen.queryByRole('button', { name: 'Schedule a rerun of episode 12' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schedule a rerun of episode 13' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Schedule a rerun of episode 11' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/Europe\/Paris/)).toBeVisible();
    // Before its first airing (08:00Z = 10:00 in Paris, that day): explained, not sent.
    fireEvent.change(dialog.getByLabelText('Date'), { target: { value: '2026-10-20' } });
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '09:30' } });
    expect(dialog.getByText(/first aired on .* 10:00/)).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Schedule' })).toBeDisabled();
    // Later that day is fine.
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '10:30' } });
    expect(dialog.queryByText(/first aired on/)).toBeNull();
    // Lengths are whole minutes, said so.
    fireEvent.change(dialog.getByLabelText('Length (minutes)'), { target: { value: '0.5' } });
    expect(dialog.getByText('A whole number of minutes, from 1 to 1440.')).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Schedule' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Length (minutes)'), { target: { value: '' } });

    fireEvent.change(dialog.getByLabelText('Date'), { target: { value: '2026-12-26' } });
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '14:00' } });
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/reruns'))?.body).toEqual({
        date: '2026-12-26',
        time: '14:00',
      }),
    );
    expect(await screen.findByText(/Rerun of episode 11 scheduled for/)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('creates a rerun slot on a chosen episode', async () => {
    const created: unknown[] = [];
    const { screen, user } = renderApp(
      showBase,
      routes('programmer', {
        [`POST ${showBase}/slots`]: (body) => {
          created.push(body);
          return [201, slot()];
        },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Add a slot' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Type'), 'rerun');
    expect(dialog.getByLabelText('Episode to air again')).toHaveValue('latest_episode');
    await user.selectOptions(dialog.getByLabelText('Episode to air again'), 'episode');
    // Not chosen yet: a calm note, saving still works.
    expect(dialog.getByText(/the latest one airs until you pick one/)).toBeVisible();
    // Only aired episodes can air again.
    expect(await dialog.findByRole('option', { name: '#11 · Best of' })).toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: '#12' })).toBeNull();
    expect(dialog.queryByRole('option', { name: '#13 · Pilot' })).toBeNull();
    await user.selectOptions(dialog.getByLabelText('Episode'), airedId);
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      type: 'rerun',
      rerun: { strategy: 'episode', episodeId: airedId },
    });
  });

  it('saves a chosen-episode strategy before the episode is picked', async () => {
    const created: unknown[] = [];
    const { screen, user } = renderApp(
      showBase,
      routes('programmer', {
        [`POST ${showBase}/slots`]: (body) => {
          created.push(body);
          return [201, slot()];
        },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Add a slot' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Type'), 'rerun');
    await user.selectOptions(dialog.getByLabelText('Episode to air again'), 'episode');
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ rerun: { strategy: 'episode', episodeId: null } });
  });

  it('edits an existing rerun slot’s strategy', async () => {
    const { screen, user, calls } = renderApp(
      showBase,
      routes('programmer', {
        [`PATCH ${showBase}/slots/${rerunSlotId}`]: [
          200,
          {
            slot: slot({ id: rerunSlotId, type: 'rerun', rerun: { strategy: 'latest_episode' } }),
            detachedEpisodeIds: [],
          },
        ],
      }),
    );
    await screen.findByText(/Reruns episode 11/);
    // The show's Edit is in the header; the rerun slot's comes last.
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(edits[edits.length - 1] as HTMLElement);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Episode to air again')).toHaveValue('episode');
    expect(await dialog.findByLabelText('Episode')).toHaveValue(airedId);
    await user.selectOptions(dialog.getByLabelText('Episode to air again'), 'latest_episode');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        type: 'rerun',
        rerun: { strategy: 'latest_episode' },
      }),
    );
  });

  it('says when a chosen-episode slot has no episode (none picked, or deleted)', async () => {
    const { screen } = renderApp(
      showBase,
      routes('presenter', {
        [`GET ${showBase}/slots`]: [
          200,
          {
            items: [
              slot({
                id: rerunSlotId,
                type: 'rerun',
                rerun: { strategy: 'episode', episodeId: null },
              }),
            ],
          },
        ],
      }),
    );
    expect(
      await screen.findByText(/Reruns the latest episode: no episode chosen \(or it was deleted\)/),
    ).toBeVisible();
  });
});
