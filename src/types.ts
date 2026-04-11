/** AI agent access control policy. */
export interface AIAgentPolicy {
  block_all?: boolean;
  deny_categories?: string[];
  allow_categories?: string[];
}

/** Access control policy for a QURL. */
export interface AccessPolicy {
  ip_allowlist?: string[];
  ip_denylist?: string[];
  geo_allowlist?: string[];
  geo_denylist?: string[];
  user_agent_allow_regex?: string;
  user_agent_deny_regex?: string;
  ai_agent_policy?: AIAgentPolicy;
}

/** An individual access token within a QURL. */
export interface AccessToken {
  /** Display identifier for this token (q_ prefix). */
  qurl_id: string;
  label?: string;
  status: "active" | "consumed" | "expired" | "revoked";
  one_time_use: boolean;
  max_sessions: number;
  session_duration: number;
  access_policy?: AccessPolicy;
  use_count: number;
  qurl_site?: string;
  created_at: string;
  expires_at: string;
}

/**
 * A QURL resource as returned by the API.
 *
 * Note: `status` is narrower than {@link AccessToken.status}. Resources only
 * have two states — `active` or `revoked` — per `QurlData.status` in the
 * OpenAPI spec. Individual access tokens can additionally be `consumed` or
 * `expired`; see {@link AccessToken.status}.
 */
export interface QURL {
  resource_id: string;
  target_url: string;
  status: "active" | "revoked";
  description?: string;
  tags?: string[];
  custom_domain?: string | null;
  qurl_site?: string;
  qurl_count?: number;
  access_tokens?: AccessToken[];
  created_at: string;
  expires_at?: string;
}

/**
 * Input for creating a QURL.
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

/** Response from creating a QURL. */
export interface CreateOutput {
  qurl_id: string;
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at?: string;
  label?: string;
}

/** Input for listing QURLs. */
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

/** Response from listing QURLs. */
export interface ListOutput {
  qurls: QURL[];
  next_cursor?: string;
  has_more: boolean;
}

/**
 * Input for extending a QURL.
 *
 * `extend_by` and `expires_at` are mutually exclusive — provide at most one.
 */
export interface ExtendInput {
  /** Relative duration to extend by (e.g., `"24h"`, `"7d"`). Mutually exclusive with `expires_at`. */
  extend_by?: string;
  /** Absolute RFC 3339 expiration timestamp. Mutually exclusive with `extend_by`. */
  expires_at?: string;
}

/**
 * Input for updating a QURL — extend expiration, change description, etc.
 *
 * `extend_by` and `expires_at` are mutually exclusive — provide at most one.
 * At least one field must be set for the request to be valid.
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

/** Input for headless QURL resolution. */
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
  plan: string;
  period_start: string;
  period_end: string;
  rate_limits?: {
    create_per_minute: number;
    create_per_hour: number;
    list_per_minute: number;
    resolve_per_minute: number;
    max_active_qurls: number;
    max_tokens_per_qurl: number;
    max_expiry_seconds: number;
  };
  usage?: {
    qurls_created: number;
    active_qurls: number;
    active_qurls_percent: number | null;
    total_accesses: number;
  };
}

/** Input for batch creating QURLs. */
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

/** Response from batch creating QURLs. */
export interface BatchCreateOutput {
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}

/** API error from the QURL service (RFC 7807). */
export interface QURLErrorData {
  status: number;
  code: string;
  title: string;
  detail: string;
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
