import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../testing/fake-event-source.ts';
import { orgs, renderApp, signedIn, stationId } from '../testing/render.tsx';

const otherStationId = orgs[0]?.stations[1]?.id ?? '';

describe('app shell', () => {
  it('lands on the first station and shows the live server clock from SSE', async () => {
    const { screen, history } = renderApp('/', signedIn());
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${stationId}`));
    expect(await screen.findByTestId('server-clock')).toHaveTextContent('--:--:--');

    const source = FakeEventSource.last();
    expect(source.url).toBe(`/api/v1/stations/${stationId}/events`);
    act(() => {
      source.open();
      source.emit({ type: 'server.clock', at: '2026-10-20T08:00:00.000Z' });
    });
    expect(screen.getByTestId('sse-status')).toHaveTextContent('Live');
    const clock = screen.getByTestId('server-clock');
    await waitFor(() => expect(clock).not.toHaveTextContent('--:--:--'));
    // The server is far in the past compared to the test machine: the offset is applied.
    expect(clock.getAttribute('datetime')?.startsWith('2026-10-20T08:00')).toBe(true);
  });

  it('switches station from the switcher and reopens the stream', async () => {
    const { user, screen, history } = renderApp(`/stations/${stationId}`, signedIn());
    const trigger = await screen.findByRole('button', { name: 'Station' });
    expect(trigger).toHaveTextContent('Vandale');
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: /Vandale Nuit/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${otherStationId}`));
    await waitFor(() =>
      expect(FakeEventSource.last().url).toBe(`/api/v1/stations/${otherStationId}/events`),
    );
    expect(FakeEventSource.instances.find((s) => s.url.includes(stationId))?.readyState).toBe(
      FakeEventSource.CLOSED,
    );
  });

  it('remembers the last station', async () => {
    localStorage.setItem('ondes.lastStation', otherStationId);
    const { history } = renderApp('/', signedIn());
    await waitFor(() => expect(history.location.pathname).toBe(`/stations/${otherStationId}`));
  });

  it("shows not found for a station the user can't open", async () => {
    const { screen } = renderApp('/stations/01a15ddf-0000-7000-8000-00000000dead', signedIn());
    expect(await screen.findByText('This page does not exist.')).toBeVisible();
  });

  it('sends the user to their account when the stream needs 2FA', async () => {
    const { screen, history } = renderApp(`/stations/${stationId}`, {
      ...signedIn(),
      [`GET /stations/${stationId}/events`]: [
        403,
        { error: 'two_factor_required', message: 'enable 2FA' },
      ],
    });
    await screen.findByTestId('server-clock');
    act(() => FakeEventSource.last().refuse());
    await waitFor(() => expect(history.location.pathname).toBe('/account'));
    expect(
      await screen.findByText(/One of your organizations requires two-factor authentication/),
    ).toBeVisible();
  });

  it('goes back to sign-in when the session expires', async () => {
    const routes = signedIn();
    const { screen, history, queryClient } = renderApp(`/stations/${stationId}`, routes);
    await screen.findByTestId('server-clock');
    routes['GET /auth/me'] = [401, { error: 'unauthenticated', message: '' }];
    routes['GET /orgs'] = [401, { error: 'unauthenticated', message: '' }];
    await act(() => queryClient.refetchQueries({ queryKey: ['auth', 'orgs'] }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toContain(encodeURIComponent(`/stations/${stationId}`));
  });

  it('shows a page for users without stations', async () => {
    const { screen } = renderApp('/', { ...signedIn(), 'GET /orgs': [200, { orgs: [] }] });
    expect(await screen.findByText('No station yet')).toBeVisible();
  });
});
