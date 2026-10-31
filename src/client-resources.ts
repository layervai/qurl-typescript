import { requireCanonicalTargetPath } from "./target-path.js";
import type {
  ConsumerAccessPolicy,
  CreateInput,
  CreateQurlForResourceInput,
  UpdateResourceQurlInput,
} from "./types.js";
import { ValidationError } from "./errors.js";
import { TEXT_ENCODER, clientValidationError } from "./client-errors.js";
import {
  describeShape,
  requireBooleanIfPresent,
  requireMaxLength,
  requireMaxSessionsInRange,
  requireNoUnknownFields,
  requireNonEmptyIfPresent,
  requireObjectInput,
  requireStringArrayElements,
  requireValidAccessPolicy,
  requireValidTags,
  requireValidTargetUrl,
} from "./client-validation.js";
import { CREATE_FIELD_KEYS } from "./client-input-fields.js";
import {
  MAX_ALIAS,
  MAX_ALLOWED_DEVICE_KEYS,
  MAX_CONSUMER_CONTRACT_ID_BYTES,
  MAX_CUSTOM_DOMAIN,
  MAX_DESCRIPTION,
  MAX_LABEL,
  MAX_SLUG,
} from "./client-limits.js";

export function validateCreateInput(input: CreateInput): void {
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
  collect(() => requireBooleanIfPresent(input.private, "private"));
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

export function validateQurlTokenOptions(input: CreateQurlForResourceInput | undefined): void {
  if (input === undefined) return;
  requireMaxLength(input.label, "label", MAX_LABEL);
  requireNonEmptyIfPresent(input.label, "label");
  requireNonEmptyIfPresent(input.expires_in, "expires_in");
  requireNonEmptyIfPresent(input.session_duration, "session_duration");
  requireCanonicalTargetPath(input.target_path, "target_path");
  requireBooleanIfPresent(input.one_time_use, "one_time_use");
  requireMaxSessionsInRange(input.max_sessions);
  requireValidAccessPolicy(input.access_policy);
}

export function validateResourceQurlUpdateInput(input: UpdateResourceQurlInput): void {
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

export function validateResourceWriteFields(
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
  collect(() => {
    if (input.private !== undefined && typeof input.private !== "boolean") {
      throw clientValidationError("private: must be a boolean");
    }
    if (input.consumer_access !== undefined) {
      const policy = input.consumer_access;
      requireObjectInput(policy, "consumer_access");
      const p = policy as Record<string, unknown>;
      requireNoUnknownFields(p, ["mode", "version", "contract_id"], "consumer_access");
      if (
        !["keys", "invite_only", "email_capture", "review", "contract"].includes(
          p.mode as string,
        ) ||
        !Number.isSafeInteger(p.version) ||
        (p.version as number) < 1
      ) {
        throw clientValidationError("consumer_access: invalid mode or version");
      }
      if (p.mode === "contract") {
        if (
          typeof p.contract_id !== "string" ||
          !p.contract_id.trim() ||
          TEXT_ENCODER.encode(p.contract_id).length > MAX_CONSUMER_CONTRACT_ID_BYTES
        ) {
          throw clientValidationError(
            "consumer_access: contract mode requires a bounded contract_id",
          );
        }
      } else if (p.contract_id !== undefined) {
        throw clientValidationError("consumer_access: contract_id requires contract mode");
      }
      if (input.private === false)
        throw clientValidationError("consumer_access: requires a private resource");
      if (options.requireUrlTarget) {
        if (p.version !== 1 || input.private !== true)
          throw clientValidationError(
            "consumer_access: creation requires private true and version one",
          );
      } else if (options.allowAliasClear) {
        const expected = input.expected_consumer_access_version;
        if (
          !Number.isSafeInteger(expected) ||
          (expected as number) < 0 ||
          p.version !== (expected as number) + 1 ||
          Object.keys(input).some(
            (key) => key !== "consumer_access" && key !== "expected_consumer_access_version",
          )
        ) {
          throw clientValidationError(
            "consumer_access: update requires its expected version and no metadata changes",
          );
        }
      }
    } else if (input.expected_consumer_access_version !== undefined) {
      throw clientValidationError("expected_consumer_access_version: requires consumer_access");
    }
  });
  collect(() => {
    const fields = ["allowed_device_keys_add", "allowed_device_keys_remove"] as const;
    for (const field of fields) {
      const keys = input[field];
      if (keys === undefined) continue;
      requireStringArrayElements(keys, field, "updateResource");
      if (keys.length > MAX_ALLOWED_DEVICE_KEYS || new Set(keys).size !== keys.length) {
        throw clientValidationError(
          `${field}: must contain at most ${MAX_ALLOWED_DEVICE_KEYS} unique keys`,
        );
      }
      for (const key of keys) {
        let canonical = false;
        try {
          canonical = key.length === 44 && atob(key).length === 32 && btoa(atob(key)) === key;
        } catch {
          /* Invalid base64 is rejected below. */
        }
        if (!canonical) {
          throw clientValidationError(`${field}: keys must be canonical padded base64 of 32 bytes`);
        }
      }
      if (input.custom_domain !== undefined) {
        throw clientValidationError(`${field}: update separately from custom_domain`);
      }
    }
    const added = new Set(input.allowed_device_keys_add as string[] | undefined);
    if ((input.allowed_device_keys_remove as string[] | undefined)?.some((key) => added.has(key))) {
      throw clientValidationError("allowed device key additions and removals must not overlap");
    }
  });
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
export function batchItemResultValidationReason(entry: unknown): string | null {
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

export function sameConsumerPolicy(
  actual: ConsumerAccessPolicy | undefined,
  expected: ConsumerAccessPolicy,
  foundExisting: boolean,
): boolean {
  return (
    actual?.mode === expected.mode &&
    (actual?.version === expected.version ||
      (foundExisting &&
        Number.isSafeInteger(actual?.version) &&
        Number(actual?.version) > expected.version)) &&
    actual?.contract_id === expected.contract_id
  );
}
