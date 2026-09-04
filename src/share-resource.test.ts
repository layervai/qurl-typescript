import { describe, expect, expectTypeOf, it, vi } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { Buffer } from "node:buffer";
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import {
  CRIDVerificationError,
  ERROR_CODE_CRID_MISMATCH,
  ERROR_CODE_INVALID_CRID,
  ERROR_CODE_INVALID_CRID_KEY,
  ERROR_CODE_MISSING_CRID,
  ShareLink,
} from "./index.js";
import type { CRIDVerificationErrorCode } from "./index.js";
import { QURLError, RuntimeError, ServerError, ValidationError } from "./errors.js";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";

type CRIDVectors = {
  producer_cases: Array<{ name: string; der_spki_b64url: string; expected_crid: string }>;
  consumer_value_cases: Array<{
    name: string;
    value: string;
    outcome: "accept" | "reject";
  }>;
  key_match_cases: Array<{
    name: string;
    crid: string;
    der_spki_b64url: string;
    outcome: "match" | "mismatch";
  }>;
};

const vectors = (
  conformancePackage as typeof import("@layervai/qurl-conformance")
).cridV1Vectors() as CRIDVectors;
const matching = vectors.producer_cases.find(({ name }) => name === "resource_key_qv2_v01");
if (!matching) throw new Error("CRID conformance vectors are missing resource_key_qv2_v01");
const matchingDerSpki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcOtuxu2qhc3gt1E7BiEU0CLqEDlXDwzZq0JnESgMAwERX6y_XXF5Cn5SKITWIZQmUhCZ0pHHlVn7SmFUTAnTGQ";
if (matching.der_spki_b64url !== matchingDerSpki) {
  throw new Error("resource_key_qv2_v01 changed; refresh the qurl-go-confirmed truncated fixture");
}
const foreign = vectors.producer_cases.find(
  ({ der_spki_b64url }) => der_spki_b64url !== matching.der_spki_b64url,
);
if (!foreign) throw new Error("CRID conformance vectors are missing a foreign resource key");
const acceptedTruncated = vectors.consumer_value_cases.find(
  ({ value, outcome }) => outcome === "accept" && value.length === 47,
);
if (!acceptedTruncated) throw new Error("CRID conformance vectors are missing a truncated CRID");
// qurl-go@a528d1f confirms this version-0x02 truncated CRID matches
// matching.der_spki_b64url through crid.KeyMatches.
const matchingTruncated = "ai4jqpd7eaoslq7jinmjv4yikgzmcxgpjfsuobinv2mxyhi";
const cridAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

function fullCridWithLateDigestMismatch(value: string): string {
  const decoded: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    accumulator = (accumulator << 5) | cridAlphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  const bytes = Uint8Array.from(decoded);
  bytes[32] ^= 1; // Last full-digest byte; the first 24 digest bytes still match.
  let checksum = 0xffffffff;
  for (const byte of bytes.subarray(0, 33)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0x82f63b78 : 0);
    }
  }
  checksum = ~checksum >>> 0;
  bytes.set([checksum >>> 24, checksum >>> 16, checksum >>> 8, checksum], 33);

  let encoded = "";
  accumulator = 0;
  bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += cridAlphabet[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += cridAlphabet[(accumulator << (5 - bits)) & 31];
  return encoded;
}

function b64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function shareResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      qurl_id: "q_a1b2c3d4e5f",
      qurl: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
      type: "url",
      expires_at: "2026-03-09T15:35:00Z",
      expires_in_seconds: 300,
      single_use: false,
      ...overrides,
    },
    meta: { request_id: "req_share" },
  };
}

