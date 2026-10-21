import {
  type AssetType,
  FINAL_UPLOAD_STATUSES,
  presignedUploadPartsSchema,
  type UploadErrorCode,
  type UploadStatus,
  type UploadUpdatedData,
  uploadSchema,
} from '@ondes/shared';
import { useSyncExternalStore } from 'react';
import { isApiError, request } from '../../app/api/client.ts';

// Browser uploads (#18's api): create the upload, PUT its parts straight to S3 through
// presigned URLs (XHR, for byte progress), complete it, then follow the ingest status from
// the `upload.updated` events (SSE) with a slow poll as a fallback. Uploads live in a module
// store per station, so they carry on while the person browses other pages.

export interface UploadJob {
  /** Local id, stable from the moment the file is picked. */
  key: string;
  filename: string;
  sizeBytes: number;
  assetType: AssetType;
  /** Server id, once created. */
  uploadId: string | null;
  /** `preparing` and `sending` are the browser's; then the server's status. */
  status: 'preparing' | 'sending' | UploadStatus;
  sentBytes: number;
  assetId: string | null;
  duplicateOfAssetId: string | null;
  errorCode: UploadErrorCode | 'network' | null;
  error: string | null;
}

const FINAL = new Set<string>(FINAL_UPLOAD_STATUSES);
export const isFinal = (job: UploadJob) => FINAL.has(job.status);

/** Parts sent at once per file, and presigned per request. */
const PART_CONCURRENCY = 3;
const PRESIGN_BATCH = 50;
const POLL_MS = 10_000;

type Listener = () => void;

interface StationUploads {
  jobs: UploadJob[];
  listeners: Set<Listener>;
  /** Aborts the requests of a job still sending. */
  aborts: Map<string, () => void>;
  poll: ReturnType<typeof setInterval> | null;
}

const stations = new Map<string, StationUploads>();
let counter = 0;

function storeOf(stationId: string): StationUploads {
  let store = stations.get(stationId);
  if (!store) {
    store = { jobs: [], listeners: new Set(), aborts: new Map(), poll: null };
    stations.set(stationId, store);
  }
  return store;
}

function update(stationId: string, key: string, patch: Partial<UploadJob>) {
  const store = storeOf(stationId);
  store.jobs = store.jobs.map((job) => (job.key === key ? { ...job, ...patch } : job));
  for (const listener of store.listeners) listener();
  schedulePoll(stationId);
}

function emit(stationId: string) {
  for (const listener of storeOf(stationId).listeners) listener();
}

const base = (stationId: string) => `/stations/${stationId}/uploads`;

/** Queues files for upload; each starts at once (parts are throttled per file). */
export function startUploads(stationId: string, files: File[], assetType: AssetType): void {
  const store = storeOf(stationId);
  const jobs = files.map(
    (file): UploadJob => ({
      key: `u${++counter}`,
      filename: file.name,
      sizeBytes: file.size,
      assetType,
      uploadId: null,
      status: 'preparing',
      sentBytes: 0,
      assetId: null,
      duplicateOfAssetId: null,
      errorCode: null,
      error: null,
    }),
  );
  store.jobs = [...jobs, ...store.jobs];
  emit(stationId);
  jobs.forEach((job, i) => void send(stationId, job.key, files[i] as File));
}

