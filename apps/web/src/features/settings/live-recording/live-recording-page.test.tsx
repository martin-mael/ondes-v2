import type { MyOrg } from '@ondes/shared';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

// Live recording settings (#67): read-only for presenters, saved for managers, and a custom
// retention that isn't a number yet never blocks the save.

const url = `/stations/${stationId}/settings/live-recording`;
const api = `/stations/${stationId}/live/recording/settings`;

function withRole(role: 'station_manager' | 'presenter'): Record<string, ApiRoute> {
  const copy = structuredClone(orgs) as MyOrg[];
  const st = copy[0]?.stations[0];
  if (st) st.role = role;
  return { ...signedIn(), 'GET /orgs': [200, { orgs: copy }] };
}

describe('live recording settings page', () => {
  it('shows the settings read-only to presenters', async () => {
    const { screen } = renderApp(url, {
      ...withRole('presenter'),
      [`GET ${api}`]: [200, { enabled: true, retentionDays: 90 }],
    });
    expect(await screen.findByRole('heading', { name: 'Live recording', level: 1 })).toBeVisible();
    expect(screen.getByLabelText('Keep the audio')).toHaveValue('90');
    expect(screen.getByLabelText('Keep the audio')).toBeDisabled();
    expect(screen.getByText('Only station managers can change these.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Live recording' })).toBeVisible();
  });

  it('saves a retention, and the rest while a custom number is unfinished', async () => {
    const { screen, user, calls } = renderApp(url, {
      ...withRole('station_manager'),
      [`GET ${api}`]: [200, { enabled: true, retentionDays: null }],
      [`PUT ${api}`]: (body) => [200, { enabled: true, retentionDays: null, ...(body as object) }],
    });
    const select = await screen.findByLabelText('Keep the audio');
    expect(select).toHaveValue('forever');
    await user.selectOptions(select, '365');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        enabled: true,
        retentionDays: 365,
      }),
    );

    await user.selectOptions(screen.getByLabelText('Keep the audio'), 'custom');
    await user.click(screen.getByRole('checkbox', { name: 'Record live shows' }));
    expect(screen.getByText(/Enter 1 to 3650 days/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ enabled: false }),
    );
  });
});
