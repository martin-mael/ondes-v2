import type { MyOrg } from '@ondes/shared';
import { act, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../../../app/testing/fake-event-source.ts';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

const url = `/stations/${stationId}`;
const api = `/stations/${stationId}`;
const at = '2026-10-23T12:05:00.000Z';

const engine = (over: Record<string, unknown> = {}) => ({
  stationId,
  desiredState: 'running',
  container: { id: 'c', status: 'running', running: true, restartCount: 0, configVersion: 'v1' },
  health: 'up',
  reportedVersion: 'v1',
  expectedVersion: 'v1',
  restartPending: false,
  livePort: 18005,
  restartStorm: { tripped: false, since: null, restarts: 0, windowSeconds: 600 },
  ...over,
});

const live = {
  enabled: true,
  reachable: true,
  onAir: 2,
  session: null,
  inputs: [
    { input: 1, mount: 'live-1', connected: true, ready: true, streamer: null },
    {
      input: 2,
      mount: 'live-2',
      connected: true,
      ready: true,
      streamer: { id: '01a169cc-0000-7000-8000-0000000000f1', displayName: 'DJ Nova' },
    },
    { input: 3, mount: 'live-3', connected: false, ready: false, streamer: null },
  ],
};

const history = {
  startsAt: '2026-10-22T12:10:00.000Z',
  endsAt: '2026-10-23T12:10:00.000Z',
  stepSeconds: 300,
  mounts: ['/vandale/aac', '/vandale/mp3'],
  points: Array.from({ length: 288 }, (_, i) => ({
    startsAt: new Date(Date.parse('2026-10-22T12:10:00.000Z') + i * 300_000).toISOString(),
    total: i % 50 === 0 ? null : 12,
    byMount: i % 50 === 0 ? {} : { '/vandale/mp3': 9, '/vandale/aac': 3 },
  })),
};

function alert(id: string, severity: string, title: string) {
  return {
    id: `01a169cc-0000-7000-8000-0000000000${id}`,
    orgId: orgs[0]?.id,
    stationId,
    type: 'island.render_failed',
    severity,
    status: 'open',
    dedupeKey: `island.render_failed:${id}`,
    title,
    message: null,
    details: {},
    occurrences: 1,
    raisedAt: at,
    lastSeenAt: at,
    escalatedAt: null,
    escalateAt: null,
    escalateTo: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolution: null,
    action: null,
  };
}

function routes(role: 'station_manager' | 'viewer'): Record<string, ApiRoute> {
  const copy = structuredClone(orgs) as MyOrg[];
  const st = copy[0]?.stations[0];
  if (st) st.role = role;
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: copy }],
    [`GET ${api}/engine`]: [200, engine()],
    [`GET ${api}/live/status`]: [200, live],
    [`GET ${api}/listeners`]: [
      200,
      {
        sampledAt: at,
        total: 17,
        mounts: [
          {
            mount: '/vandale/aac',
            listeners: 5,
            listenersMax: 6,
            sourceConnected: false,
            sampledAt: at,
          },
          {
            mount: '/vandale/mp3',
            listeners: 12,
            listenersMax: 13,
            sourceConnected: true,
            sampledAt: at,
          },
        ],
      },
    ],
    [`GET ${api}/listeners/history`]: [200, history],
    [`GET ${api}/alerts`]: [
      200,
      {
        items: [alert('01', 'warning', 'Older warning'), alert('02', 'critical', 'Critical one')],
        nextCursor: null,
      },
    ],
  };
}

describe('dashboard health panels', () => {
  it('shows the engine, live sources, listeners and open alerts (most severe first)', async () => {
    const { screen } = renderApp(url, routes('station_manager'));
    expect(await screen.findByText('Running')).toBeVisible();
    expect(screen.getByText('No restart lately')).toBeVisible();

    const sources = await screen.findAllByTestId('live-source');
    expect(sources).toHaveLength(2);
    expect(within(sources[1] as HTMLElement).getByText('DJ Nova')).toBeVisible();
    expect(within(sources[1] as HTMLElement).getByText('On air')).toBeVisible();
    expect(within(sources[0] as HTMLElement).getByText('Unknown DJ')).toBeVisible();

    expect(await screen.findByTestId('listeners-total')).toHaveTextContent('17');
    // 12:05 UTC is 14:05 in Paris: the station's clock.
    expect(screen.getByTestId('listeners')).toHaveTextContent('now · 14:05');
    expect(screen.getAllByTestId('listeners-mount')[0]).toHaveTextContent(
      '/vandale/aac 5 · on fallback',
    );

    const panel = await screen.findByTestId('alerts-panel');
    const items = await within(panel).findAllByTestId('alert-item');
    expect(items.map((i) => i.dataset.severity)).toEqual(['critical', 'warning']);
    expect(within(panel).getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(2);
    expect(within(panel).getByRole('link', { name: 'All alerts' })).toBeVisible();
  });

  it('follows engine events, and hides what the role can’t read', async () => {
    const r = routes('viewer');
    r[`GET ${api}/live/status`] = [403, { error: 'forbidden', message: 'no' }];
    const { screen } = renderApp(url, r);
    expect(await screen.findByText('Running')).toBeVisible();
    // Viewers have neither `alert:read` nor `live:read`.
    expect(screen.queryByTestId('alerts-panel')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('live-sources')).toBeNull();

    r[`GET ${api}/engine`] = [
      200,
      engine({ restartStorm: { tripped: false, since: null, restarts: 2, windowSeconds: 600 } }),
    ];
    const source = FakeEventSource.last();
    act(() => {
      source.open();
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e13',
        stationId,
        at,
        type: 'engine.restarted',
        data: { bootId: 'b', restarts: 1, inWindow: 2, windowSeconds: 600, crashed: false },
      });
    });
    expect(await screen.findByText('2 restarts in the last 10 min')).toBeVisible();
  });

  it('says when there is no listener data', async () => {
    const r = routes('station_manager');
    r[`GET ${api}/listeners`] = [200, { sampledAt: null, total: 0, mounts: [] }];
    r[`GET ${api}/listeners/history`] = [200, { ...history, mounts: [], points: [] }];
    const { screen } = renderApp(url, r);
    expect(
      await screen.findByText(
        'No listener data: the stats poller isn’t running, or Icecast can’t be read.',
      ),
    ).toBeVisible();
    expect(screen.getByText('No data')).toBeVisible();
  });
});
