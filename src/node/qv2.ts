import { createPublicKey, createPrivateKey, createHash, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isStrictJsonObject, parseStrictJson, type StrictJsonValue } from "./strict-json.js";

const TRANSPORT_PREFIX = "qv2t1";
const FRAGMENT_PREFIX = "qv2";
const TRANSPORT_MAX_LENGTH = 6_826;
const TRANSPORT_COMPONENT_MAX = 240;
const SIGNING_DOMAIN = Buffer.from("NHP-QURL-V2-ISSUER\0", "utf8");
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER >> 1n;
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const CLAIM_KEYS = new Set([
  "v",
  "iss",
  "kid",
  "iat",
  "nbf",
  "exp",
  "jti",
  "cell_public_key_b64",
  "cell_id",
  "relay_url",
  "resource_public_key_b64",
  "qurl_user_public_key_b64",
]);
const REQUIRED_CLAIM_KEYS = [...CLAIM_KEYS].filter((key) => key !== "cell_id");

export interface VerifiedQv2Link {
  readonly claimsB64: string;
  readonly signatureB64: string;
  readonly claims: {
    readonly kid: string;
    readonly cellPublicKey: Uint8Array;
    readonly resourcePublicKeyB64: string;
  };
  readonly devicePrivateKey: Uint8Array;
}

export function verifyQv2Link(
  qurl: string,
  issuers: ReadonlyMap<string, KeyObject>,
): VerifiedQv2Link {
  const hash = qurl.indexOf("#");
  if (hash < 0) throw new Error("qURL link has no credential fragment");
  const canonical = decodeTransport(qurl.slice(hash + 1));
  const parts = canonical.split(".");
  if (parts.length !== 4 || parts[0] !== FRAGMENT_PREFIX || parts.slice(1).some((p) => p === "")) {
    throw new Error("invalid qURL credential fragment");
  }
  const [, claimsB64, secretB64, signatureB64] = parts;
  const claims = parseClaims(decodeCanonicalBase64Url(claimsB64));
  const secret = parseSecret(decodeCanonicalBase64Url(secretB64));
  const signature = decodeCanonicalBase64Url(signatureB64);
  validateRawP256Signature(signature);

  const issuer = issuers.get(claims.kid);
  if (!issuer) throw new Error("qURL uses an unknown issuer key id");
  const signingInput = Buffer.concat([SIGNING_DOMAIN, Buffer.from(claimsB64, "ascii")]);
  if (!verify("sha256", signingInput, { key: issuer, dsaEncoding: "ieee-p1363" }, signature)) {
    throw new Error("qURL issuer signature verification failed");
  }

  const privateKey = decodeCanonicalBase64Url(secret.qurlUserPrivateKeyB64);
  if (privateKey.byteLength !== 32) throw new Error("qURL private key has an invalid length");
  return {
    claimsB64,
    signatureB64,
    claims: {
      kid: claims.kid,
      cellPublicKey: decodeX25519(claims.cellPublicKeyB64, "cell public key"),
      resourcePublicKeyB64: claims.resourcePublicKeyB64,
    },
    devicePrivateKey: privateKey,
  };
}

export function issuerKeyFromSpki(spki: Uint8Array): KeyObject {
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  const canonical = key.export({ format: "der", type: "spki" });
  const supplied = Buffer.from(spki.buffer, spki.byteOffset, spki.byteLength);
  // Node accepts a valid SPKI followed by unrelated DER bytes. Go's
  // x509.ParsePKIXPublicKey requires the complete input to contain one key, so
  // require the same byte-exact consumption before this key becomes trust.
  if (canonical.byteLength !== supplied.byteLength || !canonical.equals(supplied)) {
    throw new Error("issuer key must contain exactly one canonical SPKI public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("issuer key must be a P-256 SPKI public key");
  }
  return key;
}

export function x25519PublicFromPrivate(raw: Uint8Array): Uint8Array {
  if (raw.byteLength !== 32) throw new Error("X25519 private key must be 32 bytes");
  const der = Buffer.alloc(X25519_PKCS8_PREFIX.byteLength + raw.byteLength);
  X25519_PKCS8_PREFIX.copy(der);
  der.set(raw, X25519_PKCS8_PREFIX.byteLength);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.byteLength - 32));
}

export function strictBase64Url(value: string): Uint8Array {
  return decodeCanonicalBase64Url(value);
}

function decodeTransport(value: string): string {
  if (value.length > TRANSPORT_MAX_LENGTH) throw new Error("qURL transport exceeds its size limit");
  const parts = value.split(".");
  if (parts.length < 4 || parts[0] !== TRANSPORT_PREFIX) {
    throw new Error("qURL does not use the qv2t1 credential transport");
  }
  const counts = [parseCount(parts[1], 26), parseCount(parts[2], 3), parseCount(parts[3], 1)];
  if (parts.length !== 4 + counts[0] + counts[1] + counts[2]) {
    throw new Error("qURL transport part count does not match its declarations");
  }
  let offset = 4;
  const limits = [6_144, 512, 128];
  const fields = counts.map((count, index) => {
    const chunks = parts.slice(offset, offset + count);
    offset += count;
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (
        chunk.length === 0 ||
        chunk.length > TRANSPORT_COMPONENT_MAX ||
        (i < chunks.length - 1 && chunk.length !== TRANSPORT_COMPONENT_MAX) ||
        !/^[A-Za-z0-9_-]+$/.test(chunk)
      ) {
        throw new Error("qURL transport has an invalid chunk");
      }
      total += chunk.length;
      if (total > limits[index]) throw new Error("qURL transport field exceeds its size limit");
    }
    return chunks.join("");
  });
  return `${FRAGMENT_PREFIX}.${fields[0]}.${fields[1]}.${fields[2]}`;
}

