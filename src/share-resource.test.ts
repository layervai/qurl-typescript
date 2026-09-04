import { describe, expect, it, vi } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { Buffer } from "node:buffer";
import {
  CRIDVerificationError,
  ERROR_CODE_CRID_MISMATCH,
  ERROR_CODE_INVALID_CRID,
  ERROR_CODE_INVALID_CRID_KEY,
  ERROR_CODE_MISSING_CRID,
  ShareLink,
} from "./index.js";
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
const foreign = vectors.producer_cases.find(
  ({ der_spki_b64url }) => der_spki_b64url !== matching.der_spki_b64url,
);
if (!foreign) throw new Error("CRID conformance vectors are missing a foreign resource key");
const acceptedTruncated = vectors.consumer_value_cases.find(
  ({ value, outcome }) => outcome === "accept" && value.length === 47,
);
if (!acceptedTruncated) throw new Error("CRID conformance vectors are missing a truncated CRID");

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
  ])("rejects a %s TTL before the request", async (_name, ttlSeconds) => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", { ttlSeconds }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats zero TTL as omitted, matching qurl-go's zero-value options", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await createClient(fetch).shareResource("resource-id", { ttlSeconds: 0 });

    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body).toBe("{}");
  });

  it("rejects unknown option fields", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse() });

    await expect(
      createClient(fetch).shareResource("resource-id", { ttl_seconds: 90 } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the response omits the share link", async () => {
    const fetch = mockFetch({ status: 200, body: shareResponse({ qurl: "" }) });

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

  it.each([1.5, Number.POSITIVE_INFINITY])(
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

  it("accepts the conformance vector's truncated CRID path", async () => {
    const share = new ShareLink({
      link: "https://qurl.link/#qv2t1.example",
      crid: acceptedTruncated.value,
    });

    await expect(share.verifyCrid(b64url(matching.der_spki_b64url))).resolves.toBeUndefined();
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
