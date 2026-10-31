import {
  ConnectorResourceOutcomeUnknownError,
  ERROR_CODE_CONNECTOR_RESOURCE_REVOKED,
  QURLError,
  RuntimeError,
} from "./errors.js";
import { cridKeyMatches } from "./crid.js";
import type { CreatePortalOptions, Portal, RequestOptions, Resource } from "./types.js";
import { clientValidationError, unexpectedResponseError } from "./client-errors.js";
import type { QURLClient } from "./client.js";
import { containsControlCharacter } from "./client-validation.js";

// Keep these identity contracts aligned with qurl-go and the public API.
export const CONNECTOR_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

// Current service schemas intentionally share this grammar, but keep the
// mutable alias contract separate from the immutable lookup identity.
export const CONNECTOR_ALIAS_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export const CONNECTOR_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{122}$/;

export const CONNECTOR_RESOURCE_ID_DER_PREFIX = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE";

export const CONNECTOR_ROUTING_ID_PATTERN = /^c-[a-z2-7]{51}[aq]$/;

export function requireConnectorSlug(slug: string, method: string): void {
  if (typeof slug !== "string" || !CONNECTOR_SLUG_PATTERN.test(slug)) {
    throw clientValidationError(
      `${method}: slug must be 3-64 lowercase alphanumeric or hyphen characters, start with a letter, and end alphanumeric`,
    );
  }
}

export function classifyConnectorMutationFailure(
  operation: "ensure" | "delete",
  error: unknown,
): never {
  if (!(error instanceof QURLError)) {
    throw new ConnectorResourceOutcomeUnknownError(
      new RuntimeError("Unexpected failure after Connector mutation dispatch", { cause: error }),
    );
  }
  // Most authoritative 4xx responses prove that the mutation was rejected.
  // bootstrap_key_consumed is the exception: the service returns it from the
  // consume phase after the resource may have been bound or found.
  // Callers perform argument/runtime preflight outside their mutation try
  // blocks; every other surfaced failure therefore follows dispatch or a
  // nominal success whose resource contract could not be consumed, so callers
  // must reconcile before retrying. Ensure's exact 201 + valid resource but
  // missing found_existing is handled after this classifier: the row proves
  // the selected resource, while only its required metadata is unavailable.
  if (operation === "ensure" && error.status === 409 && error.code === "bootstrap_key_consumed") {
    throw new ConnectorResourceOutcomeUnknownError(error);
  }
  if (error.status >= 400 && error.status < 500) {
    throw error;
  }
  throw new ConnectorResourceOutcomeUnknownError(error);
}

