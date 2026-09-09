import { createHash, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { loadPortalDeployment, type PortalDeployment } from "./deployment.js";
import { issuerKeyFromSpki } from "./qv2.js";
import { isStrictJsonObject, parseStrictJson, type StrictJsonValue } from "./strict-json.js";
import { readBoundedBody } from "./relay.js";

export interface PortalProvider {
  /** Resolve authenticated, current trust. A failure must not return stale trust. */
  resolve(signal?: AbortSignal): Promise<PortalDeployment>;
}

export function createStaticProvider(deployment: PortalDeployment): PortalProvider {
  const snapshot: PortalDeployment = JSON.parse(JSON.stringify(deployment));
  loadPortalDeployment(snapshot);
  return {
    async resolve(signal) {
      signal?.throwIfAborted();
      return JSON.parse(JSON.stringify(snapshot));
    },
  };
}

export interface DiscoveryProviderOptions {
  readonly fetcher: (signal?: AbortSignal) => Promise<Uint8Array>;
  readonly pinSHA256?: Uint8Array;
  readonly manifestKeys?: ReadonlyMap<string, KeyObject>;
  readonly requireSignature?: boolean;
  /** Persist the required floor in deployment configuration across restarts. */
  readonly minVersion?: bigint;
  readonly expectedProfile?: string;
  readonly now?: () => number;
}

const MANIFEST_DOMAIN = Buffer.from("NHP-QURL-V2-DISCOVERY-MANIFEST\0");
const HALF_ORDER = Buffer.from(
  "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8",
  "hex",
);
const LIMIT = 1_048_576;

function object(value: StrictJsonValue, keys: readonly string[]) {
  if (!isStrictJsonObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("invalid discovery schema");
  return value;
}

function decode(value: StrictJsonValue | undefined): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("invalid discovery base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("noncanonical discovery base64url");
  return bytes;
}

export function createHTTPManifestFetcher(
  value: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): DiscoveryProviderOptions["fetcher"] {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("discovery URL must be HTTPS without credentials or fragment");
  return async (signal) => {
    const deadline = AbortSignal.timeout(30_000);
    const response = await fetch(url.href, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`discovery returned HTTP ${response.status}`);
    }
    return readBoundedBody(response, LIMIT);
  };
}

export function createDiscoveryProvider(options: DiscoveryProviderOptions): PortalProvider {
  const pin = options.pinSHA256 === undefined ? undefined : Buffer.from(options.pinSHA256);
  const keys = new Map(options.manifestKeys);
  if (
    typeof options.fetcher !== "function" ||
    (!pin && keys.size === 0) ||
    (pin && pin.length !== 32) ||
    (options.requireSignature && keys.size === 0)
  )
    throw new Error("discovery requires a fetcher and a valid pin or signing key");
  for (const [kid, key] of keys) {
    if (!kid.trim()) throw new Error("discovery signing key id is required");
    issuerKeyFromSpki(key.export({ type: "spki", format: "der" }));
  }
  const fetcher = options.fetcher;
  const required = options.requireSignature;
  const profile = options.expectedProfile;
  const now = options.now ?? Date.now;
  let floor = options.minVersion ?? 0n;
  if (typeof floor !== "bigint" || floor < 0n) throw new Error("invalid discovery version floor");
  return {
    async resolve(signal) {
      signal?.throwIfAborted();
      const envelope = object(parseStrictJson(await fetcher(signal), LIMIT), [
        "manifest_b64",
        "sig_b64",
        "kid",
      ]);
      signal?.throwIfAborted();
      const bytes = decode(envelope.manifest_b64);
      if (pin && !timingSafeEqual(pin, createHash("sha256").update(bytes).digest()))
        throw new Error("discovery manifest pin mismatch");
      let signed = false;
      if (keys.size && envelope.sig_b64 !== undefined && envelope.sig_b64 !== "") {
        const signature = decode(envelope.sig_b64);
        const key = typeof envelope.kid === "string" ? keys.get(envelope.kid) : undefined;
        if (!key || signature.length !== 64) throw new Error("invalid discovery signature");
        if (
          Buffer.compare(signature.subarray(32), HALF_ORDER) > 0 ||
          !verify(
            "sha256",
            Buffer.concat([MANIFEST_DOMAIN, bytes]),
            { key, dsaEncoding: "ieee-p1363" },
            signature,
          )
        )
          throw new Error("invalid discovery signature");
        signed = true;
      }
      if ((!pin && !signed) || (required && !signed))
        throw new Error("discovery manifest is not authenticated");
      const manifest = object(parseStrictJson(bytes, LIMIT), [
        "profile",
        "version",
        "issued_at",
        "not_after",
        "issuers",
        "relay_allowlist",
      ]);
      const { version, issued_at: issuedAt, not_after: notAfter } = manifest;
      if (
        typeof version !== "bigint" ||
        version <= 0n ||
        version > (1n << 63n) - 1n ||
        typeof issuedAt !== "bigint" ||
        issuedAt <= 0n ||
        typeof notAfter !== "bigint" ||
        notAfter <= issuedAt ||
        typeof manifest.profile !== "string" ||
        (profile && profile !== manifest.profile)
      )
        throw new Error("invalid discovery manifest");
      const seconds = BigInt(Math.floor(now() / 1000));
      if (seconds + 120n < issuedAt) throw new Error("discovery manifest is not yet valid");
      if (seconds > notAfter) throw new Error("discovery manifest expired");
      if (
        !Array.isArray(manifest.issuers) ||
        !Array.isArray(manifest.relay_allowlist) ||
        !manifest.relay_allowlist.some((value) => typeof value === "string" && value.trim())
      )
        throw new Error("discovery manifest has no usable trust");
      const deployment: PortalDeployment = {
        cells: [],
        issuers: manifest.issuers.map((row) => {
          const issuer = object(row, ["kid", "spki_der_b64"]);
          if (typeof issuer.kid !== "string" || typeof issuer.spki_der_b64 !== "string")
            throw new Error("invalid discovery issuer");
          decode(issuer.spki_der_b64);
          return { kid: issuer.kid, spki_der_b64: issuer.spki_der_b64 };
        }),
        relay_allowlist: manifest.relay_allowlist.map((value) => {
          if (typeof value !== "string") throw new Error("invalid discovery relay host");
          return value;
        }),
      };
      loadPortalDeployment(deployment);
      // No await between comparison and advance: concurrent resolutions cannot lower the floor.
      if (version < floor) throw new Error("discovery manifest downgrade");
      floor = version;
      return deployment;
    },
  };
}