function parseCount(value: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("qURL transport count is not canonical");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > maximum) {
    throw new Error("qURL transport count exceeds its limit");
  }
  return count;
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (value === "" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("value is not canonical unpadded base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("value is not canonical unpadded base64url");
  }
  return decoded;
}

function decodeX25519(value: string, name: string): Uint8Array {
  const decoded = decodeCanonicalBase64Url(value);
  if (decoded.byteLength !== 32) throw new Error(`${name} has an invalid length`);
  return decoded;
}

type ParsedClaims = {
  kid: string;
  cellPublicKeyB64: string;
  resourcePublicKeyB64: string;
};

function parseClaims(raw: Uint8Array): ParsedClaims {
  const value = parseStrictJson(raw, 4_608);
  if (!isStrictJsonObject(value)) throw new Error("qURL claims must be one JSON object");
  for (const key of Object.keys(value)) {
    if (!CLAIM_KEYS.has(key)) throw new Error("qURL claims contain an unknown field");
    if (value[key] === null) throw new Error("qURL claims contain a null field");
  }
  for (const key of REQUIRED_CLAIM_KEYS) {
    if (!(key in value)) throw new Error("qURL claims are missing a required field");
  }
  if (value.v !== 2n || value.iss !== "qurl-service")
    throw new Error("qURL claims version or issuer is invalid");
  const times: Record<"iat" | "nbf" | "exp", bigint> = {
    iat: 0n,
    nbf: 0n,
    exp: 0n,
  };
  for (const key of ["iat", "nbf", "exp"] as const) {
    const item = value[key];
    if (typeof item !== "bigint" || item <= 0n || item > 9_999_999_999n) {
      throw new Error("qURL claims contain an invalid time");
    }
    times[key] = item;
  }
  if (times.iat > times.exp || times.nbf > times.exp) {
    throw new Error("qURL claims contain an invalid time window");
  }
  const kid = requireNonEmptyString(value.kid, "issuer key id");
  requireNonEmptyString(value.jti, "qURL id");
  const cellPublicKeyB64 = requireNonEmptyString(value.cell_public_key_b64, "cell public key");
  decodeX25519(cellPublicKeyB64, "cell public key");
  const qurlPublic = requireNonEmptyString(value.qurl_user_public_key_b64, "qURL public key");
  decodeX25519(qurlPublic, "qURL public key");
  const resourcePublicKeyB64 = requireNonEmptyString(
    value.resource_public_key_b64,
    "resource public key",
  );
  const resourcePublic = decodeCanonicalBase64Url(resourcePublicKeyB64);
  if (resourcePublic.byteLength < 80 || resourcePublic.byteLength > 160) {
    throw new Error("resource public key has an invalid length");
  }
  requireNonEmptyString(value.relay_url, "relay URL");
  if ("cell_id" in value && typeof value.cell_id !== "string") {
    throw new Error("qURL cell id must be a string");
  }
  return { kid, cellPublicKeyB64, resourcePublicKeyB64 };
}

function parseSecret(raw: Uint8Array): { qurlUserPrivateKeyB64: string } {
  const value = parseStrictJson(raw, 1_024);
  if (!isStrictJsonObject(value) || Object.keys(value).length !== 1) {
    throw new Error("qURL secret has an invalid object shape");
  }
  const qurlUserPrivateKeyB64 = requireNonEmptyString(
    value.qurl_user_private_key_b64,
    "qURL private key",
  );
  const privateKey = decodeCanonicalBase64Url(qurlUserPrivateKeyB64);
  try {
    if (privateKey.byteLength !== 32) throw new Error("qURL private key has an invalid length");
  } finally {
    privateKey.fill(0);
  }
  return { qurlUserPrivateKeyB64 };
}

function requireNonEmptyString(value: StrictJsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function validateRawP256Signature(signature: Uint8Array): void {
  if (signature.byteLength !== 64) throw new Error("qURL signature must be 64 bytes");
  const r = bytesToBigInt(signature.subarray(0, 32));
  const s = bytesToBigInt(signature.subarray(32));
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) {
    throw new Error("qURL signature scalar is outside the P-256 range");
  }
  if (s > P256_HALF_ORDER) throw new Error("qURL signature is not low-S normalized");
}

function bytesToBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(value).toString("hex")}`);
}

export function qv2LinkIdentity(link: VerifiedQv2Link): Uint8Array {
  return createHash("sha256")
    .update(link.claimsB64, "ascii")
    .update(".", "ascii")
    .update(link.signatureB64, "ascii")
    .digest();
}

export const qv2Testing = { decodeTransport, parseClaims, parseSecret };
