import type { Readable } from 'node:stream';

/** Body accepted by {@link Storage.put}. Streams need a known `contentLength`. */
export type PutBody = Uint8Array | string | Readable;

export type PutOptions = {
  contentType?: string;
  /** Required when `body` is a stream: S3 needs the length up front. */
  contentLength?: number;
  /** User metadata (`x-amz-meta-*`). Keys are lower-cased by S3. */
  metadata?: Record<string, string>;
};

export type ObjectInfo = {
  key: string;
  size: number;
  etag: string;
  contentType?: string;
  lastModified?: Date;
  metadata: Record<string, string>;
};

export type GetOptions = {
  /** Inclusive byte range, like the HTTP `Range` header. */
  range?: { start: number; end?: number };
};

export type GetResult = {
  body: Readable;
  /** Length of `body` (the range length for ranged reads). */
  contentLength: number;
  etag: string;
  contentType?: string;
};

export type ListedObject = { key: string; size: number; etag: string; lastModified?: Date };

export type PresignGetOptions = {
  /** Seconds the URL stays valid. Default 900 (15 min). */
  expiresIn?: number;
  /** Sets `Content-Disposition` on the response, e.g. `attachment; filename="x.flac"`. */
  responseContentDisposition?: string;
};

export type PresignPutOptions = {
  /** Seconds the URL stays valid. Default 900 (15 min). */
  expiresIn?: number;
  /** When set, the client must send this exact `Content-Type`. */
  contentType?: string;
};

export type PresignPartsOptions = {
  /** Seconds the URLs stay valid. Default 900 (15 min). */
  expiresIn?: number;
  /**
   * Exact byte size per part number. When given, `Content-Length` is signed into that part's
   * URL, so S3 refuses a body of any other size (bounds what an untrusted client can store).
   */
  contentLengths?: Readonly<Record<number, number>>;
};

export type UploadedPart = { partNumber: number; etag: string; size?: number };

export type PresignedPart = { partNumber: number; url: string };

/**
 * Object storage used by the api and worker. Keys are opaque strings; use
 * {@link contentKey} for media so identical files share one object per org.
 *
 * Missing objects: `head` resolves `null`, `get` rejects with {@link ObjectNotFoundError},
 * `delete` is a no-op.
 */
export interface Storage {
  readonly bucket: string;

  put(key: string, body: PutBody, options?: PutOptions): Promise<{ etag: string }>;
  get(key: string, options?: GetOptions): Promise<GetResult>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** Every object under `prefix`, paging transparently. */
  list(prefix: string): AsyncIterable<ListedObject>;

  presignGet(key: string, options?: PresignGetOptions): Promise<string>;
  presignPut(key: string, options?: PresignPutOptions): Promise<string>;

  /**
   * Multipart upload, for large files uploaded by the browser or the worker.
   * Parts are 5 MiB minimum (except the last) and numbered 1..10000. A client resumes an
   * interrupted upload by calling {@link listParts} and sending only the missing parts.
   */
  createMultipartUpload(
    key: string,
    options?: { contentType?: string },
  ): Promise<{ uploadId: string }>;
  presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
    options?: PresignPartsOptions,
  ): Promise<PresignedPart[]>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
  ): Promise<{ etag: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  readonly key: string;

  constructor(key: string, options?: ErrorOptions) {
    super(`Object not found: ${key}`, options);
    this.name = 'ObjectNotFoundError';
    this.key = key;
  }
}
