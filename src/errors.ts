import type { QURLErrorData } from "./types.js";

/** Base error thrown by the qURL API client. Catch this to handle all SDK errors. */
export class QURLError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly invalidFields?: Record<string, string>;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(data: QURLErrorData) {
    super(`${data.title} (${data.status}): ${data.detail}`);
    this.name = "QURLError";
    this.status = data.status;
    this.code = data.code;
    this.detail = data.detail;
    this.invalidFields = data.invalid_fields;
    this.requestId = data.request_id;
    this.retryAfter = data.retry_after;
  }
}

/** 401 Unauthorized — invalid or missing API key. */
export class AuthenticationError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "AuthenticationError";
  }
}

/** 403 Forbidden — valid key but insufficient permissions/scope. */
export class AuthorizationError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "AuthorizationError";
  }
}

/** 404 Not Found — resource does not exist. */
export class NotFoundError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "NotFoundError";
  }
}

/** 400/422 — invalid request parameters. Check `invalidFields` for per-field details. */
export class ValidationError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "ValidationError";
  }
}

/** 429 Too Many Requests. Check `retryAfter` for the server-suggested wait time. */
export class RateLimitError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "RateLimitError";
  }
}

/** 5xx server-side error. */
export class ServerError extends QURLError {
  constructor(data: QURLErrorData) {
    super(data);
    this.name = "ServerError";
  }
}

/** Transport-level error — DNS failure, connection refused, etc. */
export class NetworkError extends QURLError {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ status: 0, code: "network_error", title: "Network Error", detail: message });
    this.name = "NetworkError";
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/** Request timed out. */
export class TimeoutError extends QURLError {
  constructor(message: string = "Request timed out", options?: { cause?: unknown }) {
    super({ status: 0, code: "timeout", title: "Timeout", detail: message });
    this.name = "TimeoutError";
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

const STATUS_ERROR_MAP: Record<number, new (data: QURLErrorData) => QURLError> = {
  400: ValidationError,
  401: AuthenticationError,
  403: AuthorizationError,
  404: NotFoundError,
  422: ValidationError,
  429: RateLimitError,
};

/** Create the appropriate QURLError subclass for an HTTP status code. */
export function createError(data: QURLErrorData): QURLError {
  if (data.status >= 500) {
    return new ServerError(data);
  }
  const ErrorClass = STATUS_ERROR_MAP[data.status] ?? QURLError;
  return new ErrorClass(data);
}
