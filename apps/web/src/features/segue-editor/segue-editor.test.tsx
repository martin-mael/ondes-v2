import type { LogDay, Segue, SegueMedia } from '@ondes/shared';
import { waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiRoute, orgs, renderApp, signedIn, stationId } from '../../app/testing/render.tsx';
import { libraryAsset, logItem } from '../log-timeline/testing.ts';
import { setRecorderDeps } from '../vt-recorder/recorder.ts';
import { fakeRecorder } from '../vt-recorder/testing.ts';

// The segue editor on the whole app with a fake api: opened from the timeline, lanes for A,
// the voice and B, the ducking preset, undo/redo, the estimated time on air in station time,
// and saves (create, update with the version, a conflict reloads).

const NOW = '2026-10-21T09:00:00.000Z';
const base = `/stations/${stationId}`;
const SR = 44_100;
const s = (n: number) => Math.round(n * SR);

const day: LogDay = {
  id: '01a15ddf-0000-7000-8000-0000000000d0',
  stationId,
  localDate: '2026-10-21',
  startsAt: '2026-10-20T22:00:00.000Z',
  endsAt: '2026-10-21T22:00:00.000Z',
  status: 'published',
  version: 3,
  generatedAt: null,
  seed: null,
  generatorVersion: null,
};

