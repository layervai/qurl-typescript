import { createError, NetworkError, QURLError, TimeoutError, ValidationError } from "./errors.js";
import type {
  AccessToken,
  BatchCreateInput,
  BatchCreateOutput,
  ClientOptions,
  CreateInput,
  CreateOutput,
  ExtendInput,
  ListInput,
  ListOutput,
  MintInput,
  MintOutput,
  QURL,
  QURLErrorData,
  Quota,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.layerv.ai";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 30_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_STATUS_MUTATING = new Set([429]);

// Shared empty default for the `passthroughStatuses` parameter on rawRequest,
// so each call that doesn't pass statuses doesn't allocate a fresh `[]`.
const NO_PASSTHROUGH_STATUSES: readonly number[] = [];

// Shared passthrough list for `batchCreate`. HTTP 400 on this endpoint
// carries a populated `BatchCreateOutput` body when every item failed
// validation — whitelist it so the generic error path doesn't swallow
// the per-item errors. Hoisted out of the call site for consistency
// with `NO_PASSTHROUGH_STATUSES` and to avoid per-call allocation.
const BATCH_PASSTHROUGH_STATUSES: readonly number[] = [400];

/** Allowlist of known query-param keys for the `list()` endpoint. */
const LIST_PARAM_KEYS = [
  "limit",
  "cursor",
  "status",
  "q",
  "sort",
  "created_after",
  "created_before",
  "expires_before",
  "expires_after",
] as const satisfies readonly (keyof ListInput)[];

// Compile-time completeness check: fails if a new key is added to ListInput
// but not to LIST_PARAM_KEYS. `satisfies` alone only validates that entries
// are valid keys, not that every key is listed — this plugs that gap.
type _ListParamKeysComplete =
  Exclude<keyof ListInput, (typeof LIST_PARAM_KEYS)[number]> extends never ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _listParamKeysComplete: _ListParamKeysComplete = true;

/**
 * Fields accepted by `update()`. The empty-input pre-flight check in
 * {@link QURLClient.update} iterates this const — so adding a new field to
 * {@link UpdateInput} without listing it here will fail the
 * `_UpdateFieldKeysComplete` check at compile time rather than silently
 * sneaking through an empty-input request.
 */
const UPDATE_FIELD_KEYS = [
  "extend_by",
  "expires_at",
  "description",
  "tags",
] as const satisfies readonly (keyof UpdateInput)[];

type _UpdateFieldKeysComplete =
  Exclude<keyof UpdateInput, (typeof UPDATE_FIELD_KEYS)[number]> extends never ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _updateFieldKeysComplete: _UpdateFieldKeysComplete = true;

/**
 * Construct a {@link ValidationError} for a client-side pre-flight check.
 * Uses `status: 0` (matching {@link NetworkError}/{@link TimeoutError}) and
 * `code: "client_validation"` so catch-by-class still works and callers can
 * tell the error originated inside the SDK rather than from the API.
 */
function clientValidationError(detail: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: "client_validation",
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
 * Uses `status: 0` because the offending HTTP status (400/207/etc.) isn't
 * the thing being reported — the shape mismatch is.
 */
function unexpectedResponseError(detail: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: "unexpected_response",
    title: "Unexpected Response",
    detail,
  });
}

// ---- Spec-derived validation helpers ------------------------------------
// These mirror constraints documented on each request schema in
// `openapi.yaml` so obvious mistakes fail fast instead of round-tripping
// to the API and coming back as a generic 400.

const MAX_TARGET_URL = 2048;
const MAX_LABEL = 500;
const MAX_DESCRIPTION = 500;
const MAX_CUSTOM_DOMAIN = 253;
const MAX_MAX_SESSIONS = 1000;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 50;
// CreateQurlRequest.target_url pattern is loose (just a URI) but
// UpdateQurlRequest.tags pattern is specific — enforce it here.
const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;
const RESOURCE_ID_PREFIX = "r_";

function requireMaxLength(value: string | undefined, field: string, max: number): void {
  if (value !== undefined && value.length > max) {
    throw clientValidationError(
      `${field}: must be ${max} characters or fewer (got ${value.length})`,
    );
  }
}

function requireMaxSessionsInRange(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_MAX_SESSIONS) {
    throw clientValidationError(
      `max_sessions: must be an integer between 0 and ${MAX_MAX_SESSIONS} (got ${value})`,
    );
  }
}