describe("shareResource", () => {
  it("posts an empty object for platform defaults and maps the one-time response", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    const share = await createClient(fetch).shareResource("resource/public+id");

    expect(share).toBeInstanceOf(ShareLink);
    expect(share.link).toBe("https://qurl.link/#qv2t1.example");
    expect(share.qurlId).toBe("q_a1b2c3d4e5f");
    expect(share.crid).toBe(matching.expected_crid);
    expect(share.type).toBe("url");
    expect(share.expiresAt?.toISOString()).toBe("2026-03-09T15:35:00.000Z");
    expect(share.expiresInSeconds).toBe(300);
    expect(share.singleUse).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/resources/resource%2Fpublic%2Bid/share",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("redacts the one-time credential from serialization, inspection, and object spread", async () => {
    const share = await createClient(
      mockFetch({ status: 200, body: shareResponse() }),
    ).shareResource("resource-id");

    expect(JSON.stringify(share)).not.toContain(share.link);
    expect(JSON.parse(JSON.stringify(share))).toMatchObject({
      link: "[redacted]",
      qurlId: "q_a1b2c3d4e5f",
    });
    expect(inspect(share)).not.toContain(share.link);
    expect({ ...share }).not.toHaveProperty("link");
    expect(share.link).toBe("https://qurl.link/#qv2t1.example");
    expect(Object.isFrozen(share)).toBe(true);
    expect(Reflect.set(share, "link", "https://evil.example/#stolen")).toBe(false);
    expect(Reflect.set(share, "crid", "replaced")).toBe(false);
    expect(() => Object.defineProperty(share, "link", { enumerable: true })).toThrow(TypeError);
    expect(share.toJSON()).toMatchObject({
      link: "[redacted]",
      expiresAt: "2026-03-09T15:35:00.000Z",
    });
  });

  it("snapshots a caller-owned expiry date at construction", () => {
    const expiresAt = new Date("2026-03-09T15:35:00Z");
    const share = new ShareLink({ link: "https://qurl.link/#qv2t1.example", expiresAt });

    expiresAt.setUTCFullYear(1970);

    expect(share.expiresAt?.toISOString()).toBe("2026-03-09T15:35:00.000Z");
  });

  it("returns a defensive expiry-date copy", () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      expiresAt: new Date("2026-03-09T15:35:00Z"),
    });

    share.expiresAt?.setUTCFullYear(1970);

    expect(share.expiresAt?.toISOString()).toBe("2026-03-09T15:35:00.000Z");
  });

  it("keeps redacted serialization safe after the exposed expiry date is invalidated", () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      expiresAt: new Date(Number.NaN),
    });

    expect(share.toJSON()).toMatchObject({ link: "[redacted]", expiresAt: undefined });
    expect(JSON.stringify(share)).not.toContain(share.link);
    expect(inspect(share)).not.toContain(share.link);
  });

  it("sends a positive whole-second TTL and preserves a caller idempotency key", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await createClient(fetch).shareResource(
      "resource-id",
      { ttlSeconds: 90 },
      { idempotencyKey: "share-job-1" },
    );

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"ttl_seconds":90}');
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("share-job-1");
  });

  it.each(["", "   "])(
    "rejects the empty resource ID %j before the request",
    async (resourceId) => {
      const fetch = mockFetch({ status: 200, body: shareResponse() });

      await expect(createClient(fetch).shareResource(resourceId)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["not-a-number", Number.NaN],
    ["outside the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
    ["non-numeric", "300" as never],
  ])("rejects a %s TTL before the request", async (_name, ttlSeconds) => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", { ttlSeconds }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an explicit zero TTL instead of silently requesting the platform default", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", { ttlSeconds: 0 }),
    ).rejects.toMatchObject({
      code: "client_validation",
      detail: "shareResource: ttlSeconds must be a positive safe integer",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unknown option fields", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", { ttl_seconds: 90 } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, "not-an-object"])("rejects the non-object options value %j", async (input) => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", input as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the response omits the share link", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ qurl: "" }) });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("fails closed when the response omits the data envelope", async () => {
    const fetch = mockFetch({ status: 200, body: { meta: { request_id: "req_share" } } });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("tolerates an omitted qurl_id from an older server", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ qurl_id: undefined }) });

    await expect(createClient(fetch).shareResource("resource-id")).resolves.toMatchObject({
      qurlId: undefined,
    });
  });

  it("preserves single-use and an omitted expiry from an older server", async () => {
    const fetch = mockFetch({
      status: 200,
      body: shareResponse({ single_use: true, expires_at: undefined }),
    });

    await expect(createClient(fetch).shareResource("resource-id")).resolves.toMatchObject({
      expiresAt: undefined,
      singleUse: true,
    });
  });

  it.each([
    ["qurl_id", 42],
    ["crid", 42],
    ["type", 42],
    ["expires_at", 42],
    ["expires_in_seconds", "300"],
    ["single_use", "false"],
  ])("fails closed when response field %s has the wrong type", async (field, value) => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ [field]: value }) });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it.each(["qurl_id", "type"])("fails closed when response field %s is blank", async (field) => {
    for (const value of ["", "   "]) {
      const fetch = mockFetch({ status: 200, body: shareResponse({ [field]: value }) });

      await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
        code: "unexpected_response",
      });
    }
  });

  it.each([
    ["qurl_id", " q_a1b2c3d4e5f "],
    ["type", " url "],
  ])("fails closed when response field %s is padded", async (field, value) => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ [field]: value }) });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("fails closed when expires_at is not an RFC 3339 timestamp", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ expires_at: "not-a-date" }) });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("fails closed when expires_at is an explicit empty string", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ expires_at: "" }) });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("fails closed when expires_in_seconds is negative", async () => {
    const fetch = mockFetch({
      status: 200,
      body: shareResponse({ expires_in_seconds: -1 }),
    });

    await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("preserves an explicit zero expires_in_seconds from the service", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ expires_in_seconds: 0 }) });

    await expect(createClient(fetch).shareResource("resource-id")).resolves.toMatchObject({
      expiresInSeconds: 0,
    });
  });

  it("sends an SDK-generated idempotency key when minting a share", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await createClient(fetch).shareResource("resource-id");

    expect(
      (vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed when expires_in_seconds is the non-integer %s",
    async (expiresInSeconds) => {
      const fetch = mockFetch({
        status: 200,
        body: shareResponse({ expires_in_seconds: expiresInSeconds }),
      });

      await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
        code: "unexpected_response",
      });
    },
  );

  it.each(["qurl_id", "crid", "type", "expires_at", "expires_in_seconds", "single_use"])(
    "treats a null optional response field %s as omitted",
    async (field) => {
      const fetch = mockFetch({ status: 200, body: shareResponse({ [field]: null }) });

      await expect(createClient(fetch).shareResource("resource-id")).resolves.toBeInstanceOf(
        ShareLink,
      );
    },
  );

  it("preserves an explicit empty CRID as malformed rather than missing", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ crid: "" }) });
    const share = await createClient(fetch).shareResource("resource-id");

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).rejects.toMatchObject({
      code: ERROR_CODE_INVALID_CRID,
    });
  });

  it("preserves an omitted response CRID as a typed missing-CRID verification failure", async () => {
    const share = await createClient(
      mockFetch({ status: 200, body: shareResponse({ crid: undefined }) }),
    ).shareResource("resource-id");

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).rejects.toMatchObject({
      code: ERROR_CODE_MISSING_CRID,
    });
  });

  it("trims transport whitespace from the returned secret link", async () => {
    const fetch = mockFetch({
      status: 200,
      body: shareResponse({ qurl: "  https://qurl.link/#qv2t1.example  " }),
    });

    await expect(createClient(fetch).shareResource("resource-id")).resolves.toMatchObject({
      link: "https://qurl.link/#qv2t1.example",
    });
  });

  it("can verify a freshly shared response against a trusted resource key", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    const share = await createClient(fetch).shareResource("resource-id");

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).resolves.toBeUndefined();
  });

  it("preserves distinct 503 codes as typed server errors", async () => {
    for (const code of ["service_unavailable", "connector_stopped"]) {
      const fetch = mockFetch({
        status: 503,
        body: { error: { status: 503, title: "Unavailable", detail: "retry later", code } },
      });

      await expect(createClient(fetch).shareResource("resource-id")).rejects.toMatchObject({
        constructor: ServerError,
        status: 503,
        code,
      });
    }
  });
});

