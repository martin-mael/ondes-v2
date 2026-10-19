import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from './config.ts';
import {
  type ListedObject,
  ObjectNotFoundError,
  type Storage,
  type UploadedPart,
} from './storage.ts';

const DEFAULT_EXPIRES_IN = 900;

export type S3StorageOptions = {
  /** Inject a preconfigured client (tests, custom middleware). Built from `config` otherwise. */
  client?: S3Client;
};

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Only send/validate the flexible checksums when an operation requires them. The SDK
    // default (CRC32 on every request) isn't supported by every S3-compatible server and
    // would leak into presigned URLs, which browsers can't satisfy.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createS3Storage(config: StorageConfig, options: S3StorageOptions = {}): Storage {
  const client = options.client ?? createS3Client(config);
  const Bucket = config.bucket;

  return {
    bucket: Bucket,

    async put(key, body, { contentType, contentLength, metadata } = {}) {
      if (body instanceof Readable && contentLength === undefined) {
        throw new Error('put: contentLength is required for stream bodies');
      }
      const res = await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
          Metadata: metadata,
        }),
      );
      return { etag: unquote(res.ETag) };
    },

    async get(key, { range } = {}) {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
          }),
        );
        if (!(res.Body instanceof Readable)) throw new Error('get: expected a Node.js stream body');
        return {
          body: res.Body,
          contentLength: res.ContentLength ?? 0,
          etag: unquote(res.ETag),
          contentType: res.ContentType,
        };
      } catch (error) {
        if (isNotFound(error)) throw new ObjectNotFoundError(key, { cause: error });
        throw error;
      }
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          key,
          size: res.ContentLength ?? 0,
          etag: unquote(res.ETag),
          contentType: res.ContentType,
          lastModified: res.LastModified,
          metadata: res.Metadata ?? {},
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async *list(prefix): AsyncGenerator<ListedObject> {
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }),
        );
        for (const object of res.Contents ?? []) {
          if (object.Key === undefined) continue;
          yield {
            key: object.Key,
            size: object.Size ?? 0,
            etag: unquote(object.ETag),
            lastModified: object.LastModified,
          };
        }
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },

    presignGet(key, { expiresIn = DEFAULT_EXPIRES_IN, responseContentDisposition } = {}) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: responseContentDisposition,
        }),
        { expiresIn },
      );
    },

    presignPut(key, { expiresIn = DEFAULT_EXPIRES_IN, contentType } = {}) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
        {
          expiresIn,
          // Make Content-Type part of the signature so the client can't change it.
          signableHeaders: contentType ? new Set(['content-type']) : undefined,
        },
      );
    },

    async createMultipartUpload(key, { contentType } = {}) {
      const res = await client.send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }),
      );
      if (!res.UploadId) throw new Error('createMultipartUpload: no UploadId in response');
      return { uploadId: res.UploadId };
    },

    presignUploadParts(key, uploadId, partNumbers, { expiresIn = DEFAULT_EXPIRES_IN } = {}) {
      return Promise.all(
        partNumbers.map(async (partNumber) => {
          assertPartNumber(partNumber);
          const url = await getSignedUrl(
            client,
            new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
            { expiresIn },
          );
          return { partNumber, url };
        }),
      );
    },

    async listParts(key, uploadId) {
      const parts: UploadedPart[] = [];
      let PartNumberMarker: string | undefined;
      do {
        const res = await client.send(
          new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker }),
        );
        for (const part of res.Parts ?? []) {
          if (part.PartNumber === undefined || part.ETag === undefined) continue;
          parts.push({ partNumber: part.PartNumber, etag: unquote(part.ETag), size: part.Size });
        }
        PartNumberMarker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
      } while (PartNumberMarker);
      return parts;
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const res = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((part) => ({ PartNumber: part.partNumber, ETag: quote(part.etag) })),
          },
        }),
      );
      return { etag: unquote(res.ETag) };
    },

    async abortMultipartUpload(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 404 ||
      error.name === 'NoSuchKey' ||
      error.name === 'NotFound')
  );
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error(`Invalid part number ${partNumber}: must be an integer in 1..10000`);
  }
}

/** S3 returns ETags wrapped in double quotes; callers get the bare value. */
function unquote(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '');
}

function quote(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}
