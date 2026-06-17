type OpenString<T extends string> = T | (string & {});

/** Common response metadata returned by the API envelope. */
export interface Meta {
  request_id?: string;
  page_size?: number;
  has_more?: boolean;
  next_cursor?: string;
  tombstone?: TombstoneInfo;
}

/** Read-only metadata returned on tombstoned-resource error envelopes. */
export interface TombstoneInfo {
  tombstoned_at: string;
  final_access_count?: number;
}

/** Shared pagination fields the SDK flattens out of response `meta`. */
export interface PaginatedOutput {
  next_cursor?: string;
  has_more: boolean;
  request_id?: string;
  page_size?: number;
}

/** Resource type values currently advertised by the API. */
export type ResourceType = OpenString<"url" | "tunnel" | "transit">;

/** A well-known AI agent category identifier. */
export type AIAgentCategory = OpenString<
  | "chatgpt"
  | "gptbot"
  | "claude"
  | "gemini"
  | "perplexity"
  | "cohere"
  | "meta"
  | "bytedance"
  | "amazon"
  | "apple"
  | "commoncrawl"
  | "mistral"
  | "generic_ai"
>;

/** AI agent access control policy. */
export interface AIAgentPolicy {
  block_all?: boolean;
  deny_categories?: AIAgentCategory[];
  allow_categories?: AIAgentCategory[];
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

/** An individual access token within a qURL resource. */
export interface AccessToken {
  /** Display identifier for this token (q_ prefix). */
  qurl_id: string;
  label?: string;
  status: "active" | "consumed" | "expired" | "revoked";
  one_time_use: boolean;
  max_sessions: number;
  /**
   * Session lifetime in seconds. The corresponding input fields take a
   * human-readable duration string like `"1h"`; the API returns seconds.
   */
  session_duration: number;
  access_policy?: AccessPolicy;
  use_count: number;
  qurl_site?: string;
  created_at: string;
  expires_at: string;
}

/** Per-qURL summary returned from resource-detail and token-update endpoints. */
export interface QurlSummary {
  qurl_id?: string;
  label?: string;
  status?: "active" | "consumed" | "expired" | "revoked";
  one_time_use?: boolean;
  max_sessions?: number;
  /** Session lifetime in seconds. */
  session_duration?: number;
  access_policy?: AccessPolicy;
  use_count?: number;
  qurl_site?: string;
  created_at?: string;
  expires_at?: string;
}

/**
 * A qURL resource as returned by the legacy `/v1/qurls` management surface.
 *
 * `qurl_link` is delivered exactly once on create/mint responses and is not
 * recoverable from read-side shapes. Persist it at create or mint time.
 */
export interface QURL {
  resource_id: string;
  type?: ResourceType;
  target_url: string;
  status: "active" | "revoked";
  description?: string;
  tags?: string[];
  /**
   * The custom hostname this resource is reachable under, or `null` when no
   * custom domain is configured. Read shapes use `string | null`; write shapes
   * use `string | undefined` because JSON `null` and an absent field have
   * different semantics.
   */
  custom_domain?: string | null;
  slug?: string;
  qurl_site?: string;
  qurl_count?: number;
  access_tokens?: AccessToken[];
  created_at: string;
  expires_at?: string;
}

/**
 * Input for creating a qURL.
 *
 * `target_url` remains required for default `url` qURLs. It is optional in the
 * type so callers can create non-url resource types such as tunnels without a
 * URL; the client still throws a `ValidationError` when a url qURL omits it.
 *
 * `tags` and `description` are not accepted on this create path. They live on
 * the resource and must be set through {@link UpdateInput} after creation.
 */
export interface CreateInput {
  type?: ResourceType;
  target_url?: string;
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
  branded_domain?: string;
  qurl_site: string;
  expires_at?: string;
  label?: string;
  type?: ResourceType;
}

/** Input for listing qURLs. */
export interface ListInput {
  limit?: number;
  cursor?: string;
  status?: "active" | "revoked" | (string & {});
  /** Free-text search over description and target_url. */
  q?: string;
  /** Sort field and direction as `field:direction`, for example `created_at:desc`. */
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
export interface ListOutput extends PaginatedOutput {
  qurls: QURL[];
}

/**
 * Input for extending a qURL's expiration. Exactly one of `extend_by` or
 * `expires_at` must be provided. The union moves the "provide at least one"
 * and "do not provide both" checks into TypeScript for typed callers.
 *
 * ```ts
 * client.extend("r_x", { extend_by: "7d" });
 * client.extend("r_x", { expires_at: "2026-06-06T00:00:00Z" });
 * client.extend("r_x", {}); // compile error
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
 * Input for updating a qURL resource.
 *
 * `access_policy` is intentionally absent: token access policy is immutable on
 * the resource-level update path and must be supplied at create/mint time or
 * changed through the resource-scoped qURL-token endpoint.
 */
export interface UpdateInput {
  /** Relative duration to extend by (e.g., `"24h"`, `"7d"`). */
  extend_by?: string;
  /** Absolute RFC 3339 expiration timestamp. */
  expires_at?: string;
  /** Resource-level description. Pass an empty string to clear. */
  description?: string;
  /** Replace all tags on this resource. Pass an empty array to clear all tags. */
  tags?: string[];
}

/**
 * Input for minting an access link.
 *
 * `expires_in` and `expires_at` are mutually exclusive. If neither is set, the
 * server applies its default expiration.
 *
 * This is intentionally not an {@link ExtendInput}-style union: minting allows
 * zero or one expiration field, while extending requires exactly one. A
 * three-arm union would make the common "omit both" case noisier than the
 * runtime mutual-exclusion check is worth.
 */
export interface MintInput {
  /** Relative duration until expiration (e.g., `"5m"`, `"24h"`, `"7d"`). */
  expires_in?: string;
  /** Absolute RFC 3339 expiration timestamp. */
  expires_at?: string;
  /** Human-readable label identifying who this link is for. Max 500 chars. */
  label?: string;
  one_time_use?: boolean;
  /** Maximum concurrent sessions. `0` = unlimited (default); max `1000`. */
  max_sessions?: number;
  /**
   * How long access lasts after the page loads (e.g., `"1h"`). Min 1s, max
   * 24h. The first create for a `target_url` anchors the resource-level cap;
   * later mints/updates that exceed it are rejected by the server.
   */
  session_duration?: string;
  access_policy?: AccessPolicy;
}

/** Response from minting an access link. */
export interface MintOutput {
  qurl_id?: string;
  qurl_link: string;
  branded_domain?: string;
  expires_at?: string;
  type?: ResourceType;
}

/** Input for headless qURL resolution. */
export interface ResolveInput {
  access_token: string;
}

/** Details of the network access that was granted. */
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
  plan: "free" | "growth" | "enterprise" | (string & {});
  period_start: string;
  period_end: string;
  /**
   * The parent object and each inner limit are optional. Guard each field
   * individually; partial responses and future tiers may expose only a subset.
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
  usage?: {
    qurls_created?: number;
    active_qurls?: number;
    /**
     * Active qURLs as a percentage of the plan's `max_active_qurls`, or `null`
     * when the plan is unlimited. Guard the null case before arithmetic:
     * `usage.active_qurls_percent * 0.01` yields `NaN` on unlimited plans.
     */
    active_qurls_percent?: number | null;
    total_accesses?: number;
  };
}

