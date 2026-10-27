import type { LiveConnectionInfo, MyOrg, Streamer } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApiRoute,
  me,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';

// The live page on the whole app with a fake api: connection settings, the streamer list for a
// manager and for a presenter, creating a streamer (password shown once), station time.

const at = '2026-10-20T08:00:00.000Z';
const base = `/stations/${stationId}/live`;
const showId = '01a15ddf-0000-7000-8000-0000000006a1';
const streamerId = '01a15ddf-0000-7000-8000-0000000006b1';
const ownId = '01a15ddf-0000-7000-8000-0000000006b2';

const withRole = (role: 'station_manager' | 'presenter' | 'viewer'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

const streamer = (overrides: Partial<Streamer> = {}): Streamer => ({
  id: streamerId,
  stationId,
  displayName: 'DJ Nova',
  username: 'nova',
  user: null,
  enabled: true,
  // 22:30 in Paris.
  expiresAt: new Date('2026-11-05T21:30:00Z'),
  anyTime: false,
  adHoc: 'approval',
  encoderMetadata: false,
  shows: [{ id: showId, name: 'Night Shift', colour: '#ff00aa' }],
  status: 'active',
  lastConnectedAt: null,
  passwordChangedAt: new Date(at),
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ...overrides,
});

const connection: LiveConnectionInfo = {
  enabled: true,
  host: 'live.vandale.test',
  port: 8105,
  mount: 'live',
  mounts: ['live', 'live-2'],
  shoutcastPort: null,
  formats: ['MP3', 'AAC'],
};

const as = (
  role: 'station_manager' | 'presenter' | 'viewer',
  routes: Record<string, ApiRoute> = {},
): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: withRole(role) }],
  [`GET ${base}/connection`]: [200, connection],
  [`GET ${base}/events`]: [200, { events: [] }],
  [`GET ${base}/requests`]: [200, { requests: [] }],
  ...routes,
});