describe("ShareLink.verifyCrid", () => {
  it("exposes a closed error-code union on CRIDVerificationError", () => {
    const error = new CRIDVerificationError(ERROR_CODE_INVALID_CRID, "invalid");

    expectTypeOf(error.code).toEqualTypeOf<CRIDVerificationErrorCode>();
  });

  it("accepts the committed DER SPKI", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).resolves.toBeUndefined();
  });

  it("accepts an ArrayBuffer DER SPKI", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });
    const bytes = b64url(matching.der_spki_b64url);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    await expect(share.verifyCrid(buffer)).resolves.toBeUndefined();
  });

  it("hashes only the bytes in an offset ArrayBufferView", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });
    const bytes = b64url(matching.der_spki_b64url);
    const padded = new Uint8Array(bytes.length + 16);
    padded.fill(0xff);
    padded.set(bytes, 8);

    await expect(share.verifyCrid(padded.subarray(8, 8 + bytes.length))).resolves.toBeUndefined();
  });

  it("reaches byte comparison for the conformance vector's truncated CRID", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: acceptedTruncated.value,
    });

    // consumer_value_cases proves only syntax acceptance, not a relationship
    // to producer_cases. An empty key must reach comparison and mismatch,
    // rather than being coupled to whichever producer key built the fixture.
    await expect(share.verifyCrid(new Uint8Array())).rejects.toMatchObject({
      code: ERROR_CODE_CRID_MISMATCH,
    });
  });

  it("accepts a truncated CRID derived from its committed DER SPKI", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matchingTruncated,
    });

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).resolves.toBeUndefined();
  });

  it("compares all 32 digest bytes for a full CRID", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: fullCridWithLateDigestMismatch(matching.expected_crid),
    });

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).rejects.toMatchObject({
      code: ERROR_CODE_CRID_MISMATCH,
    });
  });

  it("accepts a cross-realm ArrayBuffer as binary key material", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });
    const crossRealm = runInNewContext("new ArrayBuffer(8)") as ArrayBuffer;

    await expect(share.verifyCrid(crossRealm)).rejects.toMatchObject({
      code: ERROR_CODE_CRID_MISMATCH,
    });
  });

  it("rejects a foreign DER SPKI with a typed mismatch", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(share.verifyCrid(b64url(foreign.der_spki_b64url))).rejects.toMatchObject({
      constructor: CRIDVerificationError,
      code: ERROR_CODE_CRID_MISMATCH,
    });
  });

  it("keeps CRID failures inside the documented QURLError hierarchy", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(share.verifyCrid(b64url(foreign.der_spki_b64url))).rejects.toBeInstanceOf(
      QURLError,
    );
  });

  it("distinguishes an invalid caller key from an invalid server CRID", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(share.verifyCrid("not binary" as never)).rejects.toMatchObject({
      code: ERROR_CODE_INVALID_CRID_KEY,
    });
  });

  it("rejects a spoofed ArrayBuffer brand as an invalid caller key", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(
      share.verifyCrid({ [Symbol.toStringTag]: "ArrayBuffer" } as never),
    ).rejects.toMatchObject({ code: ERROR_CODE_INVALID_CRID_KEY });
  });

  it("rejects a detached ArrayBuffer through the documented error hierarchy", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });
    const detached = new ArrayBuffer(8);
    structuredClone(detached, { transfer: [detached] });

    await expect(share.verifyCrid(detached)).rejects.toMatchObject({
      constructor: CRIDVerificationError,
      code: ERROR_CODE_INVALID_CRID_KEY,
    });
  });

  it("does not misclassify an allocation failure as invalid caller key material", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });
    const slice = vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementationOnce(() => {
      throw new RangeError("allocation failed");
    });

    try {
      await expect(share.verifyCrid(new ArrayBuffer(8))).rejects.toThrow(RangeError);
    } finally {
      slice.mockRestore();
    }
  });

  it("treats an empty binary key as a mismatch, matching qurl-go", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: matching.expected_crid,
    });

    await expect(share.verifyCrid(new Uint8Array())).rejects.toMatchObject({
      code: ERROR_CODE_CRID_MISMATCH,
    });
  });

  it("fails closed when the response omitted CRID", async () => {
    const share = new ShareLink({ link: "https://qurl.link/#qv2t1.example" });

    await expect(share.verifyCrid(new Uint8Array())).rejects.toMatchObject({
      code: ERROR_CODE_MISSING_CRID,
    });
  });

  it("rejects a malformed held CRID before hashing", async () => {
    const share = new ShareLink({ link: "https://qurl.link/#qv2t1.example", crid: "NOT-A-CRID" });

    await expect(share.verifyCrid(new Uint8Array())).rejects.toMatchObject({
      code: ERROR_CODE_INVALID_CRID,
    });
  });

  it("reports missing Web Crypto as a runtime capability error", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      const share = new ShareLink({
        link: "https://qurl.link/#qv2t1.example",
        crid: matching.expected_crid,
      });
      await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).rejects.toBeInstanceOf(
        RuntimeError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a missing SubtleCrypto implementation as a runtime capability error", async () => {
    vi.stubGlobal("crypto", {});
    try {
      const share = new ShareLink({
        link: "https://qurl.link/#qv2t1.example",
        crid: matching.expected_crid,
      });
      await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).rejects.toBeInstanceOf(
        RuntimeError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(vectors.consumer_value_cases)(
    "matches the CRID v1 local gate for $name",
    async ({ value, outcome }) => {
      const share = new ShareLink({ link: "https://qurl.link/#qv2t1.example", crid: value });
      const error = await share
        .verifyCrid(b64url(matching.der_spki_b64url))
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      if (outcome === "reject") {
        expect(error).toMatchObject({
          code: ERROR_CODE_INVALID_CRID,
        });
      } else if (error instanceof CRIDVerificationError) {
        expect(error.code).not.toBe(ERROR_CODE_INVALID_CRID);
      } else {
        expect(error).toBeUndefined();
      }
    },
  );

  it.each(vectors.key_match_cases)(
    "matches the CRID v1 delivered-key rule for $name",
    async ({ crid, der_spki_b64url, outcome }) => {
      const share = new ShareLink({ link: "https://qurl.link/#qv2t1.example", crid });
      if (outcome === "match") {
        await expect(share.verifyCrid(b64url(der_spki_b64url))).resolves.toBeUndefined();
      } else {
        await expect(share.verifyCrid(b64url(der_spki_b64url))).rejects.toMatchObject({
          code: "crid_mismatch",
        });
      }
    },
  );
});
