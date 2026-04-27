/** AI agent access control policy. */
export interface AIAgentPolicy {
  block_all?: boolean;
  deny_categories?: string[];
  allow_categories?: string[];
}

/** Access control policy for a qURL. */
export interface AccessPolicy {
  ip_allowlist?: string[];
  ip_denylist?: string[];
  geo_allowlist?: string[];
  geo_denylist?: string[];
  user_agent_allow_regex?: string;
  user_agent_deny_regex?: string;
  ai_agent_policy?: AIAgentPolicy;
}

/** An individual access token within a qURL. */
export interface AccessToken {
  /** Display identifier for this token (q_ prefix). */
  qurl_id: string;
  label?: string;
  status: "active" | "consumed" | "expired" | "revoked";
  one_time_use: boolean;
  max_sessions: number;
  /**
   * Session lifetime in **seconds** (numeric). Note: the corresponding
   * input field on {@link CreateInput} and {@link MintInput} takes a
   * human-readable duration string like `"1h"` — the server parses the
   * string on write and returns the resolved number of seconds on read.
   */
  session_duration: number;
  access_policy?: AccessPolicy;
  use_count: number;
  qurl_site?: string;
  created_at: string;
  expires_at: string;
}

/**
 * A qURL resource as returned by the API.
 *
 * Note: `status` is narrower than {@link AccessToken.status}. Resources only
 * have two states — `active` or `revoked` — per `QurlData.status` in the
 * OpenAPI spec. Individual access tokens can additionally be `consumed` or
 * `expired`; see {@link AccessToken.status}.
 *
 * **`description` is set via {@link UpdateInput}, not on create.** The API
 * uses `label` on create (a token-level label) and `description` on the
 * resource itself. See the JSDoc on {@link CreateInput} for details.
 */
export interface QURL {
  resource_id: string;
  target_url: string;
  status: "active" | "revoked";
  description?: string;
  tags?: string[];
  /**
   * The custom hostname this resource is reachable under, or `null` when
   * no custom domain is configured. The read-side type is `string | null`
   * (matching the OpenAPI `nullable: true` declaration on
   * `ResourceData.custom_domain`) while the write-side type on
   * {@link CreateInput.custom_domain} is `string | undefined` (absent =
   * "don't set"). The asymmetry is deliberate — JSON `null` and an
   * absent field have different semantics, and the API surface uses
   * the convention across reads and writes.
   */
  custom_domain?: string | null;
  qurl_site?: string;
  qurl_count?: number;
  access_tokens?: AccessToken[];
  created_at: string;
  expires_at?: string;
}

/**
 * Input for creating a qURL.
 *
 * Note: `tags` and `description` are **not** accepted on create — they live
 * on the resource (see {@link QURL.tags} / {@link QURL.description}) and must
 * be set via {@link UpdateInput} after creation. The API uses different field
 * names for the create-time token label ({@link CreateInput.label}) and the
 * resource-level description on update/get responses.
 */
export interface CreateInput {
  target_url: string;
  expires_in?: string;
  one_time_use?: boolean;
  max_sessions?: number;
  session_duration?: string;
  label?: string;
  access_policy?: AccessPolicy;
  custom_domain?: string;
}

/** Response from creating a qURL. */
export interface CreateOutput {
  qurl_id: string;
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at?: string;
  label?: string;
}

/** Input for listing qURLs. */
export interface ListInput {
  limit?: number;
  cursor?: string;
  /**
   * Filter by status. Accepts a single value or comma-separated values to
   * combine multiple (e.g. `"active,revoked"`). The union lists the
   * canonical single values for autocomplete and uses the `(string & {})`
   * trick to still accept arbitrary strings — CSV combinations in any
   * order, plus any filter-only values the API may add later.
   */
  status?: "active" | "revoked" | (string & {});
  /** Free-text search over description and target_url. */
  q?: string;
  /**
   * Sort field and direction as `field:direction`. Valid fields:
   * `created_at`, `expires_at`. Valid directions: `asc`, `desc` (default
   * `desc`). Example: `created_at:desc`.
   */
  sort?: string;
  /** RFC 3339 timestamp. */
  created_after?: string;
  /** RFC 3339 timestamp. */
  created_before?: string;
  /** RFC 3339 timestamp. */
  expires_before?: string;
  /** RFC 3339 timestamp. */
  expires_after?: string;
}

