import { resolveTxt } from 'node:dns/promises';
import freeEmailDomains from 'free-email-domains';
import { HttpError } from '../../plugins/errors.ts';

// Email-domain helpers: the public-provider blocklist and the DNS TXT ownership check.

/** Public and disposable email providers (gmail.com, outlook.com, proton.me, …). Pinned package. */
const publicDomains: ReadonlySet<string> = new Set(freeEmailDomains);

/** True for a public provider or one of its subdomains (`mail.gmail.com`). */
export function isPublicEmailDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (publicDomains.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/** The domain part of an email address, lowercase. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** The subset of `node:dns/promises` used here, so tests inject a fake and never hit real DNS. */
export interface TxtResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const systemResolver: TxtResolver = { resolveTxt };

export const verificationRecord = (token: string) => `ondes-verify=${token}`;

/** "No such record" answers; anything else (timeouts, SERVFAIL) is reported as unavailable. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME', 'NXDOMAIN']);

/** Whether `domain` publishes `ondes-verify=<token>` as a TXT record (chunks joined). */
export async function hasVerificationRecord(
  resolver: TxtResolver,
  domain: string,
  token: string,
): Promise<boolean> {
  let records: string[][];
  try {
    records = await resolver.resolveTxt(domain);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && NO_RECORD.has(code)) return false;
    throw new HttpError(503, 'dns_unavailable', `couldn't look up ${domain}, try again later`);
  }
  const expected = verificationRecord(token);
  return records.some((chunks) => chunks.join('').trim() === expected);
}
