import type { AIAgentPolicy, AccessPolicy } from "./types.js";
import { TEXT_ENCODER, clientValidationError } from "./client-errors.js";
import { MAX_MAX_SESSIONS, MAX_TAGS, MAX_TAG_LENGTH, MAX_TARGET_URL } from "./client-limits.js";

// CreateQurlRequest.target_url pattern is loose (just a URI) but
// UpdateQurlRequest.tags pattern is specific — enforce it here.
export const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;

export function requireMaxLength(value: string | undefined, field: string, max: number): void {
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

export function requireMaxUtf8Bytes(value: string | undefined, field: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw clientValidationError(
      `${field}: must be a string (got ${value === null ? "null" : typeof value})`,
    );
  }
  const bytes = TEXT_ENCODER.encode(value).byteLength;
  if (bytes > max) {
    throw clientValidationError(`${field}: must be ${max} UTF-8 bytes or fewer (got ${bytes})`);
  }
}

export function requireNonEmptyIfPresent(value: unknown, field: string): void {
  // Reject `""` so uninitialized form state doesn't reach the wire.
  if (value === "") {
    throw clientValidationError(`${field}: must not be an empty string`);
  }
}

export function requireMaxSessionsInRange(value: number | undefined, field = "max_sessions"): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_MAX_SESSIONS) {
    throw clientValidationError(
      `${field}: must be an integer between 0 and ${MAX_MAX_SESSIONS} (got ${value})`,
    );
  }
}

export function requireBooleanIfPresent(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw clientValidationError(`${field}: must be a boolean (got ${describeShape(value)})`);
  }
}

export function requireListLimitInRange(value: unknown, methodName: string): void {
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

export function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

/** Match the API's tag grammar, which permits embedded spaces; values stay in JSON bodies. */
export function requireValidTags(tags: string[] | null | undefined): void {
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

export function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export const ACCESS_POLICY_LIST_FIELDS = [
  "ip_allowlist",
  "ip_denylist",
  "geo_allowlist",
  "geo_denylist",
] as const satisfies readonly (keyof AccessPolicy)[];

export const ACCESS_POLICY_STRING_FIELDS = [
  "user_agent_allow_regex",
  "user_agent_deny_regex",
] as const satisfies readonly (keyof AccessPolicy)[];

export const AI_AGENT_POLICY_LIST_FIELDS = [
  "deny_categories",
  "allow_categories",
] as const satisfies readonly (keyof AIAgentPolicy)[];

export function requireValidAccessPolicy(policy: AccessPolicy | null | undefined): void {
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
export const ALLOWED_URL_SCHEMES = ["http://", "https://"] as const;

export function requireValidHttpUrl(value: unknown, field: string): void {
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

export function requireValidTargetUrl(target_url: unknown): void {
  requireValidHttpUrl(target_url, "target_url");
}

export function requireObjectInput(
  input: unknown,
  method: string,
): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw clientValidationError(
      `${method}: input must be an object (got ${input === null ? "null" : typeof input})`,
    );
  }
}

export function requireNonEmptyStringField(
  input: Record<string, unknown>,
  field: string,
  method: string,
): void {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw clientValidationError(`${method}: ${field} must be a non-empty string`);
  }
}

export function requireNonEmptyArrayField(
  input: Record<string, unknown>,
  field: string,
  method: string,
): void {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw clientValidationError(`${method}: ${field} must be a non-empty array`);
  }
}

export function requireStringArrayElements(
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

export function requireAtLeastOneField(
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

export function requireNoUnknownFields(
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

export function normalizePatchFields(
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

export function requireConsumerDecision(id: string, version: number, allowNew = false): void {
  if (
    typeof id !== "string" ||
    (!/^[a-f0-9]{64}$/.test(id) && !(allowNew && id === "new")) ||
    !Number.isSafeInteger(version) ||
    version < (allowNew ? 0 : 1)
  )
    throw clientValidationError("consumer decision: invalid id or expected version");
}

/**
 * Portal-verb target URL validation (qurl-go `ProtectURL` parity). On top of
 * the shared scheme/length check, the URL must carry a host and must parse,
 * and embedded credentials (userinfo) are rejected. The added checks never
 * echo the URL — a userinfo URL contains credentials that must stay out of
 * logs and error messages. The REST-shaped compatibility layer keeps its
 * original prefix-only check so its accepted inputs don't change.
 */
export function requirePortalTargetUrl(targetUrl: unknown): void {
  requireValidTargetUrl(targetUrl);
  const url = targetUrl as string; // requireValidTargetUrl only returns for http(s) strings
  // WHATWG URL normalizes away an empty authority ("https:///x" parses
  // with host "x"), so the host-presence check runs on the raw string,
  // mirroring qurl-go's url.Parse which rejects authority-less URLs.
  const afterScheme = url.slice(url.indexOf("://") + 3);
  if (afterScheme === "" || "/?#".includes(afterScheme[0])) {
    throw clientValidationError("target_url: must include a host");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw clientValidationError("target_url: malformed URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw clientValidationError("target_url: must not include embedded credentials (userinfo)");
  }
}