/** Input for batch creating qURLs. */
export interface BatchCreateInput {
  /** Max 100 items per request; min 1. */
  items: CreateInput[];
}

/**
 * A successfully created item in a batch create response.
 *
 * This shape is intentionally slimmer than {@link CreateOutput}: batch items do
 * not include `qurl_id` or `label`. Use the returned `resource_id` to fetch more
 * detail when per-token identifiers are needed.
 */
export interface BatchItemSuccess {
  index: number;
  success: true;
  resource_id: string;
  qurl_link: string;
  branded_domain?: string;
  qurl_site: string;
  expires_at?: string;
}

/** A failed item in a batch create response. */
export interface BatchItemFailure {
  index: number;
  success: false;
  error: { code: string; message: string };
}

/** Result for a single item in a batch create response. */
export type BatchItemResult = BatchItemSuccess | BatchItemFailure;

/** Response from batch creating qURLs. */
export interface BatchCreateOutput {
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
  request_id?: string;
}

/** Input for creating a resource directly. */
export interface CreateResourceInput {
  type?: ResourceType;
  target_url?: string;
  description?: string;
  tags?: string[];
  custom_domain?: string;
  alias?: string;
  slug?: string;
  find_or_create?: boolean;
}

/** Input for updating resource metadata. */
export interface UpdateResourceInput {
  description?: string;
  tags?: string[];
  /** Omit to leave unchanged; send `""` to clear. `null` is not a clear signal. */
  custom_domain?: string;
  preserve_host?: boolean;
  /** Use `null` to clear the alias. */
  alias?: string | null;
}

