import type { Asset, FallbackAsset, MyOrg, SafetyStatus } from '@ondes/shared';
import { act, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../../../app/testing/fake-event-source.ts';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

const url = `/stations/${stationId}/settings/safety`;
const api = `/stations/${stationId}`;
const at = '2026-10-20T08:00:00.000Z';

function fallback(id: string, title: string, state: FallbackAsset['cache']['state']) {
  return {
    assetId: `01a15ddf-0000-7000-8000-0000000001${id}`,
    type: 'song',
    title,
    artists: ['Artist'],
    durationMs: 185_000,
    sha256: state === 'no_file' ? null : id.repeat(32),
    cache: {
      state,
      error: state === 'failed' ? 'source_missing' : null,
      errorMessage: state === 'failed' ? 'gone' : null,
    },
    addedAt: at,
  };
}

function libraryAsset(id: string, title: string): Asset {
  return {
    id: `01a15ddf-0000-7000-8000-0000000002${id}`,
    orgId: orgs[0]?.id ?? '',
    stationId,
    type: 'song',
    title,
    artists: [],
    album: null,
    year: null,
    isrc: null,
    version: null,
    durationMs: 200_000,
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
  };
}

const a = fallback('aa', 'Alpha', 'ready');
const b = fallback('bb', 'Bravo', 'failed');

const status = (over: Partial<Record<keyof SafetyStatus, unknown>> = {}) => ({
  safety: { assets: [a, b], readyCount: 1, readyDurationMs: 185_000 },
  emergency: fallback('cc', 'Loop', 'pending'),
  inEngine: { safetyFiles: 1, emergency: 'selected' },
  syncedAt: at,
  onAir: { source: 'queue', startedAt: at },
  ...over,
});

/** The fixture orgs with the first station's role replaced. */
function withRole(role: 'station_manager' | 'presenter'): Record<string, ApiRoute> {
  const copy = structuredClone(orgs) as MyOrg[];
  const st = copy[0]?.stations[0];
  if (st) st.role = role;
  return { ...signedIn(), 'GET /orgs': [200, { orgs: copy }] };
}

describe('safety settings page', () => {
  it('shows the playlist, the emergency file and their cache status, read-only', async () => {
    const { screen } = renderApp(url, {
      ...withRole('presenter'),
      [`GET ${api}/safety`]: [200, status()],
    });
    expect(await screen.findByRole('heading', { name: 'Safety & emergency' })).toBeVisible();
    expect(await screen.findByText('Alpha · Artist')).toBeVisible();
    expect(screen.getByTestId('safety-summary')).toHaveTextContent(
      '1 of 2 ready in the engine · 3:05',
    );
    const rows = screen.getAllByRole('row');
    expect(within(rows[2] as HTMLElement).getByText('Failed')).toHaveAttribute('title', 'gone');
    expect(within(screen.getByTestId('emergency-asset')).getByText('Syncing')).toBeVisible();
    expect(screen.getByText('On schedule')).toBeVisible();
    expect(screen.getByText('Only station managers can change these.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add tracks' })).toBeNull();
    // The nav entry.
    expect(screen.getByRole('link', { name: 'Safety & emergency' })).toBeVisible();
  });

  it('flags an asset without audio and a previous emergency file still in use', async () => {
    const { screen } = renderApp(url, {
      ...withRole('presenter'),
      [`GET ${api}/safety`]: [
        200,
        status({
          emergency: fallback('cc', 'Loop', 'no_file'),
          inEngine: { safetyFiles: 1, emergency: 'previous' },
        }),
      ],
    });
    expect(await screen.findByTestId('emergency-previous')).toHaveTextContent(
      'The engine still loops the previous emergency file',
    );
    expect(within(screen.getByTestId('emergency-asset')).getByText('No audio file')).toBeVisible();
  });

  it('shows safety mode, and refreshes when a track starts', async () => {
    const routes: Record<string, ApiRoute> = {
      ...withRole('presenter'),
      [`GET ${api}/safety`]: [200, status()],
    };
    const { screen } = renderApp(url, routes);
    await screen.findByText('On schedule');
    routes[`GET ${api}/safety`] = [200, status({ onAir: { source: 'emergency', startedAt: at } })];
    const source = FakeEventSource.last();
    act(() => {
      source.open();
      source.emit({
        id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e11',
        stationId,
        at,
        type: 'engine.track.started',
        data: {
          bootId: 'b',
          seq: 3,
          itemId: null,
          segmentId: null,
          source: 'emergency',
          title: null,
          artist: null,
          filename: null,
          rid: '4',
        },
      });
    });
    expect(await screen.findByTestId('safety-mode')).toHaveTextContent(
      'Safety mode: emergency file on air',
    );
  });

  it('lets a station manager add from the library, by tag, and remove', async () => {
    const charlie = libraryAsset('dd', 'Charlie');
    const routes: Record<string, ApiRoute> = {
      ...withRole('station_manager'),
      [`GET ${api}/safety`]: [200, status()],
      [`GET ${api}/assets`]: [200, { items: [charlie], nextCursor: null }],
      [`POST ${api}/safety/assets`]: (body) => [
        200,
        status({
          safety: {
            assets: [
              a,
              b,
              fallback('dd', (body as { tag?: unknown }).tag ? 'Tagged' : 'Charlie', 'pending'),
            ],
            readyCount: 1,
            readyDurationMs: 185_000,
          },
        }),
      ],
      [`DELETE ${api}/safety/assets/${b.assetId}`]: [204],
    };
    const { screen, user, calls } = renderApp(url, routes);

    await user.click(await screen.findByRole('button', { name: 'Add tracks' }));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Add 1' }));
    expect(await screen.findByText('Charlie · Artist')).toBeVisible();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ assetIds: [charlie.id] });

    await user.click(screen.getByRole('button', { name: 'Add by tag' }));
    await user.type(await screen.findByLabelText('Value'), 'Calm');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
        tag: { key: 'genre', value: 'Calm' },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Remove Bravo from the safety playlist' }));
    await waitFor(() => expect(screen.queryByText('Bravo · Artist')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('chooses the emergency file from the library, or clears it', async () => {
    const loop = libraryAsset('ee', 'New loop');
    const { screen, user, calls } = renderApp(url, {
      ...withRole('station_manager'),
      [`GET ${api}/safety`]: [200, status()],
      [`GET ${api}/assets`]: [200, { items: [loop], nextCursor: null }],
      [`PUT ${api}/safety/emergency`]: (body) => [
        200,
        status({
          emergency: (body as { assetId: string | null }).assetId
            ? fallback('ee', 'New loop', 'pending')
            : null,
        }),
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Choose from library' }));
    await user.click(await screen.findByRole('button', { name: 'Choose: New loop' }));
    expect(await screen.findByText('New loop · Artist')).toBeVisible();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ assetId: loop.id });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText(
        'No emergency file: the station goes silent if the safety playlist is empty.',
      ),
    ).toBeVisible();
  });

  it('uploads an emergency file, waits for ingest, then selects it', async () => {
    const uploadId = '01a15ddf-0000-7000-8000-000000000301';
    const assetId = '01a15ddf-0000-7000-8000-000000000302';
    const upload = (over: Record<string, unknown> = {}) => ({
      id: uploadId,
      orgId: orgs[0]?.id,
      stationId,
      status: 'uploading',
      filename: 'loop.flac',
      sizeBytes: 4,
      contentType: 'audio/flac',
      assetType: 'other',
      partSize: 5 * 1024 * 1024,
      partCount: 1,
      sha256: null,
      assetId: null,
      duplicateOfAssetId: null,
      errorCode: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      ...over,
    });
    const { screen, user, calls } = renderApp(url, {
      ...withRole('station_manager'),
      [`GET ${api}/safety`]: [200, status()],
      [`POST ${api}/uploads`]: [201, upload()],
      [`POST ${api}/uploads/${uploadId}/parts`]: [
        200,
        { parts: [{ partNumber: 1, url: 'http://s3.test/bucket/part-1' }], expiresIn: 3600 },
      ],
      'PUT /bucket/part-1': [200],
      [`POST ${api}/uploads/${uploadId}/complete`]: [200, upload({ status: 'queued' })],
      [`GET ${api}/uploads/${uploadId}`]: [200, upload({ status: 'ingested', assetId })],
      [`PUT ${api}/safety/emergency`]: [
        200,
        status({ emergency: fallback('ff', 'loop', 'pending') }),
      ],
    });
    await screen.findByRole('button', { name: 'Upload a file' });
    const file = new File(['flac'], 'loop.flac', { type: 'audio/flac' });
    await user.upload(screen.getByTestId('emergency-file-input'), file);
    expect(await screen.findByText('loop · Artist')).toBeVisible();
    expect(calls.find((c) => c.path === `${api}/uploads`)?.body).toMatchObject({
      filename: 'loop.flac',
      sizeBytes: 4,
      assetType: 'other',
    });
    expect(calls.find((c) => c.method === 'PUT' && c.path.endsWith('/emergency'))?.body).toEqual({
      assetId,
    });
  });
});
