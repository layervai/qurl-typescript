import type {
  CreateAccessCodeInput,
  CreateBillingCheckoutInput,
  CreateDelegatedQurlBatchInput,
  CreateDelegatedQurlBatchOptions,
  CreateDurableApiKeyInput,
  CreateEnrollmentTokenInput,
  CreateInput,
  CreatePortalOptions,
  CreateQurlForResourceInput,
  CreateResourceInput,
  CreateWebhookInput,
  DelegatedQurlGrant,
  GetDelegatedQurlBatchOptions,
  ListApiKeysInput,
  ListBillingInvoicesInput,
  ListConnectorInstallationsInput,
  ListDomainsInput,
  ListInput,
  ListWebhookDeliveriesInput,
  ListWebhooksInput,
  MintInput,
  ProtectUrlOptions,
  RedeemAccessCodeInput,
  RegisterDomainInput,
  RequestOptions,
  ResourceListInput,
  ShareResourceOptions,
  UpdateApiKeyInput,
  UpdateCustomerInput,
  UpdateInput,
  UpdateResourceInput,
  UpdateResourceQurlInput,
  UpdateWebhookInput,
} from "./types.js";

/** Allowlist of known query-param keys for the `list()` endpoint. */
export const LIST_PARAM_KEYS = [
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

export const REQUEST_OPTION_KEYS = [
  "idempotencyKey",
] as const satisfies readonly (keyof RequestOptions)[];

export const DELEGATED_BATCH_INPUT_KEYS = [
  "mint_capability",
  "grants",
] as const satisfies readonly (keyof CreateDelegatedQurlBatchInput)[];

export const DELEGATED_BATCH_GRANT_KEYS = [
  "expires_in",
  "label",
  "one_time_use",
  "max_sessions",
  "session_duration",
  "access_policy",
] as const satisfies readonly (keyof DelegatedQurlGrant)[];

export const DELEGATED_BATCH_CREATE_OPTION_KEYS = [
  "idempotencyKey",
] as const satisfies readonly (keyof CreateDelegatedQurlBatchOptions)[];

export const DELEGATED_BATCH_GET_OPTION_KEYS = [
  "etag",
] as const satisfies readonly (keyof GetDelegatedQurlBatchOptions)[];

// Compile-time witness: `Exclude<keyof X, (typeof KEYS)[number]>` is
// `never` iff KEYS lists every key of X. Paired with the
// `satisfies readonly (keyof X)[]` clause on the array (which catches
// the other direction), this gives bidirectional drift detection on
// the *_KEYS allowlists at zero runtime cost.
export function assertExhaustive<T extends true>(_: T): void {
  /* type-only check */
}

assertExhaustive<
  Exclude<keyof ListInput, (typeof LIST_PARAM_KEYS)[number]> extends never ? true : never
>(true);

assertExhaustive<
  Exclude<keyof RequestOptions, (typeof REQUEST_OPTION_KEYS)[number]> extends never ? true : never
>(true);

assertExhaustive<
  Exclude<
    keyof CreateDelegatedQurlBatchInput,
    (typeof DELEGATED_BATCH_INPUT_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

assertExhaustive<
  Exclude<keyof DelegatedQurlGrant, (typeof DELEGATED_BATCH_GRANT_KEYS)[number]> extends never
    ? true
    : never
>(true);

assertExhaustive<
  Exclude<
    keyof CreateDelegatedQurlBatchOptions,
    (typeof DELEGATED_BATCH_CREATE_OPTION_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

assertExhaustive<
  Exclude<
    keyof GetDelegatedQurlBatchOptions,
    (typeof DELEGATED_BATCH_GET_OPTION_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

export const CREATE_FIELD_KEYS = [
  "private",
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
export const UPDATE_FIELD_KEYS = [
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
export const MINT_FIELD_KEYS = [
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

export const RESOURCE_LIST_PARAM_KEYS = [
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

export const CREATE_RESOURCE_FIELD_KEYS = [
  "private",
  "consumer_access",
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

export const UPDATE_RESOURCE_FIELD_KEYS = [
  "allowed_device_keys_add",
  "allowed_device_keys_remove",
  "consumer_access",
  "expected_consumer_access_version",
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

export const CREATE_QURL_FOR_RESOURCE_FIELD_KEYS = [
  "expires_in",
  "one_time_use",
  "max_sessions",
  "session_duration",
  "label",
  "access_policy",
  "target_path",
] as const satisfies readonly (keyof CreateQurlForResourceInput)[];

export const SHARE_RESOURCE_OPTION_KEYS = [
  "ttlSeconds",
] as const satisfies readonly (keyof ShareResourceOptions)[];

assertExhaustive<
  Exclude<keyof ShareResourceOptions, (typeof SHARE_RESOURCE_OPTION_KEYS)[number]> extends never
    ? true
    : never
>(true);

assertExhaustive<
  Exclude<
    keyof CreateQurlForResourceInput,
    (typeof CREATE_QURL_FOR_RESOURCE_FIELD_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

/**
 * Options accepted by the portal-verb `protectUrl` / `createPortal`
 * surface. These are camelCase caller-facing options (the portal verbs are
 * the idiomatic layer); the build helpers map them onto the same wire
 * fields the REST-shaped methods send.
 */
export const PROTECT_URL_OPTION_KEYS = [
  "private",
  "consumerAccess",
  "description",
  "tags",
  "customDomain",
  "alias",
] as const satisfies readonly (keyof ProtectUrlOptions)[];

assertExhaustive<
  Exclude<keyof ProtectUrlOptions, (typeof PROTECT_URL_OPTION_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const CREATE_PORTAL_OPTION_KEYS = [
  "validFor",
  "label",
  "oneTimeUse",
  "maxSessions",
  "sessionDuration",
  "targetPath",
] as const satisfies readonly (keyof CreatePortalOptions)[];

assertExhaustive<
  Exclude<keyof CreatePortalOptions, (typeof CREATE_PORTAL_OPTION_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const UPDATE_RESOURCE_QURL_FIELD_KEYS = [
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

export const UPDATE_CUSTOMER_FIELD_KEYS = [
  "spending_cap_cents",
] as const satisfies readonly (keyof UpdateCustomerInput)[];

assertExhaustive<
  Exclude<keyof UpdateCustomerInput, (typeof UPDATE_CUSTOMER_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const CREATE_BILLING_CHECKOUT_FIELD_KEYS = [
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

export const REGISTER_DOMAIN_FIELD_KEYS = [
  "domain",
] as const satisfies readonly (keyof RegisterDomainInput)[];

assertExhaustive<
  Exclude<keyof RegisterDomainInput, (typeof REGISTER_DOMAIN_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const CREATE_WEBHOOK_FIELD_KEYS = [
  "url",
  "events",
  "description",
] as const satisfies readonly (keyof CreateWebhookInput)[];

assertExhaustive<
  Exclude<keyof CreateWebhookInput, (typeof CREATE_WEBHOOK_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const UPDATE_WEBHOOK_FIELD_KEYS = [
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

export const CREATE_API_KEY_FIELD_KEYS = [
  "kind",
  "name",
  "scopes",
  "target",
  "claims",
  "expires_in",
] as const satisfies readonly (keyof CreateDurableApiKeyInput | keyof CreateEnrollmentTokenInput)[];

assertExhaustive<
  Exclude<
    keyof CreateDurableApiKeyInput | keyof CreateEnrollmentTokenInput,
    (typeof CREATE_API_KEY_FIELD_KEYS)[number]
  > extends never
    ? true
    : never
>(true);

export const UPDATE_API_KEY_FIELD_KEYS = [
  "name",
  "scopes",
] as const satisfies readonly (keyof UpdateApiKeyInput)[];

assertExhaustive<
  Exclude<keyof UpdateApiKeyInput, (typeof UPDATE_API_KEY_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const REDEEM_ACCESS_CODE_FIELD_KEYS = [
  "code",
  "honeypot",
  "elapsed_ms",
] as const satisfies readonly (keyof RedeemAccessCodeInput)[];

assertExhaustive<
  Exclude<keyof RedeemAccessCodeInput, (typeof REDEEM_ACCESS_CODE_FIELD_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const CREATE_ACCESS_CODE_FIELD_KEYS = [
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

export const CONNECTOR_INSTALLATION_LIST_PARAM_KEYS = [
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

export const BILLING_INVOICE_LIST_PARAM_KEYS = [
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

export const DOMAIN_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListDomainsInput)[];

assertExhaustive<
  Exclude<keyof ListDomainsInput, (typeof DOMAIN_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const WEBHOOK_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
] as const satisfies readonly (keyof ListWebhooksInput)[];

assertExhaustive<
  Exclude<keyof ListWebhooksInput, (typeof WEBHOOK_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);

export const WEBHOOK_DELIVERY_LIST_PARAM_KEYS = [
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

export const API_KEY_LIST_PARAM_KEYS = [
  "limit",
  "cursor",
  "status",
] as const satisfies readonly (keyof ListApiKeysInput)[];

assertExhaustive<
  Exclude<keyof ListApiKeysInput, (typeof API_KEY_LIST_PARAM_KEYS)[number]> extends never
    ? true
    : never
>(true);