/** Resource data returned by the `/v1/resources` surface. */
export interface Resource {
  resource_id: string;
  type?: ResourceType;
  target_url?: string;
  knock_resource_id?: string;
  status?: "active" | "revoked" | (string & {});
  description?: string;
  tags?: string[];
  custom_domain?: string | null;
  alias?: string | null;
  slug?: string;
  preserve_host?: boolean;
  session_duration_cap?: number;
  qurl_count?: number;
  created_at?: string;
  expires_at?: string;
  tombstoned_at?: string;
}

/** Detail payload for one resource plus its bounded qURL preview. */
export interface ResourceDetail {
  resource?: Resource;
  qurls?: QurlSummary[];
}

export interface ResourceListInput {
  cursor?: string;
  limit?: number;
  alias?: string;
  slug?: string;
  status?: "active" | "revoked" | (string & {});
  type?: ResourceType;
}

export interface ResourceListOutput extends PaginatedOutput {
  resources: Resource[];
}

/** Input for minting a qURL against an existing resource. */
export type CreateQurlForResourceInput = Omit<
  CreateInput,
  "target_url" | "custom_domain" | "type"
> & {
  /** Path appended to the resource's target when this qURL resolves (e.g. "/api/detect"); server-validated, must start with "/". */
  target_path?: string;
};

type UpdateResourceQurlBaseInput = {
  label?: string;
  access_policy?: AccessPolicy;
  max_sessions?: number;
  session_duration?: string;
};

/**
 * Input for updating a specific qURL token on a resource.
 *
 * `extend_by` and `expires_at` are mutually exclusive. Callers may omit both
 * when only updating non-expiration token fields such as `label`,
 * `max_sessions`, `session_duration`, or `access_policy`.
 */
export type UpdateResourceQurlInput =
  | (UpdateResourceQurlBaseInput & {
      extend_by?: string;
      expires_at?: never;
    })
  | (UpdateResourceQurlBaseInput & {
      expires_at?: string;
      extend_by?: never;
    });

export interface Session {
  session_id?: string;
  qurl_id?: string;
  src_ip?: string;
  user_agent?: string;
  created_at?: string;
  last_seen_at?: string;
}

/** Metadata surfaced by list endpoints that are not paginated today. */
export interface UnpaginatedOutput {
  request_id?: string;
  /**
   * These endpoints do not accept cursor query params today; pagination drift
   * is surfaced through debug logs, not through a pageable output contract.
   */
  has_more: false;
  page_size?: number;
}

export interface SessionListOutput extends UnpaginatedOutput {
  /**
   * Active sessions. The current OpenAPI contract has no cursor query params;
   * if pagination metadata appears, the SDK surfaces it for observability but
   * returns this page only.
   */
  sessions: Session[];
}

export interface SessionTerminateOutput {
  terminated: number;
  request_id?: string;
}

export interface ConnectorInstallationStats {
  resources: number;
  qurls: number;
  accesses_24h: number;
  accesses_7d: number;
  errors_24h: number;
}

export interface ConnectorInstallationCapabilities {
  configure: boolean;
  disconnect: boolean;
  reauth: boolean;
  view_activity: boolean;
}

export interface ConnectorInstallation {
  installation_id: string;
  plugin_id: string;
  label: string;
  subject_kind: string;
  subject_display_name: string;
  status: OpenString<"active" | "degraded" | "disconnected" | "needs_reauth">;
  installed_at: string;
  last_activity_at?: string | null;
  stats: ConnectorInstallationStats;
  capabilities: ConnectorInstallationCapabilities;
}

export interface ListConnectorInstallationsInput {
  cursor?: string;
  limit?: number;
}

export interface ConnectorInstallationListOutput extends PaginatedOutput {
  installations: ConnectorInstallation[];
}

