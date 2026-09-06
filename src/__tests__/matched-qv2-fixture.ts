import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { issuerKeyFromSpki } from "../node/qv2.js";

const SIGNING_DOMAIN = Buffer.from("NHP-QURL-V2-ISSUER\0", "utf8");
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER >> 1n;
const KID = "qurl-typescript-matched-fixture";

type Claims = {
  v: number;
  iss: string;
  kid: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  cell_public_key_b64: string;
  cell_id: string;
  relay_url: string;
  resource_public_key_b64: string;
  qurl_user_public_key_b64: string;
};

export type MatchedQv2Fixture = {
  readonly qurl: string;
  readonly mismatchedPrivateKeyQurl: string;
  readonly tamperedSignedPublicKeyQurl: string;
  readonly invalidSecretQurl: string;
  readonly issuer: { readonly kid: string; readonly spki_der_b64: string };
  readonly issuerKeys: ReadonlyMap<string, KeyObject>;
  readonly cellPublicKeyB64: string;
  readonly devicePrivateKey: Uint8Array;
};

export function createMatchedQv2Fixture(): MatchedQv2Fixture {
  const issuerPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const resourcePair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuerSpki = issuerPair.publicKey.export({ format: "der", type: "spki" });
  const resourceSpki = resourcePair.publicKey.export({ format: "der", type: "spki" });
  const devicePrivateKey = Buffer.alloc(32, 9);
  // Pinned X25519 public output for the fixed raw private input. Do not derive
  // this with the verifier under test or an incorrect derivation can agree
  // with itself and keep the positive fixture green.
  const devicePublicKey = Buffer.from("V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CE", "base64url");
  const cellPublicKey = Buffer.alloc(32, 4);
  const claims: Claims = {
    v: 2,
    iss: "qurl-service",
    kid: KID,
    iat: 2_000_000_000,
    nbf: 2_000_000_000,
    exp: 2_000_000_300,
    jti: "qurl_typescript_matched_fixture",
    cell_public_key_b64: Buffer.from(cellPublicKey).toString("base64url"),
    cell_id: "fixture-cell",
    relay_url: "https://relay.example.test",
    resource_public_key_b64: Buffer.from(resourceSpki).toString("base64url"),
    qurl_user_public_key_b64: Buffer.from(devicePublicKey).toString("base64url"),
  };
  const claimsB64 = encodeClaims(claims);
  const signatureB64 = signClaims(claimsB64, issuerPair.privateKey);
  const secretB64 = encodeSecret(devicePrivateKey);
  const issuer = { kid: KID, spki_der_b64: issuerSpki.toString("base64url") };
  return {
    qurl: encodeQurl(claimsB64, secretB64, signatureB64),
    mismatchedPrivateKeyQurl: encodeQurl(
      claimsB64,
      encodeSecret(Buffer.alloc(32, 10)),
      signatureB64,
    ),
    tamperedSignedPublicKeyQurl: encodeQurl(
      encodeClaims({
        ...claims,
        qurl_user_public_key_b64: Buffer.alloc(32, 6).toString("base64url"),
      }),
      secretB64,
      signatureB64,
    ),
    invalidSecretQurl: encodeQurl(
      claimsB64,
      Buffer.from("{}", "utf8").toString("base64url"),
      signatureB64,
    ),
    issuer,
    issuerKeys: new Map([[KID, issuerKeyFromSpki(issuerSpki)]]),
    cellPublicKeyB64: claims.cell_public_key_b64,
    devicePrivateKey,
  };
}

function encodeClaims(claims: Claims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function encodeSecret(privateKey: Uint8Array): string {
  return Buffer.from(
    JSON.stringify({ qurl_user_private_key_b64: Buffer.from(privateKey).toString("base64url") }),
    "utf8",
  ).toString("base64url");
}

function signClaims(claimsB64: string, privateKey: KeyObject): string {
  const signature = sign(
    "sha256",
    Buffer.concat([SIGNING_DOMAIN, Buffer.from(claimsB64, "ascii")]),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  );
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (s > P256_HALF_ORDER) {
    const lowS = (P256_ORDER - s).toString(16).padStart(64, "0");
    Buffer.from(lowS, "hex").copy(signature, 32);
  }
  return signature.toString("base64url");
}

function encodeQurl(claims: string, secret: string, signature: string): string {
  const fields = [claims, secret, signature];
  const chunks = fields.map((field) => field.match(/.{1,240}/g) ?? []);
  const transport = [
    "qv2t1",
    ...chunks.map((parts) => parts.length.toString()),
    ...chunks.flat(),
  ].join(".");
  return `https://qurl.link/#${transport}`;
}
