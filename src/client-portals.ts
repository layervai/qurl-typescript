import type { CreatePortalOptions, Portal, RequestOptions, Resource } from "./types.js";
import { copyResponseMetadata } from "./response-metadata.js";
import { clientValidationError, unexpectedResponseError } from "./client-errors.js";
import { verifyResourceIdentity } from "./client-connectors.js";
import {
  normalizePatchFields,
  requireBooleanIfPresent,
  requireMaxLength,
  requireMaxSessionsInRange,
  requireMaxUtf8Bytes,
  requireNoUnknownFields,
  requireNonEmptyIfPresent,
  requireObjectInput,
} from "./client-validation.js";
import { CREATE_PORTAL_OPTION_KEYS } from "./client-input-fields.js";
import { MAX_LABEL, MAX_TARGET_PATH } from "./client-limits.js";
import type { QURLClient } from "./client.js";

// ---- Portal-verb helpers (mirrors qurl-go) -------------------------------
// Client-side guardrails for the portal flow (protectUrl → createPortal →
// enterPortal), kept in lockstep with qurl-go's option validation and
// qurl-python's port of it.

/**
 * Client-side floor for portal lifetimes, mirroring qurl-go's `ValidFor`.
 * The LayerV API remains the source of truth for account limits; there is
 * intentionally no SDK-side maximum because an account may allow
 * longer-lived portals.
 */
export const MIN_PORTAL_VALID_FOR_SECONDS = 60;

/**
 * Client-side floor for session durations, mirroring qurl-go's
 * `WithSessionDuration` (at least one second; zero is rejected rather than
 * treated as the server default).
 */
export const MIN_SESSION_DURATION_SECONDS = 1;

/**
 * Shape of qurl-go's offline signed-fragment links: three or more
 * dot-separated base64url parts (<version>.<claims>.<secret>.<sig>).
 * Detected only to give those links a precise error in extractAccessToken.
 *
 * @internal Exported for in-package tests; not re-exported from index.ts.
 */
export const SIGNED_FRAGMENT_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}$/;

// Access-token grammar accepted by enterPortal (base64url charset).
export const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Serialize a duration option to the API's h/m/s duration grammar.
 *
 * Strings pass through unvalidated — the server is authoritative, same as
 * the REST-shaped `expires_in` fields. Numbers are milliseconds and get
 * qurl-go's client-side guardrails: whole seconds only and at least
 * `minimumSeconds` (checked in that order so e.g. 30.5s reports "at least
 * 60s" in every SDK). Serialized with hours as the largest unit so all API
 * duration fields use the same grammar across SDKs.
 */
export function serializeApiDuration(
  value: string | number | undefined,
  field: string,
  minimumSeconds: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw clientValidationError(`${field}: must be a non-empty duration string`);
    }
    return value;
  }
  if (typeof value === "number") {
    // NaN fails no comparison, so an explicit finite check keeps the
    // error actionable instead of a misleading "whole seconds" report.
    if (!Number.isFinite(value)) {
      throw clientValidationError(`${field}: must be a finite number of milliseconds`);
    }
    if (value < minimumSeconds * 1000) {
      throw clientValidationError(`${field}: must be at least ${minimumSeconds}s`);
    }
    if (value % 1000 !== 0) {
      throw clientValidationError(`${field}: must be whole seconds`);
    }
    const seconds = value / 1000;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
  }
  throw clientValidationError(
    `${field}: must be a duration string (e.g. "5m") or a number of milliseconds`,
  );
}

/**
 * Extract the access token from a qURL link, or pass a bare token through.
 *
 * Platform-issued links carry the access token in the URL fragment
 * (`https://qurl.link/#at_...`). Error messages deliberately never echo the
 * input — qURL links are credentials and must stay out of logs.
 */
export function extractAccessToken(qurlLink: unknown): string {
  if (typeof qurlLink !== "string" || qurlLink.trim() === "") {
    throw clientValidationError("qurlLink: must be a non-empty string");
  }
  const hashIndex = qurlLink.indexOf("#");
  const token = hashIndex >= 0 ? qurlLink.slice(hashIndex + 1) : qurlLink;
  if (SIGNED_FRAGMENT_RE.test(token)) {
    throw clientValidationError(
      "qurlLink: this is a signed qURL link (offline fragment format), which cannot be " +
        "opened through the API resolver — enterPortal only accepts platform links " +
        "(https://qurl.link/#at_...) or bare access tokens",
    );
  }
  if (token === "" || !ACCESS_TOKEN_RE.test(token)) {
    throw clientValidationError(
      "qurlLink: no access token found — pass a platform qURL link " +
        "(https://qurl.link/#at_...) or a bare access token",
    );
  }
  return token;
}

/**
 * Parse an RFC 3339 timestamp from the API into a `Date`, or `undefined`
 * when absent or unparseable. The portal surface exposes `Date` (matching
 * qurl-go's `time.Time` and qurl-python's `datetime`); the REST-shaped
 * layer keeps raw wire strings.
 */
export function parseApiDate(value: string | undefined): Date | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Wire shape shared by the two portal-minting endpoints. */
export type PortalWireResponse = {
  resource_id?: string;
  crid?: string;
  qurl_link?: string;
  qurl_site?: string;
  expires_at?: string;
  qurl_id?: string;
  label?: string;
};

