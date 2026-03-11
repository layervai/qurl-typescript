/** Access control policy for a QURL. */
export interface AccessPolicy {
  ip_allowlist?: string[];
  ip_denylist?: string[];
  geo_allowlist?: string[];
  geo_denylist?: string[];
  user_agent_allow_regex?: string;
  user_agent_deny_regex?: string;
}

/** A QURL resource as returned by the API. */
export interface QURL {
  resource_id: string;
  target_url: string;
  status: "active" | "consumed" | "revoked" | "expired";
  created_at: string;
  expires_at?: string;
  one_time_use: boolean;
  max_sessions?: number;
  description?: string;
  qurl_site?: string;
  qurl_link?: string;
  access_policy?: AccessPolicy;
}

/** Input for creating a QURL. */
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

/** Response from creating a QURL. */
export interface CreateOutput {
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at?: string;
}

/** Input for listing QURLs. */
export interface ListInput {
  limit?: number;
  cursor?: string;
  status?: string;
  q?: string;
  sort?: string;
}

/** Response from listing QURLs. */
export interface ListOutput {
  qurls: QURL[];
  next_cursor?: string;
  has_more: boolean;
}

/** Input for extending a QURL. */
export interface ExtendInput {
  extend_by?: string;
  expires_at?: string;
}

/** Input for updating a QURL. */
export interface UpdateInput {
  description?: string;
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
  };
  usage?: {
    qurls_created: number;
    active_qurls: number;
    active_qurls_percent: number;
    total_accesses: number;
  };
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
}
