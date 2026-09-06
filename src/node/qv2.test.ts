import { describe, expect, it } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { createMatchedQv2Fixture } from "../__tests__/matched-qv2-fixture.js";
import { issuerKeyFromSpki, qv2Testing, strictBase64Url, verifyQv2Link } from "./qv2.js";

type TransportVector = {
  name: string;
  expect: "accept" | "reject";
  transport_fragment: string;
  canonical_fragment?: string;
};

type Qv2Vectors = {
  classes: {
    claims_parse: {
      vectors: Array<{ name: string; expect: "accept" | "reject"; claims_json: string }>;
    };
    secret_parse: {
      vectors: Array<{ name: string; expect: "accept" | "reject"; secret_json: string }>;
    };
    strict_base64: {
      vectors: Array<{ name: string; expect: "accept" | "reject"; value_b64: string }>;
    };
    transport: { vectors: TransportVector[] };
  };
};

type IssuerVectors = {
  issuer: { kid: string; spki_der_b64: string };
  vectors: Array<{
    name: string;
    expect: "accept" | "reject";
    claims_b64: string;
    sig_b64: string;
  }>;
};

const qv2 = conformancePackage.qv2Vectors() as Qv2Vectors;
const signatureVectors = conformancePackage.issuerSignatureVectors() as IssuerVectors;
const issuer = signatureVectors.issuer;
const issuerKeys = new Map([
  [issuer.kid, issuerKeyFromSpki(Buffer.from(issuer.spki_der_b64, "base64"))],
]);
const matched = createMatchedQv2Fixture();

describe("qv2t1 verifier", () => {
  it.each([
    ["one trailing byte", Buffer.from([0])],
    ["one trailing DER value", Buffer.from([0x30, 0])],
  ])("rejects an issuer SPKI with %s", (_name, trailing) => {
    const spki = Buffer.from(issuer.spki_der_b64, "base64");
    expect(() => issuerKeyFromSpki(Buffer.concat([spki, trailing]))).toThrow(
      "exactly one canonical SPKI",
    );
  });

  it.each(qv2.classes.transport.vectors)("matches transport vector $name", (vector) => {
    if (vector.expect === "accept") {
      expect(qv2Testing.decodeTransport(vector.transport_fragment)).toBe(vector.canonical_fragment);
    } else {
      expect(() => qv2Testing.decodeTransport(vector.transport_fragment)).toThrow();
    }
  });

  it.each(qv2.classes.claims_parse.vectors)("matches claims parser vector $name", (vector) => {
    const action = () => qv2Testing.parseClaims(Buffer.from(vector.claims_json));
    if (vector.expect === "accept") expect(action).not.toThrow();
    else expect(action).toThrow();
  });

  it.each(qv2.classes.secret_parse.vectors)("matches secret parser vector $name", (vector) => {
    const action = () => qv2Testing.parseSecret(Buffer.from(vector.secret_json));
    if (vector.expect === "accept") expect(action).not.toThrow();
    else expect(action).toThrow();
  });

  it.each(qv2.classes.strict_base64.vectors)("matches base64 vector $name", (vector) => {
    const action = () => strictBase64Url(vector.value_b64);
    if (vector.expect === "accept") expect(action).not.toThrow();
    else expect(action).toThrow();
  });

  it.each(signatureVectors.vectors)("matches issuer signature vector $name", (vector) => {
    const action = () =>
      qv2Testing.verifyIssuerClaims(vector.claims_b64, vector.sig_b64, issuerKeys);
    if (vector.expect === "accept") expect(action).not.toThrow();
    else expect(action).toThrow();
  });

  it("verifies a signed link whose fragment private key matches the signed public key", () => {
    const result = verifyQv2Link(matched.qurl, matched.issuerKeys);
    expect(result.claims.kid).toBe(matched.issuer.kid);
    expect(result.claims.cellPublicKey).toHaveLength(32);
    expect(result.devicePrivateKey).toEqual(matched.devicePrivateKey);
  });

  it("rejects a signed public key that does not match the fragment private key", () => {
    expect(() => verifyQv2Link(matched.mismatchedPrivateKeyQurl, matched.issuerKeys)).toThrow(
      "does not match its signed public key",
    );
  });

  it("rejects a tampered signed public key before it can select native transport", () => {
    expect(() => verifyQv2Link(matched.tamperedSignedPublicKeyQurl, matched.issuerKeys)).toThrow(
      "signature verification failed",
    );
  });

  it("rejects an unknown issuer before any transport is selected", () => {
    expect(() => verifyQv2Link(matched.qurl, new Map())).toThrow("unknown issuer");
  });
});
