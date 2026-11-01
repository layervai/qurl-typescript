import type { ApiKeyRequestScope, CredentialClaimInput, CredentialTargetInput } from "./types.js";
import { assertExhaustive } from "./client-input-fields.js";
import {
  requireMaxLength,
  requireNoUnknownFields,
  requireNonEmptyArrayField,
  requireNonEmptyStringField,
  requireStringArrayElements,
  requireValidHttpUrl,
} from "./client-validation.js";
import {
  MAX_API_KEY_NAME,
  MAX_DESCRIPTION,
  MAX_ENROLLMENT_TOKEN_TTL_SECONDS,
} from "./client-limits.js";
import { clientValidationError } from "./client-errors.js";
import { CONNECTOR_SLUG_PATTERN } from "./client-connectors.js";

const API_KEY_REQUEST_SCOPE_VALUES = [
  "qurl:read",
  "qurl:write",
  "qurl:resolve",
  "qurl:agent",
] as const satisfies readonly ApiKeyRequestScope[];

assertExhaustive<
  Exclude<ApiKeyRequestScope, (typeof API_KEY_REQUEST_SCOPE_VALUES)[number]> extends never
    ? true
    : never
>(true);

const API_KEY_REQUEST_SCOPES = new Set<string>(API_KEY_REQUEST_SCOPE_VALUES);

/** Narrow a response scope before reusing it in a create/update request. */
export function isApiKeyRequestScope(scope: string): scope is ApiKeyRequestScope {
  return API_KEY_REQUEST_SCOPES.has(scope);
}

const CREDENTIAL_TARGET_VALUES = [
  "agent",
  "connector",
] as const satisfies readonly CredentialTargetInput[];

assertExhaustive<
  Exclude<CredentialTargetInput, (typeof CREDENTIAL_TARGET_VALUES)[number]> extends never
    ? true
    : never
>(true);

const CREDENTIAL_TARGETS = new Set<string>(CREDENTIAL_TARGET_VALUES);

const CREDENTIAL_CLAIM_TYPE_VALUES = [
  "connector",
] as const satisfies readonly CredentialClaimInput["type"][];

assertExhaustive<
  Exclude<CredentialClaimInput["type"], (typeof CREDENTIAL_CLAIM_TYPE_VALUES)[number]> extends never
    ? true
    : never
>(true);

const CREDENTIAL_CLAIM_TYPES = new Set<string>(CREDENTIAL_CLAIM_TYPE_VALUES);

// Mirrors CreateApiKeyRequest.expires_in in the service OpenAPI. Composite
// durations are deliberately invalid on this endpoint. The 24h cap permits
// 1d, but no positive whole-week duration.
const CREDENTIAL_DURATION_PATTERN = /^([0-9]+)([smhdw])$/;

type CredentialDurationUnit = "s" | "m" | "h" | "d" | "w";

const CREDENTIAL_DURATION_MULTIPLIERS: Readonly<Record<CredentialDurationUnit, bigint>> = {
  s: 1n,
  m: 60n,
  h: 3600n,
  d: 86400n,
  w: 604800n,
};

export function validateWebhookWriteFields(
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

export function validateApiKeyWriteFields(
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
    const unsupported = (input.scopes as string[]).find(
      (scope) => !API_KEY_REQUEST_SCOPES.has(scope),
    );
    if (unsupported !== undefined) {
      throw clientValidationError(
        `${method}: scopes contains an unsupported permission ${JSON.stringify(unsupported)}; this SDK accepts ${API_KEY_REQUEST_SCOPE_VALUES.join(", ")}`,
      );
    }
  }
}

export function validateEnrollmentTokenFields(
  input: Record<string, unknown>,
  method: string,
): void {
  if (
    input.target !== undefined &&
    (typeof input.target !== "string" || !CREDENTIAL_TARGETS.has(input.target))
  ) {
    throw clientValidationError(`${method}: target must be 'agent' or 'connector'`);
  }

  let claimCount = 0;
  if (input.claims !== undefined) {
    if (!Array.isArray(input.claims)) {
      throw clientValidationError(`${method}: claims must be an array`);
    }
    if (input.claims.length > 1) {
      throw clientValidationError(`${method}: claims must contain at most one claim`);
    }
    claimCount = input.claims.length;
    for (const [index, claim] of input.claims.entries()) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
        throw clientValidationError(`${method}: claims[${index}] must be an object`);
      }
      requireNoUnknownFields(
        claim as Record<string, unknown>,
        ["type", "id"],
        `${method}: claims[${index}]`,
      );
      const record = claim as Record<string, unknown>;
      if (typeof record.type !== "string" || !CREDENTIAL_CLAIM_TYPES.has(record.type)) {
        throw clientValidationError(`${method}: claims[${index}].type must be 'connector'`);
      }
      if (typeof record.id !== "string" || !CONNECTOR_SLUG_PATTERN.test(record.id)) {
        throw clientValidationError(
          `${method}: claims[${index}].id is not a valid connector slug; use 3-64 lowercase letters, digits, or hyphens, starting with a letter and ending with a letter or digit`,
        );
      }
    }
  }
  // CreateApiKeyRequest.target permits an agent with zero or one connector claim.
  if (input.target === "connector" && claimCount !== 1) {
    throw clientValidationError(`${method}: target 'connector' requires exactly one claim`);
  }

  if (input.expires_in !== undefined) {
    if (typeof input.expires_in !== "string") {
      throw clientValidationError(`${method}: expires_in must be a duration string`);
    }
    const match = CREDENTIAL_DURATION_PATTERN.exec(input.expires_in);
    if (!match) {
      throw clientValidationError(`${method}: expires_in must match <integer><s|m|h|d|w>`);
    }
    const seconds =
      BigInt(match[1]) * CREDENTIAL_DURATION_MULTIPLIERS[match[2] as CredentialDurationUnit];
    if (seconds <= 0n || seconds > MAX_ENROLLMENT_TOKEN_TTL_SECONDS) {
      throw clientValidationError(
        `${method}: expires_in must be greater than zero and at most 24h`,
      );
    }
  }
}