export interface UsageCostEstimate {
  currency: string;
  amount_cents: number;
  description: string;
}

export interface UsageCurrentPeriod {
  tier: "free" | "growth" | "enterprise" | (string & {});
  period_start: string;
  period_end: string;
  qurls_created: number;
  active_qurls: number;
  cost_estimate?: UsageCostEstimate;
}

export interface UsageDailyEntry {
  date: string;
  qurls_created: number;
}

export interface UsageDaily {
  tier: "free" | "growth" | "enterprise" | (string & {});
  period_start: string;
  period_end: string;
  daily: UsageDailyEntry[];
}

export interface Customer {
  tier: "free" | "growth" | "enterprise" | (string & {});
  spending_cap_cents: number;
  current_period_usage: number;
  frozen: boolean;
  frozen_reason?: OpenString<"spending_cap" | "payment_failed" | "manual"> | null;
}

export interface UpdateCustomerInput {
  /** Non-negative spending cap in cents. Clearing/removal is not exposed by the current contract. */
  spending_cap_cents: number;
}

export interface CreateBillingCheckoutInput {
  plan: OpenString<"growth">;
}

export interface CheckoutSession {
  url: string;
}

export interface PortalSession {
  url: string;
}

export interface Invoice {
  id: string;
  amount_cents: number;
  status: "paid" | "open" | "void" | "draft" | (string & {});
  created_at: string;
  pdf_url?: string | null;
}

export interface ListBillingInvoicesInput {
  limit?: number;
  cursor?: string;
}

export interface BillingInvoiceListOutput extends PaginatedOutput {
  invoices: Invoice[];
}

export interface RegisterDomainInput {
  domain: string;
}

export interface DnsRecord {
  type?: string;
  name?: string;
  value?: string;
  verified?: boolean;
}

export interface Domain {
  domain?: string;
  status?: OpenString<
    "pending_verification" | "verified" | "provisioning_tls" | "active" | "failed"
  >;
  verification_token?: string;
  token_expires_at?: string | null;
  acme_cname_target?: string;
  created_at?: string;
  verified_at?: string | null;
  activated_at?: string | null;
  ready_for_qurls?: boolean;
  dns_records?: DnsRecord[];
}

export interface ListDomainsInput {
  limit?: number;
  cursor?: string;
}

export interface DomainListOutput extends PaginatedOutput {
  domains: Domain[];
}

export interface DomainCheckDetail {
  verified: boolean;
  error?: string;
  found?: string;
}

export interface DomainVerifyResult {
  domain?: string;
  status?: Domain["status"];
  checks?: {
    txt?: DomainCheckDetail;
    acme_cname?: DomainCheckDetail;
    traffic_routing?: DomainCheckDetail;
  };
}

export type WebhookEventType = OpenString<
  | "qurl.created"
  | "qurl.expired"
  | "qurl.revoked"
  | "qurl.updated"
  | "resource.closed"
  | "qurl.accessed"
  | "qurl.access_denied"
  | "qurl.token_exhausted"
  | "quota.warning"
  | "quota.exceeded"
  | "token.minted"
  | "token.expired"
  | "domain.verified"
  | "domain.failed"
  | "domain.deleted"
>;

export interface CreateWebhookInput {
  /** Webhook receiver URL. The service accepts public http/https URLs; prefer https in production. */
  url: string;
  events: WebhookEventType[];
  description?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  description?: string;
  status?: "active" | "disabled" | (string & {});
}

export interface Webhook {
  webhook_id?: string;
  owner_id?: string;
  url?: string;
  events?: WebhookEventType[];
  status?: "active" | "disabled" | (string & {});
  description?: string;
  created_at?: string;
  updated_at?: string;
  failure_count?: number;
  last_delivery_success?: boolean;
  last_delivery_time?: number;
}

export interface WebhookWithSecret extends Webhook {
  secret?: string;
}

export interface ListWebhooksInput {
  limit?: number;
  cursor?: string;
}

export interface WebhookListOutput extends PaginatedOutput {
  webhooks: Webhook[];
}

export interface WebhookDelivery {
  delivery_id?: string;
  webhook_id?: string;
  event_type?: WebhookEventType;
  status?: "pending" | "success" | "failed" | "retrying" | "abandoned" | (string & {});
  response_code?: number;
  response_body?: string;
  error_message?: string;
  duration_ms?: number;
  retry_count?: number;
  created_at?: string;
  completed_at?: string;
}

