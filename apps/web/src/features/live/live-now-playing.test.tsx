import type { LiveNowPlaying, MyOrg } from '@ondes/shared';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import { orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';

// Live metadata on the dashboard (#68): what the streams show while a DJ is on air, a manual
// now-playing typed by a manager and cleared again, refreshed by `live.metadata.changed`.

const route = `/stations/${stationId}/live/now-playing`;
const sessionId = '01a15ddf-0000-7000-8000-0000000068a1';

const asManager: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) => (s.id === stationId ? { ...s, role: 'station_manager' } : s)),
}));

const nowPlaying = (over: Partial<LiveNowPlaying> = {}): LiveNowPlaying => ({
  sessionId,
  input: 1,
  title: 'Night Shift #12',
  artist: 'DJ Nova',
  source: 'default',
  encoderAllowed: false,
  updatedAt: '2026-11-05T19:10:00.000Z',
  ...over,
});

describe('live now-playing control', () => {
  it('sets a manual now-playing, then goes back to automatic', async () => {
    let current = nowPlaying();
    const { screen, user, calls } = renderApp(`/stations/${stationId}`, {
      ...signedIn(),
      'GET /orgs': [200, { orgs: asManager }],
      [`GET ${route}`]: () => [200, { nowPlaying: current }],
      [`PUT ${route}`]: (body) => {
        const b = body as { title: string; artist: string };
        current = nowPlaying({ title: b.title || null, artist: b.artist, source: 'manual' });
        return [200, current];
      },
      [`DELETE ${route}`]: () => {
        current = nowPlaying();
        return [200, current];
      },
    });
    expect(await screen.findByTestId('live-now-playing')).toHaveTextContent(
      'DJ Nova – Night Shift #12',
    );
    expect(screen.getByText('Show and DJ')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Back to automatic' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Artist'), 'Kiosque');
    await user.click(screen.getByRole('button', { name: 'Show on the streams' }));
    await waitFor(() =>
      expect(screen.getByTestId('live-now-playing')).toHaveTextContent('Kiosque'),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ title: '', artist: 'Kiosque' });
    expect(screen.getByText('Typed by hand')).toBeVisible();
    expect(screen.getByLabelText('Artist')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Back to automatic' }));
    await waitFor(() =>
      expect(screen.getByTestId('live-now-playing')).toHaveTextContent('DJ Nova'),
    );
  });

  it("follows the encoder's titles over SSE and hides when nobody is on air", async () => {
    let current: LiveNowPlaying | null = nowPlaying();
    const { screen } = renderApp(`/stations/${stationId}`, {
      ...signedIn(),
      'GET /orgs': [200, { orgs: asManager }],
      [`GET ${route}`]: () => [200, { nowPlaying: current }],
    });
    expect(await screen.findByTestId('live-now-playing')).toHaveTextContent('DJ Nova');
    const source = await waitFor(() => FakeEventSource.last());
    act(() => source.open());

    current = nowPlaying({ title: 'Second Song', artist: null, source: 'encoder' });
    act(() =>
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d6801',
        stationId,
        at: '2026-11-05T19:11:00.000Z',
        type: 'live.metadata.changed',
        data: current,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('live-now-playing')).toHaveTextContent('Second Song'),
    );
    expect(screen.getByText('From the DJ software')).toBeVisible();

    current = null;
    act(() =>
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d6802',
        stationId,
        at: '2026-11-05T19:12:00.000Z',
        type: 'live.session.ended',
        data: { sessionId, streamerId: null, input: 1, reason: 'returned' },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('live-now-playing')).not.toBeInTheDocument());
  });
});
