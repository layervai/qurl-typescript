import type {
  AccessCode,
  AccessCodeListOutput,
  AccessToken,
  ApiKey,
  ApiKeyListOutput,
  ApiKeyRequestScope,
  BatchCreateInput,
  BatchCreateOutput,
  BillingInvoiceListOutput,
  CheckoutSession,
  ClientOptions,
  ConnectorInstallation,
  ConnectorInstallationListOutput,
  ConsumerAccessPolicy,
  ConsumerGrant,
  ConsumerGrantApprovalInput,
  ConsumerGrantListOutput,
  ConsumerInvitation,
  ConsumerInvitationListOutput,
  ConsumerListInput,
  CreateAccessCodeInput,
  CreateAccessCodeOutput,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  CreateBillingCheckoutInput,
  CreateDelegatedQurlBatchInput,
  CreateDelegatedQurlBatchOptions,
  CreateExternalIdentityBindingInput,
  CreateExternalIdentityBindingOutput,
  CreateInput,
  CreateOutput,
  CreatePortalOptions,
  CreateQurlForResourceInput,
  CreateResourceInput,
  CreateWebhookInput,
  Customer,
  DelegatedQurl,
  DelegatedQurlBatchAccepted,
  DelegatedQurlBatchItemResult,
  Domain,
  DomainListOutput,
  DomainVerifyResult,
  ExtendInput,
  GetDelegatedQurlBatchOptions,
  GetDelegatedQurlBatchOutput,
  Invoice,
  ListApiKeysInput,
  ListBillingInvoicesInput,
  ListConnectorInstallationsInput,
  ListDomainsInput,
  ListInput,
  ListOutput,
  ListWebhookDeliveriesInput,
  ListWebhooksInput,
  MintInput,
  MintOutput,
  Portal,
  PortalSession,
  ProtectUrlOptions,
  QURL,
  QURLErrorData,
  Quota,
  QurlSummary,
  RedeemAccessCodeInput,
  RedeemAccessCodeOutput,
  RegisterDomainInput,
  RequestOptions,
  ResolveInput,
  ResolveOutput,
  Resource,
  ResourceDetail,
  ResourceHandle,
  ResourceListInput,
  ResourceListOutput,
  Session,
  SessionListOutput,
  SessionTerminateOutput,
  ShareResourceOptions,
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
import {
  ERROR_CODE_AMBIGUOUS_RESOURCE,
  ERROR_CODE_RESOURCE_NOT_FOUND,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ERROR_CODE_UNKNOWN,
  NetworkError,
  NotFoundError,
  QURLError,
  RuntimeError,
  TimeoutError,
  ValidationError,
  createError,
} from "./errors.js";
import { copyResponseMetadata, withResponseMetadata } from "./response-metadata.js";
import { stripTrailingSlashes } from "./internal.js";
import { VERSION } from "./version.js";
import { ShareLink } from "./share.js";
import {
  MAX_AUTO_PAGINATION_PAGES,
  MAX_BATCH_ITEMS,
  MAX_CUSTOM_DOMAIN,
  MAX_DELEGATED_ETAG,
  MAX_DESCRIPTION,
  MAX_IDEMPOTENCY_KEY,
  MAX_LABEL,
  MAX_RESPONSE_BODY_BYTES,
  MAX_CONFIGURABLE_RESPONSE_BODY_BYTES,
  RETRY_AFTER_HARD_CAP_MS,
  RETRY_AFTER_PARSE_LIMIT_S,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "./client-limits.js";
import {
  TEXT_DECODER,
  TEXT_ENCODER,
  boundedErrorIdentifier,
  boundedErrorSnippet,
  boundedInvalidFields,
  boundedObjectKeys,
  boundedTombstone,
  clientValidationError,
  isIndependentAbort,
  isSdkTimeout,
  unexpectedResponseError,
  withErrorCause,
} from "./client-errors.js";
import {
  describeShape,
  normalizePatchFields,
  requireAtLeastOneField,
  requireBooleanIfPresent,
  requireConsumerDecision,
  requireListLimitInRange,
  requireMaxLength,
  requireMaxSessionsInRange,
  requireNoUnknownFields,
  requireNonEmptyIfPresent,
  requireNonEmptyStringField,
  requireObjectInput,
  requirePortalTargetUrl,
  requireValidAccessPolicy,
  requireValidTags,
} from "./client-validation.js";
import {
  API_KEY_LIST_PARAM_KEYS,
  BILLING_INVOICE_LIST_PARAM_KEYS,
  CONNECTOR_INSTALLATION_LIST_PARAM_KEYS,
  CREATE_ACCESS_CODE_FIELD_KEYS,
  CREATE_API_KEY_FIELD_KEYS,
  CREATE_BILLING_CHECKOUT_FIELD_KEYS,
  CREATE_QURL_FOR_RESOURCE_FIELD_KEYS,
  CREATE_RESOURCE_FIELD_KEYS,
  CREATE_WEBHOOK_FIELD_KEYS,
  DOMAIN_LIST_PARAM_KEYS,
  LIST_PARAM_KEYS,
  MINT_FIELD_KEYS,
  PROTECT_URL_OPTION_KEYS,
  REDEEM_ACCESS_CODE_FIELD_KEYS,
  REGISTER_DOMAIN_FIELD_KEYS,
  REQUEST_OPTION_KEYS,
  RESOURCE_LIST_PARAM_KEYS,
  SHARE_RESOURCE_OPTION_KEYS,
  UPDATE_API_KEY_FIELD_KEYS,
  UPDATE_CUSTOMER_FIELD_KEYS,
  UPDATE_FIELD_KEYS,
  UPDATE_RESOURCE_FIELD_KEYS,
  UPDATE_RESOURCE_QURL_FIELD_KEYS,
  UPDATE_WEBHOOK_FIELD_KEYS,
  WEBHOOK_DELIVERY_LIST_PARAM_KEYS,
  WEBHOOK_LIST_PARAM_KEYS,
} from "./client-input-fields.js";
import type { ApiErrorEnvelope, ApiResponse, HttpResponse } from "./client-http-types.js";
import {
  batchItemResultValidationReason,
  sameConsumerPolicy,
  validateCreateInput,
  validateQurlTokenOptions,
  validateResourceQurlUpdateInput,
  validateResourceWriteFields,
} from "./client-resources.js";
import {
  ProtectedResource,
  buildCreatePortalBody,
  extractAccessToken,
  parseApiDate,
  parsePortal,
} from "./client-portals.js";
import {
  ConnectorResource,
  classifyConnectorMutationFailure,
  parseConnectorResource,
  requireConnectorSlug,
  requireConnectorSubtleCrypto,
  verifyResourceIdentity,
} from "./client-connectors.js";
import {
  QURL_ID_PATH_OPTIONS,
  RESOURCE_OR_QURL_ID_PATH_OPTIONS,
  requireResourceCrid,
  validatePathId,
} from "./client-paths.js";
import type { EnsureConnectorResourceResult } from "./client-connectors.js";
import type { PortalWireResponse } from "./client-portals.js";
import {
  DELEGATED_BATCH_ID_PATTERN,
  DELEGATED_QURL_ID_PATTERN,
  STRONG_ETAG_PATTERN,
  classifyDelegatedBatchCreateFailure,
  delegatedBatchBase,
  delegatedEnvelope,
  delegatedResponseError,
  delegatedResponseHeaders,
  hasDelegatedNoStore,
  isUtcTimestamp,
  requiredDelegatedHeader,
  validateCreateDelegatedQurlBatchInput,
  validateDelegatedBatchCreateOptions,
  validateDelegatedBatchResults,
  validateDelegatedLocation,
  validateDelegatedQurl,
  validateGetDelegatedQurlBatchOptions,
} from "./client-delegated.js";
import {
  validateApiKeyWriteFields,
  validateEnrollmentTokenFields,
  validateWebhookWriteFields,
} from "./client-management.js";

const DEFAULT_BASE_URL = "https://api.layerv.ai";

const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_TIMEOUT = 30_000;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// Keep mutating status retries 429-only until the service-side idempotency
// cache contract is proven across 5xx, TTL, and replay-window edge cases.
// Fetch-level POST/PATCH retries still reuse Idempotency-Key below.
const RETRYABLE_STATUS_MUTATING = new Set([429]);

const REDIRECT_RESPONSE_STATUSES = new Set([300, 301, 302, 303, 305, 307, 308]);

const NO_RETRYABLE_STATUSES: ReadonlySet<number> = new Set<number>();

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

const IDEMPOTENCY_KEY_METHODS = new Set<HttpMethod>(["POST", "PATCH"]);

const MUTATING_RETRY_METHODS = new Set<HttpMethod>(["POST", "PATCH"]);

const IDEMPOTENCY_KEY_VALUE_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

const UUID_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

type RawRequestOptions = {
  passthroughStatuses?: readonly number[];
  requestOptions?: RequestOptions;
  allowEmptySuccessBody?: boolean;
  allowEmptyPassthroughBody?: boolean;
  retry?: boolean;
  /** When false, forward a caller key but do not create one for this operation. */
  generateIdempotencyKey?: boolean;
  ifNoneMatch?: string;
  /** Retain headers for endpoint-specific response checks. */
  captureResponseHeaders?: boolean;
  /** Mark the point after local preparation and immediately before fetch. */
  onDispatch?: () => void;
};

class ResponseBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response body exceeds ${limit}-byte limit`);
    this.name = "ResponseBodyTooLargeError";
  }
}

class InvalidResponseEncodingError extends Error {
  constructor() {
    super("Response body is not valid UTF-8");
    this.name = "InvalidResponseEncodingError";
  }
}

class ResponseBodyMaterializationError extends Error {
  constructor(message = "Response-like fetch returned a value that cannot be serialized as JSON") {
    super(message);
    this.name = "ResponseBodyMaterializationError";
  }
}

const NO_PASSTHROUGH_STATUSES: readonly number[] = [];

const BATCH_PASSTHROUGH_STATUSES: readonly number[] = [400];

const DELEGATED_BATCH_PASSTHROUGH_STATUSES: readonly number[] = [304];

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
    if (!IDEMPOTENCY_KEY_VALUE_RE.test(key)) {
      throw clientValidationError(
        "idempotencyKey: must contain only printable ASCII characters and must not start or end with spaces",
      );
    }
  }
}

function idempotencyKeyForRequest(
  method: HttpMethod,
  options: RequestOptions | undefined,
  generateWhenMissing = true,
): string | undefined {
  // Validate before method gating so future read-only methods that accept
  // RequestOptions fail loudly on malformed options instead of discarding them.
  validateRequestOptions(options);
  if (!IDEMPOTENCY_KEY_METHODS.has(method)) {
    return undefined;
  }
  return options?.idempotencyKey ?? (generateWhenMissing ? generateUuidV7() : undefined);
}

function generateUuidV7(): string {
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);

  const timestamp = Date.now();
  // Avoid right-shift operators here: JS bitwise shifts truncate to 32 bits,
  // while UUIDv7 stores a 48-bit millisecond timestamp.
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
  throw new RuntimeError(
    "globalThis.crypto.getRandomValues is required to generate Idempotency-Key",
  );
}

async function cancelResponseBody(body: Response["body"]): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Best-effort resource cleanup must not replace the deterministic SDK error.
  }
}

function materializedResponseBodyExceedsLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true;
  // Encoding creates another buffer. UTF-8 uses at most three bytes per
  // UTF-16 code unit, so shorter strings are provably safe without that copy.
  return value.length * 3 > limit && TEXT_ENCODER.encode(value).byteLength > limit;
}

function contentLengthExceedsLimit(response: Response, limit: number): boolean {
  // 204/205 never carry content, and a 304 Content-Length describes the
  // selected representation rather than a response body. Do not reject those
  // statuses for metadata about bytes that fetch will not deliver.
  if (response.status === 204 || response.status === 205 || response.status === 304) return false;
  // Encoded Content-Length describes wire bytes; fetch exposes decoded bytes.
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") return false;
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value.trim())) return false;
  return Number(value) > limit;
}

type ResponseUrlState = "same" | "changed" | "invalid";

/** Detect a followed redirect from fetch implementations that expose only the final URL. */
function responseUrlState(responseUrl: unknown, requestUrl: string): ResponseUrlState {
  if (typeof responseUrl !== "string" || responseUrl === "") return "same";
  if (responseUrl === requestUrl) return "same";
  try {
    // URL serialization normalizes equivalent spellings such as host case and
    // an explicit default port, so they do not create false redirect reports.
    return new URL(responseUrl).href === new URL(requestUrl).href ? "same" : "changed";
  } catch {
    // A non-empty invalid response URL cannot prove that credentials stayed on
    // the requested endpoint. Fail closed without reflecting it in diagnostics.
    return "invalid";
  }
}

/**
 * Read a response body while retaining accepted chunks up to the documented
 * cap. A fetch implementation can still hand us one arbitrarily large,
 * already-materialized chunk before we can reject it. For a compliant body,
 * final assembly transiently holds the chunks plus the combined output buffer
 * (roughly twice the cap) before decoding. Content-Length is an early-rejection
 * optimization only; streaming byte accounting remains authoritative because
 * that header may be absent or false.
 */
async function readBoundedResponseBody(response: Response, limit: number): Promise<string> {
  // `headers.get` is part of the documented injected-fetch contract. Detect a
  // malformed local shim before it can be mistaken for a retryable body-stream
  // failure and replay an otherwise deterministic GET programming error.
  if (typeof response.headers?.get !== "function") {
    throw new ResponseBodyMaterializationError(
      "Response-like fetch must provide headers.get(name)",
    );
  }
  if (contentLengthExceedsLimit(response, limit)) {
    await cancelResponseBody(response.body);
    throw new ResponseBodyTooLargeError(limit);
  }

  const body = response.body;
  if (body === null) return "";

  // Standards-compliant fetch implementations always expose a ReadableStream
  // for a non-empty body. Retain compatibility with Response-like test/custom
  // fetch implementations while still checking their materialized text before
  // this SDK parses it as JSON.
  if (body === undefined || typeof body.getReader !== "function") {
    let materializedText: unknown = "";
    if (typeof response.text === "function") {
      try {
        materializedText = await response.text();
      } catch {
        // Native fetch exposes a body stream above. A failing text() here is a
        // deterministic custom Response contract error, not a retryable reset.
        throw new ResponseBodyMaterializationError("Response-like fetch text() failed");
      }
    }
    const text = typeof materializedText === "string" ? materializedText : "";
    if (materializedResponseBodyExceedsLimit(text, limit)) {
      throw new ResponseBodyTooLargeError(limit);
    }
    if (
      text !== "" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
    ) {
      return text;
    }

    // Older injected Response-like objects may implement json() but return an
    // empty placeholder from text(). This path is never used by native fetch.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // A Response-like shim may expose json() but reject on an empty 204
      // body. Native fetch represents that body as null and returns above.
      return "";
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(parsed);
    } catch {
      throw new ResponseBodyMaterializationError();
    }
    if (serialized === undefined) return "";
    if (materializedResponseBodyExceedsLimit(serialized, limit)) {
      throw new ResponseBodyTooLargeError(limit);
    }
    return serialized;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new ResponseBodyMaterializationError(
          "Response-like fetch body stream must yield Uint8Array chunks",
        );
      }
      const nextTotal = total + value.byteLength;
      if (nextTotal > limit) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the body-limit failure even if stream cancellation fails.
        }
        throw new ResponseBodyTooLargeError(limit);
      }
      chunks.push(value);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }

  let bytes: Uint8Array;
  if (chunks.length === 1) {
    bytes = chunks[0];
  } else {
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    throw new InvalidResponseEncodingError();
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

function withEnvelopeMetadata<T>(value: T, meta: ApiResponse<unknown>["meta"]): T {
  return withResponseMetadata(value, boundedErrorIdentifier(meta?.request_id));
}

function pageFromMeta<T extends Record<string, unknown>>(
  out: T,
  meta: ApiResponse<unknown>["meta"],
): T & { next_cursor?: string; has_more: boolean; request_id?: string; page_size?: number } {
  return withEnvelopeMetadata(
    {
      ...out,
      next_cursor: meta?.next_cursor,
      has_more: meta?.has_more ?? Boolean(meta?.next_cursor),
      request_id: meta?.request_id,
      page_size: meta?.page_size,
    },
    meta,
  );
}

/** qURL API client. */
export class QURLClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly maxResponseBodyBytes: number;
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
    const responseLimit =
      options.maxResponseBodyBytes === undefined
        ? MAX_RESPONSE_BODY_BYTES
        : options.maxResponseBodyBytes;
    if (
      !Number.isSafeInteger(responseLimit) ||
      responseLimit < 1 ||
      responseLimit > MAX_CONFIGURABLE_RESPONSE_BODY_BYTES
    ) {
      throw clientValidationError(
        "maxResponseBodyBytes: must be an integer from 1 through 16777216 bytes",
      );
    }
    this.maxResponseBodyBytes = responseLimit;
    this.apiKey = options.apiKey;
    const rawBaseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
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
      return copyResponseMetadata(raw, rest);
    }
    // null is semantically "no tokens" — silent drop is fine, but surface
    // via debug so operators spot it if the API starts emitting null.
    if (qurls === null) {
      this.log("mapQurlsField: 'qurls' was null; dropping", { branch: "null" });
      return copyResponseMetadata(raw, rest);
    }
    if (qurls === undefined) {
      // Symmetric with null / non-array branches.
      this.log("mapQurlsField: 'qurls' was undefined; dropping", { branch: "undefined" });
      return copyResponseMetadata(raw, rest);
    }
    if (!rest.access_tokens) {
      return copyResponseMetadata(raw, { ...rest, access_tokens: qurls });
    }
    // Server-side bug — drop `qurls` rather than merge. If the arrays
    // disagree, no consistent reconciliation exists; a silent merge
    // could double-count or surface stale data.
    this.log("mapQurlsField: received both 'qurls' and 'access_tokens'; keeping access_tokens", {
      branch: "both",
      qurls_count: qurls.length,
      access_tokens_count: rest.access_tokens.length,
    });
    return copyResponseMetadata(raw, rest);
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
    response: HttpResponse<BatchCreateOutput>,
    requestItemCount: number,
  ): BatchCreateOutput {
    const result = response.envelope.data;
    const statusSuffix = ` (HTTP ${response.status})`;
    // Thread the server's request_id into the shape-guard error so
    // operators debugging "unexpected response" tickets have the
    // correlation handle on the error path, mirroring the success-
    // path propagation in batchCreate(). The field is optional —
    // older API versions without `meta.request_id` simply produce
    // an error without it, same as today. Embedded in BOTH the
    // .requestId property AND the message string so a stack trace
    // pasted into a support ticket carries the correlation handle
    // without a follow-up round-trip.
    const requestId = boundedErrorIdentifier(response.envelope.meta?.request_id);
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
        { requestId },
      );
    }

    if (result.succeeded + result.failed !== result.results.length) {
      throw unexpectedResponseError(
        `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: ` +
          `counts/results length mismatch (succeeded=${result.succeeded}, ` +
          `failed=${result.failed}, results.length=${result.results.length})${requestIdSuffix}`,
        { requestId },
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
        { requestId },
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
          { requestId },
        );
      }
      const entry = result.results[i] as { index: number };
      if (entry.index >= requestItemCount) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] index out of range (sent ${requestItemCount} items)${requestIdSuffix}`,
          { requestId },
        );
      }
      if (seenIndices.has(entry.index)) {
        throw unexpectedResponseError(
          `Unexpected response shape from POST /v1/qurls/batch${statusSuffix}: results[${i}] duplicate index${requestIdSuffix}`,
          { requestId },
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
        yield copyResponseMetadata(page, item);
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
          { requestId: page.request_id },
        );
      }
      seenCursors.add(cursor);
      if (pageCount >= MAX_AUTO_PAGINATION_PAGES) {
        throw unexpectedResponseError(
          `${methodName}: exceeded ${MAX_AUTO_PAGINATION_PAGES} auto-pagination pages without termination`,
          { requestId: page.request_id },
        );
      }
    } while (cursor);
  }

  // --- Portal API (mirrors qurl-go: ProtectURL → CreatePortal → EnterPortal) ---

  /**
   * Protect a private URL — create or reuse its LayerV resource.
   *
   * The first step of the portal flow (qurl-go: `Client.ProtectURL`).
   * Protect the URL once, then mint short-lived links for it with
   * {@link ProtectedResource.createPortal}:
   *
   * ```ts
   * const resource = await client.protectUrl("https://internal.example.com/dashboard");
   * const portal = await resource.createPortal({ validFor: "5m" });
   * share(portal.link);
   * ```
   *
   * Protecting the same target URL again returns the existing resource.
   * Malformed URLs and URLs with embedded credentials (userinfo) are
   * rejected before any request, mirroring qurl-go. REST-shaped equivalent:
   * {@link createResource}.
   */
  async protectUrl(
    targetUrl: string,
    opts: ProtectUrlOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<ProtectedResource> {
    requirePortalTargetUrl(targetUrl);
    requireObjectInput(opts, "protectUrl");
    requireNoUnknownFields(opts, PROTECT_URL_OPTION_KEYS, "protectUrl");
    // camelCase options → wire fields; null is treated as omitted, via the
    // SDK-wide normalizePatchFields convention.
    const normalized = normalizePatchFields(opts, PROTECT_URL_OPTION_KEYS) as ProtectUrlOptions;
    const body: Record<string, unknown> = { target_url: targetUrl };
    if (normalized.private !== undefined) body.private = normalized.private;
    if (normalized.consumerAccess !== undefined) {
      body.private = normalized.private ?? true;
      body.consumer_access = normalized.consumerAccess;
    }
    if (normalized.description !== undefined) body.description = normalized.description;
    if (normalized.tags !== undefined) body.tags = normalized.tags;
    if (normalized.customDomain !== undefined) body.custom_domain = normalized.customDomain;
    if (normalized.alias !== undefined) body.alias = normalized.alias;
    validateResourceWriteFields(body, { requireUrlTarget: true });
    const response = await this.rawRequest<Resource>("POST", "/v1/resources", body, {
      requestOptions,
    });
    if (response.status === 204)
      throw unexpectedResponseError("protectUrl: expected a resource response body");
    const resource = withEnvelopeMetadata(response.envelope.data, response.envelope.meta);
    await verifyResourceIdentity(resource, "protectUrl");
    if (
      normalized.consumerAccess &&
      (resource.private !== true ||
        !sameConsumerPolicy(
          resource.consumer_access,
          normalized.consumerAccess,
          response.envelope.meta?.found_existing === true,
        ))
    ) {
      throw unexpectedResponseError("protectUrl: private policy was not confirmed");
    }
    return new ProtectedResource(
      this,
      resource.crid as string,
      // Some resource types redact target_url in responses; fall back to
      // the caller-supplied URL so the handle stays useful.
      resource.target_url || targetUrl,
      resource,
    );
  }

  /**
   * Return a portal-minting handle for a stored CRID, without an API
   * call.
   *
   * Use when you persisted a LayerV CRID and want to mint more
   * portals for it (qurl-go: `Client.ResourceByCRID`):
   *
   * ```ts
   * const resource = client.resourceByCrid(storedCrid);
   * const portal = await resource.createPortal({ validFor: "1h" });
   * ```
   *
   * The handle carries no server metadata; use {@link getResource} when you
   * need the full resource details.
   */
  resourceByCrid(id: string): ProtectedResource {
    requireResourceCrid(id, "resourceByCrid");
    return new ProtectedResource(this, id);
  }

  /** Find or create the active qURL Connector resource for an immutable slug. */
  async ensureConnectorResource(
    slug: string,
    requestOptions?: RequestOptions,
    consumerAccess?: ConsumerAccessPolicy,
  ): Promise<EnsureConnectorResourceResult> {
    requireConnectorSlug(slug, "ensureConnectorResource");
    if (consumerAccess !== undefined) {
      validateResourceWriteFields({ consumer_access: consumerAccess, private: true });
      if (consumerAccess.version !== 1)
        throw clientValidationError("consumer_access: creation requires version one");
    }
    // Response validation imports the producer's P-256 resource key. Preflight
    // before POST so a missing runtime capability cannot orphan a committed row.
    requireConnectorSubtleCrypto("ensureConnectorResource");
    // Keep invalid options in the known pre-dispatch error arm. rawRequest
    // validates again when building the request, which protects future callers
    // that do not have this mutation-specific outcome contract.
    validateRequestOptions(requestOptions);
    let response: HttpResponse<Resource>;
    let resource: ConnectorResource;
    try {
      response = await this.rawRequest<Resource>(
        "POST",
        "/v1/resources",
        {
          type: "tunnel",
          slug,
          find_or_create: true,
          ...(consumerAccess ? { private: true, consumer_access: consumerAccess } : {}),
        },
        { requestOptions, retry: false, generateIdempotencyKey: false },
      );
      // The find-or-create endpoint returns 201 for both newly-created
      // and found-existing rows; meta.found_existing distinguishes the arms.
      if (response.status !== 201) {
        throw unexpectedResponseError(
          `ensureConnectorResource: expected HTTP 201, got ${response.status ?? "unknown"}`,
        );
      }
      if (
        consumerAccess &&
        (response.envelope.data.private !== true ||
          !sameConsumerPolicy(
            response.envelope.data.consumer_access,
            consumerAccess,
            response.envelope.meta?.found_existing === true,
          ))
      ) {
        throw unexpectedResponseError("ensureConnectorResource: private policy was not confirmed");
      }
      resource = await parseConnectorResource(
        this,
        response.envelope.data,
        "ensureConnectorResource",
        {
          slug,
        },
      );
    } catch (error) {
      classifyConnectorMutationFailure("ensure", error);
    }
    if (
      response.envelope.meta !== undefined &&
      response.envelope.meta !== null &&
      (typeof response.envelope.meta !== "object" || Array.isArray(response.envelope.meta))
    ) {
      classifyConnectorMutationFailure(
        "ensure",
        unexpectedResponseError("ensureConnectorResource: response has invalid meta"),
      );
    }
    const foundExisting = (
      response.envelope.meta as { found_existing?: unknown } | null | undefined
    )?.found_existing;
    if (foundExisting === undefined || foundExisting === null) {
      throw unexpectedResponseError(
        "ensureConnectorResource: response is missing meta.found_existing; the validated resource exists, so reconcile by slug before retrying",
      );
    }
    if (typeof foundExisting !== "boolean") {
      classifyConnectorMutationFailure(
        "ensure",
        unexpectedResponseError(
          "ensureConnectorResource: response has invalid meta.found_existing",
        ),
      );
    }
    return withEnvelopeMetadata(
      { resource: withEnvelopeMetadata(resource, response.envelope.meta), foundExisting },
      response.envelope.meta,
    );
  }

  /** Fetch a qURL Connector resource by its CRID. */
  async getConnectorResource(crid: string): Promise<ConnectorResource> {
    requireResourceCrid(crid, "getConnectorResource");
    requireConnectorSubtleCrypto("getConnectorResource");
    const {
      envelope: { data, meta },
      status: httpStatus,
    } = await this.rawRequest<ResourceDetail>(
      "GET",
      `/v1/resources/${encodeURIComponent(crid)}`,
      undefined,
      { retry: false },
    );
    if (httpStatus !== 200) {
      throw unexpectedResponseError(
        `getConnectorResource: expected HTTP 200, got ${httpStatus ?? "unknown"}`,
      );
    }
    return withEnvelopeMetadata(
      await parseConnectorResource(this, data?.resource, "getConnectorResource", {
        crid,
        revokedIsLifecycleError: true,
      }),
      meta,
    );
  }

  /** Fetch the single active qURL Connector resource for an immutable slug. */
  async getConnectorResourceBySlug(slug: string): Promise<ConnectorResource> {
    requireConnectorSlug(slug, "getConnectorResourceBySlug");
    // Parsing validates the returned P-256 resource key; avoid dispatching a
    // read that this runtime cannot safely consume.
    requireConnectorSubtleCrypto("getConnectorResourceBySlug");
    // The slug point lookup is intrinsically active-only. It also
    // rejects combining `slug` with `status`, so this query must stay slug-only.
    const {
      envelope: { data, meta },
      status: httpStatus,
    } = await this.rawRequest<Resource[]>(
      "GET",
      `/v1/resources?slug=${encodeURIComponent(slug)}`,
      undefined,
      { retry: false },
    );
    if (httpStatus !== 200) {
      throw unexpectedResponseError(
        `getConnectorResourceBySlug: expected HTTP 200, got ${httpStatus ?? "unknown"}`,
      );
    }
    if (!Array.isArray(data)) {
      throw unexpectedResponseError(
        "getConnectorResourceBySlug: response has missing or invalid data",
      );
    }
    if (data.length === 0) {
      throw new NotFoundError({
        status: 0,
        code: ERROR_CODE_RESOURCE_NOT_FOUND,
        title: "Resource Not Found",
        detail: "getConnectorResourceBySlug: no active resource exists for the requested slug",
      });
    }
    if (data.length > 1) {
      throw new QURLError({
        status: 0,
        code: ERROR_CODE_AMBIGUOUS_RESOURCE,
        title: "Ambiguous Resource",
        detail: `getConnectorResourceBySlug: expected one active resource, got ${data.length}`,
      });
    }
    return withEnvelopeMetadata(
      await parseConnectorResource(this, data[0], "getConnectorResourceBySlug", { slug }),
      meta,
    );
  }

  /**
   * Revoke a qURL Connector resource by CRID.
   *
   * The API does not apply Idempotency-Key replay to DELETE. After an
   * outcome-unknown failure, reconcile by ID before issuing a deliberate retry.
   */
  async deleteConnectorResource(crid: string): Promise<void> {
    requireResourceCrid(crid, "deleteConnectorResource");
    try {
      await this.requestNoContent(`/v1/resources/${encodeURIComponent(crid)}`);
    } catch (error) {
      classifyConnectorMutationFailure("delete", error);
    }
  }

  /**
   * Mint a short-lived qURL link (a portal) for a protected resource.
   *
   * A portal is cryptographic, just-in-time permission for one actor to
   * reach one private resource. Recipients open `portal.link` directly and
   * need no LayerV credentials. Prefer short lifetimes such as
   * `{ validFor: "5m" }`. Accepts a {@link ProtectedResource} handle or a
   * CRID string. REST-shaped equivalents: {@link mintLink} /
   * {@link createQurlForResource}.
   *
   * Duration options take a string (`"5m"`, `"24h"`; server-validated) or a
   * number of milliseconds with qurl-go's client-side guardrails: whole
   * seconds only, at least one minute for `validFor` and one second for
   * `sessionDuration`. `maxSessions: 0` is sent explicitly and means
   * unlimited; blank labels are rejected. `targetPath` is valid only for an
   * existing resource. The API owns its full grammar and tunnel-only gate.
   */
  async createPortal(
    resource: ProtectedResource | string,
    opts: CreatePortalOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<Portal> {
    let resourceId: string;
    if (typeof resource === "string") {
      resourceId = resource;
    } else if (resource instanceof ProtectedResource) {
      if (!ProtectedResource.isBoundTo(resource, this)) {
        throw clientValidationError("createPortal: resource is bound to a different client");
      }
      resourceId = resource.crid;
    } else {
      throw clientValidationError(
        `createPortal: resource must be a ProtectedResource handle or a CRID string (got ${describeShape(resource)})`,
      );
    }
    requireResourceCrid(resourceId, "createPortal");
    const body = buildCreatePortalBody(opts, "createPortal");
    const data = await this.request<PortalWireResponse>(
      "POST",
      `/v1/resources/${encodeURIComponent(resourceId)}/qurls`,
      body,
      requestOptions,
    );
    return parsePortal(data, "createPortal", resourceId, body.target_path as string | undefined);
  }

  /**
   * Protect `targetUrl` and mint a portal in one API call.
   *
   * Convenience for one-off scripts (qurl-go: `Client.CreatePortalForURL`).
   * The returned resource handle is reusable for minting more portals but
   * carries the CRID, verification key, and the caller-supplied target URL; use
   * {@link protectUrl} when you need the full server-populated resource
   * metadata. Portal options match {@link createPortal}; `targetUrl` gets
   * the same malformed-URL and embedded-credentials rejection as
   * {@link protectUrl}. `targetPath` is rejected because this call creates a
   * URL resource instead of addressing an existing resource. REST-shaped
   * equivalent: {@link create}.
   */
  async createPortalForUrl(
    targetUrl: string,
    opts: CreatePortalOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<{ portal: Portal; resource: ProtectedResource }> {
    requirePortalTargetUrl(targetUrl);
    const body: Record<string, unknown> = {
      target_url: targetUrl,
      ...buildCreatePortalBody(opts, "createPortalForUrl"),
    };
    const data = await this.request<PortalWireResponse>("POST", "/v1/qurls", body, requestOptions);
    const portal = await parsePortal(data, "createPortalForUrl");
    return copyResponseMetadata(data, {
      portal,
      resource: copyResponseMetadata(data, new ProtectedResource(this, portal.crid, targetUrl)),
    });
  }

  /**
   * Open a qURL link programmatically and return the reachable resource.
   *
   * For services and agents that open received qURL links in code — human
   * recipients just open the link. Accepts a full platform link
   * (`https://qurl.link/#at_...`) or a bare access token. Triggers an NHP
   * knock that grants network access for the caller's IP and returns a
   * {@link ResourceHandle} with the reachable resource URL and access
   * lifetime.
   *
   * Unlike qurl-go's `EnterPortal` (which verifies links locally and needs
   * no LayerV credentials), this SDK opens links through the LayerV API:
   * the client needs an API key with the `qurl:resolve` scope. REST-shaped
   * equivalent: {@link resolve}.
   *
   * Throws {@link ValidationError} (`code: "client_validation"`) when no
   * access token can be extracted from `qurlLink`, and
   * (`code: "unexpected_response"`) when access is granted but the API
   * reports no resource URL — it fails closed rather than returning an
   * empty handle. Error messages never echo the link; qURL links are
   * credentials.
   */
  async enterPortal(qurlLink: string, requestOptions?: RequestOptions): Promise<ResourceHandle> {
    const token = extractAccessToken(qurlLink);
    const resolved = await this.resolve(token, requestOptions);
    if (typeof resolved?.target_url !== "string" || resolved.target_url === "") {
      throw unexpectedResponseError(
        "enterPortal: access was granted but the API returned no resource URL",
      );
    }
    return copyResponseMetadata(resolved, {
      resourceUrl: resolved.target_url,
      openSeconds: resolved.access_grant?.expires_in ?? 0,
      resourcePublicKey: resolved.resource_id,
    });
  }

  // --- Public API ---

  /**
   * Create a new qURL.
   *
   * Portal-flow equivalent: {@link createPortalForUrl} (same endpoint,
   * returns a {@link Portal} plus a reusable resource handle).
   */
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
   *   HTTP 400 is the documented all-item validation failure. HTTP 422 is
   *   not a batch passthrough status and follows normal error handling.
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
    const response = await this.rawRequest<BatchCreateOutput>("POST", "/v1/qurls/batch", input, {
      passthroughStatuses: BATCH_PASSTHROUGH_STATUSES,
      requestOptions: options,
    });
    const result = this.validateBatchCreateResponse(response, input.items.length);
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
    const requestId = response.envelope.meta?.request_id;
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
    return withEnvelopeMetadata(
      requestId !== undefined ? { ...result, request_id: requestId } : result,
      response.envelope.meta,
    );
  }

  /**
   * Start one durable delegated qURL batch. The SDK sends this mutation once.
   * If the result may have committed, retry explicitly with the same key and
   * semantic body.
   */
  async createDelegatedQurlBatch(
    input: CreateDelegatedQurlBatchInput,
    options: CreateDelegatedQurlBatchOptions,
  ): Promise<DelegatedQurlBatchAccepted> {
    validateCreateDelegatedQurlBatchInput(input);
    validateDelegatedBatchCreateOptions(options);

    let dispatched = false;
    let acceptedBatchId: string | undefined;
    try {
      const response = await this.rawRequest<unknown>("POST", "/v1/delegated-qurl-batches", input, {
        requestOptions: options,
        retry: false,
        generateIdempotencyKey: false,
        captureResponseHeaders: true,
        onDispatch: () => {
          dispatched = true;
        },
      });
      const status = response.status ?? 0;
      if (status !== 202) {
        throw delegatedResponseError(status, "create returned an unexpected success status");
      }
      const rawData = response.envelope.data;
      if (typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)) {
        const candidate = (rawData as Record<string, unknown>).batch_id;
        if (typeof candidate === "string" && DELEGATED_BATCH_ID_PATTERN.test(candidate)) {
          acceptedBatchId = candidate;
        }
      }
      const { data, requestId } = delegatedEnvelope(response, status);
      const base = delegatedBatchBase(data, status, requestId);
      if (data.status !== "queued" || base.itemCount !== input.grants.length) {
        throw delegatedResponseError(status, "acceptance data is inconsistent", requestId);
      }
      const responseHeaders = delegatedResponseHeaders(response, status, requestId);
      const location = validateDelegatedLocation(
        requiredDelegatedHeader(response, "Location", status, requestId),
        this.baseUrl,
        base.batchId,
        status,
        requestId,
      );
      return withEnvelopeMetadata(
        {
          http_status: 202,
          batch_id: base.batchId,
          status: "queued",
          item_count: base.itemCount,
          submitted_at: base.submittedAt,
          etag: responseHeaders.etag,
          retry_after: responseHeaders.retryAfter,
          location,
          request_id: requestId,
        },
        response.envelope.meta,
      );
    } catch (error) {
      if (!dispatched) throw error;
      classifyDelegatedBatchCreateFailure(error, acceptedBatchId);
    }
  }

  /**
   * Read one delegated qURL batch state. One call performs one logical read;
   * callers retain control of the poll count and total deadline.
   */
  async getDelegatedQurlBatch(
    batchId: string,
    options?: GetDelegatedQurlBatchOptions,
  ): Promise<GetDelegatedQurlBatchOutput> {
    if (typeof batchId !== "string" || !DELEGATED_BATCH_ID_PATTERN.test(batchId)) {
      throw clientValidationError(
        "getDelegatedQurlBatch: batchId must match dqb_ plus 22 URL-safe characters",
      );
    }
    validateGetDelegatedQurlBatchOptions(options);

    const response = await this.rawRequest<unknown>(
      "GET",
      `/v1/delegated-qurl-batches/${encodeURIComponent(batchId)}`,
      undefined,
      {
        passthroughStatuses: DELEGATED_BATCH_PASSTHROUGH_STATUSES,
        allowEmptyPassthroughBody: true,
        ifNoneMatch: options?.etag,
        retry: false,
        captureResponseHeaders: true,
      },
    );
    const status = response.status ?? 0;
    if (status === 304) {
      if (response.bodyEmpty !== true || options?.etag === undefined) {
        throw delegatedResponseError(status, "304 response is inconsistent");
      }
      const responseHeaders = delegatedResponseHeaders(response, status);
      if (responseHeaders.etag !== undefined && responseHeaders.etag !== options.etag) {
        throw delegatedResponseError(status, "304 response changed the ETag");
      }
      return withEnvelopeMetadata(
        {
          http_status: 304,
          etag: responseHeaders.etag ?? options.etag,
          ...(responseHeaders.retryAfter === undefined
            ? {}
            : { retry_after: responseHeaders.retryAfter }),
        },
        response.envelope.meta,
      );
    }
    if (status !== 200 && status !== 202) {
      throw delegatedResponseError(status, "read returned an unexpected success status");
    }

    const { data, requestId } = delegatedEnvelope(response, status);
    const base = delegatedBatchBase(data, status, requestId, batchId);
    if (status === 202) {
      if (data.status !== "queued" && data.status !== "running") {
        throw delegatedResponseError(status, "pending data has a terminal status", requestId);
      }
      const responseHeaders = delegatedResponseHeaders(response, status, requestId);
      return withEnvelopeMetadata(
        {
          http_status: 202,
          batch_id: base.batchId,
          status: data.status,
          item_count: base.itemCount,
          submitted_at: base.submittedAt,
          etag: responseHeaders.etag,
          retry_after: responseHeaders.retryAfter,
          request_id: requestId,
        },
        response.envelope.meta,
      );
    }

    if (
      data.status !== "succeeded" &&
      data.status !== "partially_failed" &&
      data.status !== "failed"
    ) {
      throw delegatedResponseError(status, "terminal data has a non-terminal status", requestId);
    }
    let results: DelegatedQurlBatchItemResult[];
    try {
      if (!isUtcTimestamp(data.completed_at)) {
        throw delegatedResponseError(status, "terminal data has invalid completed_at", requestId);
      }
      results = validateDelegatedBatchResults(
        data.results,
        base.itemCount,
        data.status,
        status,
        requestId,
      );
    } catch (error) {
      const partialQurlIds = Array.isArray(data.results)
        ? [
            ...new Set(
              data.results.flatMap((item) =>
                item &&
                typeof item === "object" &&
                item.status === "succeeded" &&
                typeof item.qurl?.qurl_id === "string" &&
                DELEGATED_QURL_ID_PATTERN.test(item.qurl.qurl_id)
                  ? [item.qurl.qurl_id as string]
                  : [],
              ),
            ),
          ]
        : [];
      if (error instanceof QURLError)
        Object.defineProperty(error, "partialQurlIds", {
          value: Object.freeze(partialQurlIds),
          enumerable: true,
        });
      throw error;
    }
    // This is the caller's only copy of the bearer links. Do not discard a
    // valid terminal body because an intermediary removed a cache validator;
    // qurl-service owns the required no-store response policy.
    const cacheControl = response.headers?.get("Cache-Control") ?? null;
    if (!hasDelegatedNoStore(cacheControl)) {
      this.log("delegated batch terminal response is missing private, no-store", {
        batch_id: base.batchId,
      });
    }
    const etag = response.headers?.get("ETag") ?? undefined;
    const terminalEtag =
      etag !== undefined && etag.length <= MAX_DELEGATED_ETAG && STRONG_ETAG_PATTERN.test(etag)
        ? etag
        : undefined;
    return withEnvelopeMetadata(
      {
        http_status: 200,
        batch_id: base.batchId,
        status: data.status,
        item_count: base.itemCount,
        submitted_at: base.submittedAt,
        completed_at: data.completed_at,
        results,
        ...(terminalEtag === undefined ? {} : { etag: terminalEtag }),
        request_id: requestId,
      },
      response.envelope.meta,
    );
  }

  /** Read owner-visible metadata for one delegated qURL. */
  async getDelegatedQurl(qurlId: string): Promise<DelegatedQurl> {
    if (typeof qurlId !== "string" || !DELEGATED_QURL_ID_PATTERN.test(qurlId)) {
      throw clientValidationError(
        "getDelegatedQurl: qurlId must match q_ plus 11 lowercase hexadecimal characters",
      );
    }
    const response = await this.rawRequest<unknown>(
      "GET",
      `/v1/delegated-qurls/${encodeURIComponent(qurlId)}`,
    );
    const status = response.status ?? 0;
    if (status !== 200) {
      throw delegatedResponseError(status, "read returned an unexpected success status");
    }
    const { data, requestId } = delegatedEnvelope(response, status);
    return withEnvelopeMetadata(
      validateDelegatedQurl(data, qurlId, status, requestId),
      response.envelope.meta,
    );
  }

  /**
   * Revoke one delegated qURL. DELETE is never retried automatically. A 503
   * `mutation_outcome_unknown` is safe to retry with the same qURL ID.
   */
  async deleteDelegatedQurl(qurlId: string): Promise<void> {
    if (typeof qurlId !== "string" || !DELEGATED_QURL_ID_PATTERN.test(qurlId)) {
      throw clientValidationError(
        "deleteDelegatedQurl: qurlId must match q_ plus 11 lowercase hexadecimal characters",
      );
    }
    await this.requestNoContent(`/v1/delegated-qurls/${encodeURIComponent(qurlId)}`);
  }

  /**
   * Get a qURL resource and its access tokens.
   *
   * Accepts a CRID or qURL
   * display ID (`q_` prefix); the API resolves display IDs to the parent
   * resource automatically.
   */
  async get(id: string): Promise<QURL> {
    validatePathId(id, "get", "id", RESOURCE_OR_QURL_ID_PATH_OPTIONS);
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

    const {
      envelope: { data, meta },
    } = await this.rawRequest<(QURL & { qurls?: AccessToken[] })[]>("GET", path);
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
   * Requires a CRID returned by the API. To revoke one qURL, use
   * {@link revokeResourceQurl} instead.
   *
   * @throws {ValidationError} If `id` is not a canonical CRID.
   */
  async delete(id: string): Promise<void> {
    requireResourceCrid(id, "delete");
    await this.requestNoContent(`/v1/qurls/${encodeURIComponent(id)}`);
  }

  /**
   * Extend a qURL's expiration.
   *
   * Accepts a CRID or qURL
   * display ID (`q_` prefix). Delegates to {@link update} with only the
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
    validatePathId(id, "extend", "id", RESOURCE_OR_QURL_ID_PATH_OPTIONS);
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
   * Accepts a CRID or qURL
   * display ID (`q_` prefix); the API resolves display IDs to the parent
   * resource automatically.
   */
  async update(id: string, input: UpdateInput, options?: RequestOptions): Promise<QURL> {
    validatePathId(id, "update", "id", RESOURCE_OR_QURL_ID_PATH_OPTIONS);
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
   * Portal-flow equivalent: {@link createPortal}.
   *
   * Accepts a CRID or qURL
   * display ID (`q_` prefix); the API resolves display IDs to the parent
   * resource automatically.
   *
   * Passing `{}` or an object with all fields `null`/`undefined` is
   * equivalent to omitting the second argument: no body is sent, and the
   * server applies its 24h default expiration.
   */
  async mintLink(id: string, input?: MintInput, options?: RequestOptions): Promise<MintOutput> {
    validatePathId(id, "mintLink", "id", RESOURCE_OR_QURL_ID_PATH_OPTIONS);
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
   * Portal-flow equivalent: {@link enterPortal} (also accepts full qURL
   * links and fails closed when no resource URL is returned).
   *
   * Triggers an NHP knock to grant network access for the caller's IP.
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

  /** List resources from the `/v1/resources` API. */
  async listResources(input: ResourceListInput = {}): Promise<ResourceListOutput> {
    const {
      envelope: { data, meta },
    } = await this.rawRequest<Resource[]>(
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

  /**
   * Create a resource directly.
   *
   * Portal-flow equivalent for URL resources: {@link protectUrl} (returns
   * a portal-minting handle).
   */
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
    requireResourceCrid(id, "getResource");
    return this.request<ResourceDetail>("GET", `/v1/resources/${encodeURIComponent(id)}`);
  }

  /** Update resource metadata. */
  async updateResource(
    id: string,
    input: UpdateResourceInput,
    options?: RequestOptions,
  ): Promise<Resource> {
    requireResourceCrid(id, "updateResource");
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

  /** Send a publisher-only invitation. Mail delivery does not prove enrollment. */
  async inviteConsumer(id: string, email: string): Promise<ConsumerInvitation> {
    requireResourceCrid(id, "inviteConsumer");
    requireNonEmptyIfPresent(email, "email");
    if (typeof email !== "string" || email.length > 320)
      throw clientValidationError("email: must be a bounded string");
    return this.request<ConsumerInvitation>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/invitations`,
      { email },
    );
  }

  async listConsumerInvitations(
    id: string,
    input: ConsumerListInput = {},
  ): Promise<ConsumerInvitationListOutput> {
    requireResourceCrid(id, "listConsumerInvitations");
    const {
      envelope: { data, meta },
    } = await this.rawRequest<ConsumerInvitation[]>(
      "GET",
      appendQuery(
        `/v1/resources/${encodeURIComponent(id)}/invitations`,
        input as Record<string, unknown>,
        ["cursor", "limit"],
        "listConsumerInvitations",
      ),
    );
    return pageFromMeta({ invitations: data ?? [] }, meta);
  }

  async listConsumerGrants(
    id: string,
    input: ConsumerListInput = {},
  ): Promise<ConsumerGrantListOutput> {
    requireResourceCrid(id, "listConsumerGrants");
    const {
      envelope: { data, meta },
    } = await this.rawRequest<ConsumerGrant[]>(
      "GET",
      appendQuery(
        `/v1/resources/${encodeURIComponent(id)}/consumer-grants`,
        input as Record<string, unknown>,
        ["cursor", "limit"],
        "listConsumerGrants",
      ),
    );
    return pageFromMeta({ grants: data ?? [] }, meta);
  }

  async resendConsumerInvitation(
    id: string,
    invitationId: string,
    expectedVersion: number,
  ): Promise<ConsumerInvitation> {
    requireResourceCrid(id, "resendConsumerInvitation");
    requireConsumerDecision(invitationId, expectedVersion);
    return this.request<ConsumerInvitation>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}/resend`,
      { expected_version: expectedVersion },
    );
  }

  /** Remove the invitation and its grant. Inspect session_cleanup before reporting stream removal. */
  async revokeConsumerInvitation(
    id: string,
    invitationId: string,
    expectedVersion: number,
  ): Promise<ConsumerInvitation> {
    requireResourceCrid(id, "revokeConsumerInvitation");
    requireConsumerDecision(invitationId, expectedVersion);
    return this.request<ConsumerInvitation>(
      "DELETE",
      `/v1/resources/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}?expected_version=${expectedVersion}`,
    );
  }

  /** Review approval, key opt-in with grantId new, or trusted publisher entitlement. */
  async approveConsumerGrant(
    id: string,
    grantId: string,
    input: ConsumerGrantApprovalInput,
  ): Promise<ConsumerGrant> {
    requireResourceCrid(id, "approveConsumerGrant");
    requireObjectInput(input, "approveConsumerGrant");
    requireNoUnknownFields(
      input,
      [
        "expected_version",
        "credential_kind",
        "credential_id",
        "credential_public_key_b64",
        "entitlement_id",
        "expires_at",
      ],
      "approveConsumerGrant",
    );
    if (
      input.credential_kind !== undefined &&
      !["passkey", "device"].includes(input.credential_kind)
    ) {
      throw clientValidationError(
        "approveConsumerGrant: credential_kind must be passkey or device",
      );
    }
    requireConsumerDecision(grantId, input.expected_version, grantId === "new");
    return this.request<ConsumerGrant>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/consumer-grants/${encodeURIComponent(grantId)}/approve`,
      input,
    );
  }

  async denyConsumerGrant(
    id: string,
    grantId: string,
    expectedVersion: number,
  ): Promise<ConsumerGrant> {
    requireResourceCrid(id, "denyConsumerGrant");
    requireConsumerDecision(grantId, expectedVersion);
    return this.request<ConsumerGrant>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/consumer-grants/${encodeURIComponent(grantId)}/deny`,
      { expected_version: expectedVersion },
    );
  }

  async revokeConsumerGrant(
    id: string,
    grantId: string,
    expectedVersion: number,
  ): Promise<ConsumerGrant> {
    requireResourceCrid(id, "revokeConsumerGrant");
    requireConsumerDecision(grantId, expectedVersion);
    return this.request<ConsumerGrant>(
      "DELETE",
      `/v1/resources/${encodeURIComponent(id)}/consumer-grants/${encodeURIComponent(grantId)}?expected_version=${expectedVersion}`,
    );
  }

  /**
   * Revoke an API resource identifier retained by a client migrating to CRIDs.
   * New callers should use deleteResource with the resource CRID.
   */
  async deleteResourceByIdentifier(id: string): Promise<void> {
    if (typeof id !== "string") throw clientValidationError("id: invalid resource identifier");
    if (/^r_[a-z0-9_-]{11}$/.test(id)) {
      await this.requestNoContent(`/v1/qurls/${encodeURIComponent(id)}`);
      return;
    }
    const publicKey = /^[A-Za-z0-9_-]{107,214}$/.test(id) && id.length % 4 !== 1;
    if (!publicKey) requireResourceCrid(id, "deleteResourceByIdentifier");
    await this.requestNoContent(`/v1/resources/${encodeURIComponent(id)}`);
  }

  /** Revoke a resource and all of its qURLs. */
  async deleteResource(id: string): Promise<void> {
    requireResourceCrid(id, "deleteResource");
    await this.requestNoContent(`/v1/resources/${encodeURIComponent(id)}`);
  }

  /**
   * Mint a qURL against an existing resource.
   *
   * Portal-flow equivalent: {@link createPortal} (same endpoint).
   */
  async createQurlForResource(
    id: string,
    input?: CreateQurlForResourceInput,
    options?: RequestOptions,
  ): Promise<CreateOutput> {
    requireResourceCrid(id, "createQurlForResource");
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

  /**
   * Mint a fresh, short-lived share link for an existing CRID.
   * The returned link is secret and is not retrievable after this response.
   * If you hold the trusted resource DER SPKI, call `ShareLink.verifyCrid()`
   * before delivery to verify that the response CRID derives from that key.
   */
  async shareResource(
    id: string,
    options: ShareResourceOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<ShareLink> {
    requireResourceCrid(id, "shareResource");
    requireObjectInput(options, "shareResource");
    requireNoUnknownFields(options, SHARE_RESOURCE_OPTION_KEYS, "shareResource");
    const body: { ttl_seconds?: number } = {};
    if (options.ttlSeconds !== undefined) {
      if (
        typeof options.ttlSeconds !== "number" ||
        !Number.isSafeInteger(options.ttlSeconds) ||
        options.ttlSeconds <= 0
      ) {
        throw clientValidationError("shareResource: ttlSeconds must be a positive safe integer");
      }
      body.ttl_seconds = options.ttlSeconds;
    }
    const data = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/resources/${encodeURIComponent(id)}/share`,
      body,
      requestOptions,
    );
    if (typeof data?.qurl !== "string" || data.qurl.trim() === "") {
      throw unexpectedResponseError("shareResource: response is missing qurl");
    }
    if (data.crid !== id) {
      throw unexpectedResponseError(
        "shareResource: response CRID does not match the requested CRID",
      );
    }
    const wire = data;
    for (const field of ["qurl_id", "type", "expires_at"] as const) {
      const value = wire[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw unexpectedResponseError(`shareResource: response has invalid ${field}`);
      }
    }
    for (const field of ["qurl_id", "type"] as const) {
      const value = wire[field];
      if (typeof value === "string" && (value.trim() === "" || value.trim() !== value)) {
        throw unexpectedResponseError(`shareResource: response has invalid ${field}`);
      }
    }
    if (
      wire.expires_in_seconds !== undefined &&
      wire.expires_in_seconds !== null &&
      (typeof wire.expires_in_seconds !== "number" ||
        !Number.isSafeInteger(wire.expires_in_seconds) ||
        wire.expires_in_seconds < 0)
    ) {
      throw unexpectedResponseError("shareResource: response has invalid expires_in_seconds");
    }
    if (
      wire.single_use !== undefined &&
      wire.single_use !== null &&
      typeof wire.single_use !== "boolean"
    ) {
      throw unexpectedResponseError("shareResource: response has invalid single_use");
    }
    const expiresAt = parseApiDate(
      typeof wire.expires_at === "string" ? wire.expires_at : undefined,
    );
    if (typeof wire.expires_at === "string" && expiresAt === undefined) {
      throw unexpectedResponseError("shareResource: response has invalid expires_at");
    }
    return new ShareLink(
      copyResponseMetadata(data, {
        // Repair transport-only edge whitespace on the one-time credential;
        // ancillary identifiers fail closed instead of being normalized.
        link: data.qurl.trim(),
        qurlId: typeof wire.qurl_id === "string" ? wire.qurl_id : undefined,
        crid: id,
        type: typeof wire.type === "string" ? wire.type : undefined,
        expiresAt,
        expiresInSeconds:
          typeof wire.expires_in_seconds === "number" ? wire.expires_in_seconds : undefined,
        singleUse: typeof wire.single_use === "boolean" ? wire.single_use : undefined,
      }),
    );
  }

  /** Revoke a specific qURL token on a resource. */
  async revokeResourceQurl(id: string, qurlId: string): Promise<void> {
    requireResourceCrid(id, "revokeResourceQurl");
    validatePathId(qurlId, "revokeResourceQurl", "qurl id", QURL_ID_PATH_OPTIONS);
    await this.requestNoContent(
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
    requireResourceCrid(id, "updateResourceQurl");
    validatePathId(qurlId, "updateResourceQurl", "qurl id", QURL_ID_PATH_OPTIONS);
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

  /** List every active session, following bounded service pages. */
  async listResourceSessions(id: string): Promise<SessionListOutput> {
    requireResourceCrid(id, "listResourceSessions");
    const sessions: Session[] = [];
    let request_id: string | undefined;
    let page_size: number | undefined;
    for await (const session of this.paginateAll(
      "listResourceSessions",
      {},
      async ({ cursor }: { cursor?: string }) => {
        const {
          envelope: { data, meta },
        } = await this.rawRequest<Session[]>(
          "GET",
          appendQuery(
            `/v1/resources/${encodeURIComponent(id)}/sessions`,
            { paged: "true", cursor },
            ["paged", "cursor"],
            "listResourceSessions",
          ),
        );
        if (meta?.has_more && !meta.next_cursor) {
          throw unexpectedResponseError("Session page has no continuation cursor", {
            requestId: meta.request_id,
          });
        }
        request_id = meta?.request_id;
        page_size = meta?.page_size;
        return withEnvelopeMetadata({ ...meta, sessions: data ?? [] }, meta);
      },
      (page) => page.sessions,
    )) {
      sessions.push(session);
    }
    return withEnvelopeMetadata(
      { sessions, request_id, has_more: false, page_size },
      { request_id },
    );
  }

  /**
   * End every session page. This is not atomic: a failed page throws after earlier
   * pages may have closed sessions. List sessions to reconcile, then retry the call.
   * A retry can close newly admitted sessions and counts only its own transitions.
   */
  async terminateAllResourceSessions(id: string): Promise<SessionTerminateOutput> {
    requireResourceCrid(id, "terminateAllResourceSessions");
    const path = `/v1/resources/${encodeURIComponent(id)}/sessions`;
    let terminated = 0;
    let request_id: string | undefined;
    for await (const count of this.paginateAll(
      "terminateAllResourceSessions",
      {},
      async ({ cursor }: { cursor?: string }) => {
        const {
          envelope: { data, meta },
          status: httpStatus,
        } = await this.rawRequest<{ terminated?: number }>(
          "DELETE",
          appendQuery(
            path,
            { paged: "true", cursor },
            ["paged", "cursor"],
            "terminateAllResourceSessions",
          ),
        );
        if (httpStatus === 204) {
          throw unexpectedResponseError(
            `Unexpected 204 No Content from DELETE ${path}; expected response body`,
            { status: 204, requestId: meta?.request_id },
          );
        }
        if (meta?.has_more && !meta.next_cursor) {
          throw unexpectedResponseError("Session page has no continuation cursor", {
            requestId: meta.request_id,
          });
        }
        const count = data?.terminated;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw unexpectedResponseError(
            "terminateAllResourceSessions: missing or invalid terminated count; inspect sessions before retrying",
            { requestId: meta?.request_id },
          );
        }
        request_id = meta?.request_id;
        return withEnvelopeMetadata({ ...meta, counts: [count] }, meta);
      },
      (page) => page.counts,
    )) {
      terminated += count;
      if (!Number.isSafeInteger(terminated)) {
        throw unexpectedResponseError(
          "terminateAllResourceSessions: total exceeds safe integer range; inspect sessions before retrying",
          { requestId: request_id },
        );
      }
    }
    return withEnvelopeMetadata({ terminated, request_id }, { request_id });
  }

  /** Terminate a specific resource session. */
  async terminateResourceSession(id: string, sessionId: string): Promise<void> {
    requireResourceCrid(id, "terminateResourceSession");
    validatePathId(sessionId, "terminateResourceSession", "session id");
    await this.requestNoContent(
      `/v1/resources/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  /** List connector installations. */
  async listConnectorInstallations(
    input: ListConnectorInstallationsInput = {},
  ): Promise<ConnectorInstallationListOutput> {
    const {
      envelope: { data, meta },
    } = await this.rawRequest<ConnectorInstallationListOutput["installations"]>(
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
    const {
      envelope: { data, meta },
    } = await this.rawRequest<{ invoices?: Invoice[] }>(
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
    const {
      envelope: { data, meta },
    } = await this.rawRequest<Domain[]>(
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
    validatePathId(domain, "getDomain", "domain");
    return this.request<Domain>("GET", `/v1/domains/${encodeURIComponent(domain)}`);
  }

  /** Remove a custom domain. */
  async deleteDomain(domain: string): Promise<void> {
    validatePathId(domain, "deleteDomain", "domain");
    await this.requestNoContent(`/v1/domains/${encodeURIComponent(domain)}`);
  }

  /** Trigger DNS verification for a custom domain. */
  async verifyDomain(domain: string, options?: RequestOptions): Promise<DomainVerifyResult> {
    validatePathId(domain, "verifyDomain", "domain");
    return this.request<DomainVerifyResult>(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/verify`,
      undefined,
      options,
    );
  }

  /** Regenerate a domain verification token. */
  async regenerateDomainToken(domain: string, options?: RequestOptions): Promise<Domain> {
    validatePathId(domain, "regenerateDomainToken", "domain");
    return this.request<Domain>(
      "POST",
      `/v1/domains/${encodeURIComponent(domain)}/regenerate-token`,
      undefined,
      options,
    );
  }

  /** List webhooks. */
  async listWebhooks(input: ListWebhooksInput = {}): Promise<WebhookListOutput> {
    const {
      envelope: { data, meta },
    } = await this.rawRequest<Webhook[]>(
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
    validatePathId(id, "getWebhook");
    return this.request<Webhook>("GET", `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /** Update a webhook. */
  async updateWebhook(
    id: string,
    input: UpdateWebhookInput,
    options?: RequestOptions,
  ): Promise<Webhook> {
    validatePathId(id, "updateWebhook");
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
    validatePathId(id, "deleteWebhook");
    await this.requestNoContent(`/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /** Regenerate a webhook signing secret. */
  async regenerateWebhookSecret(id: string, options?: RequestOptions): Promise<WebhookWithSecret> {
    validatePathId(id, "regenerateWebhookSecret");
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
    validatePathId(id, "listWebhookDeliveries");
    const {
      envelope: { data, meta },
    } = await this.rawRequest<WebhookDelivery[]>(
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
    validatePathId(id, "listAllWebhookDeliveries");
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

  /**
   * Bind an external identity using the provider's trusted OAuth JWT as the
   * client's bearer credential. Persist the request key before calling, then
   * securely store the returned one-time plaintext key without logging it.
   * Retry a lost response within 24 hours with the same key and body.
   */
  async createExternalIdentityBinding(
    input: CreateExternalIdentityBindingInput,
    options: RequestOptions,
  ): Promise<CreateExternalIdentityBindingOutput> {
    const method = "createExternalIdentityBinding";
    requireObjectInput(input, method);
    requireNoUnknownFields(
      input,
      ["provider", "external_id", "display_name", "rotate_existing"],
      method,
    );
    if (!["slack", "discord", "teams"].includes(input.provider)) {
      throw clientValidationError(`${method}: provider must be slack, discord, or teams`);
    }
    if (
      typeof input.external_id !== "string" ||
      input.external_id.length > 256 ||
      !/^[\x21-\x22\x24-\x7e]+$/.test(input.external_id)
    ) {
      throw clientValidationError(
        `${method}: external_id must contain 1-256 visible ASCII characters without #`,
      );
    }
    if (
      input.display_name !== undefined &&
      (typeof input.display_name !== "string" ||
        [...input.display_name].length > 100 ||
        /[\uD800-\uDFFF]/u.test(input.display_name))
    ) {
      throw clientValidationError(
        `${method}: display_name must contain at most 100 Unicode characters`,
      );
    }
    requireBooleanIfPresent(input.rotate_existing, `${method}.rotate_existing`);
    validateRequestOptions(options);
    if (!options?.idempotencyKey || options.idempotencyKey.length < 32) {
      throw clientValidationError(
        `${method}: a persisted idempotencyKey of 32-256 characters is required`,
      );
    }
    const body: CreateExternalIdentityBindingInput = {
      provider: input.provider,
      external_id: input.external_id,
      ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
      ...(input.rotate_existing !== undefined ? { rotate_existing: input.rotate_existing } : {}),
    };
    const raw = await this.rawRequest<never>("POST", "/v1/external-identity-bindings", body, {
      requestOptions: options,
      generateIdempotencyKey: false,
    });
    // This operation returns a flat document, unlike the data/meta endpoints.
    const result = raw.envelope as unknown as CreateExternalIdentityBindingOutput;
    const expectedScopes =
      body.provider === "discord"
        ? ["qurl:read", "qurl:write"]
        : ["qurl:read", "qurl:write", "qurl:agent"];
    if (
      raw.status !== 201 ||
      typeof result.binding_id !== "string" ||
      !/^eib_[A-Za-z0-9]{11}$/.test(result.binding_id) ||
      result.provider !== body.provider ||
      result.external_id !== body.external_id ||
      !result.api_key ||
      typeof result.api_key !== "object" ||
      Array.isArray(result.api_key) ||
      typeof result.api_key.key_id !== "string" ||
      !/^key_[A-Za-z0-9]{12}$/.test(result.api_key.key_id) ||
      typeof result.api_key.plaintext !== "string" ||
      !/^lv_(?:live|test)_[A-Za-z0-9_-]{43}$/.test(result.api_key.plaintext) ||
      result.api_key.key_prefix !== result.api_key.plaintext.slice(0, 12) ||
      !Array.isArray(result.scopes) ||
      result.scopes.length !== expectedScopes.length ||
      !expectedScopes.every((scope) => result.scopes.includes(scope as ApiKeyRequestScope)) ||
      !isUtcTimestamp(result.created_at) ||
      (result.display_name !== undefined &&
        (typeof result.display_name !== "string" ||
          [...result.display_name].length > 100 ||
          /[\uD800-\uDFFF]/u.test(result.display_name)))
    ) {
      throw unexpectedResponseError(
        `${method}: invalid binding response; reconcile with the same request key before retrying`,
      );
    }
    return withEnvelopeMetadata(
      {
        binding_id: result.binding_id,
        provider: result.provider,
        external_id: result.external_id,
        ...(result.display_name !== undefined ? { display_name: result.display_name } : {}),
        api_key: {
          key_id: result.api_key.key_id,
          key_prefix: result.api_key.key_prefix,
          plaintext: result.api_key.plaintext,
        },
        scopes: result.scopes,
        created_at: result.created_at,
      },
      raw.envelope.meta,
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
    // `kind` is required by the server and has no default there. Filling it
    // in keeps the common durable-key call site unchanged.
    normalizedRecord.kind ??= "api_key";
    if (normalizedRecord.kind !== "api_key" && normalizedRecord.kind !== "enrollment_token") {
      throw clientValidationError("createApiKey: kind must be 'api_key' or 'enrollment_token'");
    }
    // `scopes` and `target`/`claims` are mutually exclusive by kind, and the
    // server rejects either mismatch with 400 invalid_input. Fail both
    // directions locally rather than paying a round trip.
    const isEnrollmentToken = normalizedRecord.kind === "enrollment_token";
    if (isEnrollmentToken) {
      if (normalizedRecord.scopes !== undefined) {
        throw clientValidationError(
          "createApiKey: scopes is not accepted for kind 'enrollment_token'; " +
            "the server assigns them from target",
        );
      }
      validateEnrollmentTokenFields(normalizedRecord, "createApiKey");
    } else {
      for (const field of ["target", "claims", "expires_in"] as const) {
        if (normalizedRecord[field] !== undefined) {
          throw clientValidationError(
            `createApiKey: ${field} is only accepted for kind 'enrollment_token'`,
          );
        }
      }
    }
    const normalized = normalizedRecord as unknown as CreateApiKeyInput;
    validateApiKeyWriteFields(normalizedRecord, "createApiKey", {
      name: true,
      scopes: !isEnrollmentToken,
    });
    return this.request<CreateApiKeyOutput>("POST", "/v1/api-keys", normalized, options);
  }

  /** List API keys. */
  async listApiKeys(input: ListApiKeysInput = {}): Promise<ApiKeyListOutput> {
    const {
      envelope: { data, meta },
    } = await this.rawRequest<ApiKey[]>(
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
    validatePathId(keyId, "updateApiKey");
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
    validatePathId(keyId, "revokeApiKey");
    await this.requestNoContent(`/v1/api-keys/${encodeURIComponent(keyId)}`);
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
    requireResourceCrid(normalizedRecord.resource_id as string, "createAccessCode", "resource_id");
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
    const {
      envelope: { data, meta },
    } = await this.rawRequest<AccessCode[]>("GET", "/v1/access-codes");
    if (meta?.has_more || meta?.next_cursor) {
      this.log("listAccessCodes: pagination metadata surfaced on unpaginated endpoint", {
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
      });
    }
    return withEnvelopeMetadata(
      {
        access_codes: data ?? [],
        request_id: meta?.request_id,
        has_more: false,
        page_size: meta?.page_size,
      },
      meta,
    );
  }

  /** Revoke an access code. */
  async revokeAccessCode(id: string): Promise<void> {
    validatePathId(id, "revokeAccessCode");
    await this.requestNoContent(`/v1/access-codes/${encodeURIComponent(id)}`);
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
    const {
      envelope: { data, meta },
      status: httpStatus,
    } = await this.rawRequest<T>(method, path, body, {
      requestOptions,
    });
    if (httpStatus === 204) {
      throw unexpectedResponseError(
        `Unexpected 204 No Content from ${method} ${path}; expected response body`,
      );
    }
    return withEnvelopeMetadata(data, meta);
  }

  /**
   * Require the service's exact 204 response with no response bytes exposed by
   * Fetch. A standards-compliant Fetch implementation discards any forbidden
   * wire body on 204, so the SDK cannot detect bytes that Fetch did not expose.
   */
  private async requestNoContent(path: string): Promise<void> {
    const response = await this.rawRequest<never>("DELETE", path, undefined, {
      allowEmptySuccessBody: true,
    });
    if (response.status !== 204 || response.bodyEmpty !== true) {
      const status = response.status ?? 0;
      const bodyShape = response.bodyEmpty ? "with an empty body" : "with response bytes";
      throw unexpectedResponseError(
        `Unexpected response from DELETE; expected empty HTTP 204, received HTTP ${status} ${bodyShape}. ` +
          "The delete may already have been applied; reconcile resource state before retrying.",
        { status },
      );
    }
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
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const {
      passthroughStatuses = NO_PASSTHROUGH_STATUSES,
      requestOptions,
      allowEmptySuccessBody = false,
      allowEmptyPassthroughBody = false,
      retry = true,
      generateIdempotencyKey = true,
      ifNoneMatch,
      captureResponseHeaders = false,
      onDispatch,
    } = rawOptions;
    const idempotencyKey = idempotencyKeyForRequest(method, requestOptions, generateIdempotencyKey);
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
    if (ifNoneMatch !== undefined) {
      headers["If-None-Match"] = ifNoneMatch;
    }

    // Reads may retry transient statuses and transport failures. POST/PATCH
    // keep status-code retries limited to rate limits and reuse the same
    // Idempotency-Key for fetch-level failures. DELETE is deliberately never
    // replayed, including after 429: this matches qurl-go's no-hidden-HTTP-
    // retry rule and avoids SDK pacing on an application request path. The
    // caller receives retryAfter when supplied and must reconcile resource
    // state before it chooses to issue another delete.
    const idempotencyKeyBackedRetry = retry && MUTATING_RETRY_METHODS.has(method);
    const retryFetchFailure = retry && (method === "GET" || idempotencyKeyBackedRetry);
    const retryable = !retry
      ? NO_RETRYABLE_STATUSES
      : method === "GET"
        ? RETRYABLE_STATUS
        : idempotencyKeyBackedRetry
          ? RETRYABLE_STATUS_MUTATING
          : NO_RETRYABLE_STATUSES;
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
      const requestSignal = AbortSignal.timeout(this.timeout);
      try {
        // `timeout` is intentionally a per-attempt budget, not a total-
        // request budget. With maxRetries=3 and timeout=30s, a slow
        // upstream + retries can run up to ~120s total. The per-
        // attempt cap matches `fetch()` semantics elsewhere and lets
        // each retry get a fresh window — a half-completed slow
        // attempt shouldn't poison the next try's deadline. Total
        // request bound: roughly `timeout * (maxRetries + 1) +
        // sum(retryDelay)`.
        onDispatch?.();
        response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
          redirect: "manual",
          signal: requestSignal,
        });
      } catch (err) {
        lastError = this.classifyFetchError(err, requestSignal);
        this.log(
          `${method} ${url} ${lastError instanceof TimeoutError ? "timed out" : "network error"}`,
          {
            error: boundedErrorSnippet(lastError.message),
          },
        );
        // An injected fetch can abort or impose a deadline for its own reason.
        // That is not this SDK's timeout. Replaying it can defeat caller-side
        // cancellation or deadline policy.
        if (
          retryFetchFailure &&
          !isIndependentAbort(err, requestSignal) &&
          attempt < this.maxRetries
        ) {
          continue;
        }
        throw lastError;
      }

      this.log(`${method} ${url} → ${response.status}`);

      // Redirects are deterministic protocol violations for SDK API calls.
      // Refuse them before reading Location or entering retry handling so
      // Authorization and Idempotency-Key can never reach a follow-up target.
      const responseUrlStateValue = responseUrlState(response.url, url);
      if (
        response.redirected === true ||
        responseUrlStateValue !== "same" ||
        REDIRECT_RESPONSE_STATUSES.has(response.status) ||
        response.type === "opaqueredirect"
      ) {
        await cancelResponseBody(response.body);
        const redirectKind =
          response.redirected === true
            ? "followed"
            : responseUrlStateValue === "invalid"
              ? "invalid custom Response.url"
              : responseUrlStateValue === "changed"
                ? "changed Response.url"
                : REDIRECT_RESPONSE_STATUSES.has(response.status)
                  ? `HTTP ${response.status}`
                  : "opaque";
        throw unexpectedResponseError(`Refused ${redirectKind} redirect response for ${method}`, {
          status: response.status,
        });
      }

      let responseBody: string;
      try {
        responseBody = await readBoundedResponseBody(response, this.maxResponseBodyBytes);
      } catch (err) {
        if (err instanceof ResponseBodyTooLargeError) {
          this.log(`rejected oversized response body from ${response.status}`, {
            status: response.status,
          });
          const detail =
            `Response body exceeds ${this.maxResponseBodyBytes}-byte limit on HTTP ${response.status}; ` +
            "request a smaller page when listing collections";
          if (response.ok) {
            throw unexpectedResponseError(detail, { status: response.status });
          }
          const bodyError = createError({
            status: response.status,
            // The unread body cannot supply a trustworthy server code. Keep
            // the real HTTP status class (429/5xx) just like other unreadable
            // error bodies instead of reclassifying it as client validation.
            code: ERROR_CODE_UNKNOWN,
            title: boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`,
            detail,
            retry_after: this.parseRetryAfter(response),
          });
          // The unread body does not change operation semantics: retry a GET,
          // or an idempotency-key-backed mutation on an explicitly retryable
          // status. Successful oversized responses remain deterministic
          // contract failures, and DELETE has no retryable statuses.
          if (retryable.has(response.status) && attempt < this.maxRetries) {
            lastError = bodyError;
            continue;
          }
          throw bodyError;
        }
        if (err instanceof InvalidResponseEncodingError) {
          this.log(`rejected malformed UTF-8 response body from ${response.status}`, {
            status: response.status,
          });
          const detail = `Response body is not valid UTF-8 on HTTP ${response.status}`;
          if (response.ok) {
            // A successful status with an invalid wire body is a deterministic
            // response-contract failure. Do not replay a GET or a mutation.
            throw unexpectedResponseError(detail, { status: response.status });
          }
          const encodingError = createError({
            status: response.status,
            code: ERROR_CODE_UNKNOWN,
            title: boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`,
            detail,
            retry_after: this.parseRetryAfter(response),
          });
          // For an explicit error status, the HTTP classification remains
          // authoritative even when its body encoding is invalid.
          if (retryable.has(response.status) && attempt < this.maxRetries) {
            lastError = encodingError;
            continue;
          }
          throw encodingError;
        }
        await cancelResponseBody(response.body);
        const transportReadError = this.classifyResponseReadError(err, response, requestSignal);
        if (transportReadError !== undefined) {
          this.log(`transport failure while reading response body from ${response.status}`, {
            status: response.status,
            error: transportReadError.code,
          });
          // A successful GET can be replayed when its success body is lost. A
          // non-success GET retries only the status set that the normal error
          // path retries. Mutations are never replayed after a body transport
          // failure because the operation may have applied.
          if (
            method === "GET" &&
            !isIndependentAbort(err, requestSignal) &&
            (response.ok || retryable.has(response.status)) &&
            attempt < this.maxRetries
          ) {
            lastError = transportReadError;
            continue;
          }
          throw transportReadError;
        }
        this.log(`failed to read response body from ${response.status}`, {
          status: response.status,
        });
        // ResponseBodyMaterializationError messages are fixed SDK-authored
        // contract text. The underlying shim rejection is never interpolated.
        const detail =
          err instanceof ResponseBodyMaterializationError
            ? err.message
            : `Failed to read response body on HTTP ${response.status}`;
        const readError = response.ok
          ? unexpectedResponseError(detail, { status: response.status })
          : createError({
              status: response.status,
              code: ERROR_CODE_UNKNOWN,
              title: boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`,
              detail,
              retry_after: this.parseRetryAfter(response),
            });
        // This arm contains deterministic Response-like shim failures (for
        // example a BigInt returned by json()) and non-Error throws. Do not
        // replay them: another attempt will see the same local contract bug.
        throw err instanceof ResponseBodyMaterializationError
          ? withErrorCause(readError, err)
          : readError;
      }

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
          return {
            envelope: { data: undefined as unknown as T },
            status: response.status,
            bodyEmpty: responseBody.length === 0,
            headers: captureResponseHeaders ? response.headers : undefined,
          };
        }
        // Exact no-content helpers must inspect both axes of the success
        // contract. Let only those callers observe an empty non-204 response;
        // body-returning methods still reject it as non-JSON below.
        if (
          ((response.ok && allowEmptySuccessBody) ||
            (isPassthrough && allowEmptyPassthroughBody)) &&
          responseBody.length === 0
        ) {
          return {
            envelope: { data: undefined as unknown as T },
            status: response.status,
            bodyEmpty: true,
            headers: captureResponseHeaders ? response.headers : undefined,
          };
        }
        try {
          const json = JSON.parse(responseBody) as ApiResponse<T>;
          return {
            envelope: { ...json },
            status: response.status,
            // JSON.parse("") throws, so parsed JSON is necessarily non-empty.
            bodyEmpty: false,
            headers: captureResponseHeaders ? response.headers : undefined,
          };
        } catch {
          // Non-JSON body on a 2xx response (server contract violation)
          // or on a passthrough status (e.g. proxy HTML on 400). The
          // body was read through the cap before JSON decoding.
          // Synthesize a typed QURLError directly so consumers catching
          // by-class don't miss the contract failure.
          this.log(
            `non-JSON body on ${isPassthrough ? "passthrough" : "success"} response ${response.status}`,
            {
              status: response.status,
              content_type: boundedErrorSnippet(response.headers.get("content-type")),
            },
          );
          throw createError({
            status: response.status,
            code: ERROR_CODE_UNEXPECTED_RESPONSE,
            title: boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`,
            detail: `Expected JSON response body on HTTP ${response.status} but received non-JSON content`,
          });
        }
      }

      const errorData = this.parseError(response, responseBody);
      const err = createError(errorData);

      // Retryability is determined by status even when an intermediary
      // returned HTML, an empty body, or another non-envelope error. Those
      // shapes are common for transient 429/502/503/504 responses and do not
      // prove that a retry cannot succeed. Redirects and oversized bodies
      // already throw before reaching this check.
      if (retryable.has(response.status) && attempt < this.maxRetries) {
        lastError = err;
        continue;
      }

      throw err;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private parseError(response: Response, responseBody: string): QURLErrorData {
    try {
      const json = JSON.parse(responseBody) as ApiErrorEnvelope;
      if (json.error) {
        const err = json.error;
        // Detail fallback chain:
        //   1. err.detail   (RFC 7807 primary)
        //   2. err.message  (legacy pre-RFC-7807 shape)
        //   3. err.title    (RFC 7807 required field)
        //   4. HTTP status  (final safety net)
        // This prevents `"Title (403): undefined"` when the API omits detail.
        const detail =
          boundedErrorSnippet(err.detail) ??
          boundedErrorSnippet(err.message) ??
          boundedErrorSnippet(err.title) ??
          `HTTP ${response.status}`;
        // HTTP/2 omits reason-phrases — `statusText` may be "".
        const title =
          boundedErrorSnippet(err.title) ??
          boundedErrorSnippet(response.statusText) ??
          `HTTP ${response.status}`;
        // The transport status is authoritative for error classification. A
        // conflicting or malformed RFC 7807 body must not turn a real 5xx into
        // a NotFoundError (or vice versa) in caller reconciliation logic.
        const status = response.status;
        return {
          status,
          code: boundedErrorIdentifier(err.code) ?? ERROR_CODE_UNKNOWN,
          title,
          detail,
          type: boundedErrorIdentifier(err.type),
          instance: boundedErrorIdentifier(err.instance),
          invalid_fields: boundedInvalidFields(err.invalid_fields),
          request_id: boundedErrorIdentifier(json.meta?.request_id),
          tombstone: response.status === 410 ? boundedTombstone(json.meta?.tombstone) : undefined,
          retry_after: this.parseRetryAfter(response),
        };
      }
      // JSON parsed cleanly but the `error` envelope is missing — the API
      // returned an unexpected shape. Surface it through debugFn so
      // operators can spot the divergence; fall through to the
      // status-only safety net below.
      this.log(`unexpected error response shape from ${response.status}`, {
        status: response.status,
        body_keys:
          typeof json === "object" && json !== null ? boundedObjectKeys(json as object) : undefined,
      });
    } catch {
      // Body wasn't valid JSON. Log so operators can distinguish this from a
      // malformed envelope, and fall through to the status-only safety net.
      this.log(`non-JSON error response from ${response.status}`, {
        status: response.status,
        content_type: boundedErrorSnippet(response.headers.get("content-type")),
      });
    }

    const statusText = boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`;
    return {
      status: response.status,
      code: ERROR_CODE_UNKNOWN,
      title: statusText,
      detail: statusText,
      retry_after: this.parseRetryAfter(response),
    };
  }

  private parseRetryAfter(response: Response): number | undefined {
    // RFC 7231 §7.1.3: Retry-After honored on 429 + 503. Although the RFC
    // also permits it on 3xx responses, rawRequest now refuses redirects
    // as deterministic errors before retry parsing, so only 429/503 apply.
    if (response.status !== 429 && response.status !== 503) return undefined;
    // This fallback can run after the body reader rejects a malformed injected
    // Response-like shim. Preserve the typed, non-retryable SDK error instead
    // of dereferencing the same missing method and leaking a raw TypeError.
    if (typeof response.headers?.get !== "function") return undefined;
    const header = response.headers.get("Retry-After");
    if (!header) return undefined;
    const trimmed = header.trim();
    if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
      const seconds = Math.ceil((Date.parse(trimmed) - Date.now()) / 1000);
      return Number.isSafeInteger(seconds)
        ? Math.min(Math.max(0, seconds), RETRY_AFTER_PARSE_LIMIT_S)
        : undefined;
    }
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

  private classifyFetchError(
    err: unknown,
    requestSignal: AbortSignal,
  ): TimeoutError | NetworkError {
    // AbortSignal.timeout is the only timeout source owned by this SDK. Keep
    // this check tied to that signal instead of trusting an injected fetch's
    // AbortError or TimeoutError name.
    if (isSdkTimeout(err, requestSignal)) {
      return new TimeoutError("Request timed out", { cause: err });
    }
    const cause = err instanceof Error ? err : undefined;
    return new NetworkError(cause?.message ?? String(err), { cause });
  }

  private classifyResponseReadError(
    err: unknown,
    response: Response,
    requestSignal: AbortSignal,
  ): QURLError | undefined {
    if (err instanceof ResponseBodyMaterializationError) return undefined;
    if (!(err instanceof Error)) return undefined;
    if (!response.ok) {
      const statusText = boundedErrorSnippet(response.statusText) || `HTTP ${response.status}`;
      return withErrorCause(
        createError({
          status: response.status,
          code: ERROR_CODE_UNKNOWN,
          title: statusText,
          detail: `Failed to read response body after HTTP ${response.status}`,
          retry_after: this.parseRetryAfter(response),
        }),
        err,
      );
    }
    if (isSdkTimeout(err, requestSignal)) {
      return new TimeoutError(
        `Request timed out while reading response body after HTTP ${response.status}`,
        { cause: err },
      );
    }
    return new NetworkError(
      `Network failure while reading response body after HTTP ${response.status}`,
      { cause: err },
    );
  }
}
export { isApiKeyRequestScope } from "./client-management.js";
export { SIGNED_FRAGMENT_RE } from "./client-portals.js";
export { ProtectedResource } from "./client-portals.js";
export type { EnsureConnectorResourceResult } from "./client-connectors.js";
export { ConnectorResource } from "./client-connectors.js";