export interface ListWebhookDeliveriesInput {
  limit?: number;
  cursor?: string;
}

export interface WebhookDeliveryListOutput extends PaginatedOutput {
  deliveries: WebhookDelivery[];
}

export interface WebhookEventTypeInfo {
  type?: WebhookEventType;
  category?: "resource" | "access" | "quota" | "token" | (string & {});
  description?: string;
}

export interface WebhookPayload {
  id?: string;
  type?: WebhookEventType;
  owner_id?: string;
  timestamp?: string;
  api_version?: string;
  data?: Record<string, unknown>;
}

export type ApiKeyScope = OpenString<"qurl:read" | "qurl:write" | "qurl:resolve" | "qurl:agent">;

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiKeyScope[];
  expires_in?: string;
  purpose?: "tunnel_bootstrap";
  tunnel_slug?: string;
}

export interface UpdateApiKeyInput {
  name?: string;
  scopes?: ApiKeyScope[];
}

export interface ApiKey {
  key_id?: string;
  key_prefix?: string;
  name?: string;
  scopes?: ApiKeyScope[];
  status?: "active" | "revoked" | (string & {});
  created_at?: string;
  updated_at?: string;
  last_used_at?: string;
  expires_at?: string;
  purpose?: "tunnel_bootstrap" | (string & {});
  tunnel_slug?: string;
}

export interface CreateApiKeyOutput extends ApiKey {
  /** Full API key secret, returned only on create. Store it immediately. */
  api_key?: string;
}

export interface ListApiKeysInput {
  limit?: number;
  cursor?: string;
  status?: "active" | "revoked" | (string & {});
}

export interface ApiKeyListOutput extends PaginatedOutput {
  api_keys: ApiKey[];
}

export interface RedeemAccessCodeInput {
  code: string;
  honeypot?: string;
  elapsed_ms?: number;
}

export interface RedeemAccessCodeOutput {
  redirect_url?: string;
}

export interface CreateAccessCodeInput {
  resource_id: string;
  name?: string;
  max_uses?: number;
  expires_at?: string;
}

export interface AccessCode {
  access_code_id?: string;
  resource_id?: string;
  name?: string;
  status?: "active" | "revoked" | (string & {});
  max_uses?: number;
  use_count?: number;
  created_at?: string;
  expires_at?: string | null;
}

export interface CreateAccessCodeOutput extends AccessCode {
  /** Full access code secret, returned only on create. Store it immediately. */
  code?: string;
}

export interface AccessCodeListOutput extends UnpaginatedOutput {
  /**
   * Access codes. The current OpenAPI contract has no cursor query params; if
   * pagination metadata appears, the SDK surfaces it for observability but
   * returns this page only.
   */
  access_codes: AccessCode[];
}

export interface AgentBootstrapInput {
  public_key: string;
  agent_id?: string;
  hostname?: string;
  version?: string;
}

export interface NHPServerPeerInfo {
  public_key_b64: string;
  host: string;
  port: number;
  expire_time: number;
}

export interface AgentBootstrapOutput {
  agent_id: string;
  registered_at: string;
  nhp_server_peer: NHPServerPeerInfo;
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

/** Per-call options accepted by mutating requests. */
export interface RequestOptions {
  /**
   * Override the auto-generated `Idempotency-Key` sent on POST/PATCH.
   *
   * Use this when an upstream operation already has a stable request ID
   * and application-level retry loops should deduplicate against that ID
   * instead of a fresh SDK-created UUIDv7. Values must be non-empty printable
   * ASCII strings of at most 256 characters and must not start or end with
   * spaces. Use a unique key for each logical operation.
   */
  idempotencyKey?: string;
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
  /**
   * Request timeout in milliseconds, per attempt (not total). Default: 30000.
   *
   * Worst-case total time for a request that exhausts all retries is roughly
   * `timeout * (maxRetries + 1) + sum(retryDelay)`.
   */
  timeout?: number;
  /** User-Agent header value. */
  userAgent?: string;
  /** Enable debug logging. Pass `true` for console.debug, or a custom callback. */
  debug?: boolean | ((message: string, data?: Record<string, unknown>) => void);
}
