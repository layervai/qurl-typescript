import {
  createError,
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ERROR_CODE_UNKNOWN,
  NetworkError,
  QURLError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
import type {
  AccessPolicy,
  AccessToken,
  AccessCode,
  AccessCodeListOutput,
  AIAgentPolicy,
  AgentBootstrapInput,
  AgentBootstrapOutput,
  ApiKey,
  ApiKeyListOutput,
  BillingInvoiceListOutput,
  BatchCreateInput,
  BatchCreateOutput,
  ClientOptions,
  ConnectorInstallation,
  ConnectorInstallationListOutput,
  CreateAccessCodeInput,
  CreateAccessCodeOutput,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  CreateBillingCheckoutInput,
  CreateInput,
  CreateOutput,
  CreateQurlForResourceInput,
  CreateResourceInput,
  CreateWebhookInput,
  Customer,
  CheckoutSession,
  Domain,
  DomainListOutput,
  DomainVerifyResult,
  ExtendInput,
  Invoice,
  ListInput,
  ListOutput,
  ListApiKeysInput,
  ListBillingInvoicesInput,
  ListConnectorInstallationsInput,
  ListDomainsInput,
  ListWebhookDeliveriesInput,
  ListWebhooksInput,
  MintInput,
  MintOutput,
  PortalSession,
  QURL,
  QURLErrorData,
  QurlSummary,
  Quota,
  RedeemAccessCodeInput,
  RedeemAccessCodeOutput,
  RegisterDomainInput,
  Resource,
  ResourceDetail,
  ResourceListInput,
  ResourceListOutput,
  RequestOptions,
  ResolveInput,
  ResolveOutput,
  Session,
  SessionListOutput,
  SessionTerminateOutput,
  UpdateApiKeyInput,
  UpdateCustomerInput,
  UpdateInput,
  UpdateResourceInput,
  UpdateResourceQurlInput,
  UpdateWebhookInput,
  UsageCurrentPeriod,
  UsageDaily,
  Webhook,
  WebhookDelivery,
  WebhookDeliveryListOutput,
  WebhookEventTypeInfo,
  WebhookListOutput,
  WebhookWithSecret,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.layerv.ai";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 30_000;
const RETRY_BASE_DELAY_MS = 500;
// Bounds local exponential backoff (NOT server-asserted Retry-After —
// see `RETRY_AFTER_HARD_CAP_MS` for that).
const RETRY_MAX_DELAY_MS = 30_000;
// Hard cap on server-asserted Retry-After. Guards against `Retry-After`
// values >2^31-1 ms overflowing Node's setTimeout (silently truncated to
// 1ms — turns a "wait a month" directive into a hot retry loop).
const RETRY_AFTER_HARD_CAP_MS = 60 * 60 * 1000;
const RETRY_AFTER_PARSE_LIMIT_S = RETRY_AFTER_HARD_CAP_MS / 1000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_STATUS_MUTATING = new Set([429]);
type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
const IDEMPOTENCY_KEY_METHODS = new Set<HttpMethod>(["POST", "PATCH"]);
const MAX_IDEMPOTENCY_KEY = 256;
const IDEMPOTENCY_KEY_VALUE_RE = /^[\x20-\x7e]+$/;
const UUID_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

type RawRequestOptions = {
  passthroughStatuses?: readonly number[];
  requestOptions?: RequestOptions;
};

const NO_PASSTHROUGH_STATUSES: readonly number[] = [];
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

const REQUEST_OPTION_KEYS = ["idempotencyKey"] as const satisfies readonly (keyof RequestOptions)[];

// Compile-time witness: `Exclude<keyof X, (typeof KEYS)[number]>` is
// `never` iff KEYS lists every key of X. Paired with the
// `satisfies readonly (keyof X)[]` clause on the array (which catches
// the other direction), this gives bidirectional drift detection on
// the *_KEYS allowlists at zero runtime cost.
function assertExhaustive<T extends true>(_: T): void {
  /* type-only check */
}
assertExhaustive<
  Exclude<keyof ListInput, (typeof LIST_PARAM_KEYS)[number]> extends never ? true : never
>(true);

assertExhaustive<
  Exclude<keyof RequestOptions, (typeof REQUEST_OPTION_KEYS)[number]> extends never ? true : never
>(true);

const CREATE_FIELD_KEYS = [
  "type",
  "target_url",
  "expires_in",
  "one_time_use",
  "max_sessions",
  "session_duration",
  "label",
  "access_policy",
  "custom_domain",
] as const satisfies readonly (keyof CreateInput)[];

assertExhaustive<
  Exclude<keyof CreateInput, (typeof CREATE_FIELD_KEYS)[number]> extends never ? true : never
>(true);

/**
 * Fields accepted by `update()`. The empty-input pre-flight check in
 * {@link QURLClient.update} iterates this const — so adding a new field to
 * {@link UpdateInput} without listing it here will fail the
 * paired `assertExhaustive` witness at compile time rather than silently
 * sneaking through an empty-input request.
 */
const UPDATE_FIELD_KEYS = [
  "extend_by",
  "expires_at",
  "description",
  "tags",
] as const satisfies readonly (keyof UpdateInput)[];

assertExhaustive<
  Exclude<keyof UpdateInput, (typeof UPDATE_FIELD_KEYS)[number]> extends never ? true : never
>(true);

/**
 * Fields accepted by `mintLink()`. Iterated by the null-stripping
 * normalization loop in {@link QURLClient.mintLink} so unknown keys
 * from untyped-JS callers don't leak through to the wire body.
 * Symmetric with `LIST_PARAM_KEYS` / `UPDATE_FIELD_KEYS`.
 */
const MINT_FIELD_KEYS = [
  "expires_in",
  "expires_at",
  "label",
  "one_time_use",
  "max_sessions",
  "session_duration",
  "access_policy",
] as const satisfies readonly (keyof MintInput)[];

assertExhaustive<
  Exclude<keyof MintInput, (typeof MINT_FIELD_KEYS)[number]> extends never ? true : never
>(true);

const RESOURCE_LIST_PARAM_KEYS = [
  "cursor",
  "limit",
  "alias",
  "slug",
  "status",
  "type",
] as const satisfies readonly (keyof ResourceListInput)[];

assertExhaustive<
  Exclude<keyof ResourceListInput, (typeof RESOURCE_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_RESOURCE_FIELD_KEYS = [
  "type",
  "target_url",
  "description",
  "tags",
  "custom_domain",
  "alias",
  "slug",
  "find_or_create",
] as const satisfies readonly (keyof CreateResourceInput)[];

assertExhaustive<
  Exclude<keyof CreateResourceInput, (typeof CREATE_RESOURCE_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const UPDATE_RESOURCE_FIELD_KEYS = [
  "description",
  "tags",
  "custom_domain",
  "preserve_host",
  "alias",
] as const satisfies readonly (keyof UpdateResourceInput)[];

assertExhaustive<
  Exclude<keyof UpdateResourceInput, (typeof UPDATE_RESOURCE_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_QURL_FOR_RESOURCE_FIELD_KEYS = [
  "expires_in",
  "one_time_use",
  "max_sessions",
  "session_duration",
  "label",
  "access_policy",
] as const satisfies readonly (keyof CreateQurlForResourceInput)[];

assertExhaustive<
  Exclude<
    keyof CreateQurlForResourceInput,
    (typeof CREATE_QURL_FOR_RESOURCE_FIELD_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const UPDATE_RESOURCE_QURL_FIELD_KEYS = [
  "extend_by",
  "expires_at",
  "label",
  "access_policy",
  "max_sessions",
  "session_duration",
] as const satisfies readonly (keyof UpdateResourceQurlInput)[];

assertExhaustive<
  Exclude<
    keyof UpdateResourceQurlInput,
    (typeof UPDATE_RESOURCE_QURL_FIELD_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const AGENT_BOOTSTRAP_FIELD_KEYS = [
  "public_key",
  "agent_id",
  "hostname",
  "version",
] as const satisfies readonly (keyof AgentBootstrapInput)[];

assertExhaustive<
  Exclude<keyof AgentBootstrapInput, (typeof AGENT_BOOTSTRAP_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const UPDATE_CUSTOMER_FIELD_KEYS = [
  "spending_cap_cents",
] as const satisfies readonly (keyof UpdateCustomerInput)[];

assertExhaustive<
  Exclude<keyof UpdateCustomerInput, (typeof UPDATE_CUSTOMER_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_BILLING_CHECKOUT_FIELD_KEYS = [
  "plan",
] as const satisfies readonly (keyof CreateBillingCheckoutInput)[];

assertExhaustive<
  Exclude<
    keyof CreateBillingCheckoutInput,
    (typeof CREATE_BILLING_CHECKOUT_FIELD_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const REGISTER_DOMAIN_FIELD_KEYS = [
  "domain",
] as const satisfies readonly (keyof RegisterDomainInput)[];

assertExhaustive<
  Exclude<keyof RegisterDomainInput, (typeof REGISTER_DOMAIN_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_WEBHOOK_FIELD_KEYS = [
  "url",
  "events",
  "description",
] as const satisfies readonly (keyof CreateWebhookInput)[];

assertExhaustive<
  Exclude<keyof CreateWebhookInput, (typeof CREATE_WEBHOOK_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const UPDATE_WEBHOOK_FIELD_KEYS = [
  "url",
  "events",
  "description",
  "status",
] as const satisfies readonly (keyof UpdateWebhookInput)[];

assertExhaustive<
  Exclude<keyof UpdateWebhookInput, (typeof UPDATE_WEBHOOK_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_API_KEY_FIELD_KEYS = [
  "name",
  "scopes",
  "expires_in",
  "purpose",
  "tunnel_slug",
] as const satisfies readonly (keyof CreateApiKeyInput)[];

assertExhaustive<
  Exclude<keyof CreateApiKeyInput, (typeof CREATE_API_KEY_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const UPDATE_API_KEY_FIELD_KEYS = [
  "name",
  "scopes",
] as const satisfies readonly (keyof UpdateApiKeyInput)[];

assertExhaustive<
  Exclude<keyof UpdateApiKeyInput, (typeof UPDATE_API_KEY_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const REDEEM_ACCESS_CODE_FIELD_KEYS = [
  "code",
  "honeypot",
  "elapsed_ms",
] as const satisfies readonly (keyof RedeemAccessCodeInput)[];

assertExhaustive<
  Exclude<keyof RedeemAccessCodeInput, (typeof REDEEM_ACCESS_CODE_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CREATE_ACCESS_CODE_FIELD_KEYS = [
  "resource_id",
  "name",
  "max_uses",
  "expires_at",
] as const satisfies readonly (keyof CreateAccessCodeInput)[];

assertExhaustive<
  Exclude<keyof CreateAccessCodeInput, (typeof CREATE_ACCESS_CODE_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

const CONNECTOR_INSTALLATION_LIST_PARAM_KEYS = [
  "cursor",
  "limit",
] as const satisfies readonly (keyof ListConnectorInstallationsInput)[];

assertExhaustive<
  Exclude<
    keyof ListConnectorInstallationsInput,
    (typeof CONNECTOR_INSTALLATION_LIST_PARAM_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const BILLING_INVOICE_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListBillingInvoicesInput)[];

assertExhaustive<
  Exclude<
    keyof ListBillingInvoicesInput,
    (typeof BILLING_INVOICE_LIST_PARAM_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const DOMAIN_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListDomainsInput)[];

assertExhaustive<
  Exclude<keyof ListDomainsInput, (typeof DOMAIN_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

const WEBHOOK_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListWebhooksInput)[];

assertExhaustive<
  Exclude<keyof ListWebhooksInput, (typeof WEBHOOK_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

const WEBHOOK_DELIVERY_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListWebhookDeliveriesInput)[];

assertExhaustive<
  Exclude<
    keyof ListWebhookDeliveriesInput,
    (typeof WEBHOOK_DELIVERY_LIST_PARAM_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

const API_KEY_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
  "status",
] as const satisfies readonly (keyof ListApiKeysInput)[];

assertExhaustive<
  Exclude<keyof ListApiKeysInput, (typeof API_KEY_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

/**
 * Construct a {@link ValidationError} for a client-side pre-flight check.
 * Uses `status: 0` (matching {@link NetworkError}/{@link TimeoutError}) and
 * `code: "client_validation"` so catch-by-class still works and callers can
 * tell the error originated inside the SDK rather than from the API.
 */
function clientValidationError(detail: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: ERROR_CODE_CLIENT_VALIDATION,
    title: "Invalid Argument",
    detail,
  });
}

function validateRequestOptions(options: unknown): asserts options is RequestOptions | undefined {
  if (options === undefined) {
    return;
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw clientValidationError(
      `request options: must be an object (got ${options === null ? "null" : describeShape(options)})`,
    );
  }
  requireNoUnknownFields(
    options as Record<string, unknown>,
    REQUEST_OPTION_KEYS,
    "request options",
  );
  const key = (options as RequestOptions).idempotencyKey;
  if (key !== undefined) {
    if (typeof key !== "string" || key.length === 0) {
      throw clientValidationError("idempotencyKey: must be a non-empty string");
    }
    requireMaxLength(key, "idempotencyKey", MAX_IDEMPOTENCY_KEY);
    if (/[\r\n]/.test(key)) {
      throw clientValidationError("idempotencyKey: must not contain CR/LF characters");
    }
    if (!IDEMPOTENCY_KEY_VALUE_RE.test(key)) {
      throw clientValidationError("idempotencyKey: must contain only visible ASCII characters");
    }
  }
}

function idempotencyKeyForRequest(
  method: HttpMethod,
  options: RequestOptions | undefined,
): string | undefined {
  validateRequestOptions(options);
  if (!IDEMPOTENCY_KEY_METHODS.has(method)) {
    return undefined;
  }
  return options?.idempotencyKey ?? generateUuidV7();
}

function generateUuidV7(): string {
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);

  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return (
    UUID_HEX[bytes[0]] +
    UUID_HEX[bytes[1]] +
    UUID_HEX[bytes[2]] +
    UUID_HEX[bytes[3]] +
    "-" +
    UUID_HEX[bytes[4]] +
    UUID_HEX[bytes[5]] +
    "-" +
    UUID_HEX[bytes[6]] +
    UUID_HEX[bytes[7]] +
    "-" +
    UUID_HEX[bytes[8]] +
    UUID_HEX[bytes[9]] +
    "-" +
    UUID_HEX[bytes[10]] +
    UUID_HEX[bytes[11]] +
    UUID_HEX[bytes[12]] +
    UUID_HEX[bytes[13]] +
    UUID_HEX[bytes[14]] +
    UUID_HEX[bytes[15]]
  );
}

function fillRandomBytes(bytes: Uint8Array<ArrayBuffer>): void {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return;
  }
  throw new Error("globalThis.crypto.getRandomValues is required to generate Idempotency-Key");
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
 *
 * Threads `request_id` through to {@link QURLError.requestId} when the
 * server-side correlation ID is available — operators debugging
 * "unexpected response" tickets need it on the *error* path too, not
 * just on success/passthrough returns.
 */
function unexpectedResponseError(detail: string, request_id?: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: ERROR_CODE_UNEXPECTED_RESPONSE,
    title: "Unexpected Response",
    detail,
    request_id,
  });
}

// ---- Spec-derived validation helpers ------------------------------------
// These mirror constraints documented on each request schema in
// `openapi.yaml` so obvious mistakes fail fast instead of round-tripping
// to the API and coming back as a generic 400.

const MAX_TARGET_URL = 2048;
const MAX_LABEL = 500;
const MAX_BATCH_ITEMS = 100;
const MAX_DESCRIPTION = 500;
const MAX_CUSTOM_DOMAIN = 253;
const MAX_MAX_SESSIONS = 1000;
const MAX_API_KEY_NAME = 100;
const MAX_ALIAS = 64;
const MAX_SLUG = 64;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 50;
const MAX_AUTO_PAGINATION_PAGES = 10_000;
// CreateQurlRequest.target_url pattern is loose (just a URI) but
// UpdateQurlRequest.tags pattern is specific — enforce it here.
const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;
const RESOURCE_ID_PREFIX = "r_";

function requireMaxLength(value: string | undefined, field: string, max: number): void {
  if (value === undefined) return;
  // Untyped-JS safety: a non-string `value` would silently pass since
  // `(42).length === undefined > max` is `false` and the bad value would
  // sail through to the wire. Match the typeof guard pattern used by
  // requireValidTags / requireValidTargetUrl.
  if (typeof value !== "string") {
    throw clientValidationError(
      `${field}: must be a string (got ${value === null ? "null" : typeof value})`,
    );
  }
  if (value.length > max) {
    throw clientValidationError(
      `${field}: must be ${max} characters or fewer (got ${value.length})`,
    );
  }
}

function requireNonEmptyIfPresent(value: unknown, field: string): void {
  // Reject `""` so uninitialized form state doesn't reach the wire.
  if (value === "") {
    throw clientValidationError(`${field}: must not be an empty string`);
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

function requireBooleanIfPresent(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw clientValidationError(`${field}: must be a boolean (got ${describeShape(value)})`);
  }
}

function requireListLimitInRange(value: unknown, methodName: string): void {
  if (value === undefined || value === null) return;
  // All current paginated OpenAPI query params share 1..100. If a future
  // endpoint diverges, add a per-endpoint bound rather than changing this
  // shared guard silently.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw clientValidationError(
      `${methodName}: limit: must be an integer between 1 and 100 (got ${rendered})`,
    );
  }
}

function appendQuery(
  path: string,
  input: Record<string, unknown>,
  keys: readonly string[],
  methodName: string,
): string {
  validateQueryInput(input, keys, methodName);
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = input[key];
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function validateQueryInput(
  input: Record<string, unknown>,
  keys: readonly string[],
  methodName: string,
): void {
  requireNoUnknownFields(input, keys, methodName);
  if (keys.includes("limit")) {
    requireListLimitInRange(input.limit as number | undefined | null, methodName);
  }
  for (const key of keys) {
    const value = input[key];
    if (value === null || value === undefined || value === "") continue;
    if (key === "limit") continue;
    if (typeof value !== "string") {
      throw clientValidationError(
        `${methodName}: ${key}: must be a string (got ${describeShape(value)})`,
      );
    }
  }
}

function validateListAllInput(
  input: Record<string, unknown>,
  keys: readonly string[],
  methodName: string,
): void {
  // Eager validation keeps listAll* call sites consistent with single-page
  // list methods: bad input throws before the async generator is consumed.
  // paginateAll intentionally re-enters the single-page method per page, so
  // each request revalidates the threaded cursor/filter set before dispatch.
  validateQueryInput(input, keys, methodName);
}

function pageFromMeta<T extends Record<string, unknown>>(
  out: T,
  meta: ApiResponse<unknown>["meta"],
): T & { next_cursor?: string; has_more: boolean; request_id?: string; page_size?: number } {
  return {
    ...out,
    next_cursor: meta?.next_cursor,
    has_more: meta?.has_more ?? Boolean(meta?.next_cursor),
    request_id: meta?.request_id,
    page_size: meta?.page_size,
  };
}

/**
 * Validates that a path-parameter argument is a non-empty string. Some callers
 * pass resource/qURL display IDs, while newer endpoints also pass domains,
 * session IDs, webhook IDs, and API-key IDs, so this intentionally enforces
 * only basic shape and leaves endpoint-specific grammar to the service.
 */
function requireNonEmptyId(id: string, method: string, field = "id"): void {
  // `.trim()` catches whitespace-only and padded IDs before they round-trip as
  // `%20...%20` paths that the server can only reject with a less useful 404.
  // The pre-flight error is more actionable than the 404.
  if (typeof id !== "string" || id.trim() === "") {
    throw clientValidationError(`${method}: ${field} is required`);
  }
  if (id.trim() !== id) {
    throw clientValidationError(
      `${method}: ${field} must not include leading or trailing whitespace`,
    );
  }
}

function requireValidTags(tags: string[] | null | undefined): void {
  // null tolerance for untyped-JS callers — treated as "don't touch."
  // Duplicates pass through to the server (authoritative on dedupe policy).
  if (tags === undefined || tags === null) return;
  if (!Array.isArray(tags)) {
    throw clientValidationError(`tags: must be an array of strings (got ${typeof tags})`);
  }
  if (tags.length > MAX_TAGS) {
    throw clientValidationError(`tags: max ${MAX_TAGS} items allowed (got ${tags.length})`);
  }
  const errors: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    // Per-element type guard for untyped-JS callers. Without this, a
    // non-string element would silently pass (`.length` on a number is
    // `undefined`; `TAG_PATTERN.test(42)` coerces to `"42"`) or TypeError
    // (`null.length`).
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

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const ACCESS_POLICY_LIST_FIELDS = [
  "ip_allowlist",
  "ip_denylist",
  "geo_allowlist",
  "geo_denylist",
] as const satisfies readonly (keyof AccessPolicy)[];

const ACCESS_POLICY_STRING_FIELDS = [
  "user_agent_allow_regex",
  "user_agent_deny_regex",
] as const satisfies readonly (keyof AccessPolicy)[];

const AI_AGENT_POLICY_LIST_FIELDS = [
  "deny_categories",
  "allow_categories",
] as const satisfies readonly (keyof AIAgentPolicy)[];

function requireValidAccessPolicy(policy: AccessPolicy | null | undefined): void {
  // null/undefined → "don't touch". Server is authoritative on CIDR /
  // ISO-3166 / regex grammar; this guard catches only the shape errors
  // an untyped-JS caller is likely to make (e.g. `geo_allowlist: "US"`
  // instead of `["US"]`) so they get a structured ValidationError
  // instead of a server 400 they have to debug.
  if (policy === undefined || policy === null) return;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw clientValidationError(`access_policy: must be an object (got ${describeShape(policy)})`);
  }
  for (const field of ACCESS_POLICY_LIST_FIELDS) {
    const value = policy[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw clientValidationError(
        `access_policy.${field}: must be an array (got ${describeShape(value)})`,
      );
    }
  }
  for (const field of ACCESS_POLICY_STRING_FIELDS) {
    const value = policy[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw clientValidationError(
        `access_policy.${field}: must be a string (got ${describeShape(value)})`,
      );
    }
  }
  const aip = policy.ai_agent_policy;
  if (aip !== undefined) {
    if (aip === null || typeof aip !== "object" || Array.isArray(aip)) {
      throw clientValidationError(
        `access_policy.ai_agent_policy: must be an object (got ${describeShape(aip)})`,
      );
    }
    if (aip.block_all !== undefined && typeof aip.block_all !== "boolean") {
      throw clientValidationError(
        `access_policy.ai_agent_policy.block_all: must be a boolean (got ${describeShape(aip.block_all)})`,
      );
    }
    for (const field of AI_AGENT_POLICY_LIST_FIELDS) {
      const value = aip[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        throw clientValidationError(
          `access_policy.ai_agent_policy.${field}: must be an array (got ${describeShape(value)})`,
        );
      }
    }
  }
}

// `format: uri` in the OpenAPI spec allows schemes the SDK doesn't
// usefully support (`ftp://`, `file://`, `javascript:`, …). This is a
// cheap client-side sanity check — the server is still the
// authoritative validator (e.g. it rejects localhost, cloud metadata,
// and private-range hosts; the SDK doesn't need to duplicate that).
const ALLOWED_URL_SCHEMES = ["http://", "https://"] as const;

function requireValidHttpUrl(value: unknown, field: string): void {
  // Three checks in priority order: type guard, scheme, length.
  // Stop at the first failure so a non-string URL doesn't
  // produce both "must be a string" AND "must be ≤ 2048 characters"
  // (the length check on a non-string would also typeof-fail and
  // duplicate the type message). The collect-all loop in
  // validateCreateInput runs each FIELD's validator independently — within
  // a single URL field itself we want fail-fast.
  if (typeof value !== "string") {
    throw clientValidationError(
      `${field}: must be a string (got ${value === null ? "null" : typeof value})`,
    );
  }
  if (!ALLOWED_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    // Truncate to keep the error message compact and avoid
    // pathologically long schemes from filling logs.
    const repr = JSON.stringify(value).slice(0, 40);
    throw clientValidationError(`${field}: must start with http:// or https:// (got ${repr})`);
  }
  if (value.length > MAX_TARGET_URL) {
    throw clientValidationError(
      `${field}: must be ${MAX_TARGET_URL} characters or fewer (got ${value.length})`,
    );
  }
}

function requireValidTargetUrl(target_url: unknown): void {
  requireValidHttpUrl(target_url, "target_url");
}

function validateCreateInput(input: CreateInput): void {
  // Untyped-JS guard: surface as ValidationError instead of raw TypeError.
  if (typeof input !== "object" || input === null) {
    throw clientValidationError(
      `create: input must be an object (got ${input === null ? "null" : typeof input})`,
    );
  }
  // Collect-all: run every validator and aggregate the messages so a
  // caller fixing multiple bad fields sees them all at once instead
  // of fix-re-run-repeat. Matches the documented batchCreate UX
  // ("All failures are collected into a single ValidationError")
  // and mirrors the requireValidTags collect-all pattern.
  const errors: string[] = [];
  const collect = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ValidationError) {
        errors.push(err.detail);
        return;
      }
      throw err;
    }
  };
  collect(() =>
    requireNoUnknownFields(input as Record<string, unknown>, CREATE_FIELD_KEYS, "create"),
  );
  const resourceType = input.type;
  if (resourceType !== undefined && typeof resourceType !== "string") {
    errors.push(
      `type: must be a string (got ${resourceType === null ? "null" : typeof resourceType})`,
    );
  }
  collect(() => {
    if (input.target_url === undefined) {
      if (resourceType === undefined || resourceType === "url") {
        throw clientValidationError("target_url: is required for url qURLs");
      }
      return;
    }
    requireValidTargetUrl(input.target_url);
  });
  collect(() => requireMaxLength(input.label, "label", MAX_LABEL));
  collect(() => requireNonEmptyIfPresent(input.label, "label"));
  collect(() => requireMaxLength(input.custom_domain, "custom_domain", MAX_CUSTOM_DOMAIN));
  collect(() => requireNonEmptyIfPresent(input.custom_domain, "custom_domain"));
  collect(() => requireBooleanIfPresent(input.one_time_use, "one_time_use"));
  collect(() => requireMaxSessionsInRange(input.max_sessions));
  collect(() => requireNonEmptyIfPresent(input.expires_in, "expires_in"));
  collect(() => requireNonEmptyIfPresent(input.session_duration, "session_duration"));
  collect(() => requireValidAccessPolicy(input.access_policy));
  if (errors.length > 0) {
    // Inner `; ` is contractual (paired with batchCreate's outer ` | `).
    // Future field-level validators must not aggregate via `; ` internally.
    throw clientValidationError(errors.join("; "));
  }
  // Intentional omission: duration *grammar* (`expires_in`,
  // `session_duration`) is server-authoritative. Empty strings are
  // rejected up front (see collect() calls above) but unit/whitespace
  // edge cases ("24hh", "1w 3d") surface as a clean server 400 — a
  // client-side regex would just create a drift surface against the
  // server's rego/duration parser.
  //
  // `access_policy` contents (CIDRs, ISO-3166 codes, regex patterns)
  // are pass-through for the same reason. The shape-guard above only
  // catches structural mistakes (string-instead-of-array on list fields)
  // an untyped-JS caller is likely to make.
}

function validateQurlTokenOptions(input: CreateQurlForResourceInput | undefined): void {
  if (input === undefined) return;
  requireMaxLength(input.label, "label", MAX_LABEL);
  requireNonEmptyIfPresent(input.label, "label");
  requireNonEmptyIfPresent(input.expires_in, "expires_in");
  requireNonEmptyIfPresent(input.session_duration, "session_duration");
  requireBooleanIfPresent(input.one_time_use, "one_time_use");
  requireMaxSessionsInRange(input.max_sessions);
  requireValidAccessPolicy(input.access_policy);
}

function validateResourceQurlUpdateInput(input: UpdateResourceQurlInput): void {
  requireMaxLength(input.label, "label", MAX_LABEL);
  requireNonEmptyIfPresent(input.label, "label");
  requireNonEmptyIfPresent(input.extend_by, "extend_by");
  requireNonEmptyIfPresent(input.expires_at, "expires_at");
  requireNonEmptyIfPresent(input.session_duration, "session_duration");
  requireMaxSessionsInRange(input.max_sessions);
  requireValidAccessPolicy(input.access_policy);
  if (input.extend_by !== undefined && input.expires_at !== undefined) {
    throw clientValidationError(
      "updateResourceQurl: `extend_by` and `expires_at` are mutually exclusive — provide at most one",
    );
  }
}

function requireObjectInput(
  input: unknown,
  method: string,
): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw clientValidationError(
      `${method}: input must be an object (got ${input === null ? "null" : typeof input})`,
    );
  }
}

function requireNonEmptyStringField(
  input: Record<string, unknown>,
  field: string,
  method: string,
): void {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw clientValidationError(`${method}: ${field} must be a non-empty string`);
  }
}

function requireNonEmptyArrayField(
  input: Record<string, unknown>,
  field: string,
  method: string,
): void {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw clientValidationError(`${method}: ${field} must be a non-empty array`);
  }
}

function requireStringArrayElements(
  value: unknown,
  field: string,
  method: string,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw clientValidationError(`${method}: ${field} must be a non-empty array`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw clientValidationError(`${method}: ${field}[${index}] must be a non-empty string`);
    }
  });
}

function requireAtLeastOneField(
  input: Record<string, unknown>,
  fields: readonly string[],
  method: string,
): void {
  if (!fields.some((field) => input[field] !== undefined)) {
    throw clientValidationError(
      `${method}: at least one field (${fields.join(", ")}) must be provided`,
    );
  }
}

function requireNoUnknownFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  method: string,
): void {
  const unknown = Object.keys(input).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    const rendered = unknown.map((field) => `"${field}"`).join(", ");
    const label = unknown.length === 1 ? "unknown field" : "unknown fields";
    throw clientValidationError(`${method}: ${label} ${rendered}`);
  }
}

function normalizePatchFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  options: { preserveNullFields?: readonly string[] } = {},
): Record<string, unknown> {
  const preserveNull = new Set(options.preserveNullFields ?? []);
  const normalized: Record<string, unknown> = {};
  for (const key of fields) {
    const value = input[key];
    if (value !== undefined && (value !== null || preserveNull.has(key))) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function validateResourceWriteFields(
  input: Record<string, unknown>,
  options: {
    allowAliasClear?: boolean;
    allowCustomDomainClear?: boolean;
    requireUrlTarget?: boolean;
    validateFindOrCreate?: boolean;
    validatePreserveHost?: boolean;
  } = {},
): void {
  const errors: string[] = [];
  const collect = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ValidationError) {
        errors.push(err.detail);
        return;
      }
      throw err;
    }
  };
  const resourceType = input.type;
  if (resourceType !== undefined && typeof resourceType !== "string") {
    errors.push(
      `type: must be a string (got ${resourceType === null ? "null" : typeof resourceType})`,
    );
  }
  collect(() => {
    if (input.target_url === undefined) {
      if (options.requireUrlTarget && (resourceType === undefined || resourceType === "url")) {
        throw clientValidationError("target_url: is required for url resources");
      }
      return;
    }
    requireValidTargetUrl(input.target_url);
  });
  collect(() =>
    requireMaxLength(input.description as string | undefined, "description", MAX_DESCRIPTION),
  );
  collect(() =>
    requireMaxLength(input.custom_domain as string | undefined, "custom_domain", MAX_CUSTOM_DOMAIN),
  );
  collect(() => {
    if (options.allowCustomDomainClear && input.custom_domain === "") return;
    requireNonEmptyIfPresent(input.custom_domain, "custom_domain");
  });
  collect(() => requireValidTags(input.tags as string[] | null | undefined));
  collect(() => {
    if (input.alias !== undefined) {
      if (input.alias === null) {
        if (!options.allowAliasClear) {
          throw clientValidationError("alias: must be a string (got null)");
        }
      } else {
        requireMaxLength(input.alias as string | undefined, "alias", MAX_ALIAS);
        requireNonEmptyIfPresent(input.alias, "alias");
      }
    }
  });
  collect(() => {
    if (input.slug === undefined) return;
    requireMaxLength(input.slug as string | undefined, "slug", MAX_SLUG);
    requireNonEmptyIfPresent(input.slug, "slug");
  });
  collect(() => {
    if (
      options.validateFindOrCreate &&
      input.find_or_create !== undefined &&
      typeof input.find_or_create !== "boolean"
    ) {
      throw clientValidationError(
        `find_or_create: must be a boolean (got ${describeShape(input.find_or_create)})`,
      );
    }
  });
  collect(() => {
    if (
      options.validatePreserveHost &&
      input.preserve_host !== undefined &&
      typeof input.preserve_host !== "boolean"
    ) {
      throw clientValidationError(
        `preserve_host: must be a boolean (got ${describeShape(input.preserve_host)})`,
      );
    }
  });
  if (errors.length > 0) {
    throw clientValidationError(errors.join("; "));
  }
}

