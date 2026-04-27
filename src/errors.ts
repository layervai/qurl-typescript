import type { QURLErrorData } from "./types.js";

/**
 * Base error thrown by the qURL API client. Catch this to handle all SDK errors.
 *
 * **`status: 0` convention:** Client-detected failures — validation errors
 * (`code: "client_validation"`), unexpected response shapes
 * (`code: "unexpected_response"`), network errors (`code: "network_error"`),
 * and timeouts (`code: "timeout"`) — all use `status: 0` because no real
 * HTTP status code applies. To distinguish between these cases, branch on
 * `.code` rather than `.status`. Non-zero `.status` always reflects a real
 * HTTP status from the API (e.g. 400, 401, 429, 500).
 */
export class QURLError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Human-readable error detail. **Always non-empty** — when the API
   * omits `detail` (RFC 7807 allows this), the constructor falls back
   * to `title`. Callers never need to null-check this property, even
   * though `QURLErrorData.detail` is optional on the wire type.
   */
  readonly detail: string;
  /** RFC 7807 problem-type URI, if the API includes one. */
  readonly type?: string;
  /** RFC 7807 occurrence URI, if the API includes one. */
  readonly instance?: string;
  readonly invalidFields?: Record<string, string>;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(data: QURLErrorData) {
    // RFC 7807 leaves `detail` optional; the API can legitimately omit it and
    // `title` is required, so falling back to title keeps the Error.message
    // meaningful instead of "Title (400): undefined".
    const detail = data.detail ?? data.title;
    super(`${data.title} (${data.status}): ${detail}`);
    this.name = "QURLError";
    this.status = data.status;
    this.code = data.code;
    this.detail = detail;
    this.type = data.type;
    this.instance = data.instance;
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

/**
 * 400/422 — invalid request parameters. Check `invalidFields` for per-field details.
 *
 * **Note:** This class covers two distinct failure modes:
 * - `code: "client_validation"` — client-side preflight failures (bad
 *   input caught before a round-trip).
 * - `code: "unexpected_response"` — the server returned a response body
 *   whose shape doesn't match the expected contract (e.g. a proxy
 *   returning HTML on a passthrough status, or a batch response missing
 *   required fields).
 *
 * `instanceof ValidationError` catches both. To distinguish them, check
 * `.code` rather than using `instanceof` alone.
 */
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
