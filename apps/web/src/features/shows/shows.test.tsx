import type { Episode, MyOrg, Show, ShowOccurrence, ShowSlot } from '@ondes/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
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

const withRole = (role: 'programmer' | 'presenter' | 'viewer'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const as = (
  role: 'programmer' | 'presenter' | 'viewer',
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
    });
    expect(await screen.findByRole('heading', { name: 'La Matinale' })).toBeVisible();
  });
});

describe('show page', () => {
  const showRoutes = (
    role: 'programmer' | 'presenter' | 'viewer',
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

  it('uploads an episode when a file is dropped on an airing', async () => {
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
      }),
    );
    expect(await screen.findByText(/ep12.wav: upload failed/)).toBeVisible();
    // Not their show: no drop target there.
    expect(wed.getByRole('button', { name: /Nuit blanche/ })).toBeVisible();
    expect(
      screen.getByText('Drop an audio file on one of your airings to upload its episode.'),
    ).toBeVisible();
  });
});

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