function requireValidTags(tags: string[] | null | undefined): void {
  // `null` is included in the signature (not just the runtime guard)
  // so the type itself documents the untyped-JS tolerance: `null` is
  // treated the same as `undefined` ("don't touch tags"), matching
  // the list() filter's null-handling. Anything else that isn't an
  // array (a plain object, number, string passed where an array was
  // expected) is a clear caller mistake and surfaces as a clean
  // ValidationError rather than falling through to a less helpful
  // runtime TypeError on `.length`. TypeScript callers hit the
  // compile-time type check; the runtime Array.isArray path catches
  // consumers calling from plain JS.
  if (tags === undefined || tags === null) return;
  if (!Array.isArray(tags)) {
    throw clientValidationError(`tags: must be an array of strings (got ${typeof tags})`);
  }
  if (tags.length > MAX_TAGS) {
    throw clientValidationError(`tags: max ${MAX_TAGS} items allowed (got ${tags.length})`);
  }
  // Collect ALL invalid tags in a single pass instead of failing fast
  // on the first one. Matches the collect-all pattern used by
  // `batchCreate` for per-item validation — callers fixing multiple
  // bad tags shouldn't have to fix-re-run-repeat. Tag arrays are
  // small (MAX_TAGS = 10) so the cost is negligible.
  const errors: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    // Per-element type guard for untyped-JS callers. Without this, a
    // non-string element would silently pass (`.length` on a number is
    // `undefined`; `TAG_PATTERN.test(42)` coerces to `"42"`) or TypeError
    // (`null.length`). Matches the `isinstance(tag, str)` check in
    // qurl-python's `_require_valid_tags`.
    if (typeof tag !== "string") {
      errors.push(`tags[${i}]: must be a string (got ${tag === null ? "null" : typeof tag})`);
      continue;
    }
    if (tag.length < 1 || tag.length > MAX_TAG_LENGTH) {
      errors.push(`tags[${i}]: must be 1-${MAX_TAG_LENGTH} characters (got ${tag.length})`);
      continue;
    }
    if (!TAG_PATTERN.test(tag)) {
      errors.push(
        `tags[${i}]: must start with an alphanumeric and contain only letters, numbers, spaces, underscores, or hyphens`,
      );
    }
  }
  if (errors.length > 0) {
    throw clientValidationError(errors.join("; "));
  }
}

// `format: uri` in the OpenAPI spec allows schemes the SDK doesn't
// usefully support (`ftp://`, `file://`, `javascript:`, …). This is a
// cheap client-side sanity check — the server is still the
// authoritative validator (e.g. it rejects localhost, cloud metadata,
// and private-range hosts; the SDK doesn't need to duplicate that).
// Matches the qurl-python SDK's `_ALLOWED_URL_SCHEMES` check.
const ALLOWED_URL_SCHEMES = ["http://", "https://"] as const;

function requireValidTargetUrl(target_url: unknown): void {
  if (
    typeof target_url !== "string" ||
    !ALLOWED_URL_SCHEMES.some((scheme) => target_url.startsWith(scheme))
  ) {
    // `JSON.stringify(...).slice(0, 40)` instead of the raw value —
    // works on any input type (string, number, null, object) without
    // risking a TypeError on non-subscriptable inputs, and truncates
    // to keep the error message compact.
    //
    // The `?.slice(...) ?? String(...).slice(...)` chain is load-bearing,
    // not dead code: `JSON.stringify(undefined)` returns the JS value
    // `undefined` itself (not the string `"undefined"`), so the optional
    // chain shortcircuits and the `??` fallback is hit. Without the
    // fallback, calling `.slice` on `undefined` at runtime would throw
    // `TypeError: Cannot read properties of undefined (reading 'slice')`
    // and mask the real validation failure. The
    // `test("create URL scheme error is safe for non-string inputs")`
    // test passes `undefined` explicitly to lock this path in.
    const repr = JSON.stringify(target_url)?.slice(0, 40) ?? String(target_url).slice(0, 40);
    throw clientValidationError(`target_url: must start with http:// or https:// (got ${repr})`);
  }
}

function validateCreateInput(input: CreateInput): void {
  requireValidTargetUrl(input.target_url);
  requireMaxLength(input.target_url, "target_url", MAX_TARGET_URL);
  requireMaxLength(input.label, "label", MAX_LABEL);
  requireMaxLength(input.custom_domain, "custom_domain", MAX_CUSTOM_DOMAIN);
  requireMaxSessionsInRange(input.max_sessions);
  // Intentional omission: `expires_in` and `session_duration` are
  // duration strings ("5m", "24h", "7d", "1w"). The spec documents
  // plan-dependent min/max bounds and a specific unit grammar, but
  // duplicating that grammar as a client-side regex risks drift from
  // the server's authoritative parser — especially for edge cases
  // like compound units or whitespace tolerance. A typo ("24hh")
  // surfaces quickly via 400 with a clear server error; catching it
  // client-side would require re-implementing the server's rego/duration
  // parser. Keep the client's validation surface small and
  // spec-traceable.
}

