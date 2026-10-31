// Match qurl-go c4f2f98's exact API response cap. Current qurl-service list
// routes cap pages at 100 items. A caller can still exceed this cap with a
// large, heavily escaped webhook-delivery page, so list callers must request a
// smaller page if the service reports the body-limit error. This cap is fixed:
// do not add an override or widen one SDK independently from the other.
// The limit is enforced from Content-Length when usable and again while
// consuming the response stream.
export const MAX_RESPONSE_BODY_BYTES = 1 << 20;

export const MAX_ERROR_SNIPPET_BYTES = 512;

// UTF-8 uses at least one byte per UTF-16 code unit. Reading more source units
// cannot add a byte that fits in a 512-byte retained diagnostic.
export const MAX_ERROR_SNIPPET_SOURCE_CODE_UNITS = MAX_ERROR_SNIPPET_BYTES;

export const MAX_INVALID_FIELD_ENTRIES = 100;

export const MAX_DEBUG_BODY_KEYS = 100;

// Bound each retained diagnostic collection as well as each string. Without
// this aggregate cap, 100 valid 512-byte keys and values could turn a small
// server error into a large caller-visible object. This is a diagnostic budget,
// not part of the API wire contract.
export const MAX_DIAGNOSTIC_COLLECTION_BYTES = 8 << 10;

export const RETRY_BASE_DELAY_MS = 500;

// Bounds local exponential backoff (NOT server-asserted Retry-After —
// see `RETRY_AFTER_HARD_CAP_MS` for that).
export const RETRY_MAX_DELAY_MS = 30_000;

// Hard cap on server-asserted Retry-After. Guards against `Retry-After`
// values >2^31-1 ms overflowing Node's setTimeout (silently truncated to
// 1ms — turns a "wait a month" directive into a hot retry loop).
export const RETRY_AFTER_HARD_CAP_MS = 60 * 60 * 1000;

export const RETRY_AFTER_PARSE_LIMIT_S = RETRY_AFTER_HARD_CAP_MS / 1000;

export const MAX_IDEMPOTENCY_KEY = 256;

// ---- Spec-derived validation helpers ------------------------------------
// These mirror constraints documented on each request schema in
// `openapi.yaml` so obvious mistakes fail fast instead of round-tripping
// to the API and coming back as a generic 400.
// CI checks every MAX_* constant against contract/validation-bounds.json; the
// weekly published-spec check detects upstream changes. Local safety budgets
// are classified separately and must not be raised to bypass a service cap.

export const MAX_TARGET_URL = 2048;

export const MAX_LABEL = 500;

export const MAX_BATCH_ITEMS = 100;

export const MAX_DESCRIPTION = 500;

export const MAX_CUSTOM_DOMAIN = 253;

export const MAX_MAX_SESSIONS = 1000;

export const MAX_API_KEY_NAME = 100;

export const MAX_ENROLLMENT_TOKEN_TTL_SECONDS = 86400n;

export const MAX_ALIAS = 64;

export const MAX_SLUG = 64;

export const MAX_TARGET_PATH = 2048;

export const MAX_TAGS = 10;

export const MAX_TAG_LENGTH = 50;

export const MAX_AUTO_PAGINATION_PAGES = 10_000;

export const MAX_DELEGATED_MINT_CAPABILITY = 8192;

export const MAX_DELEGATED_ETAG = 96;

export const MAX_DELEGATED_BATCH_ITEMS = 100;

export const MAX_PATH_ID_DECODE_PASSES = 3;

export const MAX_PATH_ID_LENGTH = 4096;
