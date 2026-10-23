import type { MyOrg } from '@ondes/shared';
import { act, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';

const url = `/stations/${stationId}/alerts`;
const api = `/stations/${stationId}/alerts`;
// 14:05 in Paris (UTC+2 until the 25th).
const raisedAt = '2026-10-23T12:05:00.000Z';

function alert(id: string, over: Record<string, unknown> = {}) {
  return {
    id: `01a169cc-0000-7000-8000-0000000000${id}`,
    orgId: orgs[0]?.id,
    stationId,
    type: 'engine.silence',
    severity: 'critical',
    status: 'open',
    dedupeKey: 'engine.silence',
    title: 'Silence on air',
    message: 'The program output has been silent for 10 s (below -40 dBFS).',
    details: {},
    occurrences: 1,
    raisedAt,
    lastSeenAt: raisedAt,
    escalatedAt: null,
    escalateAt: null,
    escalateTo: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolution: null,
    action: null,
    ...over,
  };
}

const episode = alert('02', {
  type: 'show.episode_missing',
  severity: 'warning',
  dedupeKey: 'show.episode_missing:x',
  title: 'Episode missing: Matinale',
  message: 'Matinale airs in 6 hours, …',
  details: {
    i18n: {
      key: 'episodeMissing.ahead',
      params: {
        show: 'Matinale',
        startsAt: '2026-10-23T18:00:00.000Z',
        lead: 't6h',
        policy: 'latest_episode',
      },
    },
  },
});

function withRole(role: 'station_manager' | 'programmer'): Record<string, ApiRoute> {
  const copy = structuredClone(orgs) as MyOrg[];
  const st = copy[0]?.stations[0];
  if (st) st.role = role;
  return { ...signedIn(), 'GET /orgs': [200, { orgs: copy }] };
}

const generation = alert('03', {
  type: 'log.generation_issues',
  severity: 'warning',
  dedupeKey: 'log.generation_issues:2026-10-24',
  title: 'Log generation issues',
  message: '3 issues',
  details: { i18n: { key: 'logRegen.issues', params: { localDate: '2026-10-24', total: 3 } } },
});

describe('alerts page', () => {
  it('lists open alerts in the station’s time, with the missing-episode text rendered', async () => {
    const { screen } = renderApp(url, {
      ...withRole('programmer'),
      [`GET ${api}`]: [200, { items: [alert('01'), episode, generation], nextCursor: null }],
    });
    expect(await screen.findByRole('heading', { name: 'Alerts' })).toBeVisible();
    const items = await screen.findAllByTestId('alert-item');
    expect(items).toHaveLength(3);
    const [silence, missing, regen] = items as [HTMLElement, HTMLElement, HTMLElement];
    expect(regen).toHaveTextContent('Log for Sat, Oct 24: 3 generation issues');
    expect(within(silence).getByText('Silence on air')).toBeVisible();
    expect(within(silence).getByText('Critical')).toBeVisible();
    expect(silence).toHaveTextContent(/Raised (\w{3} \d+ \w{3}, )?14:05/);
    expect(within(missing).getByText('Missing episode: Matinale')).toBeVisible();
    expect(missing).toHaveTextContent(
      /Matinale airs .*20:00 and its episode has no audio yet\. If it’s still missing an hour before, the latest episode airs again\./,
    );
    // Programmers read alerts but don't manage them.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    // The nav entry.
    expect(screen.getByRole('link', { name: 'Alerts' })).toBeVisible();
  });

  it('acknowledges and resolves', async () => {
    const routes: Record<string, ApiRoute> = {
      ...withRole('station_manager'),
      [`GET ${api}`]: [200, { items: [alert('01')], nextCursor: null }],
      [`POST ${api}/${alert('01').id}/acknowledge`]: [
        200,
        alert('01', { acknowledgedAt: raisedAt, acknowledgedBy: orgs[0]?.id }),
      ],
      [`POST ${api}/${alert('01').id}/resolve`]: [409, { error: 'alert_resolved', message: 'x' }],
    };
    const { screen, user, calls } = renderApp(url, routes);
    const button = await screen.findByRole('button', { name: 'Acknowledge' });
    routes[`GET ${api}`] = [
      200,
      {
        items: [alert('01', { acknowledgedAt: raisedAt, acknowledgedBy: orgs[0]?.id })],
        nextCursor: null,
      },
    ];
    await user.click(button);
    expect(await screen.findByText('Acknowledged')).toBeVisible();
    expect(calls.some((c) => c.path.endsWith('/acknowledge'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('This alert is already resolved.')).toBeVisible();
  });

  it('filters by status and type through the URL', async () => {
    const { screen, user, history } = renderApp(url, {
      ...withRole('programmer'),
      [`GET ${api}`]: [200, { items: [], nextCursor: null }],
    });
    expect(await screen.findByText('All clear: nothing needs attention.')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Resolved' }));
    await waitFor(() => expect(history.location.search).toContain('status=resolved'));
    await user.selectOptions(screen.getByLabelText('Type'), 'island.render_failed');
    await waitFor(() => expect(history.location.search).toContain('type=island.render_failed'));
    expect(await screen.findByText('No alerts here.')).toBeVisible();
  });

  it('shows a new alert as soon as its event arrives', async () => {
    const routes: Record<string, ApiRoute> = {
      ...withRole('programmer'),
      [`GET ${api}`]: [200, { items: [], nextCursor: null }],
    };
    const { screen } = renderApp(url, routes);
    await screen.findByText('All clear: nothing needs attention.');
    routes[`GET ${api}`] = [200, { items: [alert('01')], nextCursor: null }];
    const source = FakeEventSource.last();
    act(() => {
      source.open();
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e12',
        stationId,
        at: raisedAt,
        type: 'alert.raised',
        data: {
          alertId: alert('01').id,
          type: 'engine.silence',
          severity: 'critical',
          status: 'open',
          dedupeKey: 'engine.silence',
          title: 'Silence on air',
          message: null,
          details: {},
          occurrences: 1,
          raisedAt,
          acknowledgedAt: null,
          acknowledgedBy: null,
          resolvedAt: null,
          resolution: null,
          action: null,
        },
      });
    });
    expect(await screen.findByText('Silence on air')).toBeVisible();
  });
});