/**
 * Per-entry shape guard for {@link BatchItemResult}. Verifies every
 * non-optional field on the branch of the discriminated union selected
 * by the `success` discriminant. Protects consumers who narrow on
 * `success` and then access `resource_id` / `qurl_link` / `error` as
 * guaranteed-present — if the API ever omits one, we trip the guard
 * rather than returning `undefined` where the type says `string`.
 *
 * Returns `null` when the entry is valid, or a human-readable reason
 * string describing the *specific* field that's missing or wrong. The
 * reason never echoes the entry's values — only field names and shape
 * descriptors — so the caller can safely surface it in error messages
 * that may end up in observability pipelines. Contrast with the outer
 * guard's intentional silence about response-body content for the
 * same info-leak reason.
 */
function batchItemResultValidationReason(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "not an object";
  const e = entry as Record<string, unknown>;
  if (typeof e.index !== "number") return "missing/invalid 'index' (expected number)";
  if (e.success === true) {
    if (typeof e.resource_id !== "string") {
      return "success-branch missing required field 'resource_id' (expected string)";
    }
    if (typeof e.qurl_link !== "string") {
      return "success-branch missing required field 'qurl_link' (expected string)";
    }
    if (typeof e.qurl_site !== "string") {
      return "success-branch missing required field 'qurl_site' (expected string)";
    }
    return null;
  }
  if (e.success === false) {
    if (!e.error || typeof e.error !== "object") {
      return "failure-branch missing required field 'error' (expected object)";
    }
    const err = e.error as Record<string, unknown>;
    if (typeof err.code !== "string") {
      return "failure-branch missing required field 'error.code' (expected string)";
    }
    if (typeof err.message !== "string") {
      return "failure-branch missing required field 'error.message' (expected string)";
    }
    return null;
  }
  return "missing/invalid 'success' discriminant (expected boolean)";
}

interface ApiResponse<T> {
  data: T;
  meta?: {
    request_id?: string;
    page_size?: number;
    has_more?: boolean;
    next_cursor?: string;
  };
  /**
   * SDK-injected HTTP status code of the underlying response. This
   * field is NOT part of the API's JSON envelope — it's populated
   * by `rawRequest` after the fetch so callers can branch on the
   * observed status without re-querying the `Response` object.
   * Currently used by `batchCreate`'s shape-guard error to surface
   * whether an unexpected body came back on a success-range status
   * (e.g. 201, 207) or a passthrough status (e.g. 400).
   */
  http_status?: number;
}

interface ApiErrorEnvelope {
  error?: {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    code?: string;
    instance?: string;
    invalid_fields?: Record<string, string>;
    /**
     * Legacy field from pre-RFC-7807 error shapes. Supported for backward
     * compatibility when the API has been configured to return the older
     * `{ error: { code, message } }` envelope.
     */
    message?: string;
  };
  meta?: { request_id?: string };
}

