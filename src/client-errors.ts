import {
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ValidationError,
} from "./errors.js";
import type { TombstoneInfo } from "./types.js";
import {
  MAX_DEBUG_BODY_KEYS,
  MAX_DIAGNOSTIC_COLLECTION_BYTES,
  MAX_ERROR_SNIPPET_BYTES,
  MAX_ERROR_SNIPPET_SOURCE_CODE_UNITS,
  MAX_INVALID_FIELD_ENTRIES,
} from "./client-limits.js";

export const TEXT_ENCODER = new TextEncoder();

const ERROR_SNIPPET_ELLIPSIS = "...";

const ERROR_SNIPPET_ELLIPSIS_BYTES = 3;

// RFC 8259 JSON exchanged between systems must be valid UTF-8. A non-fatal
// decoder would replace malformed bytes with U+FFFD before JSON.parse and hide
// the producer's exact contract violation.
export const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Construct a {@link ValidationError} for a client-side pre-flight check.
 * Uses `status: 0` (matching {@link NetworkError}/{@link TimeoutError}) and
 * `code: "client_validation"` so catch-by-class still works and callers can
 * tell the error originated inside the SDK rather than from the API.
 */
export function clientValidationError(detail: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: ERROR_CODE_CLIENT_VALIDATION,
    title: "Invalid Argument",
    detail,
  });
}

/**
 * Construct a {@link ValidationError} for the case where the API returned
 * a response that parsed as JSON but didn't match the expected schema
 * shape (e.g. 400 with a body that isn't a {@link BatchCreateOutput}).
 *
 * Distinct from {@link clientValidationError} so callers can `.code`-branch
 * between "I passed bad input locally" (`"client_validation"`) and "the
 * server returned a body I can't interpret" (`"unexpected_response"`).
 * Uses `status: 0` by default because a logical shape mismatch is not tied to
 * the HTTP classification. Callers that enforce an observed HTTP contract
 * pass that status explicitly.
 *
 * Threads `request_id` through to {@link QURLError.requestId} when the
 * server-side correlation ID is available — operators debugging
 * "unexpected response" tickets need it on the *error* path too, not
 * just on success/passthrough returns.
 */
export function unexpectedResponseError(
  detail: string,
  options: { status?: number; requestId?: string } = {},
): ValidationError {
  // Every detail passed here is an SDK-authored contract message whose dynamic
  // inputs were validated by the caller-side shape guards. Do not pass raw
  // server strings to this helper. Server diagnostics use boundedErrorSnippet.
  const safeRequestId = boundedErrorIdentifier(options.requestId);
  return new ValidationError({
    status: options.status ?? 0,
    code: ERROR_CODE_UNEXPECTED_RESPONSE,
    title: "Unexpected Response",
    detail,
    request_id: safeRequestId,
  });
}

export function withErrorCause<T extends Error>(error: T, cause: unknown): T {
  // Match the native Error `cause` descriptor. In particular, do not leak a
  // transport object through Object.keys(), object spread, or JSON logging.
  Object.defineProperty(error, "cause", {
    value: cause,
    writable: true,
    configurable: true,
  });
  return error;
}

export function isIndependentAbort(error: unknown, requestSignal: AbortSignal): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError") &&
    !requestSignal.aborted
  );
}

