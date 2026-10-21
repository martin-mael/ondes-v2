import { errorResponseSchema } from '@ondes/shared';
import type { z } from 'zod';

// The api client: same-origin `fetch` (session cookie; Vite proxies /api in dev), JSON bodies,
// responses validated with the zod contracts from @ondes/shared, and one error type.

/** A non-2xx answer from the api, or a network failure (`status` 0, code `network`). */
export class ApiError extends Error {
  readonly status: number;
  /** Stable machine code from the api (`invalid_credentials`, `two_factor_required`, …). */
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isApiError = (error: unknown, code?: string): error is ApiError =>
  error instanceof ApiError && (code === undefined || error.code === code);

/**
 * Most contracts type timestamps as `Date`, JSON carries ISO strings. Timestamp fields are
 * named `…At` (`createdAt`, `expiresAt`), so those are revived before validation. Some contracts
 * keep ISO strings instead (the log's `startsAt`/`anchorAt`, the as-run's `startedAt`): a body
 * that doesn't validate revived is validated as sent. One body can't mix the two styles.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function reviveDates(key: string, value: unknown): unknown {
  return key.endsWith('At') && typeof value === 'string' && ISO_DATETIME.test(value)
    ? new Date(value)
    : value;
}

export interface RequestOptions<S extends z.ZodType | undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Validates the response body. Omit for empty answers (204). */
  schema?: S;
  signal?: AbortSignal;
}

export const API_BASE = '/api/v1';

export async function request<S extends z.ZodType | undefined = undefined>(
  path: string,
  options: RequestOptions<S> = {},
): Promise<S extends z.ZodType ? z.output<S> : undefined> {
  const { method = options.body === undefined ? 'GET' : 'POST', body, schema, signal } = options;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network', error instanceof Error ? error.message : 'network error');
  }

  const text = await res.text();
  const json: unknown = text ? safeParseJson(text) : undefined;
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.error, parsed.data.message, parsed.data.details);
    }
    throw new ApiError(res.status, 'http_error', `${res.status} ${res.statusText}`);
  }
  if (!schema) return undefined as never;
  let parsed = schema.safeParse(json);
  if (!parsed.success) {
    const raw = text ? safeParseJson(text, false) : undefined;
    const asSent = schema.safeParse(raw);
    if (asSent.success) parsed = asSent;
  }
  if (!parsed.success) {
    throw new ApiError(res.status, 'invalid_response', `unexpected response from ${path}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data as never;
}

function safeParseJson(text: string, revive = true): unknown {
  try {
    return revive ? JSON.parse(text, reviveDates) : JSON.parse(text);
  } catch {
    return undefined;
  }
}
