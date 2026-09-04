import type { QURLErrorData } from "./types.js";

/**
 * Sentinel `.code` values for SDK-internal failure modes (no real HTTP
 * status applies). Exported as constants so consumers branching on
 * `.code` don't have to duplicate string literals — e.g.
 * `if (err.code === ERROR_CODE_CLIENT_VALIDATION) ...`.
 *
 * Server-driven `.code` values (e.g. `"rate_limited"`, `"forbidden"`)
 * come from the API and aren't enumerated here — branch on the typed
 * error subclass (`RateLimitError`, `AuthorizationError`, …) instead.
 */
export const ERROR_CODE_CLIENT_VALIDATION = "client_validation";
export const ERROR_CODE_UNEXPECTED_RESPONSE = "unexpected_response";
export const ERROR_CODE_NETWORK = "network_error";
export const ERROR_CODE_TIMEOUT = "timeout";
export const ERROR_CODE_RUNTIME = "runtime_error";
/** A dispatched Connector resource mutation could have committed and must be reconciled. */
export const ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN = "connector_resource_outcome_unknown";
/** A by-ID Connector resource lookup found a revoked lifecycle row. */
export const ERROR_CODE_CONNECTOR_RESOURCE_REVOKED = "connector_resource_revoked";
/** A Connector slug lookup found no active resource (client-detected, `status: 0`). */
export const ERROR_CODE_RESOURCE_NOT_FOUND = "resource_not_found";
/** A Connector slug lookup matched more than one active resource (client-detected, `status: 0`). */
export const ERROR_CODE_AMBIGUOUS_RESOURCE = "ambiguous_resource";
/** Fallback `.code` when the server returns a non-RFC-7807 response (HTML proxy page, plaintext gateway error, JSON without `error` envelope). */
export const ERROR_CODE_UNKNOWN = "unknown";

/**
 * Base error thrown by the qURL API client. Catch this to handle all SDK errors.
 *
 * **`status: 0` convention:** Client-only validation, runtime, network, and
 * timeout failures use `status: 0` because no HTTP status applies. Logical
 * response-shape guards can also use zero. An `unexpected_response` tied to a
 * concrete HTTP contract violation (redirect, oversized body, wrong
 * no-content status/body) instead preserves the observed status. Branch on
 * `.code` first and then `.status`; see {@link ValidationError}.
 *
 * **`.code === "unknown"`** is a possible value when the server returns a
 * non-RFC-7807 response (e.g. a Cloudflare HTML error page, a gateway
 * timeout with a plaintext body, or a JSON body whose `error` envelope
 * is missing). The HTTP `.status` is still real in those cases — use
 * `.status` for the route, `.code` for the SDK-vs-API discriminant.
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
 * `instanceof ValidationError` catches both on ordinary client/response
 * paths. A Connector mutation wraps a post-dispatch `unexpected_response`
 * in {@link ConnectorResourceOutcomeUnknownError}; inspect that error's
 * typed `cause` before deciding whether to retry. To distinguish them, check
 * `.code` rather than using `instanceof` alone.
 *
 * **`.status` asymmetry within `code: "unexpected_response"`:**
 * - Shape-guard failure on a parsed JSON body (wrong field types,
 *   counts/length mismatch, per-entry contract violation): `.status`
 *   is `0`. The HTTP status that produced the bad body is appended
 *   to `.detail` as `(HTTP 400)` / `(HTTP 207)` etc. for diagnostics.
 * - Non-JSON, oversized, redirect, or exact-status/body-contract failure on a
 *   2xx, passthrough, or other observed HTTP status: `.status` is the actual
 *   HTTP status (e.g. `200`, `302`, `400`, `503`). Browser-filtered opaque
 *   redirects use `.status === 0` because Fetch does not expose their 3xx
 *   status.
 *
 * Consumers branching purely on `.status` should branch on `.code`
 * first, then `.detail` for shape-guard cases. See #59 for tracking
 * a future unification of the two paths.
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

/**
 * A Connector resource ensure/delete was dispatched, but the response cannot
 * prove whether it committed. Reconcile by immutable slug or resource ID
 * before choosing whether to retry. The original typed failure is in `cause`.
 * The wrapper uses `status: 0` so generic HTTP-status retry predicates cannot
 * replay the mutation; inspect `cause.status` for the observed HTTP status.
 * A valid HTTP 201 Connector row missing only `meta.found_existing` is a known
 * committed/selected row with incomplete metadata and is not wrapped here.
 */
export class ConnectorResourceOutcomeUnknownError extends QURLError {
  declare readonly code: typeof ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN;
  declare readonly cause: QURLError;

  constructor(cause: QURLError) {
    super({
      status: 0,
      code: ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN,
      title: "Connector Resource Outcome Unknown",
      detail: `Mutation outcome is unknown; reconcile before retrying. ${cause.detail}`,
      request_id: cause.requestId,
    });
    this.name = "ConnectorResourceOutcomeUnknownError";
    this.cause = cause;
  }
}

/** Transport-level error — DNS failure, connection refused, etc. */
export class NetworkError extends QURLError {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ status: 0, code: ERROR_CODE_NETWORK, title: "Network Error", detail: message });
    this.name = "NetworkError";
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/** Request timed out. */
export class TimeoutError extends QURLError {
  constructor(message: string = "Request timed out", options?: { cause?: unknown }) {
    super({ status: 0, code: ERROR_CODE_TIMEOUT, title: "Timeout", detail: message });
    this.name = "TimeoutError";
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/** SDK runtime capability error — unsupported JS runtime, missing Web Crypto, etc. */
export class RuntimeError extends QURLError {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ status: 0, code: ERROR_CODE_RUNTIME, title: "Runtime Error", detail: message });
    this.name = "RuntimeError";
    if (options && "cause" in options) {
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
  // Route by code first for SDK-internal failure modes that aren't a
  // function of the HTTP status. `unexpected_response` is the canonical
  // case: a 200 body with malformed JSON, a 500 body that isn't an
  // error envelope, and a 400 body that isn't a batch result are all
  // the same SDK failure (server returned a shape we can't interpret).
  // Routing them all to `ValidationError` keeps `instanceof
  // ValidationError` complete for code === "unexpected_response", as
  // documented on the class.
  if (data.code === ERROR_CODE_UNEXPECTED_RESPONSE) {
    return new ValidationError(data);
  }
  if (data.status >= 500) {
    return new ServerError(data);
  }
  const ErrorClass = STATUS_ERROR_MAP[data.status] ?? QURLError;
  return new ErrorClass(data);
}
