import {
  type LiveHandover,
  type LiveSession,
  liveHandoverSchema,
  liveSessionSchema,
  type MyOrg,
  zonedParts,
} from '@ondes/shared';
import { act, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';

// DJ handover controls (#66) on the dashboard's live sources panel: putting a waiting DJ on air
// with the chosen crossfade, back to automation, mute, disconnect, and the scheduled handovers
// (listed and typed in station time). Only for members with `engine:control`.

const url = `/stations/${stationId}`;
const api = `/stations/${stationId}`;
const base = `${api}/live`;
const nova = { id: '01a169cc-0000-7000-8000-0000000000f1', displayName: 'DJ Nova' };
const kai = { id: '01a169cc-0000-7000-8000-0000000000f2', displayName: 'Kai' };
const handoverId = '01a169cc-0000-7000-8000-0000000000e1';

const status = (muted = false) => ({
  enabled: true,
  reachable: true,
  onAir: 2,
  session: null,
  inputs: [
    { input: 1, mount: 'live', connected: true, ready: true, streamer: kai, muted: false },
    { input: 2, mount: 'live-2', connected: true, ready: true, streamer: nova, muted },
  ],
});

const streamer = (s: { id: string; displayName: string }) => ({
  ...s,
  stationId,
  username: s.displayName.toLowerCase().replace(/\W/g, ''),
  user: null,
  enabled: true,
  expiresAt: null,
  anyTime: true,
  adHoc: 'approval',
  shows: [],
  status: 'active',
  lastConnectedAt: null,
  passwordChangedAt: '2026-10-27T10:00:00.000Z',
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
});

// Answers shaped like the api's, checked against the contracts the client parses them with.
function handover(over: Partial<Record<keyof LiveHandover, unknown>> = {}) {
  const h = {
    id: handoverId,
    streamer: kai,
    // 23:00 in Paris.
    at: '2026-10-27T22:00:00.000Z',
    fadeMs: 3000,
    status: 'pending',
    reason: null,
    sessionId: null,
    createdAt: '2026-10-27T10:00:00.000Z',
    ...over,
  };
  liveHandoverSchema.parse(h);
  return h;
}

function session(): Record<keyof LiveSession, unknown> {
  const s = {
    id: '01a169cc-0000-7000-8000-0000000000d1',
    streamer: kai,
    input: 1,
    trigger: 'manual',
    startedAt: '2026-10-27T21:00:00.000Z',
    endedAt: null,
    endReason: null,
    show: null,
    episode: null,
    title: null,
  };
  liveSessionSchema.parse({ ...s, startedAt: new Date(s.startedAt) });
  return s;
}

function routes(role: 'station_manager' | 'presenter'): Record<string, ApiRoute> {
  const copy = structuredClone(orgs) as MyOrg[];
  const st = copy[0]?.stations[0];
  if (st) st.role = role;
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: copy }],
    [`GET ${base}/status`]: [200, status()],
    [`GET ${base}/handovers`]: [200, { handovers: [handover()] }],
    [`GET ${base}/streamers`]: [200, { streamers: [streamer(nova), streamer(kai)] }],
    [`PUT ${base}/on-air`]: [200, session()],
    [`DELETE ${base}/on-air`]: [204],
    [`PUT ${base}/inputs/2/mute`]: [200, { connected: true, muted: true }],
    [`POST ${base}/inputs/1/disconnect`]: [200, { disconnected: true }],
    [`DELETE ${base}/handovers/${handoverId}`]: [200, handover({ status: 'cancelled' })],
    [`POST ${base}/handovers`]: [
      201,
      handover({ id: '01a169cc-0000-7000-8000-0000000000e2', fadeMs: 0 }),
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DJ handover controls', () => {
  it('hands over with the chosen crossfade, returns, mutes and disconnects', async () => {
    const r = routes('station_manager');
    const { screen, user, calls } = renderApp(url, r);
    const sources = await screen.findAllByTestId('live-source');
    const [kaiRow, novaRow] = sources.map((s) => within(s as HTMLElement));
    if (!kaiRow || !novaRow) throw new Error('two sources expected');

    await user.selectOptions(screen.getByLabelText('Crossfade'), '3000');
    await user.click(kaiRow.getByRole('button', { name: 'Hand over' }));
    expect(calls.find((c) => c.method === 'PUT' && c.path === `${base}/on-air`)?.body).toEqual({
      input: 1,
      fadeMs: 3000,
    });

    await user.click(novaRow.getByRole('button', { name: 'Back to automation' }));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${base}/on-air`)).toBe(true);

    await user.click(novaRow.getByRole('button', { name: 'Mute' }));
    expect(calls.find((c) => c.path === `${base}/inputs/2/mute`)?.body).toEqual({ muted: true });

    // The engine says it's muted: the badge, and the button turns into Unmute.
    r[`GET ${base}/status`] = [200, status(true)];
    act(() => {
      FakeEventSource.last().emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e14',
        stationId,
        at: '2026-10-27T21:00:00.000Z',
        type: 'engine.live.muted',
        data: { bootId: 'b', seq: 9, input: 2, muted: true, connected: true },
      });
    });
    expect(await screen.findByText('Muted')).toBeVisible();
    const fresh = within((await screen.findAllByTestId('live-source'))[1] as HTMLElement);
    expect(fresh.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(kaiRow.getByRole('button', { name: 'Disconnect' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Disconnect Kai?')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Disconnect' }));
    expect(calls.some((c) => c.path === `${base}/inputs/1/disconnect`)).toBe(true);
  });

  it('lists scheduled handovers in station time, cancels one and schedules another', async () => {
    const { screen, user, calls } = renderApp(url, routes('station_manager'));
    const list = within(await screen.findByTestId('scheduled-handovers'));
    // With the day: station time, never the browser's.
    expect(await list.findByText('Tue, Oct 27, 11:00 PM: Kai, 3 s')).toBeVisible();
    await user.click(list.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(handoverId))).toBe(true);

    await user.click(list.getByRole('button', { name: 'Schedule a handover' }));
    const dialog = within(await screen.findByRole('dialog'));
    // Nothing chosen: calm inline errors, nothing sent.
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    expect(dialog.getByText('Choose the DJ who takes the air.')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.path === `${base}/handovers`)).toBe(false);

    // Two hours from now, typed in station time.
    const target = zonedParts(new Date(Date.now() + 2 * 3600_000), 'Europe/Paris');
    await user.selectOptions(await dialog.findByLabelText('DJ'), kai.id);
    const date = dialog.getByLabelText('At', { selector: 'input[type=date]' });
    await user.clear(date);
    await user.type(date, target.date);
    await user.type(dialog.getByLabelText('At', { selector: 'input[type=time]' }), target.time);
    await user.selectOptions(dialog.getByLabelText('Crossfade'), '0');
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    const post = calls.find((c) => c.method === 'POST' && c.path === `${base}/handovers`);
    expect(post?.body).toMatchObject({ streamerId: kai.id, fadeMs: 0 });
    const at = new Date((post?.body as { at: string } | undefined)?.at ?? 0);
    expect(zonedParts(at, 'Europe/Paris')).toMatchObject({ date: target.date, time: target.time });
    expect(await screen.findByText('Handover scheduled.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // The night the clocks change in Paris (last Sundays of March and October 2026): the time
  // typed is the station's wall clock on that day, whichever offset it has.
  it.each([
    // Saturday 28 March, 21:00 in Paris (CET). Sunday 03:30 is CEST (+2): 01:30 UTC.
    ['spring forward', '2026-03-28T20:00:00Z', '2026-03-29', '03:30', '2026-03-29T01:30:00.000Z'],
    // Sunday 01:30 is still CET (+1): 00:30 UTC.
    [
      'before the change',
      '2026-03-28T20:00:00Z',
      '2026-03-29',
      '01:30',
      '2026-03-29T00:30:00.000Z',
    ],
    // Saturday 24 October, 22:00 in Paris (CEST). Sunday 03:30 is CET (+1): 02:30 UTC.
    ['fall back', '2026-10-24T20:00:00Z', '2026-10-25', '03:30', '2026-10-25T02:30:00.000Z'],
    // Sunday 01:30 is still CEST (+2): 23:30 UTC the day before.
    ['before fall back', '2026-10-24T20:00:00Z', '2026-10-25', '01:30', '2026-10-24T23:30:00.000Z'],
  ])('schedules in station time across the DST change (%s)', async (_, now, date, time, utc) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const { screen, user, calls } = renderApp(url, routes('station_manager'));
    const list = within(await screen.findByTestId('scheduled-handovers'));
    await user.click(list.getByRole('button', { name: 'Schedule a handover' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.selectOptions(await dialog.findByLabelText('DJ'), kai.id);
    const day = dialog.getByLabelText('At', { selector: 'input[type=date]' });
    await user.clear(day);
    await user.type(day, date);
    await user.type(dialog.getByLabelText('At', { selector: 'input[type=time]' }), time);
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    const post = calls.find((c) => c.method === 'POST' && c.path === `${base}/handovers`);
    expect((post?.body as { at: string } | undefined)?.at).toBe(utc);
  });

  it('shows no controls to a member without engine:control', async () => {
    const { screen } = renderApp(url, routes('presenter'));
    expect(await screen.findAllByTestId('live-source')).toHaveLength(2);
    expect(screen.queryByTestId('live-input-actions')).toBeNull();
    expect(screen.queryByTestId('scheduled-handovers')).toBeNull();
  });
});
