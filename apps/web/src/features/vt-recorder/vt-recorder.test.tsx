import type { Upload } from '@ondes/shared';
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signedIn, stationId } from '../../app/testing/render.tsx';
import { takeFilename, uploadTake } from './api.ts';
import { setRecorderDeps } from './recorder.ts';
import { fakeRecorder } from './testing.ts';

// The standalone recorder page and the take's upload against a fake api: the page asks for
// the mic and says when it's blocked; the upload is a `vt` upload whose ingest it waits for.

const base = `/stations/${stationId}`;
const uploadId = '01a15ddf-0000-7000-8000-0000000007a1';
const assetId = '01a15ddf-0000-7000-8000-0000000007b1';

const upload = (overrides: Partial<Upload> = {}) => ({
  id: uploadId,
  orgId: '01a15ddf-0000-7000-8000-0000000007c1',
  stationId,
  status: 'uploading',
  filename: 'VT.wav',
  sizeBytes: 10,
  contentType: 'audio/wav',
  assetType: 'vt',
  partSize: 8 * 1024 * 1024,
  partCount: 1,
  sha256: null,
  assetId: null,
  duplicateOfAssetId: null,
  errorCode: null,
  error: null,
  createdAt: '2026-10-22T09:00:00.000Z',
  updatedAt: '2026-10-22T09:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRecorderDeps();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('VT recorder page', () => {
  it('asks for the microphone and says when it is blocked', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    const { screen, user } = renderApp(`${base}/voice-tracks/record`, signedIn());
    expect(await screen.findByRole('heading', { name: 'Record a VT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Use the microphone' }));
    expect(await screen.findByText(/The microphone is blocked/)).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});

describe('standalone VT', () => {
  it('records without pre-roll and uploads the take to the library', async () => {
    const fake = fakeRecorder();
    setRecorderDeps(fake.deps);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: fake.getUserMedia },
      configurable: true,
    });
    const created = vi.fn((_body: unknown): [number, unknown] => [201, upload()]);
    const { screen, user, history } = renderApp(`${base}/voice-tracks/record`, {
      ...signedIn(),
      [`POST ${base}/uploads`]: created,
      [`POST ${base}/uploads/${uploadId}/parts`]: [
        200,
        { parts: [{ partNumber: 1, url: 'https://s3.test/part/1' }], expiresIn: 3600 },
      ],
      'PUT /part/1': [200],
      [`POST ${base}/uploads/${uploadId}/complete`]: [202, upload({ status: 'queued' })],
      [`GET ${base}/uploads/${uploadId}`]: [200, upload({ status: 'ingested', assetId })],
    });
    await user.click(await screen.findByRole('button', { name: 'Use the microphone' }));
    await screen.findByRole('combobox', { name: 'Input' });
    // No music to hear: no pre-roll choice, no headphones hint.
    expect(screen.queryByRole('combobox', { name: 'Pre-roll' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByRole('status');
    fake.deliver(fake.startFrame(false), 1, 0.3);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(screen.queryByRole('button', { name: 'Play over the music' })).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Promo Le Sonic');
    await user.click(screen.getByRole('button', { name: 'Upload to the library' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/library`));
    expect(created.mock.calls[0]?.[0]).toMatchObject({
      filename: 'Promo Le Sonic.wav',
      assetType: 'vt',
    });
  });
});

describe('take upload', () => {
  it('names the file after the take', () => {
    expect(takeFilename('VT Fourviere → Saone/Drift')).toBe('VT Fourviere → Saone Drift.wav');
    expect(takeFilename('  ')).toBe('VT.wav');
  });

  it('uploads a vt file and resolves with the asset once ingested', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        });
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        if (url.startsWith('https://s3.test/')) return new Response(null, { status: 200 });
        if (url.endsWith('/uploads') && method === 'POST') return json(upload());
        if (url.endsWith('/parts'))
          return json({ parts: [{ partNumber: 1, url: 'https://s3.test/1' }], expiresIn: 3600 });
        if (url.endsWith('/complete')) return json(upload({ status: 'queued' }));
        polls++;
        return json(
          polls < 2 ? upload({ status: 'processing' }) : upload({ status: 'ingested', assetId }),
        );
      }),
    );
    const phases: string[] = [];
    const file = new File([new Uint8Array(10)], 'VT.wav', { type: 'audio/wav' });
    const id = await uploadTake(stationId, file, (p) => phases.push(p.phase), {
      waitForChange: async () => {},
    });
    expect(id).toBe(assetId);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { filename: 'VT.wav', sizeBytes: 10, contentType: 'audio/wav', assetType: 'vt' },
    });
    expect(calls.some((c) => c.method === 'PUT' && c.url === 'https://s3.test/1')).toBe(true);
    expect(phases).toEqual(['uploading', 'uploading', 'processing']);
  });
});
