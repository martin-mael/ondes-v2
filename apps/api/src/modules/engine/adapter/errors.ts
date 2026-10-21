/**
 * Typed failures of an engine command. Callers branch on the class (or `code`), never on
 * messages: e.g. the feeder treats `EngineUnresolvableError` as "the file is not in the
 * playout cache" and `EngineUnavailableError` as "try again on the next tick".
 */
export type EngineErrorCode =
  | 'timeout'
  | 'unreachable'
  | 'unauthorized'
  | 'bad_request'
  | 'not_queued'
  | 'unresolvable'
  | 'conflict'
  | 'engine_error'
  | 'invalid_response';

type EngineErrorDetails = {
  stationId: string;
  /** `METHOD /path` of the command that failed. */
  route: string;
  /** HTTP status, when the engine answered. */
  status?: number;
  cause?: unknown;
};

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly stationId: string;
  readonly route: string;
  readonly status: number | undefined;

  constructor(code: EngineErrorCode, message: string, details: EngineErrorDetails) {
    super(`${message} (station ${details.stationId}, ${details.route})`, {
      cause: details.cause,
    });
    this.name = new.target.name;
    this.code = code;
    this.stationId = details.stationId;
    this.route = details.route;
    this.status = details.status;
  }
}

/** The engine did not answer in time, or could not be reached at all. Retryable. */
export class EngineUnavailableError extends EngineError {}

/** 401: the bearer token doesn't match `ENGINE_CONTROL_TOKEN`. A deployment bug. */
export class EngineUnauthorizedError extends EngineError {}

/** 400, or a command that failed validation before it was sent. */
export class EngineBadRequestError extends EngineError {}

/** 404 on `DELETE /v1/queue/:id`: nothing queued under that id (already aired or removed). */
export class EngineNotQueuedError extends EngineError {}

/** 422 on a push: a file isn't in the playout cache or can't be decoded. Nothing was queued. */
export class EngineUnresolvableError extends EngineError {}

/** 409: the command doesn't apply to this station's setup (e.g. live input disabled). */
export class EngineConflictError extends EngineError {}

/** Any other non-2xx answer. */
export class EngineServerError extends EngineError {}

/** The engine answered 2xx with a body that doesn't match the contract (or another station). */
export class EngineProtocolError extends EngineError {}
