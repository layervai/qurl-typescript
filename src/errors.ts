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
/** `connectorResource` found no resource for the connector id (client-detected, `status: 0`). */
export const ERROR_CODE_RESOURCE_NOT_FOUND = "resource_not_found";
/** `connectorResource` matched more than one resource where exactly one is required (client-detected, `status: 0`). */
export const ERROR_CODE_AMBIGUOUS_RESOURCE = "ambiguous_resource";
/** Fallback `.code` when the server returns a non-RFC-7807 response (HTML proxy page, plaintext gateway error, JSON without `error` envelope). */
export const ERROR_CODE_UNKNOWN = "unknown";

/**
 * Base error thrown by the qURL API client. Catch this to handle all SDK errors.
 *
 * **`status: 0` convention:** Client-detected failures — validation errors
 * (`code: "client_validation"`), unexpected response shapes
 * (`code: "unexpected_response"`), runtime capability errors
 * (`code: "runtime_error"`), network errors (`code: "network_error"`), and
 * timeouts (`code: "timeout"`) — all use `status: 0` because no real HTTP
 * status code applies. To distinguish between these cases, branch on `.code`
 * rather than `.status`. Non-zero `.status` always reflects a real HTTP
 * status from the API (e.g. 400, 401, 429, 500).
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
 * `instanceof ValidationError` catches both. To distinguish them, check
 * `.code` rather than using `instanceof` alone.
 *
 * **`.status` asymmetry within `code: "unexpected_response"`:**
 * - Shape-guard failure on a parsed JSON body (wrong field types,
 *   counts/length mismatch, per-entry contract violation): `.status`
 *   is `0`. The HTTP status that produced the bad body is appended
 *   to `.detail` as `(HTTP 400)` / `(HTTP 207)` etc. for diagnostics.
 * - Non-JSON body on a 2xx or passthrough status (e.g. proxy HTML
 *   error page, plaintext gateway error, truncated body): `.status`
 *   is the actual HTTP status (e.g. `400`, `200`).
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

// --- Agent registration errors (registerAgent) ---
//
// The NHP-native `registerAgent` front door mirrors the Go SDK's sentinel +
// typed-error taxonomy (`qurl-go/qurl/register_errors.go`). Go callers match a
// broad outcome with `errors.Is` against a sentinel and pull structured detail
// with `errors.As`; the TS equivalent is a `.code`-discriminated class hierarchy
// under {@link RegistrationError} (itself a {@link QURLError}, so `instanceof
// QURLError` still catches every SDK error). Branch on `instanceof` for the
// class, or on `.code` for the stable discriminant. Every message is written to
// be actionable when read by an operator or an LLM agent driving registration —
// it names the next concrete step, not just the failure.
//
// These use `status: 0` (the SDK-internal convention — no single HTTP status
// applies; a registration failure can originate from an HTTPS pre-flight, an NHP
// relay exchange, or a local-state check).

/** Stable `.code` values for the registration error classes. Branch on these or
 * on `instanceof`; they are the analogue of the Go sentinels. */
export const ERROR_CODE_REGISTER_INVALID_CONFIG = "register_invalid_config";
export const ERROR_CODE_BOOTSTRAP_INVALID_CONFIG = "bootstrap_invalid_config";
export const ERROR_CODE_OTP_PENDING = "otp_pending";
export const ERROR_CODE_OTP_INCORRECT = "otp_incorrect";
export const ERROR_CODE_OTP_EXPIRED = "otp_expired";
export const ERROR_CODE_REGISTRATION_RATE_LIMITED = "registration_rate_limited";
export const ERROR_CODE_REGISTER_KEY_REJECTED = "register_key_rejected";
export const ERROR_CODE_AGENT_IDENTITY_CONFLICT = "agent_identity_conflict";
export const ERROR_CODE_NO_ACCOUNT_EMAIL = "no_account_email";
export const ERROR_CODE_DEVICE_CREDENTIAL_MISSING = "device_credential_missing";
export const ERROR_CODE_REGISTRATION_INVALID_INPUT = "registration_invalid_input";
export const ERROR_CODE_REGISTRATION_DISABLED = "registration_disabled";
export const ERROR_CODE_REGISTRATION_RETRY_LATER = "registration_retry_later";
export const ERROR_CODE_BOOTSTRAP_SETUP_KEY_CONSUMED = "bootstrap_setup_key_consumed";
export const ERROR_CODE_REGISTRATION_DENIED = "registration_denied";
export const ERROR_CODE_INVALID_AGENT_STATE = "invalid_agent_state";