/**
 * Parse a {@link Portal} from a create-portal API response. `resource_id`
 * and `qurl_link` are required, mirroring qurl-go's fail-closed response
 * check; everything else is optional because the two mint endpoints differ
 * in which ancillary fields they return.
 */
export async function parsePortal(
  data: PortalWireResponse | undefined,
  method: string,
  expectedCrid?: string,
): Promise<Portal> {
  if (typeof data?.resource_id !== "string" || data.resource_id.trim() === "") {
    throw unexpectedResponseError(`${method}: response is missing resource_id`);
  }
  if (typeof data.qurl_link !== "string" || data.qurl_link.trim() === "") {
    throw unexpectedResponseError(`${method}: response is missing qurl_link`);
  }
  await verifyResourceIdentity(data, method, expectedCrid);
  return copyResponseMetadata(data, {
    crid: data.crid as string,
    resourcePublicKey: data.resource_id,
    link: data.qurl_link,
    site: data.qurl_site,
    expiresAt: parseApiDate(data.expires_at),
    // Same empty-string → absent normalization the REST-shaped layer's
    // consumers apply to qurl_id.
    qurlId: data.qurl_id || undefined,
    label: data.label,
  });
}

/**
 * Validate portal options and build the create-portal wire body. The service
 * requires a JSON object even when every option is omitted; `{}` selects the
 * owner's plan defaults and matches qurl-go's zero-value request struct.
 */
export function buildCreatePortalBody(
  opts: CreatePortalOptions,
  method: string,
): Record<string, unknown> {
  requireObjectInput(opts, method);
  requireNoUnknownFields(opts, CREATE_PORTAL_OPTION_KEYS, method);
  // null → omitted, via the SDK-wide normalizePatchFields convention.
  const { validFor, label, oneTimeUse, maxSessions, sessionDuration, targetPath } =
    normalizePatchFields(opts, CREATE_PORTAL_OPTION_KEYS) as CreatePortalOptions;
  if (label !== undefined) {
    requireMaxLength(label, "label", MAX_LABEL);
    // qurl-go's WithLabel rejects blank labels; the REST-shaped mintLink
    // keeps its permissive whitespace behavior, so the check lives here.
    if (label.trim() === "") {
      throw clientValidationError("label: must not be empty");
    }
  }
  requireBooleanIfPresent(oneTimeUse, "oneTimeUse");
  requireMaxSessionsInRange(maxSessions, "maxSessions");
  requireMaxUtf8Bytes(targetPath, "targetPath", MAX_TARGET_PATH);
  requireNonEmptyIfPresent(targetPath, "targetPath");
  if (targetPath !== undefined && method === "createPortalForUrl") {
    throw clientValidationError("targetPath: requires an existing resource");
  }
  const body: Record<string, unknown> = {};
  const expiresIn = serializeApiDuration(validFor, "validFor", MIN_PORTAL_VALID_FOR_SECONDS);
  if (expiresIn !== undefined) body.expires_in = expiresIn;
  if (label !== undefined) body.label = label;
  if (oneTimeUse !== undefined) body.one_time_use = oneTimeUse;
  // Explicit 0 means unlimited and must survive body construction.
  if (maxSessions !== undefined) body.max_sessions = maxSessions;
  const wireSessionDuration = serializeApiDuration(
    sessionDuration,
    "sessionDuration",
    MIN_SESSION_DURATION_SECONDS,
  );
  if (wireSessionDuration !== undefined) body.session_duration = wireSessionDuration;
  if (targetPath !== undefined) body.target_path = targetPath;
  return body;
}

/**
 * A LayerV-protected resource, bound to the client that produced it.
 *
 * Obtained from {@link QURLClient.protectUrl} or {@link QURLClient.resourceByCrid} —
 * not constructed directly. Mint short-lived access links for the resource
 * with {@link createPortal} (qurl-go: `qurl.Resource`).
 */
export class ProtectedResource {
  // A true private field (not a module-scope WeakMap registry, which
  // CONTRIBUTING.md's dual-build rule bars) so the binding stays on the
  // instance and out of Object.keys/JSON.stringify output.
  readonly #client: QURLClient;
  /** The public resource CRID. */
  readonly crid: string;
  /** The private URL protected by this resource, when known. */
  readonly targetUrl?: string;
  /**
   * Full server-populated {@link Resource} metadata when the handle came
   * from an API response; `undefined` for {@link QURLClient.resourceByCrid}
   * handles and for the one-call {@link QURLClient.createPortalForUrl} path.
   */
  readonly details?: Resource;

  constructor(client: QURLClient, id: string, targetUrl?: string, details?: Resource) {
    this.#client = client;
    this.crid = id;
    this.targetUrl = targetUrl;
    this.details = details;
    copyResponseMetadata(details, this);
  }

  /**
   * Whether `resource` was produced by `client`. A static because the
   * binding lives in a private field that only this class can read; used
   * by {@link QURLClient.createPortal} to refuse handles bound to a
   * different client.
   */
  static isBoundTo(resource: ProtectedResource, client: QURLClient): boolean {
    return resource.#client === client;
  }

  /**
   * Mint a short-lived qURL link (a portal) for this resource. See
   * {@link QURLClient.createPortal} for the option reference.
   */
  async createPortal(
    opts: CreatePortalOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<Portal> {
    return this.#client.createPortal(this, opts, requestOptions);
  }
}
