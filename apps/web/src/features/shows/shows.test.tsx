import type { Episode, MyOrg, Show, ShowOccurrence, ShowSlot } from '@ondes/shared';
import { createEvent, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApiReply,
  type ApiRoute,
  me,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';

// Shows pages on the whole app with a fake api: the list and its permissions, creating a show,
// planning and uploading episodes as a presenter, slot edits that detach episodes, and the
// calendar (conflicts, cancelled airings, moving an airing).

const at = '2026-10-20T08:00:00.000Z';
const showId = '01a15ddf-0000-7000-8000-0000000005a1';
const otherShowId = '01a15ddf-0000-7000-8000-0000000005a2';
const slotId = '01a15ddf-0000-7000-8000-0000000005b1';
const otherSlotId = '01a15ddf-0000-7000-8000-0000000005b2';
const episodeId = '01a15ddf-0000-7000-8000-0000000005c1';
const newEpisodeId = '01a15ddf-0000-7000-8000-0000000005c2';
const uploadId = '01a15ddf-0000-7000-8000-0000000005d1';
const assetId = '01a15ddf-0000-7000-8000-0000000005e1';
const programmerId = '01a15ddf-0000-7000-8000-000000000002';
const base = `/stations/${stationId}`;
const showBase = `${base}/shows/${showId}`;

const withRole = (role: 'programmer' | 'presenter' | 'viewer' | 'station_manager'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const as = (
  role: 'programmer' | 'presenter' | 'viewer' | 'station_manager',
  routes: Record<string, ApiRoute> = {},
): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: withRole(role) }],
  ...routes,
});