function validateWebhookWriteFields(
  input: Record<string, unknown>,
  method: string,
  requiredFields: { url?: boolean; events?: boolean } = {},
): void {
  if (requiredFields.url || input.url !== undefined) {
    requireNonEmptyStringField(input, "url", method);
    requireValidHttpUrl(input.url, "url");
  }
  if (requiredFields.events || input.events !== undefined) {
    requireNonEmptyArrayField(input, "events", method);
    requireStringArrayElements(input.events, "events", method);
  }
  requireMaxLength(input.description as string | undefined, "description", MAX_DESCRIPTION);
  if (input.status !== undefined) {
    requireNonEmptyStringField(input, "status", method);
  }
}

function validateApiKeyWriteFields(
  input: Record<string, unknown>,
  method: string,
  requiredFields: { name?: boolean; scopes?: boolean } = {},
): void {
  if (requiredFields.name || input.name !== undefined) {
    requireNonEmptyStringField(input, "name", method);
    requireMaxLength(input.name as string, "name", MAX_API_KEY_NAME);
  }
  if (requiredFields.scopes || input.scopes !== undefined) {
    requireNonEmptyArrayField(input, "scopes", method);
    requireStringArrayElements(input.scopes, "scopes", method);
  }
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
  // `Number.isInteger` rejects NaN, Infinity, and floats; combined
  // with `>= 0`, the check rules out pathological proxy bodies that
  // would attribute to a useless index. `index` is informational, so
  // this isn't a correctness hazard, but tightening the constraint
  // matches the same posture as the count integer guards above.
  if (!Number.isInteger(e.index) || (e.index as number) < 0) {
    return "missing/invalid 'index' (expected non-negative integer)";
  }
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
   *
   * The leading underscores avoid colliding with any future API field
   * named `http_status` — the spread `{ ...json, __http_status }` would
   * otherwise let the SDK silently overwrite a server-supplied value.
   */
  __http_status?: number;
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

/** qURL API client. */
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
      throw clientValidationError("apiKey is required");
    }
    // Header-injection guard: `Authorization: Bearer ${apiKey}` would
    // otherwise be exploitable on a CR/LF-bearing key. Surface as
    // ValidationError at construction, not as TypeError on first request.
    if (/[\r\n]/.test(options.apiKey)) {
      throw clientValidationError("apiKey: must not contain CR/LF characters");
    }
    this.apiKey = options.apiKey;
    const rawBaseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Parse the URL so the loopback exemption matches on the hostname,
    // not a string prefix. `startsWith("http://localhost")` would
    // accept `http://localhost.attacker.com` and silently send the
    // bearer token in plaintext to an arbitrary host — exactly what
    // this guard is meant to prevent.
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(rawBaseUrl);
    } catch {
      throw clientValidationError(
        `baseUrl: must be a valid URL (got ${JSON.stringify(rawBaseUrl).slice(0, 60)})`,
      );
    }
    // Reject any non-http/https scheme outright (ftp://, file://,
    // javascript:, ...). The loopback exemption logic below handles
    // IPv6 bracket form on `URL.hostname` — see the inner comment.
    if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
      throw clientValidationError(
        `baseUrl: must use http:// or https:// scheme (got ${JSON.stringify(rawBaseUrl).slice(0, 60)})`,
      );
    }
    if (parsedBaseUrl.protocol === "http:") {
      // Node's `URL.hostname` returns IPv6 hosts WITH brackets (e.g.
      // `[::1]`) — verified empirically. The bare `::1` arm is defensive
      // against runtimes that strip brackets (some whatwg-URL builds);
      // both are cheap, keep both.
      const host = parsedBaseUrl.hostname.toLowerCase();
      // `0.0.0.0` is bind-all, not loopback — would route the bearer to any local listener.
      const isLoopback =
        host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
      if (!isLoopback) {
        throw clientValidationError(
          `baseUrl: must use https:// scheme (got ${JSON.stringify(rawBaseUrl).slice(0, 60)})`,
        );
      }
    }
    this.baseUrl = rawBaseUrl;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    // Clamp `maxRetries` to a non-negative integer. Negative values
    // would skip the loop entirely (zero attempts, not just zero
    // retries); NaN slips past `Math.max` so use `Number.isFinite`.
    const requestedMaxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRetries = Number.isFinite(requestedMaxRetries)
      ? Math.max(0, Math.floor(requestedMaxRetries))
      : DEFAULT_MAX_RETRIES;
    // WHATWG: `AbortSignal.timeout(non-finite|≤0)` is immediate-abort.
    const requestedTimeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.timeout =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : DEFAULT_TIMEOUT;
    const userAgent = options.userAgent ?? `qurl-typescript/${VERSION}`;
    if (/[\r\n]/.test(userAgent)) {
      throw clientValidationError("userAgent: must not contain CR/LF characters");
    }
    this.userAgent = userAgent;

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
   * Map the API's wire-format `qurls` field to the SDK's `access_tokens`.
   *
   * Uses `hasOwnProperty.call` (not `if (raw.qurls)`) so empty `qurls: []`
   * still enters the rename branch — consumers expect `access_tokens: []`,
   * not `qurls: []` leaking through. `.call` form confines the check to
   * own-properties; safe even on pre-parsed bodies from arbitrary sources.
   */
  private mapQurlsField(raw: QURL & { qurls?: AccessToken[] }): QURL {
    if (!Object.prototype.hasOwnProperty.call(raw, "qurls")) return raw;
    const { qurls, ...rest } = raw;
    // Defensive: drop non-array `qurls` to keep `access_tokens: AccessToken[]`'s
    // type promise honest under a misbehaving proxy.
    if (qurls !== undefined && qurls !== null && !Array.isArray(qurls)) {
      this.log("mapQurlsField: 'qurls' was not an array; dropping", {
        branch: "non-array",
        qurls_type: typeof qurls,
      });
      return rest;
    }
    // null is semantically "no tokens" — silent drop is fine, but surface
    // via debug so operators spot it if the API starts emitting null.
    if (qurls === null) {
      this.log("mapQurlsField: 'qurls' was null; dropping", { branch: "null" });
      return rest;
    }
    if (qurls === undefined) {
      // Symmetric with null / non-array branches.
      this.log("mapQurlsField: 'qurls' was undefined; dropping", { branch: "undefined" });
      return rest;
    }
    if (!rest.access_tokens) {
      return { ...rest, access_tokens: qurls };
    }
    // Server-side bug — drop `qurls` rather than merge. If the arrays
    // disagree, no consistent reconciliation exists; a silent merge
    // could double-count or surface stale data.
    this.log("mapQurlsField: received both 'qurls' and 'access_tokens'; keeping access_tokens", {
      branch: "both",
      qurls_count: qurls.length,
      access_tokens_count: rest.access_tokens.length,
    });
    return rest;
  }

  /**
   * Validate the response envelope from POST /v1/qurls/batch and return
   * the inner {@link BatchCreateOutput}. Throws
   * {@link unexpectedResponseError} on any shape-guard failure.
   *
   * Three layers of defense:
   *   1. Top-level shape (succeeded/failed are non-negative integers;
   *      results is an array).
   *   2. Arithmetic invariants: `succeeded + failed === results.length`
   *      and `results.length === requestItemCount` (catches silent
   *      server-side item drops).
   *   3. Per-entry discriminated-union contract + index range / dedupe.
   *
   * Error messages include the observed HTTP status as a suffix so
   * operators can attribute drift; entry values are deliberately
   * never echoed (unexpected bodies may carry sensitive data).
   *
   * **Fail-fast, unlike `validateCreateInput`'s collect-all.** This is
   * a server-contract integrity check, not user input — once the envelope
   * is malformed, additional shape errors don't help debug the upstream
   * issue.
   */
  private validateBatchCreateResponse(
    envelope: ApiResponse<BatchCreateOutput>,
    requestItemCount: number,
  ): BatchCreateOutput {
    const result = envelope.data;
    const statusSuffix =
      envelope.__http_status !== undefined ? ` (HTTP ${envelope.__http_status})` : "";
    // Thread the server's request_id into the shape-guard error so
    // operators debugging "unexpected response" tickets have the
    // correlation handle on the error path, mirroring the success-
    // path propagation in batchCreate(). The field is optional —
    // older API versions without `meta.request_id` simply produce
    // an error without it, same as today. Embedded in BOTH the
    // .requestId property AND the message string so a stack trace
    // pasted into a support ticket carries the correlation handle
    // without a follow-up round-trip.
    const requestId = envelope.meta?.request_id;
    const requestIdSuffix = requestId !== undefined ? ` [request_id=${requestId}]` : "";

    // `Number.isInteger` rejects NaN, Infinity, and floats. Combined
    // with `>= 0`, this rules out pathological proxy bodies (e.g.
    // `succeeded: -1, failed: 1, results: [<one entry>]`) that the
    // arithmetic invariant below would only catch by accident. Make
    // the constraint intentional rather than incidental.
    if (
      !result ||
      !Number.isInteger(result.succeeded) ||
      result.succeeded < 0 ||
      !Number.isInteger(result.failed) ||
      result.failed < 0 ||
      !Array.isArray(result.results)
    ) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}${requestIdSuffix}`,
        requestId,
      );
    }

    if (result.succeeded + result.failed !== result.results.length) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: ` +
          `counts/results length mismatch (succeeded=${result.succeeded}, ` +
          `failed=${result.failed}, results.length=${result.results.length})${requestIdSuffix}`,
        requestId,
      );
    }

    // OpenAPI contract: one result per input item. Without this check, a
    // server that drops items (e.g. sends 2 results for 3 inputs with
    // succeeded=1, failed=1) passes the arithmetic invariant above and
    // every per-entry check below — but the consumer keying by `r.index`
    // would silently lose the dropped item. Combined with the per-entry
    // index range + dedup checks, this guarantees the seen-indices set is
    // exactly [0, requestItemCount).
    if (result.results.length !== requestItemCount) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: ` +
          `results.length (${result.results.length}) does not match request item count (${requestItemCount})${requestIdSuffix}`,
        requestId,
      );
    }

    // Per-entry discriminated-union contract. Reason strings report
    // field NAMES only, never values — safe for observability pipelines.
    // Short-circuit on first bad entry (server-contract check, not user
    // input). `index` is bound to `[0, requestItemCount)` and de-duped:
    // both are unambiguous server bugs that silently break per-item
    // attribution, so fail closed to match this guard's posture.
    const seenIndices = new Set<number>();
    for (let i = 0; i < result.results.length; i++) {
      const reason = batchItemResultValidationReason(result.results[i]);
      if (reason !== null) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] ${reason}${requestIdSuffix}`,
          requestId,
        );
      }
      const entry = result.results[i] as { index: number };
      if (entry.index >= requestItemCount) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] index out of range (sent ${requestItemCount} items)${requestIdSuffix}`,
          requestId,
        );
      }
      if (seenIndices.has(entry.index)) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] duplicate index${requestIdSuffix}`,
          requestId,
        );
      }
      seenIndices.add(entry.index);
    }

    return result;
  }

  private async *paginateAll<
    TItem,
    TInput extends { cursor?: string },
    TPage extends { next_cursor?: string; has_more?: boolean; request_id?: string },
  >(
    methodName: string,
    input: Omit<TInput, "cursor">,
    loadPage: (input: TInput) => Promise<TPage>,
    itemsFromPage: (page: TPage) => TItem[],
  ): AsyncGenerator<TItem, void, undefined> {
    let cursor: string | undefined;
    let pageCount = 0;
    // Bounded by MAX_AUTO_PAGINATION_PAGES, so pathological cursor streams
    // cannot grow this set without limit.
    const seenCursors = new Set<string>();
    do {
      pageCount += 1;
      const page = await loadPage({ ...input, cursor } as TInput);
      for (const item of itemsFromPage(page)) {
        yield item;
      }
      cursor = page.next_cursor;
      if (page.has_more === false) {
        break;
      }
      if (!cursor) {
        break;
      }
      if (seenCursors.has(cursor)) {
        throw unexpectedResponseError(
          `${methodName}: server returned repeated cursor after ${pageCount} auto-pagination pages`,
          page.request_id,
        );
      }
      seenCursors.add(cursor);
      if (pageCount >= MAX_AUTO_PAGINATION_PAGES) {
        throw unexpectedResponseError(
          `${methodName}: exceeded ${MAX_AUTO_PAGINATION_PAGES} auto-pagination pages without termination`,
          page.request_id,
        );
      }
    } while (cursor);
  }

  // --- Public API ---

  /** Create a new qURL. */
  async create(input: CreateInput, options?: RequestOptions): Promise<CreateOutput> {
    validateCreateInput(input);
    return this.request<CreateOutput>("POST", "/v1/qurls", input, options);
  }

  /**
   * Batch create multiple qURLs (1-`MAX_BATCH_ITEMS` items).
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
   * **Client-side validation:** All items are validated before any network
   * request is made (target_url scheme, label length, max_sessions range,
   * tag constraints). All failures are collected into a single
   * `ValidationError` with per-index attribution
   * (`"items[0]: ... | items[3]: ..."`) — items are separated by ` | ` and
   * field-level errors within an item by `; ` so callers can split the
   * detail message reliably. Every problem surfaces in one throw instead
   * of fix-re-run-repeat.
   *
   * Throws `ValidationError` client-side (`status: 0`, `code: "client_validation"`)
   * when `items` is empty or exceeds `MAX_BATCH_ITEMS`, or when the
   * HTTP 400 response body doesn't match the expected `BatchCreateOutput`
   * shape (defense-in-depth for cases where the endpoint returns a non-batch
   * error on 400).
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
  async batchCreate(input: BatchCreateInput, options?: RequestOptions): Promise<BatchCreateOutput> {
    // Untyped-JS safety: the rest of the validators (requireValidTags,
    // requireMaxLength, etc.) all surface a structured ValidationError
    // for non-conforming inputs. Without this guard, `batchCreate({} as
    // any)` would throw a raw TypeError on `.length`. Match the pattern.
    if (!input || !Array.isArray(input.items)) {
      throw clientValidationError("batchCreate: items must be an array");
    }
    // Size checks are fail-fast (binary, no useful aggregation), per-item
    // validation below is collect-all (multiple bad items aggregate into
    // one throw). The asymmetry is deliberate: there's nothing to combine
    // for empty input or oversized batches — the size is wrong or it isn't.
    if (input.items.length === 0) {
      throw clientValidationError("batchCreate requires at least 1 item");
    }
    if (input.items.length > MAX_BATCH_ITEMS) {
      throw clientValidationError(
        `batchCreate accepts at most ${MAX_BATCH_ITEMS} items, got ${input.items.length}`,
      );
    }
    // Collect ALL per-item validation errors in one pass (not fail-fast)
    // so callers see every problem without fix-re-run-repeat. Kept inline
    // (not unified with `validateCreateInput`'s `collect()`) because the
    // separator policy and `items[i]:` prefix differ.
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
      // Outer separator differs from `validateCreateInput`'s inner
      // `"; "` so callers can split the message reliably:
      //   `items[0]: a; b | items[2]: c; d`
      // Without this asymmetry, the same `; ` at both levels makes
      // it ambiguous which separator is "next item" vs "next field
      // within item". Mirrors the JSDoc example shape.
      throw clientValidationError(`batchCreate: ${perItemErrors.join(" | ")}`);
    }
    // 400 carries per-item errors (see rawRequest JSDoc). Use rawRequest
    // directly (not `this.request`) so we can read `meta.request_id`
    // from the envelope and propagate it into the returned
    // BatchCreateOutput — consumers filing support tickets on partial
    // or total batch failures need the correlation ID.
    const envelope = await this.rawRequest<BatchCreateOutput>("POST", "/v1/qurls/batch", input, {
      passthroughStatuses: BATCH_PASSTHROUGH_STATUSES,
      requestOptions: options,
    });
    const result = this.validateBatchCreateResponse(envelope, input.items.length);
    // Attach the server request_id from the envelope meta without
    // mutating `result` (which is the parsed JSON body). Mirrors the
    // non-mutating style used elsewhere (e.g. `mapQurlsField`). In the
    // no-request_id branch we can return `result` directly because
    // `response.json()` already produced a fresh object — a spread
    // there would be a redundant allocation. Only the attach path
    // copies. The field is optional on BatchCreateOutput so older API
    // versions that omit `meta.request_id` still produce a valid
    // return value.
    //
    // If a future server payload puts `request_id` on both `data` and
    // `meta`, the spread `{ ...result, request_id: requestId }` makes
    // `meta` win — that's deliberate: the type only documents `meta`
    // as the source, and `meta.request_id` is the canonical envelope
    // field. The data-side variant would be a wire-format duplication
    // we don't want to silently honor.
    const requestId = envelope.meta?.request_id;
    // Both-fields-present and data-only-present are both worth surfacing
    // via debug — the former because meta wins silently, the latter
    // because it suggests an envelope-shape transition. Data-side value
    // is preserved when meta is absent (no over-eager strip).
    const dataRequestId = (result as { request_id?: unknown }).request_id;
    if (dataRequestId !== undefined) {
      const dataRequestIdRepr = String(dataRequestId).slice(0, 80);
      if (requestId !== undefined && dataRequestId !== requestId) {
        this.log("batchCreate: response carries request_id on BOTH data and meta; keeping meta", {
          meta_request_id: requestId,
          data_request_id: dataRequestIdRepr,
        });
      } else if (requestId === undefined) {
        // Data-only request_id suggests an envelope-shape transition;
        // surface for observability.
        this.log("batchCreate: response carries request_id on data only (meta absent)", {
          data_request_id: dataRequestIdRepr,
        });
      }
    }
    return requestId !== undefined ? { ...result, request_id: requestId } : result;
  }

  /**
   * Get a qURL resource and its access tokens.
   *
   * Accepts either a resource ID (`r_` prefix) or a qURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   */
  async get(id: string): Promise<QURL> {
    requireNonEmptyId(id, "get");
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "GET",
      `/v1/qurls/${encodeURIComponent(id)}`,
    );
    return this.mapQurlsField(raw);
  }

  /**
   * Lists protected URLs. Each qURL groups access tokens sharing the same target URL.
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
    const path = appendQuery(
      "/v1/qurls",
      input as Record<string, unknown>,
      LIST_PARAM_KEYS,
      "list",
    );

    const { data, meta } = await this.rawRequest<(QURL & { qurls?: AccessToken[] })[]>("GET", path);
    return pageFromMeta(
      {
        // Defensive: map in case API includes nested tokens on list items in the future.
        qurls: (data ?? []).map((raw) => this.mapQurlsField(raw)),
      },
      meta,
    );
  }

  /**
   * Iterate over all qURLs, automatically paginating.
   *
   * Termination honors explicit `has_more: false` first, then falls back
   * to the cursor shape. A missing `next_cursor` still terminates even if
   * a buggy response claimed `has_more: true`, and a stale cursor with
   * `has_more: false` does not trigger an extra round-trip.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAll(input: Omit<ListInput, "cursor"> = {}): AsyncGenerator<QURL, void, undefined> {
    validateListAllInput(input as Record<string, unknown>, LIST_PARAM_KEYS, "listAll");
    return this.paginateAll<QURL, ListInput, ListOutput>(
      "listAll",
      input,
      (pageInput) => this.list(pageInput),
      (page) => page.qurls,
    );
  }

  /**
   * Delete (revoke) a qURL resource and all its access tokens.
   *
   * Only accepts a resource ID (`r_` prefix), not a qURL display ID (`q_`
   * prefix). Per the OpenAPI spec: *"Requires a resource ID (r_ prefix).
   * To revoke a single token, use DELETE /v1/resources/:id/qurls/:qurl_id"*.
   * A client-side prefix check catches the mistake before the API round-trip.
   */
  async delete(id: string): Promise<void> {
    // Type guard for untyped-JS callers — without it, `(undefined).length`
    // is a raw TypeError instead of the structured ValidationError the
    // rest of the surface produces.
    if (typeof id !== "string") {
      throw clientValidationError(
        `delete: requires a resource ID (${RESOURCE_ID_PREFIX} prefix + suffix) — got ${id === null ? "null" : typeof id}`,
      );
    }
    if (id.trim() !== id) {
      throw clientValidationError("delete: id must not include leading or trailing whitespace");
    }
    // Too-short check runs BEFORE the prefix check so it catches
    // bare-prefix inputs like `"r_"` (right prefix, no suffix) in
    // addition to `""` / `"x"` / `"ab"` / `"q_"`. Without this
    // ordering, an exact `"r_"` would pass the startsWith check and
    // the SDK would send `DELETE /v1/qurls/r_` to the server —
    // rejected server-side, but this catches it client-side without
    // a round-trip.
    if (id.length <= RESOURCE_ID_PREFIX.length) {
      throw clientValidationError(
        `delete: requires a resource ID (${RESOURCE_ID_PREFIX} prefix + suffix) — got ${id.length} character${id.length === 1 ? "" : "s"}`,
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
          "To revoke a single access token, use the resource-scoped token endpoint.",
      );
    }
    await this.rawRequest("DELETE", `/v1/qurls/${encodeURIComponent(id)}`);
  }

  /**
   * Extend a qURL's expiration.
   *
   * Accepts either a resource ID (`r_` prefix) or a qURL display ID (`q_`
   * prefix). Convenience method — delegates to {@link update} with only the
   * expiration fields. `ExtendInput` shares its `extend_by` / `expires_at`
   * fields with `UpdateInput` but is *narrower in two ways*: (1) exactly
   * one of the two must be present (XOR via `?: never`), where `UpdateInput`
   * allows neither; and (2) `description` / `tags` are absent.
   *
   * Destructuring before delegation strips wider fields at runtime, so an
   * untyped-JS caller spreading `{ description, tags, ... }` can't leak
   * those through this path. The XOR (exactly-one-of-two) invariant is
   * enforced separately by the runtime check inside `update()`.
   */
  async extend(id: string, input: ExtendInput, options?: RequestOptions): Promise<QURL> {
    requireNonEmptyId(id, "extend");
    requireObjectInput(input, "extend");
    const { extend_by, expires_at } = input;
    if (extend_by === undefined && expires_at === undefined) {
      throw clientValidationError("extend: exactly one of `extend_by` or `expires_at` is required");
    }
    if (extend_by !== undefined && expires_at !== undefined) {
      throw clientValidationError(
        "extend: `extend_by` and `expires_at` are mutually exclusive — provide exactly one",
      );
    }
    return this.update(id, { extend_by, expires_at }, options);
  }

  /**
   * Update a qURL — extend expiration, change description, rename tags.
   *
   * Accepts either a resource ID (`r_` prefix) or a qURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   */
  async update(id: string, input: UpdateInput, options?: RequestOptions): Promise<QURL> {
    requireNonEmptyId(id, "update");
    requireObjectInput(input, "update");
    requireNoUnknownFields(input, UPDATE_FIELD_KEYS, "update");
    // Normalize null → undefined so untyped-JS callers passing
    // `{ tags: null }` don't leak null into the wire body or crash
    // downstream validators. Shallow copy keeps caller input untouched.
    const normalized = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_FIELD_KEYS,
    ) as UpdateInput;

    // Timing fields have no clear-semantic (unlike `description: ""`).
    requireNonEmptyIfPresent(normalized.extend_by, "extend_by");
    requireNonEmptyIfPresent(normalized.expires_at, "expires_at");

    if (normalized.extend_by !== undefined && normalized.expires_at !== undefined) {
      throw clientValidationError(
        "update: `extend_by` and `expires_at` are mutually exclusive — provide at most one",
      );
    }
    requireAtLeastOneField(normalized as Record<string, unknown>, UPDATE_FIELD_KEYS, "update");
    // Per-field validators run after the empty-input guard so the
    // cheap binary check short-circuits first; order is correctness-neutral
    // (`requireMaxLength(undefined, …)` is a no-op).
    requireMaxLength(normalized.description, "description", MAX_DESCRIPTION);
    requireValidTags(normalized.tags);
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "PATCH",
      `/v1/qurls/${encodeURIComponent(id)}`,
      normalized,
      options,
    );
    return this.mapQurlsField(raw);
  }

  /**
   * Mint a new access link for a qURL.
   *
   * Accepts either a resource ID (`r_` prefix) or a qURL display ID (`q_`
   * prefix); the API resolves `q_` IDs to the parent resource automatically.
   *
   * Passing `{}` or an object with all fields `null`/`undefined` is
   * equivalent to omitting the second argument: no body is sent, and the
   * server applies its 24h default expiration.
   */
  async mintLink(id: string, input?: MintInput, options?: RequestOptions): Promise<MintOutput> {
    requireNonEmptyId(id, "mintLink");
    // Normalize null → omitted so untyped-JS callers passing
    // `{ expires_in: null, expires_at: "..." }` don't leak null into
    // the wire body via JSON.stringify and don't bypass the XOR check
    // below (which uses `!== undefined`). Mirrors the null-normalization
    // pattern used by update(); keeps the two write surfaces symmetric.
    let normalized: MintInput | undefined = input;
    if (input !== undefined) {
      requireObjectInput(input, "mintLink");
      requireNoUnknownFields(input, MINT_FIELD_KEYS, "mintLink");
      // Iterate the explicit allowlist (matching update() / list())
      // so unknown keys from untyped-JS callers can't leak through
      // to the wire body. The compile-time `assertExhaustive` check
      // on MINT_FIELD_KEYS keeps this in sync with MintInput.
      const stripped: Record<string, unknown> = {};
      let hasAnyField = false;
      for (const key of MINT_FIELD_KEYS) {
        const value = input[key];
        if (value !== null && value !== undefined) {
          stripped[key] = value;
          hasAnyField = true;
        }
      }
      // Collapse to `undefined` when stripping leaves nothing so
      // `mintLink(id, {})` matches `mintLink(id)` on the wire (no
      // Content-Type, no body); server-side defaults are identical.
      normalized = hasAnyField ? (stripped as MintInput) : undefined;
    }
    if (normalized !== undefined) {
      requireNonEmptyIfPresent(normalized.expires_in, "expires_in");
      requireNonEmptyIfPresent(normalized.expires_at, "expires_at");
      if (normalized.expires_in !== undefined && normalized.expires_at !== undefined) {
        throw clientValidationError(
          "mintLink: `expires_in` and `expires_at` are mutually exclusive — provide at most one",
        );
      }
      requireMaxLength(normalized.label, "label", MAX_LABEL);
      requireNonEmptyIfPresent(normalized.label, "label");
      requireNonEmptyIfPresent(normalized.session_duration, "session_duration");
      requireMaxSessionsInRange(normalized.max_sessions);
      requireValidAccessPolicy(normalized.access_policy);
      // Duration *grammar* and access_policy contents are server-authoritative
      // (same rationale as validateCreateInput). Empty-string rejection happens
      // above; bound/unit checks happen server-side.
    }
    return this.request<MintOutput>(
      "POST",
      `/v1/qurls/${encodeURIComponent(id)}/mint_link`,
      normalized,
      options,
    );
  }

  /**
   * Resolve a qURL access token (headless).
   *
   * Triggers an NHP knock to open firewall access for the caller's IP.
   * Requires `qurl:resolve` scope on the API key.
   *
   * Accepts a plain token string or a `ResolveInput` object.
   */
  async resolve(input: ResolveInput | string, options?: RequestOptions): Promise<ResolveOutput> {
    // Mirror get/update/mintLink: catch untyped-JS misuse client-side.
    let body: ResolveInput;
    if (typeof input === "string") {
      if (input.length === 0) {
        throw clientValidationError("resolve: access_token must be a non-empty string");
      }
      body = { access_token: input };
    } else if (typeof input === "object" && input !== null) {
      if (typeof input.access_token !== "string" || input.access_token.length === 0) {
        throw clientValidationError("resolve: access_token must be a non-empty string");
      }
      // Allowlist-rebuild — symmetric with list()/update()/mintLink().
      body = { access_token: input.access_token };
    } else {
      throw clientValidationError(
        `resolve: input must be a string or { access_token } object (got ${input === null ? "null" : typeof input})`,
      );
    }
    return this.request<ResolveOutput>("POST", "/v1/resolve", body, options);
  }

  /** Get quota and usage information. */
  async getQuota(): Promise<Quota> {
    return this.request<Quota>("GET", "/v1/quota");
  }

  /** Bootstrap a LayerV qURL Connector agent. */
  async bootstrapAgent(
    input: AgentBootstrapInput,
    options?: RequestOptions,
  ): Promise<AgentBootstrapOutput> {
    requireObjectInput(input, "bootstrapAgent");
    requireNoUnknownFields(input, AGENT_BOOTSTRAP_FIELD_KEYS, "bootstrapAgent");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      AGENT_BOOTSTRAP_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as AgentBootstrapInput;
    requireNonEmptyStringField(normalizedRecord, "public_key", "bootstrapAgent");
    return this.request<AgentBootstrapOutput>("POST", "/v1/agent/bootstrap", normalized, options);
  }

  /** List resources from the `/v1/resources` API. */
  async listResources(input: ResourceListInput = {}): Promise<ResourceListOutput> {
    const { data, meta } = await this.rawRequest<Resource[]>(
      "GET",
      appendQuery(
        "/v1/resources",
        input as Record<string, unknown>,
        RESOURCE_LIST_PARAM_KEYS,
        "listResources",
      ),
    );
    return pageFromMeta({ resources: data ?? [] }, meta);
  }

  /**
   * Iterate all resources, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllResources(
    input: Omit<ResourceListInput, "cursor"> = {},
  ): AsyncGenerator<Resource, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      RESOURCE_LIST_PARAM_KEYS,
      "listAllResources",
    );
    return this.paginateAll<Resource, ResourceListInput, ResourceListOutput>(
      "listAllResources",
      input,
      (pageInput) => this.listResources(pageInput),
      (page) => page.resources,
    );
  }

  /** Create a resource directly. */
  async createResource(input: CreateResourceInput, options?: RequestOptions): Promise<Resource> {
    requireObjectInput(input, "createResource");
    requireNoUnknownFields(input, CREATE_RESOURCE_FIELD_KEYS, "createResource");
    const normalized = normalizePatchFields(
      input as Record<string, unknown>,
      CREATE_RESOURCE_FIELD_KEYS,
    ) as CreateResourceInput;
    validateResourceWriteFields(normalized as Record<string, unknown>, {
      requireUrlTarget: true,
      validateFindOrCreate: true,
    });
    return this.request<Resource>("POST", "/v1/resources", normalized, options);
  }

  /** Get one resource plus its bounded qURL preview. */
  async getResource(id: string): Promise<ResourceDetail> {
    requireNonEmptyId(id, "getResource");
    return this.request<ResourceDetail>("GET", `/v1/resources/${encodeURIComponent(id)}`);
  }

  /** Update resource metadata. */
  async updateResource(
    id: string,
    input: UpdateResourceInput,
    options?: RequestOptions,
  ): Promise<Resource> {
    requireNonEmptyId(id, "updateResource");
    requireObjectInput(input, "updateResource");
    requireNoUnknownFields(input, UPDATE_RESOURCE_FIELD_KEYS, "updateResource");
    const validationInput = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_RESOURCE_FIELD_KEYS,
      { preserveNullFields: ["alias"] },
    ) as UpdateResourceInput;
    requireAtLeastOneField(
      validationInput as Record<string, unknown>,
      UPDATE_RESOURCE_FIELD_KEYS,
      "updateResource",
    );
    validateResourceWriteFields(validationInput as Record<string, unknown>, {
      allowAliasClear: true,
      allowCustomDomainClear: true,
      validatePreserveHost: true,
    });
    return this.request<Resource>(
      "PATCH",
      `/v1/resources/${encodeURIComponent(id)}`,
      validationInput,
      options,
    );
  }

  /** Revoke a resource and all of its qURLs. */
  async deleteResource(id: string): Promise<void> {
    requireNonEmptyId(id, "deleteResource");
    await this.rawRequest("DELETE", `/v1/resources/${encodeURIComponent(id)}`);
  }

  /** Mint a qURL against an existing resource. */
  async createQurlForResource(
    id: string,
    input?: CreateQurlForResourceInput,
    options?: RequestOptions,
  ): Promise<CreateOutput> {
    requireNonEmptyId(id, "createQurlForResource");
    let normalized: CreateQurlForResourceInput | undefined = input;
    if (input !== undefined) {
      requireObjectInput(input, "createQurlForResource");
      requireNoUnknownFields(input, CREATE_QURL_FOR_RESOURCE_FIELD_KEYS, "createQurlForResource");
      const stripped = normalizePatchFields(
        input as Record<string, unknown>,
        CREATE_QURL_FOR_RESOURCE_FIELD_KEYS,
      ) as CreateQurlForResourceInput;
      normalized = Object.keys(stripped).length > 0 ? stripped : undefined;
    }
    validateQurlTokenOptions(normalized);
    return this.request<CreateOutput>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/qurls`,
      normalized,
      options,
    );
  }

  /** Revoke a specific qURL token on a resource. */
  async revokeResourceQurl(id: string, qurlId: string): Promise<void> {
    requireNonEmptyId(id, "revokeResourceQurl");
    requireNonEmptyId(qurlId, "revokeResourceQurl");
    await this.rawRequest(
      "DELETE",
      `/v1/resources/${encodeURIComponent(id)}/qurls/${encodeURIComponent(qurlId)}`,
    );
  }

  /** Update a specific qURL token on a resource. */
  async updateResourceQurl(
    id: string,
    qurlId: string,
    input: UpdateResourceQurlInput,
    options?: RequestOptions,
  ): Promise<QurlSummary> {
    requireNonEmptyId(id, "updateResourceQurl");
    requireNonEmptyId(qurlId, "updateResourceQurl");
    requireObjectInput(input, "updateResourceQurl");
    requireNoUnknownFields(input, UPDATE_RESOURCE_QURL_FIELD_KEYS, "updateResourceQurl");
    const normalized = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_RESOURCE_QURL_FIELD_KEYS,
    ) as UpdateResourceQurlInput;
    requireAtLeastOneField(
      normalized as Record<string, unknown>,
      UPDATE_RESOURCE_QURL_FIELD_KEYS,
      "updateResourceQurl",
    );
    validateResourceQurlUpdateInput(normalized);
    return this.request<QurlSummary>(
      "PATCH",
      `/v1/resources/${encodeURIComponent(id)}/qurls/${encodeURIComponent(qurlId)}`,
      normalized,
      options,
    );
  }

  /**
   * List active access sessions for a resource.
   *
   * The current API contract has no cursor query params for this endpoint.
   * If the service later advertises pagination metadata, the SDK returns
   * this page and emits a debug log rather than pretending it fetched all pages.
   */
  async listResourceSessions(id: string): Promise<SessionListOutput> {
    requireNonEmptyId(id, "listResourceSessions");
    const { data, meta } = await this.rawRequest<Session[]>(
      "GET",
      `/v1/resources/${encodeURIComponent(id)}/sessions`,
    );
    if (meta?.has_more || meta?.next_cursor) {
      this.log("listResourceSessions: pagination metadata surfaced on unpaginated endpoint", {
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
      });
    }
    return {
      sessions: data ?? [],
      request_id: meta?.request_id,
      has_more: false,
      page_size: meta?.page_size,
    };
  }

  /**
   * Terminate all active sessions for a resource.
   *
   * The returned count is best-effort under retries: if the first DELETE
   * succeeds server-side but the response is lost, a retried request may
   * return `0` because there are no sessions left to terminate.
   */
  async terminateAllResourceSessions(id: string): Promise<SessionTerminateOutput> {
    requireNonEmptyId(id, "terminateAllResourceSessions");
    const path = `/v1/resources/${encodeURIComponent(id)}/sessions`;
    const { data, meta, __http_status } = await this.rawRequest<{ terminated?: number }>(
      "DELETE",
      path,
    );
    if (__http_status === 204) {
      throw unexpectedResponseError(
        `Unexpected 204 No Content from DELETE ${path}; expected response body`,
      );
    }
    if (data?.terminated === undefined) {
      this.log("terminateAllResourceSessions: missing terminated count; defaulting to zero", {
        request_id: meta?.request_id,
      });
    }
    return { terminated: data?.terminated ?? 0, request_id: meta?.request_id };
  }

  /** Terminate a specific resource session. */
  async terminateResourceSession(id: string, sessionId: string): Promise<void> {
    requireNonEmptyId(id, "terminateResourceSession");
    requireNonEmptyId(sessionId, "terminateResourceSession");
    await this.rawRequest(
      "DELETE",
      `/v1/resources/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  /** List connector installations. */
  async listConnectorInstallations(
    input: ListConnectorInstallationsInput = {},
  ): Promise<ConnectorInstallationListOutput> {
    const { data, meta } = await this.rawRequest<ConnectorInstallationListOutput["installations"]>(
      "GET",
      appendQuery(
        "/v1/connectors/installations",
        input as Record<string, unknown>,
        CONNECTOR_INSTALLATION_LIST_PARAM_KEYS,
        "listConnectorInstallations",
      ),
    );
    return pageFromMeta({ installations: data ?? [] }, meta);
  }

  /**
   * Iterate all connector installations, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllConnectorInstallations(
    input: Omit<ListConnectorInstallationsInput, "cursor"> = {},
  ): AsyncGenerator<ConnectorInstallation, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      CONNECTOR_INSTALLATION_LIST_PARAM_KEYS,
      "listAllConnectorInstallations",
    );
    return this.paginateAll<
      ConnectorInstallation,
      ListConnectorInstallationsInput,
      ConnectorInstallationListOutput
    >(
      "listAllConnectorInstallations",
      input,
      (pageInput) => this.listConnectorInstallations(pageInput),
      (page) => page.installations,
    );
  }

  /** Get current-period usage. */
  async getUsageCurrentPeriod(): Promise<UsageCurrentPeriod> {
    return this.request<UsageCurrentPeriod>("GET", "/v1/usage/current-period");
  }

  /** Get daily usage for the current period. */
  async getUsageDaily(): Promise<UsageDaily> {
    return this.request<UsageDaily>("GET", "/v1/usage/daily");
  }

  /** Get the customer profile. */
  async getCustomer(): Promise<Customer> {
    return this.request<Customer>("GET", "/v1/customer");
  }

  /** Update customer settings. */
  async updateCustomer(input: UpdateCustomerInput, options?: RequestOptions): Promise<Customer> {
    requireObjectInput(input, "updateCustomer");
    requireNoUnknownFields(input, UPDATE_CUSTOMER_FIELD_KEYS, "updateCustomer");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_CUSTOMER_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as UpdateCustomerInput;
    const spendingCap = normalized.spending_cap_cents;
    if (spendingCap === undefined) {
      throw clientValidationError("updateCustomer: spending_cap_cents is required");
    }
    if (!Number.isInteger(spendingCap) || spendingCap < 0) {
      const rendered =
        typeof spendingCap === "number" ? String(spendingCap) : describeShape(spendingCap);
      throw clientValidationError(
        `updateCustomer: spending_cap_cents must be a non-negative integer (got ${rendered})`,
      );
    }
    return this.request<Customer>("PATCH", "/v1/customer", normalized, options);
  }

  /** Create a Stripe checkout session. */
  async createBillingCheckout(
    input: CreateBillingCheckoutInput,
    options?: RequestOptions,
  ): Promise<CheckoutSession> {
    requireObjectInput(input, "createBillingCheckout");
    requireNoUnknownFields(input, CREATE_BILLING_CHECKOUT_FIELD_KEYS, "createBillingCheckout");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      CREATE_BILLING_CHECKOUT_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as CreateBillingCheckoutInput;
    requireNonEmptyStringField(normalizedRecord, "plan", "createBillingCheckout");
    return this.request<CheckoutSession>("POST", "/v1/billing/checkout", normalized, options);
  }

  /** Create a Stripe billing portal session. */
  async createBillingPortal(options?: RequestOptions): Promise<PortalSession> {
    return this.request<PortalSession>("POST", "/v1/billing/portal", undefined, options);
  }

  /** List billing invoices. */
  async listBillingInvoices(
    input: ListBillingInvoicesInput = {},
  ): Promise<BillingInvoiceListOutput> {
    // This endpoint nests the list in `data.invoices` unlike the other list
    // endpoints, which return `data` as the array directly.
    const { data, meta } = await this.rawRequest<{ invoices?: Invoice[] }>(
      "GET",
      appendQuery(
        "/v1/billing/invoices",
        input as Record<string, unknown>,
        BILLING_INVOICE_LIST_PARAM_KEYS,
        "listBillingInvoices",
      ),
    );
    return pageFromMeta({ invoices: data?.invoices ?? [] }, meta);
  }

  /**
   * Iterate all billing invoices, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllBillingInvoices(
    input: Omit<ListBillingInvoicesInput, "cursor"> = {},
  ): AsyncGenerator<Invoice, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      BILLING_INVOICE_LIST_PARAM_KEYS,
      "listAllBillingInvoices",
    );
    return this.paginateAll<Invoice, ListBillingInvoicesInput, BillingInvoiceListOutput>(
      "listAllBillingInvoices",
      input,
      (pageInput) => this.listBillingInvoices(pageInput),
      (page) => page.invoices,
    );
  }

  /** Register a custom domain. */
  async registerDomain(input: RegisterDomainInput, options?: RequestOptions): Promise<Domain> {
    requireObjectInput(input, "registerDomain");
    requireNoUnknownFields(input, REGISTER_DOMAIN_FIELD_KEYS, "registerDomain");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      REGISTER_DOMAIN_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as RegisterDomainInput;
    requireNonEmptyStringField(normalizedRecord, "domain", "registerDomain");
    requireMaxLength(normalized.domain as string, "domain", MAX_CUSTOM_DOMAIN);
    return this.request<Domain>("POST", "/v1/domains", normalized, options);
  }

  /** List custom domains. */
  async listDomains(input: ListDomainsInput = {}): Promise<DomainListOutput> {
    const { data, meta } = await this.rawRequest<Domain[]>(
      "GET",
      appendQuery(
        "/v1/domains",
        input as Record<string, unknown>,
        DOMAIN_LIST_PARAM_KEYS,
        "listDomains",
      ),
    );
    return pageFromMeta({ domains: data ?? [] }, meta);
  }

  /**
   * Iterate all domains, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllDomains(
    input: Omit<ListDomainsInput, "cursor"> = {},
  ): AsyncGenerator<Domain, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      DOMAIN_LIST_PARAM_KEYS,
      "listAllDomains",
    );
    return this.paginateAll<Domain, ListDomainsInput, DomainListOutput>(
      "listAllDomains",
      input,
      (pageInput) => this.listDomains(pageInput),
      (page) => page.domains,
    );
  }

  /** Get custom domain status. */
  async getDomain(domain: string): Promise<Domain> {
    requireNonEmptyId(domain, "getDomain", "domain");
    return this.request<Domain>("GET", `/v1/domains/${encodeURIComponent(domain)}`);
  }

  /** Remove a custom domain. */
  async deleteDomain(domain: string): Promise<void> {
    requireNonEmptyId(domain, "deleteDomain", "domain");
    await this.rawRequest("DELETE", `/v1/domains/${encodeURIComponent(domain)}`);
  }

  /** Trigger DNS verification for a custom domain. */
  async verifyDomain(domain: string, options?: RequestOptions): Promise<DomainVerifyResult> {
    requireNonEmptyId(domain, "verifyDomain", "domain");
    return this.request<DomainVerifyResult>(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/verify`,
      undefined,
      options,
    );
  }

  /** Regenerate a domain verification token. */
  async regenerateDomainToken(domain: string, options?: RequestOptions): Promise<Domain> {
    requireNonEmptyId(domain, "regenerateDomainToken", "domain");
    return this.request<Domain>(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/regenerate-token`,
      undefined,
      options,
    );
  }

  /** List webhooks. */
  async listWebhooks(input: ListWebhooksInput = {}): Promise<WebhookListOutput> {
    const { data, meta } = await this.rawRequest<Webhook[]>(
      "GET",
      appendQuery(
        "/v1/webhooks",
        input as Record<string, unknown>,
        WEBHOOK_LIST_PARAM_KEYS,
        "listWebhooks",
      ),
    );
    return pageFromMeta({ webhooks: data ?? [] }, meta);
  }

  /**
   * Iterate all webhooks, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllWebhooks(
    input: Omit<ListWebhooksInput, "cursor"> = {},
  ): AsyncGenerator<Webhook, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      WEBHOOK_LIST_PARAM_KEYS,
      "listAllWebhooks",
    );
    return this.paginateAll<Webhook, ListWebhooksInput, WebhookListOutput>(
      "listAllWebhooks",
      input,
      (pageInput) => this.listWebhooks(pageInput),
      (page) => page.webhooks,
    );
  }

  /** Create a webhook. */
  async createWebhook(
    input: CreateWebhookInput,
    options?: RequestOptions,
  ): Promise<WebhookWithSecret> {
    requireObjectInput(input, "createWebhook");
    requireNoUnknownFields(input, CREATE_WEBHOOK_FIELD_KEYS, "createWebhook");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      CREATE_WEBHOOK_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as CreateWebhookInput;
    validateWebhookWriteFields(normalizedRecord, "createWebhook", {
      url: true,
      events: true,
    });
    return this.request<WebhookWithSecret>("POST", "/v1/webhooks", normalized, options);
  }

  /** List available webhook event types. */
  async listWebhookEventTypes(): Promise<WebhookEventTypeInfo[]> {
    return this.request<WebhookEventTypeInfo[]>("GET", "/v1/webhooks/events");
  }

  /** Get a webhook. */
  async getWebhook(id: string): Promise<Webhook> {
    requireNonEmptyId(id, "getWebhook");
    return this.request<Webhook>("GET", `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /** Update a webhook. */
  async updateWebhook(
    id: string,
    input: UpdateWebhookInput,
    options?: RequestOptions,
  ): Promise<Webhook> {
    requireNonEmptyId(id, "updateWebhook");
    requireObjectInput(input, "updateWebhook");
    requireNoUnknownFields(input, UPDATE_WEBHOOK_FIELD_KEYS, "updateWebhook");
    const normalized = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_WEBHOOK_FIELD_KEYS,
    ) as UpdateWebhookInput;
    requireAtLeastOneField(
      normalized as Record<string, unknown>,
      UPDATE_WEBHOOK_FIELD_KEYS,
      "updateWebhook",
    );
    validateWebhookWriteFields(normalized as Record<string, unknown>, "updateWebhook");
    return this.request<Webhook>(
      "PATCH",
      `/v1/webhooks/${encodeURIComponent(id)}`,
      normalized,
      options,
    );
  }

  /** Delete a webhook. */
  async deleteWebhook(id: string): Promise<void> {
    requireNonEmptyId(id, "deleteWebhook");
    await this.rawRequest("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /** Regenerate a webhook signing secret. */
  async regenerateWebhookSecret(id: string, options?: RequestOptions): Promise<WebhookWithSecret> {
    requireNonEmptyId(id, "regenerateWebhookSecret");
    return this.request<WebhookWithSecret>(
      "POST",
      `/v1/webhooks/${encodeURIComponent(id)}/secret`,
      undefined,
      options,
    );
  }

  /** List delivery attempts for a webhook. */
  async listWebhookDeliveries(
    id: string,
    input: ListWebhookDeliveriesInput = {},
  ): Promise<WebhookDeliveryListOutput> {
    requireNonEmptyId(id, "listWebhookDeliveries");
    const { data, meta } = await this.rawRequest<WebhookDelivery[]>(
      "GET",
      appendQuery(
        `/v1/webhooks/${encodeURIComponent(id)}/deliveries`,
        input as Record<string, unknown>,
        WEBHOOK_DELIVERY_LIST_PARAM_KEYS,
        "listWebhookDeliveries",
      ),
    );
    return pageFromMeta({ deliveries: data ?? [] }, meta);
  }

  /**
   * Iterate all delivery attempts for a webhook, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllWebhookDeliveries(
    id: string,
    input: Omit<ListWebhookDeliveriesInput, "cursor"> = {},
  ): AsyncGenerator<WebhookDelivery, void, undefined> {
    requireNonEmptyId(id, "listAllWebhookDeliveries");
    validateListAllInput(
      input as Record<string, unknown>,
      WEBHOOK_DELIVERY_LIST_PARAM_KEYS,
      "listAllWebhookDeliveries",
    );
    return this.paginateAll<WebhookDelivery, ListWebhookDeliveriesInput, WebhookDeliveryListOutput>(
      "listAllWebhookDeliveries",
      input,
      (pageInput) => this.listWebhookDeliveries(id, pageInput),
      (page) => page.deliveries,
    );
  }

  /** Create a new API key. */
  async createApiKey(
    input: CreateApiKeyInput,
    options?: RequestOptions,
  ): Promise<CreateApiKeyOutput> {
    requireObjectInput(input, "createApiKey");
    requireNoUnknownFields(input, CREATE_API_KEY_FIELD_KEYS, "createApiKey");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      CREATE_API_KEY_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as CreateApiKeyInput;
    validateApiKeyWriteFields(normalizedRecord, "createApiKey", {
      name: true,
      scopes: true,
    });
    return this.request<CreateApiKeyOutput>("POST", "/v1/api-keys", normalized, options);
  }

  /** List API keys. */
  async listApiKeys(input: ListApiKeysInput = {}): Promise<ApiKeyListOutput> {
    const { data, meta } = await this.rawRequest<ApiKey[]>(
      "GET",
      appendQuery(
        "/v1/api-keys",
        input as Record<string, unknown>,
        API_KEY_LIST_PARAM_KEYS,
        "listApiKeys",
      ),
    );
    return pageFromMeta({ api_keys: data ?? [] }, meta);
  }

  /**
   * Iterate all API keys, automatically paginating.
   *
   * Input is validated synchronously when this method is called, before
   * iteration begins.
   */
  listAllApiKeys(
    input: Omit<ListApiKeysInput, "cursor"> = {},
  ): AsyncGenerator<ApiKey, void, undefined> {
    validateListAllInput(
      input as Record<string, unknown>,
      API_KEY_LIST_PARAM_KEYS,
      "listAllApiKeys",
    );
    return this.paginateAll<ApiKey, ListApiKeysInput, ApiKeyListOutput>(
      "listAllApiKeys",
      input,
      (pageInput) => this.listApiKeys(pageInput),
      (page) => page.api_keys,
    );
  }

  /** Update an API key. */
  async updateApiKey(
    keyId: string,
    input: UpdateApiKeyInput,
    options?: RequestOptions,
  ): Promise<ApiKey> {
    requireNonEmptyId(keyId, "updateApiKey");
    requireObjectInput(input, "updateApiKey");
    requireNoUnknownFields(input, UPDATE_API_KEY_FIELD_KEYS, "updateApiKey");
    const normalized = normalizePatchFields(
      input as Record<string, unknown>,
      UPDATE_API_KEY_FIELD_KEYS,
    ) as UpdateApiKeyInput;
    requireAtLeastOneField(
      normalized as Record<string, unknown>,
      UPDATE_API_KEY_FIELD_KEYS,
      "updateApiKey",
    );
    validateApiKeyWriteFields(normalized as Record<string, unknown>, "updateApiKey");
    return this.request<ApiKey>(
      "PATCH",
      `/v1/api-keys/${encodeURIComponent(keyId)}`,
      normalized,
      options,
    );
  }

  /** Revoke an API key. */
  async revokeApiKey(keyId: string): Promise<void> {
    requireNonEmptyId(keyId, "revokeApiKey");
    await this.rawRequest("DELETE", `/v1/api-keys/${encodeURIComponent(keyId)}`);
  }

  /** Redeem an access code. */
  async redeemAccessCode(
    input: RedeemAccessCodeInput,
    options?: RequestOptions,
  ): Promise<RedeemAccessCodeOutput> {
    requireObjectInput(input, "redeemAccessCode");
    requireNoUnknownFields(input, REDEEM_ACCESS_CODE_FIELD_KEYS, "redeemAccessCode");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      REDEEM_ACCESS_CODE_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as RedeemAccessCodeInput;
    requireNonEmptyStringField(normalizedRecord, "code", "redeemAccessCode");
    return this.request<RedeemAccessCodeOutput>(
      "POST",
      "/v1/access-codes/redeem",
      normalized,
      options,
    );
  }

  /** Create an access code. */
  async createAccessCode(
    input: CreateAccessCodeInput,
    options?: RequestOptions,
  ): Promise<CreateAccessCodeOutput> {
    requireObjectInput(input, "createAccessCode");
    requireNoUnknownFields(input, CREATE_ACCESS_CODE_FIELD_KEYS, "createAccessCode");
    const normalizedRecord = normalizePatchFields(
      input as Record<string, unknown>,
      CREATE_ACCESS_CODE_FIELD_KEYS,
    );
    const normalized = normalizedRecord as unknown as CreateAccessCodeInput;
    requireNonEmptyStringField(normalizedRecord, "resource_id", "createAccessCode");
    return this.request<CreateAccessCodeOutput>("POST", "/v1/access-codes", normalized, options);
  }

  /**
   * List access codes.
   *
   * The current API contract has no cursor query params for this endpoint.
   * If the service later advertises pagination metadata, the SDK returns
   * this page and emits a debug log rather than pretending it fetched all pages.
   */
  async listAccessCodes(): Promise<AccessCodeListOutput> {
    const { data, meta } = await this.rawRequest<AccessCode[]>("GET", "/v1/access-codes");
    if (meta?.has_more || meta?.next_cursor) {
      this.log("listAccessCodes: pagination metadata surfaced on unpaginated endpoint", {
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
      });
    }
    return {
      access_codes: data ?? [],
      request_id: meta?.request_id,
      has_more: false,
      page_size: meta?.page_size,
    };
  }

  /** Revoke an access code. */
  async revokeAccessCode(id: string): Promise<void> {
    requireNonEmptyId(id, "revokeAccessCode");
    await this.rawRequest("DELETE", `/v1/access-codes/${encodeURIComponent(id)}`);
  }

  // --- Internal HTTP plumbing ---

  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    requestOptions?: RequestOptions,
  ): Promise<T> {
    // List methods call rawRequest directly so 204 can degrade to an empty page.
    // Body-returning endpoints declare 200 JSON today, so this path fails closed.
    const { data, __http_status } = await this.rawRequest<T>(method, path, body, {
      requestOptions,
    });
    if (__http_status === 204) {
      throw unexpectedResponseError(
        `Unexpected 204 No Content from ${method} ${path}; expected response body`,
      );
    }
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
    method: HttpMethod,
    path: string,
    body?: unknown,
    rawOptions: RawRequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const { passthroughStatuses = NO_PASSTHROUGH_STATUSES, requestOptions } = rawOptions;
    const idempotencyKey = idempotencyKeyForRequest(method, requestOptions);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    // POST/PATCH keep status-code retries limited to rate limits. They
    // still retry fetch-level failures below with the same Idempotency-Key,
    // which fixes the duplicate-creation path from lost responses
    // without broadening mutating 5xx replay behavior.
    const mutating = IDEMPOTENCY_KEY_METHODS.has(method);
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
        // `timeout` is intentionally a per-attempt budget, not a total-
        // request budget. With maxRetries=3 and timeout=30s, a slow
        // upstream + retries can run up to ~120s total. The per-
        // attempt cap matches `fetch()` semantics elsewhere and lets
        // each retry get a fresh window — a half-completed slow
        // attempt shouldn't poison the next try's deadline. Total
        // request bound: roughly `timeout * (maxRetries + 1) +
        // sum(retryDelay)`.
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
          // rawRequest list callers may intentionally degrade 204/missing bodies
          // to empty collections; scalar/body helpers fail closed in request().
          // 204 on a non-DELETE method would deliver `undefined` to a
          // caller whose return type expects data — silent failure.
          // Surface via debug so operators see drift; the actual return
          // is unchanged for back-compat (DELETE is the only documented
          // 204-returning endpoint and its return type is `Promise<void>`).
          if (method !== "DELETE") {
            this.log(`unexpected 204 on ${method} ${url} — caller expected a response body`, {
              method,
              url,
            });
          }
          return { data: undefined as unknown as T, __http_status: response.status };
        }
        try {
          const json = (await response.json()) as ApiResponse<T>;
          return { ...json, __http_status: response.status };
        } catch {
          // Non-JSON body on a 2xx response (server contract violation)
          // or on a passthrough status (e.g. proxy HTML on 400). The
          // body stream is already consumed by the failed `.json()`,
          // so we can't delegate to parseError — synthesize a typed
          // QURLError directly so consumers catching by-class don't
          // miss it.
          this.log(
            `non-JSON body on ${isPassthrough ? "passthrough" : "success"} response ${response.status}`,
            {
              status: response.status,
              content_type: response.headers.get("content-type") ?? undefined,
            },
          );
          throw createError({
            status: response.status,
            code: ERROR_CODE_UNEXPECTED_RESPONSE,
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
        // HTTP/2 omits reason-phrases — `statusText` may be "".
        const title = err.title ?? (response.statusText || `HTTP ${response.status}`);
        return {
          status: err.status ?? response.status,
          code: err.code ?? ERROR_CODE_UNKNOWN,
          title,
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
      code: ERROR_CODE_UNKNOWN,
      title: response.statusText || `HTTP ${response.status}`,
      detail: response.statusText || `HTTP ${response.status}`,
    };
  }

  private parseRetryAfter(response: Response): number | undefined {
    // RFC 7231 §7.1.3: Retry-After honored on 429 + 503. (RFC 7231
    // also allows Retry-After on 3xx redirects; the SDK doesn't follow
    // redirects, so 429/503 cover the relevant cases.)
    if (response.status !== 429 && response.status !== 503) return undefined;
    const header = response.headers.get("Retry-After");
    if (!header) return undefined;
    // TODO: parse HTTP-date format per RFC 7231 §7.1.3 — currently only
    // handles delta-seconds; HTTP-date headers fall through to the
    // exponential-backoff branch in `retryDelay`. Tracked in #61.
    //
    // Digit-only pre-check rather than `parseInt` alone: `parseInt("60abc")`
    // returns `60` and would silently honor a malformed header. The
    // strict check makes any deviation observable (debug log) instead.
    const trimmed = header.trim();
    if (!/^\d+$/.test(trimmed)) {
      this.log("Retry-After header was non-numeric, using exponential backoff", {
        header_value: header.slice(0, 100),
      });
      return undefined;
    }
    const value = parseInt(trimmed, 10);
    // Reject pathological values at parse time. Without this, very large
    // integers (e.g. `Retry-After: 9999999999999`) propagate through the
    // `*1000` ms-conversion in retryDelay before the hard cap clamps
    // them — fail fast instead, with a debug breadcrumb. Cutoff matches
    // the hard cap so a clean cap-bounded value still parses.
    if (value > RETRY_AFTER_PARSE_LIMIT_S) {
      this.log("Retry-After header exceeded parse limit, using exponential backoff", {
        header_value: header.slice(0, 100),
        limit_seconds: RETRY_AFTER_PARSE_LIMIT_S,
      });
      return undefined;
    }
    return value;
  }

  /**
   * Compute the delay before the next retry attempt.
   *
   * - If the server sent a usable `Retry-After`, the value (converted
   *   from seconds to ms) is honored without the `RETRY_MAX_DELAY_MS`
   *   clamp — the cap exists to bound exponential backoff against
   *   ourselves; clamping a server-asserted directive (e.g.
   *   `Retry-After: 60`) down to 30s would just re-trip the rate limit.
   *   `Retry-After: 0` is honored verbatim per RFC 7231 §7.1.3 ("retry
   *   immediately").
   * - Otherwise: `RETRY_BASE_DELAY_MS * 2^(attempt-1)` plus 0-50%
   *   jitter, capped at `RETRY_MAX_DELAY_MS`.
   */
  private retryDelay(attempt: number, lastError?: Error): number {
    if (lastError instanceof QURLError && lastError.retryAfter !== undefined) {
      const requestedMs = lastError.retryAfter * 1000;
      if (requestedMs > RETRY_AFTER_HARD_CAP_MS) {
        this.log("Retry-After exceeded hard cap, truncating", {
          requested_seconds: lastError.retryAfter,
          capped_ms: RETRY_AFTER_HARD_CAP_MS,
        });
        return RETRY_AFTER_HARD_CAP_MS;
      }
      return requestedMs;
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
