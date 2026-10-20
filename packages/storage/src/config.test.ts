import { describe, expect, it } from 'vitest';
import { loadStorageConfig } from './config.ts';

const env = {
  S3_ENDPOINT: 'http://127.0.0.1:3900',
  S3_REGION: 'garage',
  S3_BUCKET: 'ondes-dev',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: 'true',
};

describe('loadStorageConfig', () => {
  it('reads the S3_* variables', () => {
    expect(loadStorageConfig(env)).toEqual({
      endpoint: 'http://127.0.0.1:3900',
      region: 'garage',
      bucket: 'ondes-dev',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });
  });

  it('treats an empty endpoint as AWS and defaults to virtual-hosted style', () => {
    const config = loadStorageConfig({ ...env, S3_ENDPOINT: '', S3_FORCE_PATH_STYLE: undefined });
    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBe(false);
  });

  it('fails on missing credentials', () => {
    expect(() => loadStorageConfig({ ...env, S3_SECRET_ACCESS_KEY: undefined })).toThrow();
  });
});