async function send(stationId: string, key: string, file: File) {
  const store = storeOf(stationId);
  const controller = new AbortController();
  const xhrs = new Set<XMLHttpRequest>();
  store.aborts.set(key, () => {
    controller.abort();
    for (const xhr of xhrs) xhr.abort();
  });
  try {
    const job = store.jobs.find((j) => j.key === key);
    const upload = await request(base(stationId), {
      body: {
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type || undefined,
        assetType: job?.assetType ?? 'song',
      },
      schema: uploadSchema,
      signal: controller.signal,
    });
    update(stationId, key, { uploadId: upload.id, status: 'sending' });
    const sent = new Map<number, number>();
    const progress = () =>
      update(stationId, key, { sentBytes: [...sent.values()].reduce((a, b) => a + b, 0) });

    const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
    for (let i = 0; i < numbers.length; i += PRESIGN_BATCH) {
      const batch = numbers.slice(i, i + PRESIGN_BATCH);
      const { parts } = await request(`${base(stationId)}/${upload.id}/parts`, {
        body: { partNumbers: batch },
        schema: presignedUploadPartsSchema,
        signal: controller.signal,
      });
      const queue = [...parts];
      const worker = async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          const start = (part.partNumber - 1) * upload.partSize;
          // No content type: the presigned URL signs none.
          const blob = file.slice(start, Math.min(file.size, start + upload.partSize), '');
          const partNumber = part.partNumber;
          await putPart(part.url, blob, xhrs, (loaded) => {
            sent.set(partNumber, loaded);
            progress();
          });
        }
      };
      await Promise.all(Array.from({ length: PART_CONCURRENCY }, worker));
    }
    const completed = await request(`${base(stationId)}/${upload.id}/complete`, {
      method: 'POST',
      schema: uploadSchema,
      signal: controller.signal,
    });
    applyServer(stationId, key, completed);
  } catch (error) {
    if (controller.signal.aborted) return;
    update(stationId, key, {
      status: 'failed',
      errorCode:
        isApiError(error) && error.code === 'quota_exceeded' ? 'quota_exceeded' : 'network',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    store.aborts.delete(key);
  }
}

function putPart(
  url: string,
  blob: Blob,
  xhrs: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.add(xhr);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve();
      } else reject(new Error(`part upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => {
      xhrs.delete(xhr);
      reject(new Error('part upload failed: network'));
    };
    xhr.onabort = () => {
      xhrs.delete(xhr);
      reject(new Error('aborted'));
    };
    xhr.send(blob);
  });
}

type ServerFields = Pick<
  UploadUpdatedData,
  'status' | 'assetId' | 'duplicateOfAssetId' | 'errorCode' | 'error'
>;

function applyServer(stationId: string, key: string, data: ServerFields) {
  update(stationId, key, {
    status: data.status,
    assetId: data.assetId,
    duplicateOfAssetId: data.duplicateOfAssetId,
    errorCode: data.errorCode,
    error: data.error,
  });
}

/** An `upload.updated` event: updates the job of that upload, if it is one of ours. */
export function applyUploadEvent(stationId: string, data: UploadUpdatedData): UploadJob | null {
  const job = storeOf(stationId).jobs.find((j) => j.uploadId === data.id);
  // While parts are still being sent, our own status wins.
  if (!job || job.status === 'preparing' || job.status === 'sending') return null;
  applyServer(stationId, job.key, data);
  return job;
}

/** Cancels a job: stops sending, aborts the upload on the server. */
export async function cancelUpload(stationId: string, key: string): Promise<void> {
  const store = storeOf(stationId);
  store.aborts.get(key)?.();
  const job = store.jobs.find((j) => j.key === key);
  update(stationId, key, { status: 'aborted' });
  if (job?.uploadId) {
    await request(`${base(stationId)}/${job.uploadId}/abort`, { method: 'POST' }).catch(() => {});
  }
}

/** Queues a failed upload again (server side: the file is already uploaded). */
export async function retryUpload(stationId: string, key: string): Promise<void> {
  const job = storeOf(stationId).jobs.find((j) => j.key === key);
  if (!job?.uploadId) return;
  const upload = await request(`${base(stationId)}/${job.uploadId}/retry`, {
    method: 'POST',
    schema: uploadSchema,
  });
  applyServer(stationId, key, upload);
}

export function clearFinished(stationId: string): void {
  const store = storeOf(stationId);
  store.jobs = store.jobs.filter((job) => !isFinal(job));
  emit(stationId);
}

/** Polls server-side jobs not final yet, in case an event was missed. */
function schedulePoll(stationId: string) {
  const store = storeOf(stationId);
  const waiting = store.jobs.some(
    (j) => j.uploadId && !isFinal(j) && j.status !== 'preparing' && j.status !== 'sending',
  );
  if (waiting && !store.poll) {
    store.poll = setInterval(() => void poll(stationId), POLL_MS);
  } else if (!waiting && store.poll) {
    clearInterval(store.poll);
    store.poll = null;
  }
}

async function poll(stationId: string) {
  const store = storeOf(stationId);
  const waiting = store.jobs.filter(
    (j) => j.uploadId && !isFinal(j) && j.status !== 'preparing' && j.status !== 'sending',
  );
  for (const job of waiting) {
    const upload = await request(`${base(stationId)}/${job.uploadId}`, {
      schema: uploadSchema,
    }).catch(() => null);
    if (upload && upload.status !== job.status) applyServer(stationId, job.key, upload);
  }
}

const NO_JOBS: UploadJob[] = [];

export function useUploads(stationId: string): UploadJob[] {
  return useSyncExternalStore(
    (listener) => {
      const store = storeOf(stationId);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => stations.get(stationId)?.jobs ?? NO_JOBS,
  );
}

/** Tests: forgets every job. */
export function resetUploads(): void {
  for (const store of stations.values()) {
    if (store.poll) clearInterval(store.poll);
    for (const abort of store.aborts.values()) abort();
  }
  stations.clear();
}