const asset = (n: number, title: string) => ({
  id: `01a15ddf-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  type: 'song' as const,
  title,
  artists: ['Les Traboules'],
  durationMs: 200_000,
});
const vtAsset = '01a15ddf-0000-7000-8000-0000000002f1';

const a = logItem({
  plannedStart: '2026-10-21T10:00:00.000Z',
  title: null,
  asset: asset(1, 'Fourviere'),
  assetId: asset(1, 'Fourviere').id,
});
const b = logItem({
  plannedStart: '2026-10-21T10:03:20.000Z',
  title: null,
  asset: asset(2, 'Saone Drift'),
  assetId: asset(2, 'Saone Drift').id,
});

const media = (assetId: string, seconds: number): SegueMedia => ({
  assetId,
  sha256: assetId.replace(/-/g, '').padEnd(64, '0'),
  sampleRate: SR,
  durationSamples: s(seconds),
  gainDb: -2,
  cueIn: 0,
  cueOut: s(seconds),
});

const segue = (overrides: Partial<Segue> = {}): Segue => ({
  id: '01a15ddf-0000-7000-8000-0000000005e1',
  stationId,
  fromItemId: a.id,
  toItemId: b.id,
  fromAssetId: a.assetId,
  toAssetId: b.assetId,
  out: { envelope: [] },
  in: { start: -s(1), envelope: [] },
  voices: [{ assetId: vtAsset, start: -s(3), gainDb: 0, envelope: [] }],
  origin: 'manual',
  status: 'ready',
  problem: null,
  island: null,
  version: 4,
  createdBy: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...overrides,
});

const url = `${base}/log/segue?date=2026-10-21&from=${a.id}&to=${b.id}`;

function routes(existing: Segue | null, extra: Record<string, ApiRoute> = {}) {
  return {
    ...signedIn(),
    [`GET ${base}/log`]: [200, { from: day.startsAt, to: day.endsAt, days: [day], items: [a, b] }],
    [`GET ${base}/asrun`]: [200, { items: [], nextCursor: null }],
    [`GET ${base}/segues`]: [200, { items: existing ? [existing] : [] }],
    [`GET ${base}/segues/media`]: [
      200,
      {
        items: { [a.id]: media(a.assetId as string, 200), [b.id]: media(b.assetId as string, 200) },
        assets: existing ? { [vtAsset]: media(vtAsset, 5) } : {},
      },
    ],
    ...extra,
  } satisfies Record<string, ApiRoute>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('segue editor', () => {
  it('opens from the timeline on a transition', async () => {
    const { screen, user, history } = renderApp(`${base}/log?date=2026-10-21`, routes(null));
    await user.click(await screen.findByRole('button', { name: 'Actions for Fourviere' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Edit the segue into the next item' }),
    );
    expect(await screen.findByRole('heading', { name: 'Segue' })).toBeInTheDocument();
    expect(history.location.pathname).toBe(`${base}/log/segue`);
    expect(history.location.search).toContain(`from=${a.id}`);
    expect(history.location.search).toContain(`to=${b.id}`);
  });

  it('shows the lanes and the time on air in station time', async () => {
    const { screen } = renderApp(url, routes(segue()));
    expect(await screen.findByText('Outgoing')).toBeInTheDocument();
    expect(await screen.findByText('Voice 1')).toBeInTheDocument();
    expect(screen.getByText('Incoming')).toBeInTheDocument();
    expect(screen.getByText('Fourviere → Saone Drift')).toBeInTheDocument();
    // A plays 200 s from 12:00:00 Paris: B starts 1 s before its end, at 12:03:19.
    expect(await screen.findByText(/Next starts −?-1 s · on air ≈ 12:03:19/)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('No island: airs as a crossfade')).toBeInTheDocument();
  });

  it('ducks under the voice, undoes and redoes, and saves with the version', async () => {
    const put = vi.fn((body: unknown): [number, unknown] => [
      200,
      segue({ ...(body as object), version: 5 }),
    ]);
    const { screen, user } = renderApp(
      url,
      routes(segue(), { [`PUT ${base}/segues/${segue().id}`]: put }),
    );
    await screen.findByText('Voice 1');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Duck under the voice: -8 dB, 300 ms ramps',
      }),
    );
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      version: 4,
      out: {
        envelope: [
          { at: -s(3) - s(0.3), gainDb: 0 },
          { at: -s(3), gainDb: -8 },
        ],
      },
      in: { start: -s(1), envelope: [{ at: s(2), gainDb: -8 }, { gainDb: 0 }] },
    });
    await waitFor(() => expect(save).toBeDisabled());
  });

  // A's outro 12 s before its end, crossfade 7 s before; B's intro 8 s.
  const marked = (assetId: string, markers: NonNullable<SegueMedia['markers']>) => ({
    ...media(assetId, 200),
    markers,
  });
  const markedItems = {
    [a.id]: marked(a.assetId as string, {
      introEnd: null,
      outroStart: s(188),
      crossStartNext: s(193),
    }),
    [b.id]: marked(b.assetId as string, {
      introEnd: s(8),
      outroStart: null,
      crossStartNext: null,
    }),
  };
  const AUTO = 'Auto placement: move the voices and the next song, replace the envelopes';

  it('resets to auto placement (#61) after asking: the voice ends on B’s intro end, B at its natural start', async () => {
    const put = vi.fn((body: unknown): [number, unknown] => [200, segue(body as object)]);
    const { screen, user } = renderApp(
      url,
      routes(segue(), {
        [`PUT ${base}/segues/${segue().id}`]: put,
        [`GET ${base}/segues/media`]: [
          200,
          { items: markedItems, assets: { [vtAsset]: media(vtAsset, 5) } },
        ],
      }),
    );
    await screen.findByText('Voice 1');
    const save = screen.getByRole('button', { name: 'Save' });
    // B was placed by hand (−1 s): it asks first, and keeping it changes nothing.
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(await screen.findByRole('menuitem', { name: AUTO }));
    expect(await screen.findByRole('dialog', { name: 'Replace your placement?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(await screen.findByRole('menuitem', { name: AUTO }));
    await user.click(await screen.findByRole('button', { name: 'Replace' }));
    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      in: { start: -s(7) },
      voices: [{ assetId: vtAsset, start: -s(7) + s(8) - s(5) }],
      out: { envelope: [{ gainDb: 0 }, { at: -s(4), gainDb: -8 }] },
    });
  });

  it('creates the segue of a new transition', async () => {
    const post = vi.fn((body: unknown): [number, unknown] => [201, segue(body as object)]);
    const { screen, user } = renderApp(url, routes(null, { [`POST ${base}/segues`]: post }));
    await screen.findByText('Not saved yet');
    expect(screen.queryByText('Voice 1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      fromItemId: a.id,
      toItemId: b.id,
      in: { start: 0 },
      voices: [],
    });
  });

  it('keeps the draft on a conflict: keep mine saves over theirs, load theirs is undoable', async () => {
    let current = segue();
    const puts: unknown[] = [];
    const { screen, user } = renderApp(
      url,
      routes(current, {
        [`GET ${base}/segues`]: () => [200, { items: [current] }],
        [`PUT ${base}/segues/${current.id}`]: (body) => {
          puts.push(body);
          if (puts.length === 1) {
            current = segue({ version: 9, out: { envelope: [{ at: -s(1), gainDb: -3 }] } });
            return [409, { error: 'conflict', message: 'segue changed' }];
          }
          return [200, segue({ ...(body as object), version: 10 })];
        },
      }),
    );
    await screen.findByText('Voice 1');
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
    );
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);
    expect(
      await screen.findByRole('dialog', { name: 'Someone saved this segue meanwhile' }),
    ).toBeInTheDocument();

    // Load theirs: a new step, so Undo brings the draft back.
    await user.click(screen.getByRole('button', { name: 'Load theirs' }));
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(save).toBeEnabled();

    // Keep mine: the next save sends their version and replaces it.
    await user.click(save);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({
      version: 9,
      out: {
        envelope: [
          { at: -s(2), gainDb: 0 },
          { at: 0, gainDb: -90 },
        ],
      },
    });
  });

  it('says why a save failed', async () => {
    const { screen, user } = renderApp(
      url,
      routes(segue(), {
        [`PUT ${base}/segues/${segue().id}`]: [
          400,
          { error: 'validation_failed', message: 'envelope points must be in order' },
        ],
      }),
    );
    await screen.findByText('Voice 1');
    await user.click(screen.getByRole('button', { name: 'Envelopes' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/The segue couldn’t be saved: /)).toBeInTheDocument();
    // Still dirty: nothing was lost.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('applies a typed voice gain on Enter, negative values included', async () => {
    const { screen, user } = renderApp(url, routes(segue()));
    await screen.findByText('Voice 1');
    const gain = screen.getByRole('textbox', { name: 'Gain (dB)' });
    await user.clear(gain);
    await user.type(gain, '-');
    expect(gain).toHaveValue('-');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(gain, '4.5{Enter}');
    expect(gain).toHaveValue('-4.5');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('lets a viewer listen but not edit', async () => {
    const { screen, user } = renderApp(url, {
      ...routes(segue()),
      'GET /orgs': [
        200,
        {
          orgs: orgs.map((org) => ({
            ...org,
            stations: org.stations.map((st) =>
              st.id === stationId ? { ...st, role: 'viewer' } : st,
            ),
          })),
        },
      ],
    });
    await screen.findByText('Voice 1');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Envelopes' })).not.toBeInTheDocument();
    // Keys that edit do nothing: no unsaved state.
    await user.click(screen.getByText('Voice 1'));
    await user.keyboard('{ArrowRight}{Delete}');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('places the first voice picked from the library (#61)', async () => {
    const vt = { ...libraryAsset('f1', 'Station ID', 5000), type: 'vt' as const };
    const post = vi.fn((body: unknown): [number, unknown] => [201, segue(body as object)]);
    const { screen, user } = renderApp(url, {
      ...routes(null, {
        [`POST ${base}/segues`]: post,
        [`GET ${base}/segues/media`]: [
          200,
          { items: markedItems, assets: { [vt.id]: media(vt.id, 5) } },
        ],
      }),
      [`GET ${base}/assets`]: [200, { items: [vt], nextCursor: null }],
    });
    await screen.findByText('Not saved yet');
    await user.click(screen.getByRole('button', { name: 'Add a voice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a voice' });
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Station ID' }));
    expect(await screen.findByText('Voice 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      in: { start: -s(7) },
      voices: [{ assetId: vt.id, start: -s(4) }],
    });
  });

  it('adds a picked voice without placing it when its audio fails to load, and says so', {
    timeout: 15_000,
  }, async () => {
    const vt = { ...libraryAsset('f1', 'Station ID', 5000), type: 'vt' as const };
    const post = vi.fn((body: unknown): [number, unknown] => [201, segue(body as object)]);
    let failing = false;
    const { screen, user } = renderApp(url, {
      ...routes(null, {
        [`POST ${base}/segues`]: post,
        [`GET ${base}/segues/media`]: () =>
          failing
            ? [500, { error: 'internal', message: 'Media unavailable' }]
            : [200, { items: markedItems, assets: {} }],
      }),
      [`GET ${base}/assets`]: [200, { items: [vt], nextCursor: null }],
    });
    await screen.findByText('Not saved yet');
    failing = true;
    await user.click(screen.getByRole('button', { name: 'Add a voice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a voice' });
    await user.click(await within(dialog).findByRole('button', { name: 'Choose: Station ID' }));
    // After the query client's retries.
    expect(
      await screen.findByText(
        /The voice’s audio couldn’t be loaded .*without auto placement/,
        {},
        { timeout: 6000 },
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    // Where a new voice goes, B where it was.
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      in: { start: 0 },
      voices: [{ assetId: vt.id, start: -s(3) }],
    });
  });

  it('opens the voice picker', async () => {
    const { screen, user } = renderApp(url, {
      ...routes(segue()),
      [`GET ${base}/assets`]: [200, { items: [], nextCursor: null }],
    });
    await screen.findByText('Voice 1');
    await user.click(screen.getByRole('button', { name: 'Add a voice' }));
    expect(await screen.findByRole('dialog', { name: 'Add a voice' })).toBeInTheDocument();
  });

  describe('recording a VT (#59)', () => {
    const take = '01a15ddf-0000-7000-8000-0000000002f2';
    const uploadId = '01a15ddf-0000-7000-8000-0000000007a1';
    const upload = (status: string, extra: object = {}) => ({
      id: uploadId,
      orgId: '01a15ddf-0000-7000-8000-0000000007c1',
      stationId,
      status,
      filename: 'take.wav',
      sizeBytes: 10,
      contentType: 'audio/wav',
      assetType: 'vt',
      partSize: 64 * 1024 * 1024,
      partCount: 1,
      sha256: null,
      assetId: null,
      duplicateOfAssetId: null,
      errorCode: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    });
    const recordRoutes = (existing: Segue, extra: Record<string, ApiRoute> = {}) =>
      routes(existing, {
        [`GET ${base}/segues/media`]: [
          200,
          {
            items: {
              [a.id]: media(a.assetId as string, 200),
              [b.id]: media(b.assetId as string, 200),
            },
            assets: { [vtAsset]: media(vtAsset, 5), [take]: media(take, 2.5) },
          },
        ],
        [`GET ${base}/assets/${take}`]: [404],
        ...extra,
      });
    let fake: ReturnType<typeof fakeRecorder>;
    beforeEach(() => {
      fake = fakeRecorder();
      setRecorderDeps(fake.deps);
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: fake.getUserMedia },
        configurable: true,
      });
    });
    afterEach(() => {
      setRecorderDeps();
      Reflect.deleteProperty(navigator, 'mediaDevices');
    });

    /** Opens the recorder from the editor, after an unsaved edit of the draft. */
    async function openRecorder(r: ReturnType<typeof renderApp>) {
      const { screen, user } = r;
      await screen.findByText('Voice 1');
      await user.click(screen.getByRole('button', { name: 'Envelopes' }));
      await user.click(
        await screen.findByRole('menuitem', { name: 'Fade out the outgoing song (2 s)' }),
      );
      await user.click(screen.getByRole('button', { name: 'Record a VT' }));
      await screen.findByRole('heading', { name: 'Record a VT for this segue' });
      await user.click(screen.getByRole('button', { name: 'Use the microphone' }));
      await screen.findByRole('combobox', { name: 'Input' });
    }

    /** Records 1 s of silence, `voice` s at `level`, then 1 s of silence. */
    async function recordTake(r: ReturnType<typeof renderApp>, voice: number, level: number) {
      const { screen, user } = r;
      await user.click(screen.getByRole('button', { name: /^(Record|Retake)$/ }));
      await screen.findByRole('status');
      const start = fake.startFrame(true);
      fake.deliver(start, 1, 0);
      fake.deliver(start + 48_000, voice, level);
      fake.deliver(start + 48_000 * (1 + voice), 1, 0);
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await screen.findByText(/kept of/);
    }

    it('records over the pre-roll, uploads the take and places it where it was spoken', async () => {
      const put = vi.fn((body: unknown): [number, unknown] => [200, segue(body as object)]);
      const created = vi.fn((_body: unknown): [number, unknown] => [201, upload('uploading')]);
      const r = renderApp(
        url,
        recordRoutes(segue(), {
          [`PUT ${base}/segues/${segue().id}`]: put,
          [`POST ${base}/uploads`]: created,
          [`POST ${base}/uploads/${uploadId}/parts`]: [
            200,
            { parts: [{ partNumber: 1, url: 'https://s3.test/part/1' }], expiresIn: 3600 },
          ],
          'PUT /part/1': [200],
          [`POST ${base}/uploads/${uploadId}/complete`]: [202, upload('queued')],
          [`GET ${base}/uploads/${uploadId}`]: [200, upload('ingested', { assetId: take })],
        }),
      );
      const { screen, user, history } = r;
      await openRecorder(r);
      // The mic is opened raw.
      expect(fake.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await recordTake(r, 2, 0.3);
      // Trimmed to 150 ms before the voice and 300 ms after it.
      expect(screen.getByText('0:02.5 kept of 0:04.0')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Upload and place' }));
      await waitFor(() => expect(history.location.pathname).toBe(`${base}/log/segue`));
      expect(created.mock.calls[0]?.[0]).toMatchObject({
        assetType: 'vt',
        contentType: 'audio/wav',
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await screen.findByText('Voice 2')).toBeInTheDocument();

      // Pre-roll: 10 s before the transition (the voice at −3 s); the take starts 30 ms of
      // latency before it, and the voice 0.85 s into the take.
      const from = -s(3) - s(10);
      const start = from - Math.round(0.03 * SR) + Math.round(0.85 * SR);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(put).toHaveBeenCalledOnce());
      expect(put.mock.calls[0]?.[0]).toMatchObject({
        version: 4,
        // The draft's fade-out came back with the take.
        out: { envelope: [{ at: -s(2) }, { at: 0, gainDb: -90 }] },
        voices: [{ assetId: vtAsset }, { assetId: take, start, cueIn: 0 }],
      });
    });

    it('warns calmly when a take clips or is very quiet, and retakes', async () => {
      const r = renderApp(url, recordRoutes(segue()));
      const { screen } = r;
      await openRecorder(r);
      await recordTake(r, 1, 1);
      expect(screen.getByText(/The take clips/)).toBeInTheDocument();
      // Never a block.
      expect(screen.getByRole('button', { name: 'Upload and place' })).toBeEnabled();

      await recordTake(r, 3, 0.01);
      expect(screen.queryByText(/The take clips/)).not.toBeInTheDocument();
      expect(screen.getByText(/The take is very quiet/)).toBeInTheDocument();
      expect(screen.getByText('0:03.5 kept of 0:05.0')).toBeInTheDocument();
    });

    it('asks before dropping a take, and takes the draft back without asking', async () => {
      const r = renderApp(url, recordRoutes(segue()));
      const { screen, user, history } = r;
      await openRecorder(r);
      // Only the draft is unsaved: it goes back with the link.
      await user.click(screen.getByText('Back to the segue'));
      await screen.findByText('Voice 1');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

      // A take is lost by leaving: that asks.
      await user.click(screen.getByRole('button', { name: 'Record a VT' }));
      await user.click(await screen.findByRole('button', { name: 'Use the microphone' }));
      await screen.findByRole('combobox', { name: 'Input' });
      await recordTake(r, 1, 0.3);
      await user.click(screen.getByText('Back to the segue'));
      expect(
        await screen.findByRole('dialog', { name: 'Leave without saving?' }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Stay' }));
      expect(history.location.pathname).toBe(`${base}/log/segue/record`);
    });

    it('drops a draft left behind when the editor is opened another way', async () => {
      const r = renderApp(url, recordRoutes(segue()));
      const { screen, history } = r;
      await openRecorder(r);
      // Out of the recorder by another way (the draft's guard is answered elsewhere).
      history.push(`${base}/log?date=2026-10-21`);
      const leave = await screen.findByRole('button', { name: 'Leave without saving' });
      await r.user.click(leave);
      history.push(url);
      await screen.findByText('Voice 1');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('says when a take arrives on a segue with 4 voices already', async () => {
      const voices = [1, 2, 3, 4].map((n) => ({
        assetId: vtAsset,
        start: -s(n),
        gainDb: 0,
        envelope: [],
      }));
      const { screen } = renderApp(
        `${url}&voice=${take}&at=${-s(4)}`,
        recordRoutes(segue({ voices })),
      );
      expect(await screen.findByText(/already has 4 voices/)).toBeInTheDocument();
      expect(screen.queryByText('Voice 5')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  it('says when the transition is gone from the log', async () => {
    const { screen } = renderApp(
      `${base}/log/segue?date=2026-10-21&from=${b.id}&to=${a.id}`,
      routes(null),
    );
    expect(await screen.findByText('This transition is no longer in the log.')).toBeInTheDocument();
  });
});
