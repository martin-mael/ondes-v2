import { NotFoundError } from '@ondes/db';
import type { ErrorResponse } from '@ondes/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

/**
 * An error with an HTTP status and a stable machine code. Throw it from services and routes;
 * the error handler turns it into `{ error, message }`.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

/** Maps errors to the `ErrorResponse` contract. 5xx details are logged, never sent. */
export const errorsPlugin = fp(
  async (app: FastifyInstance) => {
    app.setNotFoundHandler((request, reply) => {
      reply
        .code(404)
        .send({ error: 'not_found', message: `${request.method} ${request.url} not found` });
    });

    app.setErrorHandler((error: FastifyError, request, reply) => {
      const send = (status: number, body: ErrorResponse) => reply.code(status).send(body);

      if (error instanceof HttpError) {
        return send(error.statusCode, {
          error: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      if (error instanceof NotFoundError) {
        return send(404, { error: 'not_found', message: error.message });
      }
      if (hasZodFastifySchemaValidationErrors(error)) {
        return send(400, {
          error: 'validation_failed',
          message: error.message,
          details: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        });
      }
      if (error instanceof ZodError) {
        return send(400, {
          error: 'validation_failed',
          message: 'invalid input',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      if (isResponseSerializationError(error)) {
        request.log.error({ err: error, issues: error.cause.issues }, 'response failed its schema');
        return send(500, { error: 'internal', message: 'internal server error' });
      }
      const status = error.statusCode ?? 500;
      if (status >= 500) {
        request.log.error({ err: error }, 'unhandled error');
        return send(500, { error: 'internal', message: 'internal server error' });
      }
      // Fastify's own 4xx (bad JSON, unsupported media type, payload too large, 429…).
      return send(status, {
        error: CLIENT_ERROR_CODES[status] ?? 'bad_request',
        message: error.message,
      });
    });
  },
  { name: 'errors' },
);
