import { clientValidationError } from "./client-errors.js";
import { MAX_TARGET_PATH } from "./client-limits.js";
import { requireMaxUtf8Bytes, requireNonEmptyIfPresent } from "./client-validation.js";

// TODO(upstream-contract): qurl-service ValidateTargetPath and the released
// target_path_v1_vectors define this grammar without normalization.
const INVALID_TARGET_PATH_ASCII = /[^A-Za-z0-9._~!$&()*+,;=:@%/?-]/;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-fA-F]{2})/;

export function isCanonicalTargetPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_TARGET_PATH ||
    value.startsWith("//") ||
    !value.startsWith("/") ||
    INVALID_TARGET_PATH_ASCII.test(value) ||
    MALFORMED_PERCENT_ESCAPE.test(value)
  )
    return false;
  const path = value.split("?", 1)[0]!;
  // Queries remain encoded data; only the path defines authorization.
  return (
    !/[%!()*;]/.test(path) &&
    !path.slice(1).includes("//") &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

export function requireCanonicalTargetPath(value: string | undefined, field: string): void {
  if (value === undefined) return;
  requireMaxUtf8Bytes(value, field, MAX_TARGET_PATH);
  requireNonEmptyIfPresent(value, field);
  if (!isCanonicalTargetPath(value)) {
    throw clientValidationError(`${field}: must be a canonical ASCII path with optional query`);
  }
}