/** Response from listing qURLs. */
export interface ListOutput {
  qurls: QURL[];
  next_cursor?: string;
  has_more: boolean;
}

/**
 * Input for extending a qURL's expiration. Exactly one of `extend_by`
 * or `expires_at` must be provided — the discriminated union form moves
 * the "provide at least one" check from runtime into the TypeScript
 * type system, so `extend(id, {})` is a compile error instead of a
 * runtime `ValidationError`. The `?: never` on the *other* field also
 * catches the "provide both" mistake at compile time.
 *
 * ```ts
 * client.extend("r_x", { extend_by: "7d" });      // OK
 * client.extend("r_x", { expires_at: "2026-..." }); // OK
 * client.extend("r_x", {});                         // compile error
 * client.extend("r_x", { extend_by: "7d", expires_at: "..." }); // compile error
 * ```
 */
export type ExtendInput =
  | {
      /** Relative duration to extend by (e.g., `"24h"`, `"7d"`). */
      extend_by: string;
      expires_at?: never;
    }
  | {
      /** Absolute RFC 3339 expiration timestamp. */
      expires_at: string;
      extend_by?: never;
    };

/**
 * Input for updating a qURL — extend expiration, change description, etc.
 *
 * `extend_by` and `expires_at` are mutually exclusive — provide at most one.
 * At least one field must be set for the request to be valid.
 *
 * **`access_policy` is not included** and cannot be updated after create.
 * The OpenAPI `UpdateQurlRequest` schema only accepts `extend_by`,
 * `expires_at`, `tags`, and `description`; access policy is immutable
 * from the server's perspective and must be set via {@link CreateInput}
 * when the qURL is first created.
 */
export interface UpdateInput {
  /** Relative duration to extend by (e.g., `"24h"`, `"7d"`). Mutually exclusive with `expires_at`. */
  extend_by?: string;
  /** Absolute RFC 3339 expiration timestamp. Mutually exclusive with `extend_by`. */
  expires_at?: string;
  /**
   * Resource-level description. Distinct from the token-level `label` on
   * {@link CreateInput} / {@link MintInput} — the API intentionally uses
   * different field names for the create and update flows.
   *
   * Pass an empty string to clear the existing description.
   */
  description?: string;
  /**
   * Replace all tags on this resource. Pass an empty array to clear all tags.
   */
  tags?: string[];
}

/**
 * Input for minting an access link.
 *
 * `expires_in` and `expires_at` are mutually exclusive — provide at most one.
 * If neither is specified, the link defaults to 24 hours from now.
 */
export interface MintInput {
  /** Relative duration until expiration (e.g., `"5m"`, `"24h"`, `"7d"`). Mutually exclusive with `expires_at`. */
  expires_in?: string;
  /** Absolute RFC 3339 expiration timestamp. Mutually exclusive with `expires_in`. */
  expires_at?: string;
  /** Human-readable label identifying who this link is for. Max 500 chars. */
  label?: string;
  one_time_use?: boolean;
  /** Maximum concurrent sessions. `0` = unlimited (default); max `1000`. */
  max_sessions?: number;
  /** How long access lasts after clicking (e.g., `"1h"`). Min 5m, max 24h. */
  session_duration?: string;
  access_policy?: AccessPolicy;
}

/** Response from minting an access link. */
export interface MintOutput {
  qurl_link: string;
  expires_at?: string;
}

/** Input for headless qURL resolution. */
export interface ResolveInput {
  access_token: string;
}

/** Details of the firewall access that was granted. */
export interface AccessGrant {
  expires_in: number;
  granted_at: string;
  src_ip: string;
}