/** QURL API client. */
export class QURLClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly userAgent: string;
  private readonly debugFn: ((message: string, data?: Record<string, unknown>) => void) | undefined;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    // Clamp `maxRetries` to a non-negative integer. A negative value
    // would cause the retry loop `for (let attempt = 0; attempt <=
    // this.maxRetries; attempt++)` to skip entirely — meaning ZERO
    // attempts, not even the initial request. Clamping defends against
    // that footgun while preserving the "0 = no retries, just the
    // initial attempt" semantic that `DEFAULT_MAX_RETRIES = 3` relies on.
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.userAgent = options.userAgent ?? `qurl-typescript/${VERSION}`;

    if (options.debug === true) {
      this.debugFn = (msg, data) => console.debug(`[qurl] ${msg}`, data ?? "");
    } else if (typeof options.debug === "function") {
      this.debugFn = options.debug;
    }
  }

  /** Returns a JSON-safe representation with the API key masked. */
  toJSON() {
    return { baseUrl: this.baseUrl, apiKey: this.maskKey() };
  }

  /** Custom Node.js inspect output with the API key masked. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `QURLClient ${JSON.stringify(this.toJSON())}`;
  }

  private maskKey(): string {
    if (this.apiKey.length > 8) {
      return this.apiKey.slice(0, 4) + "***" + this.apiKey.slice(-4);
    }
    return "***";
  }

  private log(message: string, data?: Record<string, unknown>): void {
    this.debugFn?.(message, data);
  }

  // --- Helpers ---

  /**
   * Maps the API's "qurls" field to "access_tokens" on the SDK type.
   * Uses destructuring to avoid mutation and unsafe casts.
   */
  private mapQurlsField(raw: QURL & { qurls?: AccessToken[] }): QURL {
    const { qurls, ...rest } = raw;
    if (qurls && !rest.access_tokens) {
      return { ...rest, access_tokens: qurls };
    }
    if (qurls && rest.access_tokens) {
      // The API is authoritative when both fields are present — we
      // keep `access_tokens` and drop `qurls`. This path is unexpected
      // (the API spec returns exactly one of the two), so log a debug
      // line to aid future-change diagnostics. A silent drop would
      // make a spec migration hard to notice; the log gives operators
      // a signal without raising for something that's not a caller error.
      this.log("mapQurlsField: received both 'qurls' and 'access_tokens'; keeping access_tokens", {
        qurls_count: qurls.length,
        access_tokens_count: rest.access_tokens.length,
      });
    }
    return rest;
  }

  /**
   * Validate the response envelope from POST /v1/qurls/batch and return
   * the inner {@link BatchCreateOutput}. Throws
   * {@link unexpectedResponseError} on any shape-guard failure.
   *
   * Enforces three layers of defense-in-depth:
   *   1. **Top-level shape**: `result` exists, `succeeded`/`failed` are
   *      numbers, `results` is an array. Catches non-`BatchCreateOutput`
   *      bodies on the 400 passthrough path (e.g. a proxy/gateway
   *      returning a different error envelope).
   *   2. **Arithmetic invariant**: `succeeded + failed === results.length`.
   *      Catches the realistic edge case where a proxy returns a body
   *      that happens to have the right field names but inconsistent
   *      counts (e.g. a generic error counter from a gateway).
   *   3. **Per-entry discriminated-union contract**: every entry has a
   *      boolean `success` and the non-optional fields for its branch
   *      (`resource_id`/`qurl_link`/`qurl_site` on success, `error.code`/
   *      `error.message` on failure). Protects TypeScript consumers who
   *      narrow on `success` and then access branch-specific fields as
   *      guaranteed-present.
   *
   * Error messages include the observed HTTP status ("(HTTP 400)" /
   * "(HTTP 201)" / etc.) so operators can distinguish proxy-induced
   * 400 from genuine API schema drift on the happy path. The response
   * body content is intentionally omitted — unexpected bodies could
   * contain sensitive data (auth details, request echoes) and error
   * messages may end up in client-side logs.
   */
  private validateBatchCreateResponse(envelope: ApiResponse<BatchCreateOutput>): BatchCreateOutput {
    const result = envelope.data;
    const statusSuffix =
      envelope.http_status !== undefined ? ` (HTTP ${envelope.http_status})` : "";

    // Layer 1: top-level shape.
    if (
      !result ||
      typeof result.succeeded !== "number" ||
      typeof result.failed !== "number" ||
      !Array.isArray(result.results)
    ) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}`,
      );
    }

    // Layer 2: arithmetic invariant.
    if (result.succeeded + result.failed !== result.results.length) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: ` +
          `counts/results length mismatch (succeeded=${result.succeeded}, ` +
          `failed=${result.failed}, results.length=${result.results.length})`,
      );
    }

    // Layer 3: per-entry discriminated-union contract. The reason
    // string from `batchItemResultValidationReason` only reports field
    // NAMES, never values — safe to surface into observability pipelines.
    for (let i = 0; i < result.results.length; i++) {
      const reason = batchItemResultValidationReason(result.results[i]);
      if (reason !== null) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] ${reason}`,
        );
      }
    }

    return result;
  }

  // --- Public API ---

  /** Create a new QURL. */
  async create(input: CreateInput): Promise<CreateOutput> {
    validateCreateInput(input);
    return this.request<CreateOutput>("POST", "/v1/qurls", input);
  }

  /**
   * Batch create multiple QURLs (1-100 items).
   *
   * **Partial failures do not throw.** Two paths resolve normally with
   * structured per-item results:
   * - **HTTP 207 Multi-Status** (some succeeded, some failed) — passes the
   *   `response.ok` check naturally since 207 is in the 2xx range.
   * - **HTTP 400** (every item failed validation) — the API returns a
   *   populated `BatchCreateOutput` body in this case; whitelisted via
   *   `passthroughStatuses` so the structured per-item errors aren't
   *   swallowed by the generic error path.
   *
   * Callers that only catch thrown errors will **silently miss partial
   * failures**. Always branch on `result.failed > 0` before treating the
   * call as successful. Other error statuses (401, 403, 429, 5xx) still
   * throw the appropriate `QURLError` subclass.
   *
   * Throws `ValidationError` client-side (`status: 0`, `code: "client_validation"`)
   * when `items` is empty or exceeds 100, or when the HTTP 400 response body
   * doesn't match the expected `BatchCreateOutput` shape (defense-in-depth
   * for cases where the endpoint returns a non-batch error on 400).
   *
   * @example
   * Always check `result.failed` after the call — exceptions alone are
   * not enough, because 207 / 400 partial failures resolve normally:
   * ```ts
   * const result = await client.batchCreate({ items });
   *
   * if (result.failed > 0) {
   *   console.warn(`${result.failed}/${result.results.length} items failed`);
   * }
   *
   * // Discriminated union on `success` lets you narrow per-item:
   * for (const r of result.results) {
   *   if (r.success) {
   *     handleOk(r.resource_id, r.qurl_link);
   *   } else {
   *     handleErr(r.index, r.error.code, r.error.message);
   *   }
   * }
   * ```
   */
  async batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput> {
    if (input.items.length === 0) {
      throw clientValidationError("batchCreate requires at least 1 item");
    }
    if (input.items.length > 100) {
      throw clientValidationError(
        `batchCreate accepts at most 100 items, got ${input.items.length}`,
      );
    }
    // Validate each item the same way single-create validates its input.
    // Catching obvious field issues client-side avoids the whole batch
    // round-tripping just to come back as a per-item validation error.
    //
    // Collect ALL invalid items instead of failing fast on the first one
    // — callers fixing a bad batch can see every problem in one pass
    // instead of the frustrating fix-re-run-repeat loop fail-fast would
    // force. Non-ValidationError exceptions (unexpected bugs) still
    // re-throw immediately since they don't have a per-item attribution.
    const perItemErrors: string[] = [];
    for (let i = 0; i < input.items.length; i++) {
      try {
        validateCreateInput(input.items[i]);
      } catch (err) {
        if (err instanceof ValidationError) {
          perItemErrors.push(`items[${i}]: ${err.detail}`);
          continue;
        }
        throw err;
      }
    }
    if (perItemErrors.length > 0) {
      throw clientValidationError(`batchCreate: ${perItemErrors.join("; ")}`);
    }
    // 400 carries per-item errors (see rawRequest JSDoc). Use rawRequest
    // directly (not `this.request`) so we can read `meta.request_id`
    // from the envelope and propagate it into the returned
    // BatchCreateOutput — consumers filing support tickets on partial
    // or total batch failures need the correlation ID.
    const envelope = await this.rawRequest<BatchCreateOutput>(
      "POST",
      "/v1/qurls/batch",
      input,
      BATCH_PASSTHROUGH_STATUSES,
    );
    const result = this.validateBatchCreateResponse(envelope);
    // Attach the server request_id from the envelope meta without
    // mutating `result` (which is the parsed JSON body). Mirrors the
    // non-mutating style used elsewhere (e.g. `mapQurlsField`). In the
    // no-request_id branch we can return `result` directly because
    // `response.json()` already produced a fresh object — a spread
    // there would be a redundant allocation. Only the attach path
    // copies. The field is optional on BatchCreateOutput so older API
    // versions that omit `meta.request_id` still produce a valid
    // return value.
    const requestId = envelope.meta?.request_id;
    return requestId !== undefined ? { ...result, request_id: requestId } : result;
  }

  /**
   * Get a QURL resource and its access tokens.
   *
   * Accepts either a resource ID (`r_` prefix) or a QURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   */
  async get(id: string): Promise<QURL> {
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "GET",
      `/v1/qurls/${encodeURIComponent(id)}`,
    );
    return this.mapQurlsField(raw);
  }

  /**
   * Lists protected URLs. Each QURL groups access tokens sharing the same target URL.
   * Note: list items include qurl_count but not access_tokens (too expensive at scale).
   *
   * **`limit` semantics:** `limit` is validated client-side to be in
   * the range `[1, 100]` per the OpenAPI spec (`GET /v1/qurls` defines
   * `limit: integer, minimum: 1, maximum: 100, default: 20`). Passing
   * a value outside that range throws `ValidationError` before the
   * request is issued. Omitting `limit` lets the server apply its
   * default page size (currently 20). Matches the client-side
   * validation style used for `max_sessions`, `tag count`, URL length.
   */
  async list(input: ListInput = {}): Promise<ListOutput> {
    if (input.limit !== undefined && input.limit !== null) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw clientValidationError(
          `limit: must be an integer between 1 and 100 (got ${input.limit})`,
        );
      }
    }
    const params = new URLSearchParams();
    // Explicit allowlist rather than Object.entries: TypeScript's structural
    // typing can't prevent callers from spreading untyped objects with extra
    // properties, and String(value) on an unexpected array/object would emit
    // "[object Object]" as a query param.
    for (const key of LIST_PARAM_KEYS) {
      const value = input[key];
      // Drop null/undefined and empty strings — an empty string from
      // an untyped JS caller would otherwise produce `?status=&q=`
      // garbage that the API might interpret as an explicit empty
      // filter. Numeric 0 is preserved (serializes as "0") because
      // it's a meaningful `limit` value.
      if (value !== null && value !== undefined && value !== "") {
        params.set(key, String(value));
      }
    }

    const query = params.toString();
    const path = query ? `/v1/qurls?${query}` : "/v1/qurls";

    const { data, meta } = await this.rawRequest<(QURL & { qurls?: AccessToken[] })[]>("GET", path);
    return {
      // Defensive: map in case API includes nested tokens on list items in the future.
      qurls: data.map((raw) => this.mapQurlsField(raw)),
      next_cursor: meta?.next_cursor,
      has_more: meta?.has_more ?? false,
    };
  }

  /**
   * Iterate over all QURLs, automatically paginating.
   *
   * Termination is **cursor-driven**: the loop stops as soon as the API
   * returns a page with no `next_cursor`, not when `has_more === false`.
   * This is deliberate — if the API ever returned `has_more: true` with
   * a missing or empty `next_cursor` (a server bug), a has_more-driven
   * loop would spin forever, while this cursor-driven loop terminates
   * cleanly. The trade-off is that `has_more: false` with a spurious
   * trailing cursor would cause one extra round-trip; we accept that
   * over the risk of an infinite loop.
   */
  async *listAll(input: Omit<ListInput, "cursor"> = {}): AsyncGenerator<QURL, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor });
      for (const qurl of page.qurls) {
        yield qurl;
      }
      cursor = page.next_cursor;
    } while (cursor);
  }

  /**
   * Delete (revoke) a QURL resource and all its access tokens.
   *
   * Only accepts a resource ID (`r_` prefix), not a QURL display ID (`q_`
   * prefix). Per the OpenAPI spec: *"Requires a resource ID (r_ prefix).
   * To revoke a single token, use DELETE /v1/resources/:id/qurls/:qurl_id"*.
   * A client-side prefix check catches the mistake before the API round-trip.
   */
  async delete(id: string): Promise<void> {
    // Too-short check runs BEFORE the prefix check so it catches
    // bare-prefix inputs like `"r_"` (right prefix, no suffix) in
    // addition to `""` / `"x"` / `"ab"` / `"q_"`. Without this
    // ordering, an exact `"r_"` would pass the startsWith check and
    // the SDK would send `DELETE /v1/qurls/r_` to the server —
    // rejected server-side, but this catches it client-side without
    // a round-trip.
    if (id.length <= RESOURCE_ID_PREFIX.length) {
      throw clientValidationError(
        `delete: requires a resource ID (${RESOURCE_ID_PREFIX} prefix + suffix) — got an invalid or empty identifier`,
      );
    }
    if (!id.startsWith(RESOURCE_ID_PREFIX)) {
      // Wrong-prefix branch: the input is long enough to plausibly be
      // an ID but has the wrong prefix (e.g. `q_3a7f2c8e91b`,
      // `at_xyz…`). Echo only the 2-char prefix — never the raw ID
      // — so observability pipelines don't end up with caller-supplied
      // identifiers in error logs.
      const observedPrefix = id.slice(0, RESOURCE_ID_PREFIX.length);
      throw clientValidationError(
        `delete: only resource IDs (${RESOURCE_ID_PREFIX} prefix) are accepted — ` +
          `got an ID starting with "${observedPrefix}". ` +
          "To revoke a single access token, use the token-scoped revoke endpoint (not yet available in this SDK version).",
      );
    }
    await this.rawRequest("DELETE", `/v1/qurls/${encodeURIComponent(id)}`);
  }

  /**
   * Extend a QURL's expiration.
   *
   * Accepts either a resource ID (`r_` prefix) or a QURL display ID (`q_`
   * prefix). Convenience method — delegates to {@link update} with only the
   * expiration fields. `ExtendInput` is a strict subset of `UpdateInput`, but
   * destructuring before delegation enforces the narrow type at runtime so
   * spread or variable callers can't accidentally leak `description` / `tags`
   * through this path.
   */
  async extend(id: string, input: ExtendInput): Promise<QURL> {
    const { extend_by, expires_at } = input;
    return this.update(id, { extend_by, expires_at });
  }

  /**
   * Update a QURL — extend expiration, change description, rename tags.
   *
   * Accepts either a resource ID (`r_` prefix) or a QURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   */
  async update(id: string, input: UpdateInput): Promise<QURL> {
    // Normalize `null` → `undefined` for all update fields before any
    // downstream checks. TypeScript's type system already enforces
    // optional fields, but untyped-JS callers may pass `{ tags: null }`
    // or `{ description: null }` expecting "don't touch this field".
    // Without this normalization, `null` would:
    //   1. Pass the `hasAnyField` check (since `null !== undefined`),
    //      producing a false "non-empty" input.
    //   2. Crash inside `requireValidTags(null)` on `.length`.
    //   3. Reach the wire body as `"tags": null` via JSON.stringify,
    //      which the server would likely reject or misinterpret.
    // Mirrors the `list()` filter's null-tolerance (line ~550) where
    // null query-param values are stripped for the same reason.
    // A shallow copy keeps the caller's input object untouched.
    const normalized: UpdateInput = {};
    for (const key of UPDATE_FIELD_KEYS) {
      const value = input[key];
      if (value !== null && value !== undefined) {
        // `as any` / `as unknown as` gymnastics would satisfy the
        // assignment to the union-typed key, but the simpler read
        // is: for each UpdateInput key, copy non-null/undefined
        // values to the normalized object. TypeScript can't prove
        // the per-key assignment because the union type is erased
        // in the loop, so use a tiny local cast.
        (normalized as Record<string, unknown>)[key] = value;
      }
    }

    // Match batchCreate's client-side validation pattern: catch obvious
    // mistakes before the API round-trip.
    if (normalized.extend_by !== undefined && normalized.expires_at !== undefined) {
      throw clientValidationError(
        "update: `extend_by` and `expires_at` are mutually exclusive — provide at most one",
      );
    }
    // Driven by UPDATE_FIELD_KEYS (with its own compile-time completeness
    // check) so a new field added to UpdateInput automatically participates
    // in the empty-input guard instead of silently passing through.
    const hasAnyField = UPDATE_FIELD_KEYS.some((key) => normalized[key] !== undefined);
    if (!hasAnyField) {
      throw clientValidationError(
        `update: at least one field (${UPDATE_FIELD_KEYS.join(", ")}) must be provided`,
      );
    }
    requireMaxLength(normalized.description, "description", MAX_DESCRIPTION);
    requireValidTags(normalized.tags);
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "PATCH",
      `/v1/qurls/${encodeURIComponent(id)}`,
      normalized,
    );
    return this.mapQurlsField(raw);
  }

  /**
   * Mint a new access link for a QURL.
   *
   * Accepts either a resource ID (`r_` prefix) or a QURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   */
  async mintLink(id: string, input?: MintInput): Promise<MintOutput> {
    if (input?.expires_in !== undefined && input.expires_at !== undefined) {
      throw clientValidationError(
        "mintLink: `expires_in` and `expires_at` are mutually exclusive — provide at most one",
      );
    }
    if (input !== undefined) {
      requireMaxLength(input.label, "label", MAX_LABEL);
      requireMaxSessionsInRange(input.max_sessions);
    }
    return this.request<MintOutput>("POST", `/v1/qurls/${encodeURIComponent(id)}/mint_link`, input);
  }

  /**
   * Resolve a QURL access token (headless).
   *
   * Triggers an NHP knock to open firewall access for the caller's IP.
   * Requires `qurl:resolve` scope on the API key.
   *
   * Accepts a plain token string or a `ResolveInput` object.
   */
  async resolve(input: ResolveInput | string): Promise<ResolveOutput> {
    const body = typeof input === "string" ? { access_token: input } : input;
    return this.request<ResolveOutput>("POST", "/v1/resolve", body);
  }

  /** Get quota and usage information. */
  async getQuota(): Promise<Quota> {
    return this.request<Quota>("GET", "/v1/quota");
  }

  // --- Internal HTTP plumbing ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    passthroughStatuses?: readonly number[],
  ): Promise<T> {
    const { data } = await this.rawRequest<T>(method, path, body, passthroughStatuses);
    return data;
  }

  /**
   * Issue an HTTP request and parse the JSON response.
   *
   * `passthroughStatuses` lets a caller opt certain non-2xx codes out of the
   * default throw-on-error path and receive the parsed body instead. This is
   * used by `batchCreate`, where the API returns a structured
   * `BatchCreateOutput` on HTTP 400 (all items rejected) — throwing would
   * drop the per-item errors.
   */
  private async rawRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    passthroughStatuses: readonly number[] = NO_PASSTHROUGH_STATUSES,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // DELETE is intentionally NOT classified as mutating. HTTP DELETE
    // is idempotent by spec — deleting an already-deleted resource is
    // a safe no-op on the server side — and the response body is
    // either empty (204) or carries no state worth duplicating. POST
    // and PATCH are the real non-idempotent writes: retrying them on
    // 5xx risks creating duplicate records or applying a PATCH twice,
    // so those restrict retries to {429} (rate limits only).
    const mutating = method === "POST" || method === "PATCH";
    const retryable = mutating ? RETRYABLE_STATUS_MUTATING : RETRYABLE_STATUS;
    const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelay(attempt, lastError);
        this.log(`Retry ${attempt}/${this.maxRetries} after ${delay}ms`, { method, url });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      this.log(`${method} ${url}`);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        lastError = this.classifyFetchError(err);
        this.log(
          `${method} ${url} ${lastError instanceof TimeoutError ? "timed out" : "network error"}`,
          {
            error: lastError.message,
          },
        );
        if (attempt < this.maxRetries) {
          continue;
        }
        throw lastError;
      }

      this.log(`${method} ${url} → ${response.status}`);

      // `response.ok` is true for the entire 200-299 range, so partial-
      // success responses like 207 flow through this path naturally —
      // `passthroughStatuses` only needs to enumerate non-2xx statuses
      // that the caller wants to parse as a success envelope (e.g.
      // `batchCreate` opts 400 in so per-item errors still reach the
      // caller as a structured body instead of being raised as QURLError).
      const isPassthrough = !response.ok && passthroughStatuses.includes(response.status);
      if (response.ok || isPassthrough) {
        if (response.status === 204) {
          return { data: undefined as unknown as T, http_status: response.status };
        }
        try {
          const json = (await response.json()) as ApiResponse<T>;
          // Inject the HTTP status via shallow copy (not in-place
          // mutation of the parsed JSON) so downstream callers get an
          // SDK-owned object. Mirrors the non-mutating style used by
          // `mapQurlsField` and `batchCreate`'s `request_id` attach.
          // `response.json()` already produces a fresh object, so the
          // spread is cheap and no one else holds a reference to it.
          return { ...json, http_status: response.status };
        } catch (parseErr) {
          // On the ok path, a non-JSON body is a server contract
          // violation that should throw at the call site — preserve
          // the original SyntaxError behavior so it's debuggable.
          if (!isPassthrough) {
            throw parseErr;
          }
          // Passthrough path: a proxy/CDN/WAF can return a whitelisted
          // status (e.g. 400 for `batchCreate`) with a non-JSON body —
          // a Cloudflare HTML error page, a truncated response, a
          // gateway's plaintext error. Surface a clean QURLError with
          // the observed status instead of bubbling SyntaxError. We
          // synthesize a minimal error envelope directly rather than
          // delegating to `parseError` because the Response body stream
          // has already been consumed. No retry classification runs:
          // passthrough states are definitive (batchCreate's 400 is a
          // final answer, not a transient condition), and a non-JSON
          // body there has no retryable signal. Mirrors the fix in
          // qurl-python's `_raw_request` (PR #8 commit 73ada8a).
          this.log(
            `non-JSON body on passthrough status ${response.status}; surfacing as QURLError`,
            {
              status: response.status,
              content_type: response.headers.get("content-type") ?? undefined,
            },
          );
          throw createError({
            status: response.status,
            code: "unexpected_response",
            title: response.statusText || `HTTP ${response.status}`,
            detail: `Expected JSON response body on HTTP ${response.status} but received non-JSON content`,
          });
        }
      }

      const errorData = await this.parseError(response);
      const err = createError(errorData);

      if (retryable.has(response.status) && attempt < this.maxRetries) {
        lastError = err;
        continue;
      }

      throw err;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async parseError(response: Response): Promise<QURLErrorData> {
    try {
      const json = (await response.json()) as ApiErrorEnvelope;
      if (json.error) {
        const err = json.error;
        // Detail fallback chain:
        //   1. err.detail   (RFC 7807 primary)
        //   2. err.message  (legacy pre-RFC-7807 shape)
        //   3. err.title    (RFC 7807 required field)
        //   4. HTTP status  (final safety net)
        // This prevents `"Title (403): undefined"` when the API omits detail.
        const detail = err.detail ?? err.message ?? err.title ?? `HTTP ${response.status}`;
        return {
          status: err.status ?? response.status,
          code: err.code ?? "unknown",
          title: err.title ?? response.statusText,
          detail,
          type: err.type,
          instance: err.instance,
          invalid_fields: err.invalid_fields,
          request_id: json.meta?.request_id,
          retry_after: this.parseRetryAfter(response),
        };
      }
      // JSON parsed cleanly but the `error` envelope is missing — the API
      // returned an unexpected shape. Surface it through debugFn so
      // operators can spot the divergence; fall through to the
      // status-only safety net below.
      this.log(`unexpected error response shape from ${response.status}`, {
        status: response.status,
        body_keys: Object.keys(json as object),
      });
    } catch {
      // Body wasn't valid JSON (or the network stream errored during
      // read). Log so operators can distinguish this from a malformed
      // envelope, and fall through to the status-only safety net.
      this.log(`non-JSON error response from ${response.status}`, {
        status: response.status,
        content_type: response.headers.get("content-type") ?? undefined,
      });
    }

    return {
      status: response.status,
      code: "unknown",
      title: response.statusText,
      detail: response.statusText || `HTTP ${response.status}`,
    };
  }

  private parseRetryAfter(response: Response): number | undefined {
    if (response.status !== 429) return undefined;
    const header = response.headers.get("Retry-After");
    if (!header) return undefined;
    // TODO: parse HTTP-date format per RFC 7231 §7.1.3 — currently only
    // handles delta-seconds; HTTP-date headers fall through to the
    // exponential-backoff branch in `retryDelay`. In practice qurl-service
    // emits delta-seconds, so this is a forward-compat gap, not a bug.
    const seconds = parseInt(header, 10);
    return Number.isNaN(seconds) ? undefined : seconds;
  }

  private retryDelay(attempt: number, lastError?: Error): number {
    if (lastError instanceof QURLError && lastError.retryAfter) {
      return Math.min(lastError.retryAfter * 1000, RETRY_MAX_DELAY_MS);
    }
    const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
  }

  private classifyFetchError(err: unknown): TimeoutError | NetworkError {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return new TimeoutError("Request timed out", { cause: err });
    }
    const cause = err instanceof Error ? err : undefined;
    return new NetworkError(cause?.message ?? String(err), { cause });
  }
}