const show = (overrides: Partial<Show> = {}): Show => ({
  id: showId,
  stationId,
  name: 'La Matinale',
  description: 'Le réveil de Vandale',
  artworkUrl: null,
  colour: '#1e90ff',
  defaultDurationMs: 3_600_000,
  defaultSlotType: 'prerecorded',
  tags: ['talk'],
  hosts: [{ userId: me.user.id, name: 'Camille Dj' }],
  nextEpisodeNumber: 13,
  fallbackPolicy: 'latest_episode',
  fallbackEpisodeId: null,
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

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
  exceptions: [],
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const episode = (overrides: Partial<Episode> = {}): Episode => ({
  id: episodeId,
  showId,
  number: 12,
  title: 'Spécial rentrée',
  description: null,
  tracklist: [],
  kind: 'prerecorded',
  assetId: null,
  status: 'planned',
  airedAt: null,
  slotId,
  occurrenceDate: '2026-10-21',
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const DAY = 24 * 3600 * 1000;

/** An airing `days` from now, so it falls in the show page's planning window. */
const occurrence = (days: number, overrides: Partial<ShowOccurrence> = {}): ShowOccurrence => {
  const startsAt = new Date(Date.now() + days * DAY);
  return {
    slotId,
    date: startsAt.toISOString().slice(0, 10),
    show: { id: showId, name: 'La Matinale', colour: '#1e90ff' },
    type: 'prerecorded',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    durationMs: 3_600_000,
    moved: false,
    episode: null,
    ...overrides,
  };
};

const occurrences = (items: ShowOccurrence[], conflicts: unknown[] = []): ApiReply => [
  200,
  { timezone: 'Europe/Paris', occurrences: items, conflicts },
];

describe('shows list', () => {
  it('lists the shows a presenter hosts first, from the nav, without "New show"', async () => {
    const { screen, user, history } = renderApp(
      base,
      as('presenter', {
        [`GET ${base}/shows`]: [
          200,
          {
            items: [
              show(),
              show({ id: otherShowId, name: 'Nuit blanche', hosts: [], colour: null }),
            ],
          },
        ],
      }),
    );
    await user.click(await screen.findByRole('link', { name: 'Shows' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/shows`));
    const mine = (await screen.findByRole('heading', { name: 'Your shows' })).closest('section');
    expect(within(mine as HTMLElement).getByText('La Matinale')).toBeVisible();
    expect(within(mine as HTMLElement).queryByText('Nuit blanche')).toBeNull();
    expect(screen.getByText('Nuit blanche')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New show' })).toBeNull();
  });

  it('creates a show with hosts as a programmer, then opens it', async () => {
    const { screen, user, calls, history } = renderApp(
      `${base}/shows`,
      as('programmer', {
        [`GET ${base}/shows`]: [200, { items: [] }],
        [`GET ${base}/show-hosts`]: [
          200,
          {
            items: [
              { userId: me.user.id, name: 'Camille Dj' },
              { userId: programmerId, name: 'Prog' },
            ],
          },
        ],
        [`POST ${base}/shows`]: [201, show()],
        [`GET ${showBase}`]: [200, show()],
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/slots`]: [200, { items: [] }],
        [`GET ${showBase}/episodes`]: [200, { items: [] }],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'New show' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Required.')).toBeVisible();

    await user.type(screen.getByLabelText('Name'), 'La Matinale');
    await user.type(screen.getByLabelText('Tags'), 'talk, news');
    await user.click(await screen.findByRole('checkbox', { name: 'Camille Dj' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(history.location.pathname).toBe(showBase));
    expect(calls.find((c) => c.method === 'POST' && c.path === `${base}/shows`)?.body).toEqual({
      name: 'La Matinale',
      description: null,
      artworkUrl: null,
      colour: null,
      defaultDurationMs: 3_600_000,
      defaultSlotType: 'prerecorded',
      tags: ['talk', 'news'],
      hostUserIds: [me.user.id],
      fallbackPolicy: 'latest_episode',
      fallbackEpisodeId: null,
    });
    expect(await screen.findByRole('heading', { name: 'La Matinale' })).toBeVisible();
  });
});

describe('show page', () => {
  const showRoutes = (
    role: 'programmer' | 'presenter' | 'viewer' | 'station_manager',
    extra: Record<string, ApiRoute> = {},
  ) =>
    as(role, {
      [`GET ${showBase}`]: [200, show()],
      [`GET ${showBase}/slots`]: [200, { items: [slot()] }],
      [`GET ${showBase}/episodes`]: [200, { items: [episode()] }],
      ...extra,
    });

  it('shows hosts, slots, episodes and creates the missing episodes in one click', async () => {
    const created: unknown[] = [];
    const { screen, user } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([
          occurrence(1, { episode: { ...episode(), id: episodeId } }),
          occurrence(5, { slotId: otherSlotId, type: 'live' }),
          occurrence(8),
          occurrence(30),
        ]),
        [`POST ${showBase}/episodes`]: (body) => {
          created.push(body);
          return [201, episode({ id: newEpisodeId, number: 12 + created.length })];
        },
      }),
    );
    expect(await screen.findByText('Hosted by Camille Dj')).toBeVisible();
    expect(screen.getByText('Le réveil de Vandale')).toBeVisible();
    expect(await screen.findByText('Every Wednesday at 20:00')).toBeVisible();
    // A presenter plans episodes, but doesn't shape the grid.
    expect(screen.queryByRole('button', { name: 'Add a slot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Episode #12' })).toBeVisible();

    await user.click(
      await screen.findByRole('button', { name: 'Create the next 2 weeks’ episodes (2)' }),
    );
    expect(await screen.findByText('2 episodes created.')).toBeVisible();
    // The live and the pre-recorded airing of the next two weeks; not the one in a month.
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ slotId: otherSlotId });
    expect(created[1]).toMatchObject({ slotId });
  });

  it('sets the missing-episode fallback to a chosen episode with audio', async () => {
    const aired = episode({ id: newEpisodeId, number: 11, title: 'Best of', assetId });
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${showBase}/episodes`]: [200, { items: [episode(), aired] }],
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`PATCH ${showBase}`]: [
          200,
          show({ fallbackPolicy: 'episode', fallbackEpisodeId: newEpisodeId }),
        ],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const policy = await screen.findByLabelText('If an episode is missing');
    expect(policy).toHaveValue('latest_episode');
    await user.selectOptions(policy, 'episode');
    const chosen = await screen.findByLabelText('Episode to rerun');
    // Only episodes with audio can stand in.
    expect(await screen.findByRole('option', { name: '#11 · Best of' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '#12 · Spécial rentrée' })).toBeNull();
    await user.selectOptions(chosen, newEpisodeId);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path === showBase)?.body).toMatchObject({
        fallbackPolicy: 'episode',
        fallbackEpisodeId: newEpisodeId,
      }),
    );
  });

  it('uploads an airing’s episode as a presenter: creates it, uploads, attaches', async () => {
    const free = occurrence(2);
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([free]),
        [`POST ${showBase}/episodes`]: [201, episode({ id: newEpisodeId, number: 13 })],
        [`POST ${base}/uploads`]: [
          201,
          {
            id: uploadId,
            orgId: orgs[0]?.id,
            stationId,
            status: 'uploading',
            filename: 'ep13.mp3',
            sizeBytes: 4,
            contentType: 'audio/mpeg',
            assetType: 'episode',
            partSize: 16 * 1024 * 1024,
            partCount: 1,
            sha256: null,
            assetId: null,
            duplicateOfAssetId: null,
            errorCode: null,
            error: null,
            createdAt: at,
            updatedAt: at,
          },
        ],
        [`POST ${base}/uploads/${uploadId}/parts`]: [
          200,
          { parts: [{ partNumber: 1, url: 'http://s3.test/bucket/part-1' }], expiresIn: 900 },
        ],
        'PUT /bucket/part-1': [200],
        [`POST ${base}/uploads/${uploadId}/complete`]: [202, uploadReply({ status: 'queued' })],
        [`GET ${base}/uploads/${uploadId}`]: [200, uploadReply({ status: 'ingested', assetId })],
        [`PATCH ${showBase}/episodes/${newEpisodeId}`]: [
          200,
          episode({ id: newEpisodeId, number: 13, assetId, status: 'ready' }),
        ],
      }),
    );
    const row = (await screen.findAllByTestId('upcoming-row'))[0] as HTMLElement;
    const file = new File(['RIFF'], 'ep13.mp3', { type: 'audio/mpeg' });
    await user.upload(within(row).getByLabelText('Upload audio'), file);

    expect(await screen.findByText('ep13.mp3: the episode is ready.')).toBeVisible();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === `${showBase}/episodes`)?.body,
    ).toEqual({ kind: 'prerecorded', slotId, occurrenceDate: free.date });
    expect(calls.find((c) => c.method === 'POST' && c.path === `${base}/uploads`)?.body).toEqual({
      filename: 'ep13.mp3',
      sizeBytes: 4,
      contentType: 'audio/mpeg',
      assetType: 'episode',
      showId,
    });
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/bucket/part-1')).toBe(true);
    expect(
      calls.find((c) => c.method === 'PATCH' && c.path === `${showBase}/episodes/${newEpisodeId}`)
        ?.body,
    ).toEqual({ assetId });
  });

  it('renumbers an episode, and explains a taken number', async () => {
    let attempts = 0;
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`PATCH ${showBase}/episodes/${episodeId}`]: () => {
          attempts += 1;
          return attempts === 1
            ? [409, { error: 'episode_number_taken', message: 'taken' }]
            : [200, episode({ number: 20 })];
        },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Episode #12' }));
    const number = await screen.findByLabelText('Number');
    await user.clear(number);
    await user.type(number, '11');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The show already has an episode with this number.'),
    ).toBeVisible();
    await user.clear(number);
    await user.type(number, '20');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Episode saved.')).toBeVisible();
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.at(-1)?.body).toMatchObject({
      number: 20,
      title: 'Spécial rentrée',
      slotId,
      occurrenceDate: '2026-10-21',
    });
  });

  it('warns when a slot edit detaches episodes, and lists them to plan again', async () => {
    let detached = false;
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('programmer', {
        [`GET ${base}/show-occurrences`]: occurrences([occurrence(3)]),
        [`GET ${showBase}/episodes`]: () => [
          200,
          { items: [episode(detached ? { slotId: null, occurrenceDate: null } : {})] },
        ],
        [`PATCH ${showBase}/slots/${slotId}`]: (body) => {
          detached = true;
          return [
            200,
            {
              slot: slot({ rule: (body as { rule: ShowSlot['rule'] }).rule }),
              detachedEpisodeIds: [episodeId],
            },
          ];
        },
      }),
    );
    await screen.findByText('Every Wednesday at 20:00');
    // The show's Edit is in the header; the slot's comes last.
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(edits[edits.length - 1] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Wednesday' }));
    await user.click(screen.getByRole('button', { name: 'Thursday' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('An episode lost its airing')).toBeVisible();
    expect(screen.getByText(/#12: kept with their audio/)).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      type: 'prerecorded',
      durationMs: 3_600_000,
      rule: { freq: 'weekly', byDay: ['th'], interval: 1, time: '20:00' },
    });
    expect(await screen.findByRole('heading', { name: 'Episodes to plan' })).toBeVisible();
    expect(screen.getByLabelText('Plan #12 on…')).toBeVisible();
  });

  it('creates slots by rule: weekly, every N weeks, once', async () => {
    const created: unknown[] = [];
    const { screen, user } = renderApp(
      showBase,
      showRoutes('programmer', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/slots`]: [200, { items: [] }],
        [`POST ${showBase}/slots`]: (body) => {
          created.push(body);
          return [201, slot()];
        },
      }),
    );
    const add = async () => {
      await user.click(await screen.findByRole('button', { name: 'Add a slot' }));
      return within(await screen.findByRole('dialog'));
    };

    // Every other week, Tuesday and Thursday at 21:30 for 90 min.
    let dialog = await add();
    for (const day of [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]) {
      const button = dialog.getByRole('button', { name: day });
      if (button.getAttribute('aria-pressed') === 'true') await user.click(button);
    }
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    expect(await dialog.findByText('Pick at least one day.')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Tuesday' }));
    await user.click(dialog.getByRole('button', { name: 'Thursday' }));
    await user.clear(dialog.getByLabelText('Every … weeks'));
    await user.type(dialog.getByLabelText('Every … weeks'), '2');
    fireEvent.change(dialog.getByLabelText('From'), { target: { value: '2026-11-03' } });
    fireEvent.change(dialog.getByLabelText('Until (optional)'), {
      target: { value: '2027-06-30' },
    });
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '21:30' } });
    await user.clear(dialog.getByLabelText('Length (min)'));
    await user.type(dialog.getByLabelText('Length (min)'), '90');
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      type: 'prerecorded',
      durationMs: 5_400_000,
      rule: {
        freq: 'weekly',
        startDate: '2026-11-03',
        until: '2027-06-30',
        interval: 2,
        byDay: ['tu', 'th'],
        time: '21:30',
      },
      startMode: 'hard',
      startCapMs: null,
    });

    // A one-off live special, starting after the item on air, 45 s late at most (#46).
    dialog = await add();
    await user.selectOptions(dialog.getByLabelText('Type'), 'live');
    await user.selectOptions(dialog.getByLabelText('Repeats'), 'once');
    fireEvent.change(dialog.getByLabelText('Date'), { target: { value: '2026-12-31' } });
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '23:00' } });
    // Its live settings (#65): wait 10 min for the DJ, who goes on air as soon as they connect.
    fireEvent.change(dialog.getByLabelText('Wait for the DJ (minutes)'), {
      target: { value: '10' },
    });
    await user.selectOptions(dialog.getByLabelText('DJ connected early'), 'go_live');
    await user.selectOptions(dialog.getByLabelText('Start'), 'soft');
    await user.type(dialog.getByLabelText('Late by at most (s)'), '700');
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    expect(await dialog.findByText('Seconds, from 0 to 600.')).toBeVisible();
    expect(created).toHaveLength(1);
    await user.clear(dialog.getByLabelText('Late by at most (s)'));
    await user.type(dialog.getByLabelText('Late by at most (s)'), '45');
    await user.click(dialog.getByRole('button', { name: 'Add the slot' }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect(created[1]).toEqual({
      type: 'live',
      durationMs: 3_600_000,
      rule: { freq: 'once', date: '2026-12-31', time: '23:00' },
      live: { graceMs: 600_000, earlyConnect: 'go_live' },
      startMode: 'soft',
      startCapMs: 45_000,
    });
  });

  it('restores an exception from the slot editor, which stays up to date', async () => {
    let restored = false;
    const { screen, user } = renderApp(
      showBase,
      showRoutes('programmer', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/slots`]: () => [
          200,
          {
            items: [
              slot({ exceptions: restored ? [] : [{ date: '2026-10-28', kind: 'cancelled' }] }),
            ],
          },
        ],
        [`DELETE ${showBase}/slots/${slotId}/exceptions/2026-10-28`]: () => {
          restored = true;
          return [200, { slot: slot(), detachedEpisodeIds: [] }];
        },
      }),
    );
    expect(await screen.findByText(/1 exception/)).toBeVisible();
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(edits[edits.length - 1] as HTMLElement);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Wed, Oct 28: cancelled')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(dialog.queryByText('Wed, Oct 28: cancelled')).toBeNull());
    expect(dialog.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('attaches a library file to an episode, and shows it attached', async () => {
    let attached = false;
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/episodes`]: () => [
          200,
          { items: [episode(attached ? { assetId, status: 'ready' } : {})] },
        ],
        [`GET ${base}/assets`]: [
          200,
          {
            items: [
              {
                id: assetId,
                orgId: orgs[0]?.id,
                stationId,
                type: 'episode',
                title: 'Matinale 12 master',
                artists: [],
                album: null,
                year: null,
                isrc: null,
                version: null,
                durationMs: 3_540_000,
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
        [`PATCH ${showBase}/episodes/${episodeId}`]: () => {
          attached = true;
          return [200, episode({ assetId, status: 'ready' })];
        },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Episode #12' }));
    let dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('No audio yet.')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'From the library' }));
    await user.click(await screen.findByRole('button', { name: 'Use: Matinale 12 master' }));
    expect(await screen.findByText('Audio attached.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ assetId });
    dialog = within(screen.getAllByRole('dialog')[0] as HTMLElement);
    expect(await dialog.findByText('The audio file is attached.')).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Remove the audio' })).toBeVisible();
  });

  it("shows a live episode's recording, and lets a manager process it again (#67)", async () => {
    const recordingId = '01a15ddf-0000-7000-8000-00000000c0de';
    const recording = (status: string, version: number) => ({
      id: recordingId,
      stationId,
      episodeId,
      eventId: null,
      sessionId: null,
      title: 'La Matinale #12',
      status,
      version,
      durationMs: 7_140_000,
      assetId,
      error: status === 'failed' ? 'recording file live-b-2.flac is gone' : null,
      builtAt: at,
      buildMs: 54_000,
      expiresAt: '2026-11-26T19:00:00.000Z',
      parts: [
        {
          id: '01a15ddf-0000-7000-8000-0000000000a1',
          sessionId: slotId,
          status: 'closed',
          startedAt: at,
          endedAt: at,
        },
        {
          id: '01a15ddf-0000-7000-8000-0000000000a2',
          sessionId: slotId,
          status: 'closed',
          startedAt: at,
          endedAt: at,
        },
      ],
      createdAt: at,
    });
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('station_manager', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/episodes`]: [
          200,
          { items: [episode({ kind: 'live', status: 'aired', assetId })] },
        ],
        [`GET ${showBase}/episodes/${episodeId}/recording`]: [
          200,
          { recording: recording('failed', 2) },
        ],
        [`POST ${base}/live/recordings/${recordingId}/rebuild`]: [202, recording('pending', 3)],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Episode #12' }));
    const section = within(await screen.findByTestId('episode-recording'));
    expect(section.getByText('Failed')).toBeVisible();
    expect(section.getByText('recording file live-b-2.flac is gone')).toBeVisible();
    expect(section.getByText(/1 h 59 of audio · 2 parts joined/)).toBeVisible();
    await user.click(section.getByRole('button', { name: 'Process again' }));
    expect(await screen.findByText('The recording is processed again')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/rebuild'))).toBe(true);
  });

  it('offers the recording over other audio a build kept, and says when it cannot be read (#67)', async () => {
    const recordingId = '01a15ddf-0000-7000-8000-00000000c0df';
    const liveAssetId = '01a15ddf-0000-7000-8000-00000000a55e';
    const recording = {
      id: recordingId,
      stationId,
      episodeId,
      eventId: null,
      sessionId: null,
      title: 'La Matinale #12',
      status: 'ready',
      version: 1,
      durationMs: 3_600_000,
      assetId: liveAssetId,
      error: null,
      builtAt: at,
      buildMs: 30_000,
      expiresAt: null,
      parts: [],
      createdAt: at,
    };
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('station_manager', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/episodes`]: [
          200,
          { items: [episode({ kind: 'live', status: 'aired', assetId })] },
        ],
        [`GET ${showBase}/episodes/${episodeId}/recording`]: [200, { recording }],
        [`POST ${base}/live/recordings/${recordingId}/attach`]: [200, recording],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Episode #12' }));
    const section = within(await screen.findByTestId('episode-recording'));
    expect(section.getByText(/The episode already had other audio, which was kept/)).toBeVisible();
    await user.click(section.getByRole('button', { name: 'Use the recording' }));
    expect(await screen.findByText('The recording is now the episode’s audio')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/attach'))).toBe(true);
  });

  it("says calmly when a live episode's recording can't be read (#67)", async () => {
    const { screen, user } = renderApp(
      showBase,
      showRoutes('station_manager', {
        [`GET ${base}/show-occurrences`]: occurrences([]),
        [`GET ${showBase}/episodes`]: [
          200,
          { items: [episode({ kind: 'live', status: 'aired', assetId })] },
        ],
        [`GET ${showBase}/episodes/${episodeId}/recording`]: [
          500,
          { error: 'internal', message: 'boom' },
        ],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Episode #12' }));
    const section = within(await screen.findByTestId('episode-recording', {}, { timeout: 5000 }));
    expect(section.getByText(/The recording couldn’t be read/)).toBeVisible();
  });

  it('plans an unscheduled episode on a free airing', async () => {
    const free = occurrence(9);
    const { screen, user, calls } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([free]),
        [`GET ${showBase}/episodes`]: [
          200,
          { items: [episode({ slotId: null, occurrenceDate: null })] },
        ],
        [`PATCH ${showBase}/episodes/${episodeId}`]: [200, episode()],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Episodes to plan' })).toBeVisible();
    const select = screen.getByLabelText('Plan #12 on…');
    const option = within(select).getAllByRole('option')[1] as HTMLOptionElement;
    await user.selectOptions(select, option);
    expect(await screen.findByText('Episode #12 planned.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      slotId,
      occurrenceDate: free.date,
    });
  });

  it('creates episodes only for airings still to come', async () => {
    const created: unknown[] = [];
    const { screen, user } = renderApp(
      showBase,
      showRoutes('presenter', {
        [`GET ${base}/show-occurrences`]: occurrences([
          occurrence(-0.2, { date: '2000-01-01' }),
          occurrence(3),
        ]),
        [`POST ${showBase}/episodes`]: (body) => {
          created.push(body);
          return [201, episode({ id: newEpisodeId, number: 13 })];
        },
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Create the next 2 weeks’ episodes (1)' }),
    );
    expect(await screen.findByText('Episode created.')).toBeVisible();
    expect(created).toEqual([{ slotId, occurrenceDate: occurrence(3).date }]);
  });

  it('is read-only for viewers', async () => {
    const { screen } = renderApp(
      showBase,
      showRoutes('viewer', {
        [`GET ${base}/show-occurrences`]: occurrences([occurrence(2)]),
      }),
    );
    expect(await screen.findByText('Hosted by Camille Dj')).toBeVisible();
    expect(await screen.findByText('No episode yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Upload audio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New episode' })).toBeNull();
  });
});

describe('calendar', () => {
  const week = `${base}/shows/calendar?view=week&date=2026-10-21`;
  // Wednesday 21 October 2026, 20:00 in Paris (CEST).
  const wednesday = new Date('2026-10-21T18:00:00.000Z');
  const airing = (overrides: Partial<ShowOccurrence> = {}): ShowOccurrence => ({
    slotId,
    date: '2026-10-21',
    show: { id: showId, name: 'La Matinale', colour: '#1e90ff' },
    type: 'prerecorded',
    startsAt: wednesday,
    endsAt: new Date(wednesday.getTime() + 3_600_000),
    durationMs: 3_600_000,
    moved: false,
    episode: null,
    ...overrides,
  });
  const other = airing({
    slotId: otherSlotId,
    show: { id: otherShowId, name: 'Nuit blanche', colour: null },
    startsAt: new Date(wednesday.getTime() + 1_800_000),
    endsAt: new Date(wednesday.getTime() + 5_400_000),
  });

  const calendarRoutes = (role: 'programmer' | 'presenter', extra: Record<string, ApiRoute> = {}) =>
    as(role, {
      [`GET ${base}/shows`]: [
        200,
        { items: [show(), show({ id: otherShowId, name: 'Nuit blanche', hosts: [] })] },
      ],
      [`GET ${showBase}/slots`]: [
        200,
        { items: [slot({ exceptions: [{ date: '2026-10-23', kind: 'cancelled' }] })] },
      ],
      [`GET ${base}/shows/${otherShowId}/slots`]: [200, { items: [] }],
      [`GET ${base}/show-occurrences`]: occurrences(
        [airing({ episode: { ...episode(), id: episodeId } }), other],
        [
          {
            a: { slotId, date: '2026-10-21' },
            b: { slotId: otherSlotId, date: '2026-10-21' },
            startsAt: other.startsAt,
            endsAt: airing().endsAt,
            overlapMs: 1_800_000,
          },
        ],
      ),
      ...extra,
    });

  it('shows a week with its overlaps and cancelled airings, from the nav', async () => {
    const { screen, user } = renderApp(base, calendarRoutes('programmer'));
    await user.click(await screen.findByRole('link', { name: 'Calendar' }));
    expect(await screen.findByText('An overlap')).toBeVisible();
    expect(
      screen.getByText('La Matinale and Nuit blanche overlap on Wed, Oct 21 20:30 (30 min).'),
    ).toBeVisible();
    expect(await screen.findByText('Times in Europe/Paris.')).toBeVisible();
  });

  it('places airings on the station clock, marks cancelled ones and moves an airing', async () => {
    vi.stubGlobal('confirm', () => true);
    const { screen, user, calls } = renderApp(
      week,
      calendarRoutes('programmer', {
        [`PUT ${showBase}/slots/${slotId}/exceptions/2026-10-21`]: (body) => [
          200,
          {
            slot: slot(),
            detachedEpisodeIds: (body as { kind: string }).kind === 'cancelled' ? [episodeId] : [],
          },
        ],
      }),
    );
    const wed = within(await screen.findByTestId('day-2026-10-21'));
    const entry = await wed.findByRole('button', { name: /20:00 La Matinale/ });
    expect(entry).toHaveTextContent('#12 · Planned');
    expect(wed.getByRole('button', { name: /20:30 Nuit blanche/ })).toBeVisible();
    const fri = within(screen.getByTestId('day-2026-10-23'));
    expect(fri.getByRole('button', { name: /La Matinale.*cancelled/ })).toBeVisible();

    await user.click(entry);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Overlaps Nuit blanche for 30 min.')).toBeVisible();
    const date = dialog.getByLabelText('Date');
    expect(date).toHaveValue('2026-10-21');
    fireEvent.change(date, { target: { value: '2026-10-22' } });
    fireEvent.change(dialog.getByLabelText('Time'), { target: { value: '18:30' } });
    await user.click(dialog.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Airing moved.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'moved',
      startDate: '2026-10-22',
      startTime: '18:30',
      durationMs: null,
    });

    await user.click(await wed.findByRole('button', { name: /20:00 La Matinale/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Cancel this airing',
      }),
    );
    expect(await screen.findByText('An episode lost its airing')).toBeVisible();
    expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ kind: 'cancelled' });
  });

  it('reports a failed upload of a dropped file', async () => {
    const { screen, calls } = renderApp(
      week,
      calendarRoutes('presenter', {
        [`POST ${base}/uploads`]: [500, { error: 'internal', message: 'boom' }],
      }),
    );
    const wed = within(await screen.findByTestId('day-2026-10-21'));
    const entry = await wed.findByRole('button', { name: /20:00 La Matinale/ });
    const file = new File(['RIFF'], 'ep12.wav', { type: 'audio/wav' });
    fireEvent.dragOver(entry, { dataTransfer: { types: ['Files'], files: [file] } });
    fireEvent.drop(entry, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === `${base}/uploads`)?.body).toEqual({
        filename: 'ep12.wav',
        sizeBytes: 4,
        contentType: 'audio/wav',
        assetType: 'episode',
        showId,
      }),
    );
    expect(await screen.findByText(/ep12.wav: upload failed/)).toBeVisible();
    // Not their show: no drop target there.
    expect(wed.getByRole('button', { name: /Nuit blanche/ })).toBeVisible();
    expect(
      screen.getByText('Drop an audio file on one of your airings to upload its episode.'),
    ).toBeVisible();
  });

  it('uploads the episode of the airing a file is dropped on', async () => {
    const { screen, calls } = renderApp(
      week,
      calendarRoutes('presenter', {
        ...uploadRoutes(),
        [`PATCH ${showBase}/episodes/${episodeId}`]: [200, episode({ assetId, status: 'ready' })],
      }),
    );
    const wed = within(await screen.findByTestId('day-2026-10-21'));
    const entry = await wed.findByRole('button', { name: /20:00 La Matinale/ });
    const file = new File(['RIFF'], 'ep12.wav', { type: 'audio/wav' });
    fireEvent.dragOver(entry, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(entry).toHaveTextContent('Drop to upload');
    fireEvent.drop(entry, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(await screen.findByText('ep12.wav: the episode is ready.')).toBeVisible();
    // The airing already has its episode: no new one, the audio goes to #12.
    expect(calls.some((c) => c.method === 'POST' && c.path === `${showBase}/episodes`)).toBe(false);
    expect(calls.find((c) => c.method === 'POST' && c.path === `${base}/uploads`)?.body).toEqual({
      filename: 'ep12.wav',
      sizeBytes: 4,
      contentType: 'audio/wav',
      assetType: 'episode',
      showId,
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ assetId });
  });

  it('moves an airing by dragging it to another day and time', async () => {
    const { screen, calls } = renderApp(
      week,
      calendarRoutes('programmer', {
        [`PUT ${showBase}/slots/${slotId}/exceptions/2026-10-21`]: [
          200,
          { slot: slot(), detachedEpisodeIds: [] },
        ],
      }),
    );
    const wed = within(await screen.findByTestId('day-2026-10-21'));
    const entry = await wed.findByRole('button', { name: /20:00 La Matinale/ });
    const data: Record<string, string> = {};
    const dataTransfer = {
      types: ['application/x-ondes-occurrence'],
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? '',
    };
    // happy-dom lays nothing out: rects are at 0, so clientY is the offset in the column
    // (44 px an hour): grabbed at its top, dropped at 18:00 on Thursday.
    // happy-dom's DragEvent drops `clientY` from its init: set it on the event.
    const at = (event: Event, clientY: number) => {
      Object.defineProperty(event, 'clientY', { value: clientY });
      return event;
    };
    fireEvent(entry, at(createEvent.dragStart(entry, { dataTransfer }), 0));
    const thursday = screen.getByTestId('day-2026-10-22');
    fireEvent.dragOver(thursday, { dataTransfer });
    fireEvent(thursday, at(createEvent.drop(thursday, { dataTransfer }), 18 * 44));
    expect(await screen.findByText(/Moved to Thu, Oct 22 18:00/)).toBeVisible();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'moved',
      startDate: '2026-10-22',
      startTime: '18:00',
      durationMs: null,
    });
  });

  it('restores a cancelled airing', async () => {
    const { screen, user, calls } = renderApp(
      week,
      calendarRoutes('programmer', {
        [`DELETE ${showBase}/slots/${slotId}/exceptions/2026-10-23`]: [
          200,
          { slot: slot(), detachedEpisodeIds: [] },
        ],
      }),
    );
    const fri = within(await screen.findByTestId('day-2026-10-23'));
    await user.click(await fri.findByRole('button', { name: /La Matinale.*cancelled/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/This airing is cancelled/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Airing restored.')).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' && c.path === `${showBase}/slots/${slotId}/exceptions/2026-10-23`,
      ),
    ).toBe(true);
  });

  it('marks live airings for screen readers', async () => {
    const { screen } = renderApp(
      week,
      calendarRoutes('programmer', {
        [`GET ${base}/show-occurrences`]: occurrences([airing({ type: 'live' })]),
      }),
    );
    const wed = within(await screen.findByTestId('day-2026-10-21'));
    expect(await wed.findByRole('img', { name: 'Live' })).toBeInTheDocument();
  });

  it('opens on the list view on a phone', async () => {
    const width = window.innerWidth;
    window.innerWidth = 375;
    try {
      const { screen } = renderApp(
        `${base}/shows/calendar?date=2026-10-21`,
        calendarRoutes('presenter'),
      );
      expect(await screen.findByRole('button', { name: 'List', pressed: true })).toBeVisible();
      expect(await screen.findByRole('heading', { name: 'Wednesday, Oct 21' })).toBeVisible();
      expect(screen.getAllByText('Nothing on air.').length).toBeGreaterThan(0);
    } finally {
      window.innerWidth = width;
    }
  });
});

/** The library upload api, answering an ingested upload of `assetId`. */
function uploadRoutes(): Record<string, ApiRoute> {
  return {
    [`POST ${base}/uploads`]: [201, uploadReply({})],
    [`POST ${base}/uploads/${uploadId}/parts`]: [
      200,
      { parts: [{ partNumber: 1, url: 'http://s3.test/bucket/part-1' }], expiresIn: 900 },
    ],
    'PUT /bucket/part-1': [200],
    [`POST ${base}/uploads/${uploadId}/complete`]: [202, uploadReply({ status: 'queued' })],
    [`GET ${base}/uploads/${uploadId}`]: [200, uploadReply({ status: 'ingested', assetId })],
  };
}

function uploadReply(overrides: Record<string, unknown>) {
  return {
    id: uploadId,
    orgId: orgs[0]?.id,
    stationId,
    status: 'uploading',
    filename: 'ep13.mp3',
    sizeBytes: 4,
    contentType: 'audio/mpeg',
    assetType: 'episode',
    partSize: 16 * 1024 * 1024,
    partCount: 1,
    sha256: null,
    assetId: null,
    duplicateOfAssetId: null,
    errorCode: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