describe('live page', () => {
  it('shows a manager every streamer and the connection settings, in station time', async () => {
    const { screen } = renderApp(
      base,
      as('station_manager', { [`GET ${base}/streamers`]: [200, { streamers: [streamer()] }] }),
    );
    expect(await screen.findByText('DJ Nova')).toBeTruthy();
    expect(screen.getByText('Night Shift')).toBeTruthy();
    expect(screen.getByText('Guest')).toBeTruthy();
    expect(screen.getByText(/Until .*10:30\s?PM/)).toBeTruthy();
    expect(screen.getAllByText('live.vandale.test')).toHaveLength(2);
    expect(screen.getAllByText('8105')).toHaveLength(2);
    expect(
      screen.getByText('icecast://<your username>:<your password>@live.vandale.test:8105/live'),
    ).toBeTruthy();
    expect(screen.getByText(/doesn’t take Shoutcast \(v1\) clients/)).toBeTruthy();
    // The harbor pool (#64): the next DJ's mount.
    expect(screen.getByText(/If live is taken .*, use live-2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New streamer' })).toBeTruthy();
  });

  it('says the port is not assigned yet before the engine starts, with nothing to copy', async () => {
    const { screen } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [] }],
        [`GET ${base}/connection`]: [200, { ...connection, port: null }],
      }),
    );
    expect(await screen.findByText(/hasn’t started yet/)).toBeTruthy();
    // Port in BUTT and Mixxx, and OBS's URL.
    expect(screen.getAllByText('Not assigned yet')).toHaveLength(3);
    expect(screen.queryByText(/icecast:\/\//)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Port' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy Server' })).toHaveLength(2);
  });

  it('creates a streamer and shows its password once', async () => {
    const created = streamer({ shows: [], anyTime: true, expiresAt: null, username: 'guest-dj' });
    const { screen, user, calls } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [] }],
        [`GET ${base}/streamers/user-candidates`]: [
          200,
          { users: [{ id: me.user.id, name: 'Camille Dj' }] },
        ],
        [`GET /stations/${stationId}/shows`]: [200, { items: [] }],
        [`POST ${base}/streamers`]: [
          201,
          { streamer: created, password: 'Abcdefghijkmnpqrstuvwxyz' },
        ],
      }),
    );
    expect(await screen.findByText(/Nobody can go live yet/)).toBeTruthy();
    expect(screen.getByText(/connect from 15 minutes before/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'New streamer' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'Guest DJ');
    await user.type(dialog.getByLabelText('Username'), 'Guest-DJ');
    await user.click(dialog.getByText('May connect any time'));
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByText('Password for guest-dj')).toBeTruthy());
    expect(screen.getByDisplayValue('Abcdefghijkmnpqrstuvwxyz')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === `${base}/streamers`);
    expect(post?.body).toEqual({
      displayName: 'Guest DJ',
      username: 'guest-dj',
      userId: null,
      enabled: true,
      expiresAt: null,
      anyTime: true,
      adHoc: 'approval',
      encoderMetadata: false,
      showIds: [],
    });
  });

  it('shows a presenter only their credentials, with their username in the settings', async () => {
    const own = streamer({
      id: ownId,
      username: 'camille',
      displayName: 'Camille',
      user: { id: me.user.id, name: 'Camille Dj' },
      expiresAt: null,
      anyTime: true,
      shows: [],
    });
    const { screen } = renderApp(
      base,
      as('presenter', { [`GET ${base}/streamers`]: [200, { streamers: [own] }] }),
    );
    expect(await screen.findByText('Your credentials')).toBeTruthy();
    expect(await screen.findByText('Any time')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New password' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New streamer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getAllByText('camille').length).toBeGreaterThan(1);
  });

  it('tells a presenter without credentials to ask', async () => {
    const { screen } = renderApp(
      base,
      as('presenter', { [`GET ${base}/streamers`]: [200, { streamers: [] }] }),
    );
    expect(await screen.findByText(/You have no live credentials/)).toBeTruthy();
  });

  it('asks a manager to put a DJ connected outside their slot on air (#65)', async () => {
    const requestId = '01a15ddf-0000-7000-8000-0000000006c1';
    const sessionId = '01a15ddf-0000-7000-8000-0000000006d1';
    const pending = {
      id: requestId,
      streamer: { id: streamerId, displayName: 'DJ Nova' },
      input: 2,
      status: 'pending',
      // 09:05 in Paris.
      requestedAt: '2026-10-20T07:05:00.000Z',
      decidedAt: null,
    };
    const { screen, user, calls } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [streamer()] }],
        [`GET ${base}/requests`]: [200, { requests: [pending] }],
        [`POST ${base}/requests/${requestId}/approve`]: [
          200,
          {
            id: sessionId,
            streamer: { id: streamerId, displayName: 'DJ Nova' },
            input: 2,
            trigger: 'ad_hoc',
            startedAt: at,
            endedAt: null,
            endReason: null,
          },
        ],
      }),
    );
    expect(
      await screen.findByText('DJ Nova is connected (input 2). Put them on air?'),
    ).toBeTruthy();
    expect(screen.getByText(/since 9:05\s?AM/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Put on air' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path === `${base}/requests/${requestId}/approve`,
        ),
      ).toBe(true),
    );
  });

  it('shows no prompt to a presenter, who may not put anyone on air', async () => {
    const { screen, calls } = renderApp(
      base,
      as('presenter', { [`GET ${base}/streamers`]: [200, { streamers: [] }] }),
    );
    expect(await screen.findByText(/You have no live credentials/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Put on air' })).toBeNull();
    expect(calls.some((c) => c.path === `${base}/requests`)).toBe(false);
  });

  it('creates an event in station time (#65)', async () => {
    const eventId = '01a15ddf-0000-7000-8000-0000000006e1';
    const { screen, user, calls } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [streamer()] }],
        [`POST ${base}/events`]: [
          201,
          {
            id: eventId,
            stationId,
            title: 'Fête de la musique',
            startsAt: '2026-06-21T16:00:00.000Z',
            endsAt: '2026-06-21T20:00:00.000Z',
            streamers: [{ id: streamerId, displayName: 'DJ Nova' }],
            createdAt: at,
            updatedAt: at,
          },
        ],
      }),
    );
    expect(await screen.findByText('No upcoming event.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New event' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Title'), 'Fête de la musique');
    // Typed in station time (Europe/Paris, CEST in June).
    await user.type(
      dialog.getByLabelText('Starts', { selector: 'input[type=date]' }),
      '2026-06-21',
    );
    await user.type(dialog.getByLabelText('Starts', { selector: 'input[type=time]' }), '18:00');
    await user.type(dialog.getByLabelText('Ends', { selector: 'input[type=date]' }), '2026-06-21');
    await user.type(dialog.getByLabelText('Ends', { selector: 'input[type=time]' }), '22:00');
    await user.click(await dialog.findByText('DJ Nova'));
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === `${base}/events`)).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.path === `${base}/events`);
    expect(post?.body).toEqual({
      title: 'Fête de la musique',
      startsAt: '2026-06-21T16:00:00.000Z',
      endsAt: '2026-06-21T20:00:00.000Z',
      streamerIds: [streamerId],
    });
  });

  it('sets a streamer’s ad-hoc policy (#65)', async () => {
    const { screen, user, calls } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [streamer()] }],
        [`GET ${base}/streamers/user-candidates`]: [200, { users: [] }],
        [`GET /stations/${stationId}/shows`]: [200, { items: [] }],
        [`PATCH ${base}/streamers/${streamerId}`]: [200, streamer({ adHoc: 'allowed' })],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Outside their slots'), 'allowed');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ adHoc: 'allowed' });
  });

  it('deletes an event after confirming (#65)', async () => {
    const eventId = '01a15ddf-0000-7000-8000-0000000006e2';
    const event = {
      id: eventId,
      stationId,
      title: 'Block party',
      startsAt: '2026-11-21T16:00:00.000Z',
      endsAt: '2026-11-21T20:00:00.000Z',
      streamers: [],
      createdAt: at,
      updatedAt: at,
    };
    const { screen, user, calls } = renderApp(
      base,
      as('station_manager', {
        [`GET ${base}/streamers`]: [200, { streamers: [] }],
        [`GET ${base}/events`]: [200, { events: [event] }],
        [`DELETE ${base}/events/${eventId}`]: [204, null],
      }),
    );
    expect(await screen.findByText('Block party')).toBeTruthy();
    expect(screen.getByText(/Any streamer/)).toBeTruthy();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const row = within(screen.getByText('Block party').closest('li') as HTMLElement);
    await user.click(row.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path === `${base}/events/${eventId}`),
      ).toBe(true),
    );
    expect(confirm).toHaveBeenCalledWith('Delete the event “Block party”?');
    vi.unstubAllGlobals();
  });
});