export function decodeCanonicalBase64Url(value: string): Uint8Array | undefined {
  if (
    !CONNECTOR_RESOURCE_ID_PATTERN.test(value) ||
    !value.startsWith(CONNECTOR_RESOURCE_ID_DER_PREFIX)
  ) {
    return undefined;
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "==";
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function requireConnectorSubtleCrypto(method: string): void {
  if (!globalThis.crypto?.subtle) {
    throw new RuntimeError(`${method}: requires the Web Crypto SubtleCrypto API`);
  }
}

export async function importsAsConnectorPublicKey(der: Uint8Array): Promise<boolean> {
  try {
    const keyData = new ArrayBuffer(der.byteLength);
    new Uint8Array(keyData).set(der);
    await globalThis.crypto.subtle.importKey(
      "spki",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return true;
  } catch {
    return false;
  }
}

export type ConnectorResourceExpectation = {
  slug?: string;
  crid?: string;
  revokedIsLifecycleError?: boolean;
};

export async function verifyResourceIdentity(
  resource: { resource_id?: unknown; crid?: unknown } | undefined,
  method: string,
  expectedCrid?: string,
): Promise<void> {
  if (!resource || typeof resource.resource_id !== "string") {
    throw unexpectedResponseError(`${method}: response has missing or invalid resource_id`);
  }
  const resourceKey = decodeCanonicalBase64Url(resource.resource_id);
  requireConnectorSubtleCrypto(method);
  if (!resourceKey || !(await importsAsConnectorPublicKey(resourceKey))) {
    throw unexpectedResponseError(`${method}: response has missing or invalid resource_id`);
  }
  if (expectedCrid !== undefined && resource.crid !== expectedCrid) {
    throw unexpectedResponseError(`${method}: response crid does not match the request`);
  }
  if (!(await cridKeyMatches(resource.crid, resourceKey))) {
    throw unexpectedResponseError(
      `${method}: response has missing, invalid, or public-key-mismatched crid`,
    );
  }
}

export async function parseConnectorResource(
  client: QURLClient,
  value: unknown,
  method: string,
  expectation: ConnectorResourceExpectation = {},
): Promise<ConnectorResource> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unexpectedResponseError(`${method}: response is missing connector resource data`);
  }
  const resource = value as Resource;
  await verifyResourceIdentity(resource, method, expectation.crid);
  if (
    typeof resource.connector_routing_id !== "string" ||
    !CONNECTOR_ROUTING_ID_PATTERN.test(resource.connector_routing_id)
  ) {
    throw unexpectedResponseError(
      `${method}: response has missing or invalid connector_routing_id`,
    );
  }
  if (
    typeof resource.knock_resource_id !== "string" ||
    resource.knock_resource_id.trim() === "" ||
    resource.knock_resource_id.trim() !== resource.knock_resource_id ||
    containsControlCharacter(resource.knock_resource_id)
  ) {
    throw unexpectedResponseError(`${method}: response has missing or invalid knock_resource_id`);
  }
  if (
    resource.resource_id === resource.knock_resource_id ||
    resource.connector_routing_id === resource.knock_resource_id
  ) {
    throw unexpectedResponseError(
      `${method}: response cross-wires resource identity, routing, and admission values`,
    );
  }
  if (resource.type !== "tunnel") {
    throw unexpectedResponseError(`${method}: response resource type is not tunnel`);
  }
  if (typeof resource.slug !== "string" || !CONNECTOR_SLUG_PATTERN.test(resource.slug)) {
    throw unexpectedResponseError(`${method}: response has missing or invalid slug`);
  }
  if (expectation.slug !== undefined && resource.slug !== expectation.slug) {
    throw unexpectedResponseError(`${method}: response slug does not match the request`);
  }
  if (
    resource.alias !== undefined &&
    resource.alias !== null &&
    (typeof resource.alias !== "string" || !CONNECTOR_ALIAS_PATTERN.test(resource.alias))
  ) {
    // The public API intentionally gives mutable aliases and immutable slugs the
    // same canonical wire grammar (domain aliasPattern/slugPattern). Keeping
    // response validation aligned avoids accepting a row the service itself
    // could not create or update.
    throw unexpectedResponseError(`${method}: response has invalid alias`);
  }
  if (resource.status === "revoked") {
    if (expectation.revokedIsLifecycleError !== true) {
      throw unexpectedResponseError(
        `${method}: active-only operation returned a revoked connector resource`,
      );
    }
    throw new QURLError({
      status: 0,
      code: ERROR_CODE_CONNECTOR_RESOURCE_REVOKED,
      title: "Connector Resource Revoked",
      detail: `${method}: qURL Connector resource is revoked`,
    });
  }
  if (resource.status !== "active") {
    throw unexpectedResponseError(`${method}: response has invalid resource status`);
  }
  return new ConnectorResource(client, resource, CONNECTOR_RESOURCE_CONSTRUCTOR_TOKEN);
}

/** Result of idempotently ensuring a qURL Connector resource. */
export interface EnsureConnectorResourceResult {
  resource: ConnectorResource;
  foundExisting: boolean;
}

export const CONNECTOR_RESOURCE_CONSTRUCTOR_TOKEN = Symbol("validated ConnectorResource");

/**
 * A validated qURL Connector resource bound to the client that loaded it.
 *
 * Resource identity, reverse-routing identity, and NHP admission identity are
 * distinct server-issued values. Callers must consume each field verbatim and
 * must never derive one from another.
 */
export class ConnectorResource {
  readonly #client: QURLClient;
  readonly resourcePublicKey: string;
  /** Required public identifier, verified against the returned resource key. */
  readonly crid: string;
  readonly connectorRoutingId: string;
  readonly knockResourceId: string;
  readonly slug: string;
  readonly alias?: string;

  /** @internal Instances are returned by QURLClient after wire validation. */
  constructor(
    client: QURLClient,
    details: Resource,
    validationToken: typeof CONNECTOR_RESOURCE_CONSTRUCTOR_TOKEN,
  ) {
    if (validationToken !== CONNECTOR_RESOURCE_CONSTRUCTOR_TOKEN) {
      throw clientValidationError(
        "ConnectorResource cannot be constructed directly; load it through QURLClient",
      );
    }
    this.#client = client;
    this.resourcePublicKey = details.resource_id;
    this.crid = details.crid!;
    this.connectorRoutingId = details.connector_routing_id as string;
    this.knockResourceId = details.knock_resource_id as string;
    this.slug = details.slug as string;
    this.alias = details.alias ?? undefined;
  }

  /** Mint a short-lived portal for this Connector resource. */
  async createPortal(
    opts: CreatePortalOptions = {},
    requestOptions?: RequestOptions,
  ): Promise<Portal> {
    return this.#client.createPortal(this.crid, opts, requestOptions);
  }
}