/** Response from headless resolution. */
export interface ResolveOutput {
  target_url: string;
  resource_id: string;
  access_grant?: AccessGrant;
}

/** Quota information. */
export interface Quota {
  /**
   * Subscription plan. Open union — see `ListInput.status` JSDoc for the
   * `(string & {})` pattern explanation.
   */
  plan: "free" | "growth" | "enterprise" | (string & {});
  period_start: string;
  period_end: string;
  /**
   * Rate limit configuration. The parent is optional (older API
   * deployments and partial responses may omit it entirely), and
   * every inner field is also optional — if a future plan tier
   * exposes only a subset of limits, consumers must guard each
   * field individually rather than trusting `rate_limits` to
   * imply the full shape.
   */
  rate_limits?: {
    create_per_minute?: number;
    create_per_hour?: number;
    list_per_minute?: number;
    resolve_per_minute?: number;
    max_active_qurls?: number;
    max_tokens_per_qurl?: number;
    max_expiry_seconds?: number;
  };
  /**
   * Usage snapshot. Same optional-parent + optional-fields shape as
   * {@link rate_limits}: a partial response (e.g. `{ data: { plan } }`
   * with no usage at all) is valid, and individual usage counters
   * may be absent on plans that don't track them.
   */
  usage?: {
    qurls_created?: number;
    active_qurls?: number;
    active_qurls_percent?: number | null;
    total_accesses?: number;
  };
}

/** Input for batch creating qURLs. */
export interface BatchCreateInput {
  items: CreateInput[];
}

/**
 * A successfully created item in a batch create response.
 *
 * Note: the batch response is intentionally slimmer than {@link CreateOutput}
 * — it does **not** include `qurl_id` or `label`. This matches the API's
 * `BatchItemResult` schema in `openapi.yaml`. If you need `qurl_id` / `label`
 * per item, call {@link QURLClient.create} individually.
 */
export interface BatchItemSuccess {
  index: number;
  success: true;
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at?: string;
}

/** A failed item in a batch create response. */
export interface BatchItemFailure {
  index: number;
  success: false;
  error: { code: string; message: string };
}

/**
 * Result for a single item in a batch create response.
 *
 * Discriminate on `success` for type-safe narrowing:
 * ```ts
 * for (const r of result.results) {
 *   if (r.success) {
 *     console.log(r.resource_id); // success fields narrowed
 *   } else {
 *     console.log(r.error.message); // error narrowed
 *   }
 * }
 * ```
 */
export type BatchItemResult = BatchItemSuccess | BatchItemFailure;

/** Response from batch creating qURLs. */
export interface BatchCreateOutput {
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
  /**
   * Server-assigned request ID from the response `meta.request_id` field.
   * Propagated through the 400-passthrough path so consumers filing
   * support tickets on partial/total batch failures have a correlation
   * ID. Optional because older API versions or non-JSON responses may
   * omit it.
   */
  request_id?: string;
}

/** API error from the qURL service (RFC 7807). */
export interface QURLErrorData {
  status: number;
  code: string;
  title: string;
  /** Human-readable explanation. Optional per RFC 7807. */
  detail?: string;
  /** Problem-type URI (RFC 7807 `type`). Optional. */
  type?: string;
  /** URI reference that identifies the specific occurrence (RFC 7807 `instance`). Optional. */
  instance?: string;
  invalid_fields?: Record<string, string>;
  request_id?: string;
  retry_after?: number;
}

/** Client configuration options. */
export interface ClientOptions {
  /** API key (required). */
  apiKey: string;
  /** Base URL. Defaults to https://api.layerv.ai */
  baseUrl?: string;
  /** Custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Maximum retry attempts for transient errors (429, 5xx). Default: 3. */
  maxRetries?: number;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /** User-Agent header value. */
  userAgent?: string;
  /** Enable debug logging. Pass `true` for console.debug, or a custom callback. */
  debug?: boolean | ((message: string, data?: Record<string, unknown>) => void);
}
