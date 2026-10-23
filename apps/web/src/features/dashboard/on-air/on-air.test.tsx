import type { OnAir } from '@ondes/shared';
import { act, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../../../app/testing/fake-event-source.ts';
import { renderApp, signedIn, stationId } from '../../../app/testing/render.tsx';

// The on-air widget (#70): what it shows from `GET …/on-air`, its counters against the
// engine's (as-run) times through the `server.clock` offset, and its refetch on events.

const url = `/stations/${stationId}`;
const route = `GET /stations/${stationId}/on-air`;
/** The api (and engine) clock runs an hour and a bit ahead of this machine's. */
const SKEW_MS = 3_600_000 + 437;
const serverNow = () => Date.now() + SKEW_MS;
const iso = (ms: number) => new Date(ms).toISOString();

function snapshot(now: number, over: Partial<OnAir> = {}): OnAir {
  return {
    at: iso(now),
    mode: { kind: 'automation', djName: null },
    current: {
      asRunId: '01a15ddf-0000-7000-8000-0000000c0001',
      source: 'log',
      kind: 'song',
      logItemId: '01a15ddf-0000-7000-8000-0000000c0002',
      title: 'Wichita Lineman',
      artist: 'Glen Campbell',
      // 65.4 s ago on the engine's clock.
      startedAt: iso(now - 65_400),
      durationMs: 180_000,
      introMs: 12_000,
      outroMs: 170_000,
    },
    next: [
      {
        logItemId: '01a15ddf-0000-7000-8000-0000000c0003',
        kind: 'jingle',
        timing: 'flow',
        title: 'Station ID',
        artists: [],
        plannedStart: iso(now + 110_000),
        estimatedStart: iso(now + 114_600),
        durationMs: 8_000,
      },
      {
        logItemId: '01a15ddf-0000-7000-8000-0000000c0004',
        kind: 'song',
        timing: 'hard',
        title: 'News',
        artists: ['Newsroom'],
        plannedStart: iso(now + 600_000),
        estimatedStart: iso(now + 600_000),
        durationMs: 120_000,
      },
    ],
    nextHardEvent: {
      kind: 'hard_start',
      at: iso(now + 600_000),
      title: 'News',
      logItemId: '01a15ddf-0000-7000-8000-0000000c0004',
      showId: null,
    },
    show: {
      showId: '01a15ddf-0000-7000-8000-0000000c0005',
      name: 'La Matinale',
      colour: '#ff8800',
      artworkUrl: null,
      type: 'prerecorded',
      startsAt: iso(now - 1_800_000),
      endsAt: iso(now + 1_800_000),
      episode: { id: '01a15ddf-0000-7000-8000-0000000c0006', number: 42, title: null },
      rerun: false,
    },
    ...over,
  };
}

/** Opens the stream and sends the api's clock. */
async function connect() {
  const source = await waitFor(() => FakeEventSource.last());
  act(() => {
    source.open();
    source.emit({ type: 'server.clock', at: iso(serverNow()) });
  });
  return source;
}

const seconds = (text: string | null) => {
  const m = /(\d+):(\d{2})\s*$/.exec(text ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};

describe('on-air widget', () => {
  it('shows the item on air, its markers, the show block, the next items and event', async () => {
    const now = serverNow();
    const { screen } = renderApp(url, { ...signedIn(), [route]: [200, snapshot(now)] });
    await connect();
    expect(await screen.findByTestId('on-air-title')).toHaveTextContent('Wichita Lineman');
    expect(screen.getByText('Glen Campbell')).toBeVisible();
    expect(screen.getByTestId('on-air-mode')).toHaveTextContent('Automation');
    expect(screen.getByTestId('on-air-intro')).toBeInTheDocument();
    expect(screen.getByTestId('on-air-outro')).toBeInTheDocument();

    const show = screen.getByTestId('on-air-show');
    expect(show).toHaveTextContent('La Matinale');
    expect(show).toHaveTextContent('Episode 42');

    const next = within(screen.getByTestId('on-air-next')).getAllByRole('listitem');
    expect(next).toHaveLength(2);
    // Estimated start in the station's time (Europe/Paris), not the plan's.
    const paris = (ms: number) =>
      new Date(ms).toLocaleTimeString('en', { timeZone: 'Europe/Paris', hour12: false });
    expect(next[0]).toHaveTextContent(paris(now + 114_600));
    expect(next[1]).toHaveTextContent('Hard start');
    await waitFor(() =>
      expect(screen.getByTestId('on-air-countdown')).toHaveTextContent(/^9:\d\d$/),
    );
  });

  it('keeps elapsed and the clock within 1 s of the engine, whatever the browser’s clock', async () => {
    const now = serverNow();
    // The as-run's engine start, as the api gives it.
    const startedAt = now - 65_400;
    const { screen } = renderApp(url, { ...signedIn(), [route]: [200, snapshot(now)] });
    await connect();
    const elapsed = await screen.findByTestId('on-air-elapsed');

    // Watch three ticks: each lands right after the engine's second boundary of the item.
    let shown = seconds(elapsed.textContent);
    for (let i = 0; i < 3; i++) {
      await waitFor(() => expect(seconds(elapsed.textContent)).toBe(shown + 1), {
        timeout: 1_500,
        interval: 5,
      });
      shown += 1;
      const truthMs = serverNow() - startedAt;
      // Displayed whole seconds never run ahead, and lag by well under a second.
      expect(truthMs - shown * 1_000).toBeGreaterThanOrEqual(-50);
      expect(truthMs - shown * 1_000).toBeLessThan(1_000);
      const clock = screen.getByTestId('station-clock').getAttribute('datetime') ?? '';
      expect(Math.abs(Date.parse(clock) - serverNow())).toBeLessThan(1_000);
    }
  }, 10_000);

  it('shows the DJ in live mode and refetches when the as-run moves', async () => {
    let calls = 0;
    const routes = {
      ...signedIn(),
      [route]: () => {
        calls++;
        return [200, calls === 1 ? snapshot(serverNow()) : liveSnapshot()] as [number, OnAir];
      },
    };
    const liveSnapshot = () =>
      snapshot(serverNow(), {
        mode: { kind: 'live', djName: 'Nova' },
        current: {
          asRunId: '01a15ddf-0000-7000-8000-0000000c0009',
          source: 'live',
          kind: null,
          logItemId: null,
          title: null,
          artist: null,
          startedAt: iso(serverNow()),
          durationMs: null,
          introMs: null,
          outroMs: null,
        },
      });
    const { screen } = renderApp(url, routes);
    const source = await connect();
    expect(await screen.findByTestId('on-air-mode')).toHaveTextContent('Automation');

    act(() =>
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e11',
        stationId,
        at: iso(serverNow()),
        type: 'live.session.started',
        data: {
          sessionId: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e12',
          streamerId: null,
          input: 1,
          trigger: 'slot',
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('on-air-mode')).toHaveTextContent('Live: Nova'));
    expect(screen.getByTestId('on-air-title')).toHaveTextContent('Live from the studio');
    expect(screen.queryByTestId('on-air-remaining')).not.toBeInTheDocument();
  });

  it('says so when nothing is on air', async () => {
    const { screen } = renderApp(url, {
      ...signedIn(),
      [route]: [
        200,
        snapshot(serverNow(), {
          mode: { kind: 'safety', djName: null },
          current: null,
          next: [],
          nextHardEvent: null,
          show: null,
        }),
      ],
    });
    await connect();
    expect(await screen.findByText('Nothing is on air.')).toBeVisible();
    expect(screen.getByTestId('on-air-mode')).toHaveTextContent('Safety');
    expect(screen.getByText('No show right now.')).toBeVisible();
    expect(screen.getByText('None in the next 24 hours.')).toBeVisible();
  });
});
