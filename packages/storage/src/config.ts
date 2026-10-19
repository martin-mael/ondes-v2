import { z } from 'zod';

/** Env vars read by {@link loadStorageConfig}. Names match `.env.example`. */
export const storageEnvSchema = z.object({
  /** Omit for AWS S3; set for Garage, MinIO, R2, etc. */
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** Path-style (`endpoint/bucket/key`) addressing. Garage and MinIO need it. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

export type StorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export function loadStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  // Empty strings (e.g. `S3_ENDPOINT=` in a .env file) mean "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = storageEnvSchema.parse(cleaned);
  return {
    endpoint: parsed.S3_ENDPOINT,
    region: parsed.S3_REGION,
    bucket: parsed.S3_BUCKET,
    accessKeyId: parsed.S3_ACCESS_KEY_ID,
    secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
    forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
  };
}
