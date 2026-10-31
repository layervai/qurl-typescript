import { parseCrid } from "./crid.js";
import { clientValidationError } from "./client-errors.js";
import { MAX_PATH_ID_DECODE_PASSES, MAX_PATH_ID_LENGTH } from "./client-limits.js";

// Best-effort defence-in-depth against today's access-token grammar. The
// service remains authoritative because resource IDs and credentials are both
// opaque and future credential formats may not retain the `at_` prefix. The
// delimiter requirement cannot collide with current base64url public keys,
// standard-base64 keys, or base32 CRIDs.
export const PATH_EMBEDDED_ACCESS_TOKEN_RE = /[?&#=:\s]at_/i;

export const PATH_PREFIXED_ACCESS_TOKEN_RE = /\/at_/i;

export const QURL_LINK_URL_RE =
  /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*qurl\.link(?::\d{1,5})?(?:\/|[?#])/i;

// ponytail: today's 22-character token suffix only improves URL-paste diagnostics;
// other lengths are still rejected as URLs without echoing the input.
export const URL_EMBEDDED_ACCESS_TOKEN_RE = /[?&#=:/]at_[a-z0-9_-]{22}(?:$|[?&#:/])/i;

// A host without a slash can be a legitimate domain identifier. Require the
// path boundary so shared validation does not break the domain namespace.
export const PATH_SCHEMELESS_URL_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?\//i;

export const QURL_DISPLAY_ID_PREFIX_RE = /^q_/i;

export function isUrlLikePathId(value: string): boolean {
  return /^https?:\/\//i.test(value) || PATH_SCHEMELESS_URL_RE.test(value);
}

export interface PathIdValidationOptions {
  /** Reject a bare access token in namespaces that accept resource/qURL IDs. */
  rejectBareAccessToken?: boolean;
  /** Safe, non-secret recovery guidance appended to an access-token error. */
  accessTokenRecovery?: string;
  /** Reject qURL display IDs where the operation requires a parent resource. */
  rejectQurlDisplayId?: boolean;
  requireCridUnlessQurlDisplayId?: boolean;
}

export const REVOKE_INDIVIDUAL_QURL_RECOVERY =
  "revoke individual tokens with revokeResourceQurl(crid, qurlId)";

export const DELETE_RESOURCE_RECOVERY =
  "pass a CRID returned by the API; to revoke one qURL, call revokeResourceQurl(crid, qurlId)";

export const RESOURCE_OR_QURL_ID_PATH_OPTIONS: PathIdValidationOptions = {
  requireCridUnlessQurlDisplayId: true,
};

export const QURL_ID_PATH_OPTIONS: PathIdValidationOptions = {
  rejectBareAccessToken: true,
  accessTokenRecovery: "pass the qURL display ID, not its access token",
};

/**
 * Validates that a path-parameter argument is a non-empty string. Some callers
 * pass resource/qURL display IDs, while newer endpoints also pass domains,
 * session IDs, webhook IDs, and API-key IDs, so this intentionally enforces
 * only basic shape plus transport-safety rules and leaves endpoint-specific
 * identifier grammar to the service.
 */
export function validatePathId(
  id: string,
  method: string,
  field = "id",
  options: PathIdValidationOptions = {},
): void {
  if (options.requireCridUnlessQurlDisplayId && typeof id === "string" && !id.startsWith("q_")) {
    requireResourceCrid(id, method, field);
    return;
  }
  // `.trim()` catches whitespace-only and padded IDs before they round-trip as
  // `%20...%20` paths that the server can only reject with a less useful 404.
  // The pre-flight error is more actionable than the 404.
  if (typeof id !== "string") {
    const observedType = id === null ? "null" : typeof id;
    throw clientValidationError(`${method}: ${field} is required (got ${observedType})`);
  }
  if (id.trim() === "") {
    throw clientValidationError(`${method}: ${field} is required`);
  }
  if (id.trim() !== id) {
    throw clientValidationError(
      `${method}: ${field} must not include leading or trailing whitespace`,
    );
  }
  if (id.length > MAX_PATH_ID_LENGTH) {
    throw clientValidationError(
      `${method}: ${field} must be ${MAX_PATH_ID_LENGTH} characters or fewer`,
    );
  }
  const decodedIds = decodedPathIdForms(id);
  // URL resolvers and intermediaries can normalize raw or pre-encoded dot
  // segments before routing. Reject every decoded form we inspected so an
  // item operation cannot be retargeted to a collection endpoint. Embedded
  // `a/../b` remains an opaque single segment because the later URL builder
  // percent-encodes its slash.
  if (decodedIds.some((value) => value === "." || value === "..")) {
    throw clientValidationError(`${method}: ${field} is an invalid URL path segment`);
  }
  // `/` is deliberately outside the general delimiter class so a URL path
  // such as `/at_a_glance` is not misread as a credential. For non-URL input,
  // `/at_` remains a strong pasted-path signal. Fragment, query, header, and
  // pasted `Bearer at_...` / `token:at_...` forms are also strong signals.
  // Bare `at_...` values are rejected only for resource/qURL identifiers:
  // those current formats have fixed non-colliding prefixes, while domain,
  // webhook, session, and API-key IDs are deliberately opaque/open contracts.
  // Full URLs and delimiter/path-prefixed credentials remain rejected in
  // every namespace.
  const containsUrl = decodedIds.some(isUrlLikePathId);
  const containsAccessToken = decodedIds.some((value) => {
    const valueIsUrl = isUrlLikePathId(value);
    return (
      (QURL_LINK_URL_RE.test(value) &&
        (PATH_EMBEDDED_ACCESS_TOKEN_RE.test(value) || PATH_PREFIXED_ACCESS_TOKEN_RE.test(value))) ||
      (valueIsUrl
        ? URL_EMBEDDED_ACCESS_TOKEN_RE.test(value)
        : PATH_EMBEDDED_ACCESS_TOKEN_RE.test(value) || PATH_PREFIXED_ACCESS_TOKEN_RE.test(value)) ||
      (options.rejectBareAccessToken === true && value.slice(0, 3).toLowerCase() === "at_")
    );
  });
  if (containsAccessToken) {
    const recovery = options.accessTokenRecovery ?? "pass the identifier returned by the API";
    throw clientValidationError(
      `${method}: ${field} must not contain an access token; ${recovery}`,
    );
  }
  // A full target/qURL is a common argument mix-up, but it is distinct from
  // passing an access-token credential. Diagnose it accurately without
  // echoing the URL, which may itself contain sensitive query parameters.
  if (containsUrl) {
    throw clientValidationError(`${method}: ${field} must be an identifier, not a URL`);
  }
  if (
    options.rejectQurlDisplayId === true &&
    decodedIds.some((value) => QURL_DISPLAY_ID_PREFIX_RE.test(value))
  ) {
    throw clientValidationError(
      `${method}: ${field} must not be a qURL display ID; ${REVOKE_INDIVIDUAL_QURL_RECOVERY}`,
    );
  }
}

export function decodedPathIdForms(id: string): string[] {
  // Probe repeatedly encoded input too. Callers sometimes pre-encode a copied
  // link before passing it through a URL builder that encodes it again. Three
  // passes cover the common accidental cases without allowing hostile input
  // to create unbounded work. More deeply encoded or malformed-percent input
  // deliberately fails open to the authoritative service after safe segment
  // encoding; this heuristic is not an identifier parser.
  const decodedIds = [id];
  let decodedId = id;
  for (let pass = 0; pass < MAX_PATH_ID_DECODE_PASSES; pass += 1) {
    try {
      const next = decodeURIComponent(decodedId);
      if (next === decodedId) break;
      decodedIds.push(next);
      decodedId = next;
    } catch {
      // Malformed percent escapes remain opaque and are left to the service.
      break;
    }
  }
  return decodedIds;
}

export function requireResourceCrid(crid: string, method: string, field = "id"): void {
  if (parseCrid(crid)) return;
  // Keep actionable paste errors without inspecting valid CRIDs twice.
  validatePathId(crid, method, field, {
    rejectBareAccessToken: true,
    rejectQurlDisplayId: true,
    accessTokenRecovery:
      method === "delete" || method === "deleteResource"
        ? DELETE_RESOURCE_RECOVERY
        : "pass a CRID returned by the API",
  });
  throw clientValidationError(`${method}: requires a valid CRID`);
}