/**
 * Base class for every error `registerAgent` throws. Extends {@link QURLError}
 * (so `instanceof QURLError` and the existing catch-all still work) and adds the
 * registration `.code` discriminant. Catch this to handle any registration
 * failure; branch on the subclass or `.code` for the specific outcome.
 */
export class RegistrationError extends QURLError {
  constructor(code: string, title: string, detail: string, options?: { cause?: unknown }) {
    super({ status: 0, code, title, detail });
    this.name = "RegistrationError";
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/** Inputs or options to `registerAgent` were invalid before any network call
 * (empty key, nil store, conflicting OTP options, bad base URL, corrupt local
 * state). Mirrors Go `ErrInvalidRegisterConfig`. */
export class RegisterConfigError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_REGISTER_INVALID_CONFIG, "Invalid registration config", detail, options);
    this.name = "RegisterConfigError";
  }
}

/** Inputs or options to the deprecated `bootstrapAgent` were invalid, or a
 * bootstrap load-path/config check failed. The bootstrap front-door class,
 * distinct from {@link RegisterConfigError} so each entry point keeps its own
 * class. Mirrors Go `ErrInvalidBootstrapConfig`. */
export class BootstrapConfigError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_BOOTSTRAP_INVALID_CONFIG, "Invalid bootstrap config", detail, options);
    this.name = "BootstrapConfigError";
  }
}

/**
 * Thrown when account-key registration has requested an email one-time code and
 * is waiting for the caller to supply it. This is NOT a hard failure: it is the
 * pause point of the two-phase email-OTP flow. Re-run `registerAgent` with
 * `withOTP(code)` once the code arrives. Mirrors Go `*OTPPendingError`
 * (unwrapping to `ErrOTPPending`); {@link maskedEmail} / {@link requestedAt} are
 * the analogue of the Go struct fields.
 */
export class OTPPendingError extends RegistrationError {
  /** The masked destination the code was sent to, e.g. `"j***@x.com"`. Empty if
   * the service did not report one. */
  readonly maskedEmail: string;
  /** When the one-time code was requested (emailed). */
  readonly requestedAt: Date;

  constructor(args: { maskedEmail?: string; requestedAt: Date }) {
    const dest =
      args.maskedEmail && args.maskedEmail.trim() !== "" ? args.maskedEmail : "your account email";
    super(
      ERROR_CODE_OTP_PENDING,
      "Registration awaiting one-time code",
      `A one-time code was requested for ${dest} — check that inbox and re-run registerAgent with withOTP("<code>") to finish enrollment. Codes expire after a short window; if none arrives, re-running without withOTP re-sends a fresh code after a short cooldown.`,
    );
    this.name = "OTPPendingError";
    this.maskedEmail = args.maskedEmail ?? "";
    this.requestedAt = args.requestedAt;
  }
}

/** A supplied one-time code was rejected as wrong. Re-run with the correct code.
 * Mirrors Go `ErrOTPIncorrect`. */
export class OTPIncorrectError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_OTP_INCORRECT, "One-time code incorrect", detail, options);
    this.name = "OTPIncorrectError";
  }
}

/** A supplied one-time code was valid but has expired. Re-run with no code to
 * request a fresh one, then supply the new code. Mirrors Go `ErrOTPExpired`. */
export class OTPExpiredError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_OTP_EXPIRED, "One-time code expired", detail, options);
    this.name = "OTPExpiredError";
  }
}

/** The enrollment service is rate limiting or has locked out further attempts.
 * Back off and retry later. Mirrors Go `ErrRegistrationRateLimited`. */
export class RegistrationRateLimitedError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_REGISTRATION_RATE_LIMITED, "Registration rate limited", detail, options);
    this.name = "RegistrationRateLimitedError";
  }
}

/** The supplied API key was rejected as invalid. Check the key and re-run.
 * Mirrors Go `ErrKeyRejected`. */
export class RegisterKeyRejectedError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_REGISTER_KEY_REJECTED, "Registration key rejected", detail, options);
    this.name = "RegisterKeyRejectedError";
  }
}

/** The device identity is already enrolled to a different key or agent. Re-run
 * with `withTakeover()` to re-bind it, or choose a different device id with
 * `withDeviceID()`. Mirrors Go `ErrAgentIdentityConflict`. */
