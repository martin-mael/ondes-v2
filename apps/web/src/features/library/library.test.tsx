import type {
  AssetActivity,
  AssetDetail,
  LibraryFacets,
  LibraryItem,
  LibrarySearchPage,
  MyOrg,
} from '@ondes/shared';
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../app/testing/fake-event-source.ts';
import {
  type ApiCall,
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../app/testing/render.tsx';
import { registerAssetDrawerSlot } from './drawer-slots.ts';
import { filterOf } from './filters.ts';
import { resetUploads } from './uploads.ts';

// The library screen on the whole app with a fake api: list and facets, search and facet
// filters into the api filter, bulk edits on ids and on "all matching", the asset drawer and
// its extension slot, uploads with progress and SSE status, and the read-only view.

const at = '2026-10-21T08:00:00.000Z';
const lib = `/stations/${stationId}/library`;
const ids = Array.from({ length: 3 }, (_, i) => `01a15ddf-0000-7000-8000-0000000001a${i}`);
const uploadId = '01a15ddf-0000-7000-8000-0000000002a0';

const asRole = (role: 'programmer' | 'presenter'): MyOrg[] =>
  orgs.map((org) => ({
    ...org,
    stations: org.stations.map((s) => (s.id === stationId ? { ...s, role } : s)),
  }));

function item(i: number, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: ids[i] ?? '',
    orgId: orgs[0]?.id ?? '',
    stationId,
    type: 'song',
    title: ['Été indien', 'One More Time', 'Around the World'][i] ?? `Song ${i}`,
    artists: [['Joe Dassin'], ['Daft Punk'], ['Daft Punk']][i] ?? [],
    album: null,
    year: 1997,
    isrc: null,
    version: null,
    durationMs: 187_000,
    explicit: false,
    startAt: null,
    killAt: null,
    notes: null,
    metadata: {},
    sourceFilename: null,
    normalizeLoudness: true,
    gainOverrideDb: null,
    createdAt: new Date(at),
    updatedAt: new Date(at),
    tags: [{ id: '01a15ddf-0000-7000-8000-0000000003a0', key: 'genre', value: 'house' }],
    analysis: { loudness: true, cues: true, peaks: i !== 2 },
    integratedLufs: -12,
    playoutGain: { gainDb: -4, source: 'measured', limitedByPeak: false },
    bpm: 123,
    musicalKey: 'Am',
    lastPlayedAt: null,
    ...patch,
  };
}

const page: LibrarySearchPage = { items: [item(0), item(1), item(2)], nextCursor: null };
const facets: LibraryFacets = {
  total: 250,
  types: [
    { type: 'song', count: 240 },
    { type: 'jingle', count: 10 },
  ],
  tags: [
    { id: '01a15ddf-0000-7000-8000-0000000003a0', key: 'genre', value: 'house', count: 120 },
    { id: '01a15ddf-0000-7000-8000-0000000003a1', key: 'genre', value: 'soul', count: 30 },
  ],
  analysis: [
    { state: 'complete', count: 200 },
    { state: 'pending', count: 50 },
    { state: 'no_loudness', count: 5 },
    { state: 'no_cues', count: 10 },
    { state: 'no_peaks', count: 50 },
  ],
  validity: [
    { validity: 'active', count: 245 },
    { validity: 'future', count: 2 },
    { validity: 'expired', count: 3 },
  ],
};

const detail: AssetDetail = {
  ...item(0),
  album: 'Le Costume Blanc',
  files: [],
  cues: {
    assetId: ids[0] ?? '',
    sampleRate: 44_100,
    analyzerVersion: 'autocue/1',
    cueIn: { samples: 44_100, source: 'auto', locked: false },
    cueOut: { samples: 441_000, source: 'manual', locked: true },
    introEnd: { samples: null, source: 'auto', locked: false },
    outroStart: { samples: null, source: 'auto', locked: false },
    fadeIn: { samples: null, source: 'auto', locked: false },
    fadeOut: { samples: null, source: 'auto', locked: false },
    crossStartNext: { samples: 400_000, source: 'auto', locked: false },
    updatedAt: new Date(at),
  },
  loudness: {
    assetId: ids[0] ?? '',
    integratedLufs: -12,
    loudnessRangeLu: 6,
    truePeakDbtp: -0.5,
    playoutSha256: null,
    analyzer: 'ffmpeg-ebur128',
    analyzerVersion: '1',
    confidence: null,
    measuredAt: new Date(at),
  },
  analysis: null,
};
const activity: AssetActivity = { lastPlayedAt: null, plays7d: 0, plays30d: 2, cache: null };

