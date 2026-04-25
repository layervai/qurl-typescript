/** Access control policy for a qURL. */
export interface AccessPolicy {
  ip_allowlist?: string[];
  ip_denylist?: string[];
  geo_allowlist?: string[];
  geo_denylist?: string[];
  user_agent_allow_regex?: string;
  user_agent_deny_regex?: string;
}

/** An individual access token within a qURL. */
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

/** A qURL resource as returned by the API. */
export interface QURL {
  resource_id: string;
  target_url: string;
  status: "active" | "consumed" | "revoked" | "expired";
  description?: string;
  tags?: string[];
  custom_domain?: string;
  qurl_site?: string;
  qurl_count?: number;
  access_tokens?: AccessToken[];
  created_at: string;
  expires_at?: string;
}

/** Input for creating a qURL. */
export interface CreateInput {
  target_url: string;
  expires_in?: string;
  one_time_use?: boolean;
  max_sessions?: number;
  description?: string;
  metadata?: Record<string, string>;
  access_policy?: AccessPolicy;
  custom_domain?: string;
}

/** Response from creating a qURL. */
export interface CreateOutput {
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at?: string;
  one_time_use?: boolean;
}

/** Input for listing qURLs. */
export interface ListInput {
  limit?: number;
  cursor?: string;
  status?: QURL["status"];
  q?: string;
  sort?: string;
}

/** Response from listing qURLs. */
export interface ListOutput {
  qurls: QURL[];
  next_cursor?: string;
  has_more: boolean;
}

/** Input for extending a qURL. */
export interface ExtendInput {
  extend_by?: string;
  expires_at?: string;
}

/** Input for updating a qURL — extend expiration, change description, etc. */
export interface UpdateInput {
  extend_by?: string;
  expires_at?: string;
  description?: string;
  access_policy?: AccessPolicy;
}

/** Input for minting an access link. */
export interface MintInput {
  expires_at?: string;
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
  };
  usage?: {
    qurls_created: number;
    active_qurls: number;
    active_qurls_percent: number;
    total_accesses: number;
  };
}

/** API error from the qURL service (RFC 7807). */
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