export function isSdkTimeout(error: unknown, requestSignal: AbortSignal): boolean {
  return (
    error instanceof Error &&
    requestSignal.aborted &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Normalize a server-provided problem title/detail into a single-line,
 * UTF-8-safe snippet. Error messages must stay bounded even when a proxy or
 * compromised upstream returns very large structured problem fields.
 */
function normalizedErrorSnippet(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bound source work before the Unicode regular expressions allocate
  // normalized copies. The response body cap is much larger than one retained
  // diagnostic, so processing the full server string would waste memory.
  const normalized = value
    .slice(0, MAX_ERROR_SNIPPET_SOURCE_CODE_UNITS)
    // Strip control characters plus bidi override/isolate controls that can
    // visually reorder diagnostics. Preserve other formatting characters
    // such as ZWJ/ZWNJ, which are required by legitimate scripts and emoji.
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

export function boundedErrorSnippet(value: unknown): string | undefined {
  const sourceTruncated =
    typeof value === "string" && value.length > MAX_ERROR_SNIPPET_SOURCE_CODE_UNITS;
  const normalized = normalizedErrorSnippet(value);
  if (normalized === undefined) return undefined;
  const contentLimit = sourceTruncated
    ? MAX_ERROR_SNIPPET_BYTES - ERROR_SNIPPET_ELLIPSIS_BYTES
    : MAX_ERROR_SNIPPET_BYTES;
  // UTF-8 uses at most three bytes per UTF-16 code unit. Most diagnostics are
  // short ASCII, so avoid an allocation only to prove they fit.
  if (normalized.length * 3 <= contentLimit) {
    return sourceTruncated ? `${normalized}${ERROR_SNIPPET_ELLIPSIS}` : normalized;
  }
  const encoded = TEXT_ENCODER.encode(normalized);
  if (encoded.byteLength <= contentLimit) {
    return sourceTruncated ? `${normalized}${ERROR_SNIPPET_ELLIPSIS}` : normalized;
  }

  let end = MAX_ERROR_SNIPPET_BYTES - ERROR_SNIPPET_ELLIPSIS_BYTES;
  // Do not split a multi-byte UTF-8 sequence at the cap.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return `${TEXT_DECODER.decode(encoded.subarray(0, end))}${ERROR_SNIPPET_ELLIPSIS}`;
}

/** Keep server identifiers useful as exact machine-readable discriminants. */
export function boundedErrorIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ERROR_SNIPPET_SOURCE_CODE_UNITS) {
    return undefined;
  }
  const normalized = normalizedErrorSnippet(value);
  if (
    normalized === undefined ||
    normalized !== value ||
    TEXT_ENCODER.encode(value).byteLength > MAX_ERROR_SNIPPET_BYTES
  ) {
    return undefined;
  }
  return value;
}

/** Keep only the documented retained metadata, with bounded wire values. */
export function boundedTombstone(value: unknown): TombstoneInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const timestamp = boundedErrorIdentifier(raw.tombstoned_at);
  if (
    timestamp === undefined ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    return undefined;
  const out: TombstoneInfo = { tombstoned_at: timestamp };
  const count = raw.final_access_count;
  // The API omits zero: absence means no snapshot or a redacted count.
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 1) {
    out.final_access_count = count;
  }
  return out;
}

/** Collect at most the first N enumerable own string keys without a full key-array copy. */
function firstEnumerableOwnKeys(value: object, limit: number): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    keys.push(key);
    if (keys.length === limit) break;
  }
  return keys;
}

/** Bound the structured per-field diagnostics exposed on ValidationError. */
export function boundedInvalidFields(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const entries: [string, string][] = [];
  const retainedKeys = new Set<string>();
  let retainedBytes = 0;
  // Bound inspected entries as well as retained entries. A hostile envelope
  // whose values all have the wrong type must not make diagnostics scan every
  // key in the response body.
  for (const rawKey of firstEnumerableOwnKeys(value, MAX_INVALID_FIELD_ENTRIES)) {
    const rawValue = (value as Record<string, unknown>)[rawKey];
    const key = boundedErrorSnippet(rawKey);
    const fieldDetail = boundedErrorSnippet(rawValue);
    if (key !== undefined && fieldDetail !== undefined && !retainedKeys.has(key)) {
      const entryBytes =
        TEXT_ENCODER.encode(key).byteLength + TEXT_ENCODER.encode(fieldDetail).byteLength;
      // A later, smaller entry can still fit even when this one cannot.
      if (retainedBytes + entryBytes > MAX_DIAGNOSTIC_COLLECTION_BYTES) continue;
      retainedKeys.add(key);
      entries.push([key, fieldDetail]);
      retainedBytes += entryBytes;
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Bound server-controlled object keys before forwarding them to a debug sink. */
export function boundedObjectKeys(value: object): string[] {
  // Stop before normalization so a hostile envelope cannot force work over
  // every enumerable own key. Some early keys may normalize away; bounded
  // diagnostics are more important here than filling every available slot.
  const retained: string[] = [];
  let retainedBytes = 0;
  for (const rawKey of firstEnumerableOwnKeys(value, MAX_DEBUG_BODY_KEYS)) {
    const key = boundedErrorSnippet(rawKey);
    if (key === undefined) continue;
    const keyBytes = TEXT_ENCODER.encode(key).byteLength;
    // A later, smaller key can still fit even when this one cannot.
    if (retainedBytes + keyBytes > MAX_DIAGNOSTIC_COLLECTION_BYTES) continue;
    retained.push(key);
    retainedBytes += keyBytes;
  }
  return retained;
}