function routes(role: 'programmer' | 'presenter', extra: Record<string, ApiRoute> = {}) {
  return {
    ...signedIn(),
    'GET /orgs': [200, { orgs: asRole(role) }],
    [`POST ${lib}/search`]: [200, page],
    [`POST ${lib}/facets`]: [200, facets],
    [`GET /stations/${stationId}/assets/${ids[0]}`]: [200, detail],
    [`GET ${lib}/assets/${ids[0]}/activity`]: [200, activity],
    [`GET /stations/${stationId}/tags`]: [200, { tags: [] }],
    ...extra,
  } satisfies Record<string, ApiRoute>;
}

const lastBody = (calls: ApiCall[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path).at(-1)?.body as Record<
    string,
    unknown
  >;

// The virtualizer measures its scroll box; happy-dom lays nothing out.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetUploads();
});

describe('library page', () => {
  it('lists assets with facet counts and a nav entry', async () => {
    const { screen } = renderApp(`/stations/${stationId}/library`, routes('presenter'));
    expect(await screen.findByText('One More Time')).toBeInTheDocument();
    expect(screen.getByText('250 assets')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Library' })).toBeInTheDocument();
    const types = screen.getByRole('group', { name: 'Type' });
    expect(within(types).getByText('240')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Genre' })).toHaveTextContent('soul30');
    // Read-only: no selection, no upload.
    expect(screen.queryByRole('checkbox', { name: /Select One More Time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('sends the search box, facets and sort to the api, and keeps them in the URL', async () => {
    const { screen, user, calls, history } = renderApp(
      `/stations/${stationId}/library`,
      routes('presenter'),
    );
    await screen.findByText('One More Time');
    await user.type(screen.getByRole('searchbox'), 'daft');
    await waitFor(() => expect(lastBody(calls, `${lib}/search`)?.filter).toEqual({ q: 'daft' }));
    await user.click(screen.getByRole('checkbox', { name: 'Jingle' }));
    await user.click(screen.getByRole('checkbox', { name: 'soul' }));
    await waitFor(() =>
      expect(lastBody(calls, `${lib}/facets`)?.filter).toEqual({
        q: 'daft',
        types: ['jingle'],
        tags: [{ key: 'genre', value: 'soul' }],
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Title' }));
    await waitFor(() =>
      expect(lastBody(calls, `${lib}/search`)).toMatchObject({ sort: 'title', direction: 'asc' }),
    );
    expect(history.location.search).toContain('sort=title');
    expect(history.location.search).toContain('genre%3Asoul');
  });

  it('bulk edits tags on picked rows, and fields on all matching assets', async () => {
    let bulk: unknown[] = [];
    const { screen, user } = renderApp(
      `/stations/${stationId}/library`,
      routes('programmer', {
        [`POST ${lib}/bulk`]: (body) => {
          bulk = [...bulk, body];
          return [200, { matched: 2, changed: 2 }];
        },
      }),
    );
    await screen.findByText('One More Time');
    await user.click(screen.getByRole('checkbox', { name: 'Select Été indien' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select One More Time' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Add: Value' }), 'disco');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bulk[0]).toEqual({
        selection: { ids: [ids[0], ids[1]] },
        action: { kind: 'tags', add: [{ key: 'genre', value: 'disco' }], remove: [] },
      }),
    );
    expect(await screen.findByText('2 of 2 assets changed.')).toBeInTheDocument();

    // Everything loaded, then everything matching.
    await user.click(screen.getByRole('checkbox', { name: 'Select the loaded assets' }));
    await user.click(screen.getByRole('button', { name: 'Select all 250 matching' }));
    expect(screen.getByText('All 250 matching selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit fields' }));
    const edit = await screen.findByRole('dialog');
    await user.click(within(edit).getByRole('checkbox', { name: 'Explicit' }));
    await user.click(within(edit).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bulk[1]).toEqual({
        selection: { filter: {}, expectedCount: 250 },
        action: { kind: 'update', patch: { explicit: true } },
      }),
    );
  });

  it('explains a selection that changed meanwhile', async () => {
    const { screen, user } = renderApp(
      `/stations/${stationId}/library`,
      routes('programmer', {
        [`POST ${lib}/bulk`]: [
          409,
          { error: 'selection_changed', message: 'changed', details: { count: 248 } },
        ],
      }),
    );
    await screen.findByText('One More Time');
    await user.click(screen.getByRole('checkbox', { name: 'Select the loaded assets' }));
    await user.click(screen.getByRole('button', { name: 'Select all 250 matching' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete 250 assets' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('248 assets match now');
  });

  it('opens the asset drawer with its details and the extension slots', async () => {
    const unregister = registerAssetDrawerSlot({
      id: 'cue-editor-test',
      title: { en: 'Cue editor', fr: 'Éditeur de cues' },
      replaces: 'cues',
      Component: ({ asset, canWrite }) => (
        <p>
          editing {asset.title} {canWrite ? 'rw' : 'ro'}
        </p>
      ),
    });
    try {
      const { screen, user, history } = renderApp(
        `/stations/${stationId}/library`,
        routes('programmer'),
      );
      await user.click(await screen.findByRole('button', { name: 'Été indien' }));
      const drawer = await screen.findByRole('dialog');
      expect(history.location.search).toContain(`asset=${ids[0]}`);
      expect(await within(drawer).findByText('Le Costume Blanc')).toBeInTheDocument();
      expect(within(drawer).getByText('−12.0 LUFS')).toBeInTheDocument();
      expect(within(drawer).getByText(/−4\.0 dB \(measured\)/)).toBeInTheDocument();
      // The slot replaced the built-in cue list.
      expect(within(drawer).getByRole('region', { name: 'Cue editor' })).toHaveTextContent(
        'editing Été indien rw',
      );
      expect(within(drawer).queryByRole('region', { name: 'Cue points' })).toBeNull();
      expect(await within(drawer).findByText('0 / 2')).toBeInTheDocument();
    } finally {
      unregister();
    }
  });

  it('shows the cue points when no slot replaces them', async () => {
    const { screen } = renderApp(
      `/stations/${stationId}/library?asset=${ids[0]}`,
      routes('presenter'),
    );
    const cues = await screen.findByRole('region', { name: 'Cue points' });
    expect(cues).toHaveTextContent('0:01.000auto');
    expect(cues).toHaveTextContent('0:10.000manual');
  });

  it('uploads a file with progress, then follows its ingest over SSE', async () => {
    const puts: string[] = [];
    class FakeXhr {
      upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      send(blob: Blob) {
        puts.push(this.url);
        this.upload.onprogress?.({ loaded: blob.size / 2 });
        setTimeout(() => {
          this.status = 200;
          this.onload?.();
        }, 0);
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const upload = {
      id: uploadId,
      orgId: orgs[0]?.id,
      stationId,
      status: 'uploading',
      filename: 'mistral.flac',
      sizeBytes: 4,
      contentType: 'audio/flac',
      assetType: 'song',
      partSize: 16 * 1024 * 1024,
      partCount: 1,
      sha256: null,
      assetId: null,
      duplicateOfAssetId: null,
      errorCode: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    const base = `/stations/${stationId}/uploads`;
    const { screen, user, calls } = renderApp(
      `/stations/${stationId}/library`,
      routes('programmer', {
        [`POST ${base}`]: [201, upload],
        [`POST ${base}/${uploadId}/parts`]: [
          200,
          { parts: [{ partNumber: 1, url: 'https://s3.test/part1' }], expiresIn: 3600 },
        ],
        [`POST ${base}/${uploadId}/complete`]: [200, { ...upload, status: 'queued' }],
      }),
    );
    await screen.findByText('One More Time');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    const file = new File(['flac'], 'mistral.flac', { type: 'audio/flac' });
    await user.upload(screen.getByTestId('upload-input'), file);

    const row = await screen.findByRole('listitem', { name: 'mistral.flac' });
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Queued'));
    expect(puts).toEqual(['https://s3.test/part1']);
    expect(lastBody(calls, base)).toMatchObject({ filename: 'mistral.flac', sizeBytes: 4 });

    act(() => {
      const source = FakeEventSource.last();
      source.open();
      source.emit({
        id: '01a15ddf-0000-7000-8000-0000000004a0',
        stationId,
        at,
        type: 'upload.updated',
        data: {
          id: uploadId,
          status: 'ingested',
          filename: 'mistral.flac',
          assetId: ids[0],
          duplicateOfAssetId: null,
          errorCode: null,
          error: null,
        },
      });
    });
    await waitFor(() =>
      expect(within(row).getByRole('status')).toHaveTextContent('Added to the library'),
    );
    await user.click(within(row).getByRole('button', { name: 'Open the asset' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('library page, more', () => {
  const sha = 'a'.repeat(64);
  const file = {
    fileId: ids[0],
    storageKey: 'k',
    sha256: sha,
    sizeBytes: 1,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    durationSamples: 1,
    flacBlockSize: 1024,
  };
  const ingested = {
    id: '01a15ddf-0000-7000-8000-0000000004b0',
    stationId,
    at,
    type: 'asset.ingested',
    data: { orgId: orgs[0]?.id, assetId: ids[0], uploadId, master: file, playout: file },
  };

  it('saves filters in this browser and applies them again', async () => {
    const first = renderApp(
      `/stations/${stationId}/library?type=%5B%22jingle%22%5D`,
      routes('presenter'),
    );
    await first.screen.findByText('One More Time');
    await first.user.click(first.screen.getByRole('button', { name: 'Saved filters' }));
    await first.user.click(
      await first.screen.findByRole('menuitem', { name: /Save the current filters/ }),
    );
    const dialog = await first.screen.findByRole('dialog');
    await first.user.type(within(dialog).getByLabelText('Name'), 'Jingles');
    await first.user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    cleanup();

    const again = renderApp(`/stations/${stationId}/library`, routes('presenter'));
    await again.screen.findByText('One More Time');
    await again.user.click(again.screen.getByRole('button', { name: 'Saved filters' }));
    await again.user.click(await again.screen.findByRole('menuitem', { name: 'Jingles' }));
    await waitFor(() =>
      expect(lastBody(again.calls, `${lib}/search`)?.filter).toEqual({ types: ['jingle'] }),
    );
  });

  it('remembers the visible columns', async () => {
    const first = renderApp(`/stations/${stationId}/library`, routes('presenter'));
    await first.screen.findByText('One More Time');
    expect(first.screen.getByRole('columnheader', { name: 'Album' })).toBeInTheDocument();
    await first.user.click(first.screen.getByRole('button', { name: 'Columns' }));
    await first.user.click(await first.screen.findByRole('menuitemcheckbox', { name: 'Album' }));
    await first.user.click(await first.screen.findByRole('menuitemcheckbox', { name: 'BPM' }));
    cleanup();

    const again = renderApp(`/stations/${stationId}/library`, routes('presenter'));
    await again.screen.findByText('One More Time');
    expect(again.screen.queryByRole('columnheader', { name: 'Album' })).toBeNull();
    expect(again.screen.getByRole('columnheader', { name: /BPM/ })).toBeInTheDocument();
  });

  it('keeps the count seen at "select all", even after new assets arrive', async () => {
    let total = 250;
    let bulk: unknown;
    const { screen, user } = renderApp(
      `/stations/${stationId}/library`,
      routes('programmer', {
        [`POST ${lib}/facets`]: () => [200, { ...facets, total }],
        [`POST ${lib}/bulk`]: (body) => {
          bulk = body;
          return [200, { matched: 250, changed: 250 }];
        },
      }),
    );
    await screen.findByText('One More Time');
    await user.click(screen.getByRole('checkbox', { name: 'Select the loaded assets' }));
    await user.click(screen.getByRole('button', { name: 'Select all 250 matching' }));
    total = 251;
    act(() => {
      const source = FakeEventSource.last();
      source.open();
      source.emit(ingested);
    });
    await waitFor(() => expect(screen.getByText('251 assets')).toBeInTheDocument());
    expect(screen.getByText('All 250 matching selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit fields' }));
    const edit = await screen.findByRole('dialog');
    await user.click(within(edit).getByRole('checkbox', { name: 'Explicit' }));
    await user.click(within(edit).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bulk).toMatchObject({ selection: { filter: {}, expectedCount: 250 } }),
    );
  });

  it('adds the selection to a category, and explains a refused delete', async () => {
    const bulk: unknown[] = [];
    const categoryId = '01a15ddf-0000-7000-8000-0000000005a0';
    const { screen, user } = renderApp(
      `/stations/${stationId}/library`,
      routes('programmer', {
        [`GET /stations/${stationId}/categories`]: [
          200,
          {
            items: [
              {
                id: categoryId,
                orgId: orgs[0]?.id,
                stationId,
                name: 'House power',
                description: null,
                color: null,
                assetType: 'song',
                rule: null,
                rotationOrder: 'least_recently_played',
                searchDepthPercent: 100,
                restMinutes: 0,
                maxPlaysPerDay: null,
                maxPlaysPerWeek: null,
                createdAt: at,
                updatedAt: at,
                counts: {
                  members: 0,
                  schedulable: 0,
                  ruleMatches: 0,
                  manualOnly: 0,
                  excluded: 0,
                  totalDurationMs: 0,
                },
              },
            ],
          },
        ],
        [`POST ${lib}/bulk`]: (body) => {
          bulk.push(body);
          return (body as { action: { kind: string } }).action.kind === 'delete'
            ? [
                409,
                {
                  error: 'asset_in_use',
                  message: 'in use',
                  details: {
                    usages: [{ assetId: ids[0], kind: 'safety_playlist', usedBy: stationId }],
                  },
                },
              ]
            : [200, { matched: 1, changed: 1 }];
        },
      }),
    );
    await screen.findByText('One More Time');
    await user.click(screen.getByRole('checkbox', { name: 'Select Été indien' }));
    await user.click(screen.getByRole('button', { name: 'Category' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveValue(categoryId),
    );
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Action' }), 'exclude');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(bulk[0]).toEqual({
        selection: { ids: [ids[0]] },
        action: { kind: 'category', categoryId, mode: 'exclude' },
      }),
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select Été indien' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete 1 assets' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 assets are still used (the safety playlist)',
    );
  });
});

describe('library filters', () => {
  it('turns URL params into the api filter', () => {
    const today = new Date(2026, 2, 29, 15, 0); // DST day in Paris; counted in local days.
    expect(
      filterOf(
        {
          q: '  daft ',
          tag: ['genre:house', 'bogus', 'mood:warm'],
          durMin: 90,
          yearMax: 1999,
          addedFrom: '2026-03-01',
          addedTo: '2026-03-02',
          notPlayedDays: 7,
        },
        today,
      ),
    ).toEqual({
      q: 'daft',
      tags: [
        { key: 'genre', value: 'house' },
        { key: 'mood', value: 'warm' },
      ],
      durationMs: { min: 90_000, max: undefined },
      year: { min: undefined, max: 1999 },
      addedAt: { min: new Date(2026, 2, 1), max: new Date(new Date(2026, 2, 3).getTime() - 1) },
      notPlayedSince: new Date(new Date(2026, 2, 29).getTime() - 7 * 86_400_000),
    });
  });
});