export class AgentIdentityConflictError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_AGENT_IDENTITY_CONFLICT, "Agent identity conflict", detail, options);
    this.name = "AgentIdentityConflictError";
  }
}

/** Account-key email-OTP registration cannot proceed because the account has no
 * usable email on file. Add an email, or register with a pre-issued key instead.
 * Mirrors Go `ErrNoAccountEmail`. */
export class NoAccountEmailError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_NO_ACCOUNT_EMAIL, "Account has no email for one-time code", detail, options);
    this.name = "NoAccountEmailError";
  }
}

/** The saved AgentState shows the device is registered but holds no device API
 * credential — the credential is issued once and this state cannot reproduce it.
 * Recovery depends on how it arose (re-register under a new device id / with
 * takeover if the key was already issued; clear or replace the state if it simply
 * lacks the credential). Mirrors Go `ErrDeviceCredentialMissing`. */
export class DeviceCredentialMissingError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      ERROR_CODE_DEVICE_CREDENTIAL_MISSING,
      "Device credential missing from agent state",
      detail,
      options,
    );
    this.name = "DeviceCredentialMissingError";
  }
}

/** The enrollment service rejected a registration input as malformed (e.g. a
 * device id that is not a valid identifier). Fix the input and re-run. Mirrors
 * Go `ErrRegistrationInvalidInput`. */
export class RegistrationInvalidInputError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_REGISTRATION_INVALID_INPUT, "Registration input invalid", detail, options);
    this.name = "RegistrationInvalidInputError";
  }
}

/** Agent registration is disabled for the account. Contact the account owner to
 * enable it. Mirrors Go `ErrRegistrationDisabled`. */
export class RegistrationDisabledError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(ERROR_CODE_REGISTRATION_DISABLED, "Agent registration disabled", detail, options);
    this.name = "RegistrationDisabledError";
  }
}

/** The registration relay answered with an overload cookie-challenge (NHP_COK)
 * instead of a registration reply: the enrollment path is under load. Back off
 * briefly and re-run. Mirrors Go `ErrRegistrationRetryLater`. */
export class RegistrationRetryLaterError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      ERROR_CODE_REGISTRATION_RETRY_LATER,
      "Registration relay busy; retry shortly",
      detail,
      options,
    );
    this.name = "RegistrationRetryLaterError";
  }
}

/** An incomplete bootstrap retry was rejected because the one-time setup key
 * appears to have already been used. Run the LayerV setup flow again or restore
 * the completed AgentState. Mirrors Go `ErrBootstrapSetupKeyConsumed`. */
export class BootstrapSetupKeyConsumedError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      ERROR_CODE_BOOTSTRAP_SETUP_KEY_CONSUMED,
      "Bootstrap setup key already consumed",
      detail,
      options,
    );
    this.name = "BootstrapSetupKeyConsumedError";
  }
}

/** Persisted agent state exists but cannot be read back — a corrupt or
 * undecodable blob, distinct from "not yet persisted" (which a store models as a
 * null load). Mirrors Go `ErrInvalidAgentState`. */
export class InvalidAgentStateError extends RegistrationError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      ERROR_CODE_INVALID_AGENT_STATE,
      "Agent state is present but unreadable or corrupt",
      detail,
      options,
    );
    this.name = "InvalidAgentStateError";
  }
}

/**
 * An authenticated enrollment denial the SDK could not map to a known typed
 * error: the NHP registration reply (NHP_RAK) carried an error code this SDK
 * version does not recognize. {@link errCode} and {@link errMsg} are the raw wire
 * fields, surfaced verbatim so an operator can act on a code newer than the SDK.
 * Known codes are mapped to the typed errors above instead. Mirrors Go
 * `*RegistrationDenyError`.
 */
export class RegistrationDenyError extends RegistrationError {
  /** The NHP_RAK error code string (`"0"`/`""` are success and never produce
   * this error). */
  readonly errCode: string;
  /** The human-readable message from the enrollment service, if any. */
  readonly errMsg: string;

  constructor(errCode: string, errMsg: string) {
    const detail =
      errMsg.trim() !== ""
        ? `Registration denied (errCode=${JSON.stringify(errCode)}): ${errMsg}`
        : `Registration denied (errCode=${JSON.stringify(errCode)})`;
    super(ERROR_CODE_REGISTRATION_DENIED, "Registration denied", detail);
    this.name = "RegistrationDenyError";
    this.errCode = errCode;
    this.errMsg = errMsg;
  }
}
