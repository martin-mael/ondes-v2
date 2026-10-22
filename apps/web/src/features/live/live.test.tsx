import type { LiveConnectionInfo, MyOrg, Streamer } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    expect(
      screen.getByText(/Shoutcast \(v1\) clients would connect on the port \+ 1/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New streamer' })).toBeTruthy();
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
});
