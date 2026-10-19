const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,10}$/;
const CONTENT_KEY = /^org\/([A-Za-z0-9_-]{1,64})\/sha256\/([0-9a-f]{64})\.([a-z0-9]{1,10})$/;

export type ContentKeyParts = { orgId: string; sha256: string; ext: string };

/** Prefix holding every object of an org: `org/<orgId>/`. */
export function orgPrefix(orgId: string): string {
  if (!ORG_ID.test(orgId)) throw new Error(`Invalid org id for a storage key: ${orgId}`);
  return `org/${orgId}/`;
}

/**
 * Content-addressed key: `org/<orgId>/sha256/<hash>.<ext>`. The same file uploaded twice
 * by one org maps to one object. `sha256` is the hex digest of the file bytes; `ext` is
 * lower-cased and may carry a leading dot.
 */
export function contentKey({ orgId, sha256, ext }: ContentKeyParts): string {
  const hash = sha256.toLowerCase();
  const extension = ext.replace(/^\./, '').toLowerCase();
  if (!SHA256.test(hash)) throw new Error(`Invalid sha256 for a storage key: ${sha256}`);
  if (!EXT.test(extension)) throw new Error(`Invalid extension for a storage key: ${ext}`);
  return `${orgPrefix(orgId)}sha256/${hash}.${extension}`;
}

/** Inverse of {@link contentKey}; `null` for any other key. */
export function parseContentKey(key: string): ContentKeyParts | null {
  const match = CONTENT_KEY.exec(key);
  if (!match) return null;
  const [, orgId, sha256, ext] = match;
  if (orgId === undefined || sha256 === undefined || ext === undefined) return null;
  return { orgId, sha256, ext };
}
