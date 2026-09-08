import { describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  DelegatedBatchOutcomeUnknownError,
  ERROR_CODE_DELEGATED_BATCH_OUTCOME_UNKNOWN,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  NetworkError,
  ValidationError,
} from "./errors.js";
import type { CreateDelegatedQurlBatchInput } from "./types.js";
import { createClient, mockFetch, mockFetches } from "./__tests__/test-helpers.js";

const BATCH_ID = `dqb_${"a".repeat(22)}`;
const ETAG = `"dqb-${"a".repeat(32)}"`;
const IDEMPOTENCY_KEY = "12345678-1234-1234-1234-123456789012";
const QURL_ID = "q_0123456789a";
const SUBMITTED_AT = "2026-09-07T12:00:00Z";
const COMMON_HEADERS = { "Cache-Control": "private, no-store", ETag: ETAG };
const ACCEPTED_HEADERS = {
  ...COMMON_HEADERS,
  Location: `https://api.test.layerv.ai/v1/delegated-qurl-batches/${BATCH_ID}`,
  "Retry-After": "2",
};
const INPUT: CreateDelegatedQurlBatchInput = {
  mint_capability: "opaque-capability",
  grants: [
    {
      expires_in: "1h",
      label: "recipient",
      one_time_use: true,
      max_sessions: 1,
      session_duration: "30m",
      access_policy: {
        geo_allowlist: ["US"],
        ai_agent_policy: { deny_categories: ["new-agent-category"] },
      },
    },
  ],
};

function acceptedBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      batch_id: BATCH_ID,
      status: "queued",
      item_count: 1,
      submitted_at: SUBMITTED_AT,
      ...overrides,
    },
    meta: { request_id: "req_create", forward_compatible: true },
  };
}

function pendingBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      batch_id: BATCH_ID,
      status: "running",
      item_count: 2,
      submitted_at: SUBMITTED_AT,
      ...overrides,
    },
    meta: { request_id: "req_get" },
  };
}

describe("delegated qURL batches", () => {
  it("sends one exact create and returns the 202 polling contract", async () => {
    const fetch = mockFetch({ status: 202, headers: ACCEPTED_HEADERS, body: acceptedBody() });
    const result = await createClient(fetch).createDelegatedQurlBatch(INPUT, {
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      http_status: 202,
      batch_id: BATCH_ID,
      status: "queued",
      item_count: 1,
      submitted_at: SUBMITTED_AT,
      etag: ETAG,
      retry_after: 2,
      location: ACCEPTED_HEADERS.Location,
      request_id: "req_create",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.test.layerv.ai/v1/delegated-qurl-batches");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.headers).toMatchObject({ "Idempotency-Key": IDEMPOTENCY_KEY });
    expect(init?.body).toBe(JSON.stringify(INPUT));
  });

  it("accepts max_sessions zero", async () => {
    const fetch = mockFetch({ status: 202, headers: ACCEPTED_HEADERS, body: acceptedBody() });
    const input = {
      ...INPUT,
      grants: [{ ...INPUT.grants[0], max_sessions: 0 }],
    };

    await expect(
      createClient(fetch).createDelegatedQurlBatch(input, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({ batch_id: BATCH_ID });
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(input));
  });

  it.each([
    ["unknown request field", { ...INPUT, unexpected: true }, { idempotencyKey: IDEMPOTENCY_KEY }],
    [
      "unknown grant field",
      { ...INPUT, grants: [{ ...INPUT.grants[0], unexpected: true }] },
      { idempotencyKey: IDEMPOTENCY_KEY },
    ],
    [
      "invalid policy shape",
      {
        ...INPUT,
        grants: [{ access_policy: { geo_allowlist: "US" } }],
      },
      { idempotencyKey: IDEMPOTENCY_KEY },
    ],
    ["short idempotency key", INPUT, { idempotencyKey: "too-short" }],
  ])("rejects %s before dispatch", async (_label, input, options) => {
    const fetch = vi.fn();
    await expect(
      createClient(fetch as typeof globalThis.fetch).createDelegatedQurlBatch(
        input as CreateDelegatedQurlBatchInput,
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hide a mutation retry after a transport failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("connection reset"));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 3,
    });

    const error = await client
      .createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY })
      .catch((caught: unknown) => caught as DelegatedBatchOutcomeUnknownError);

    expect(error).toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
    expect(error).toMatchObject({
      status: 0,
      code: ERROR_CODE_DELEGATED_BATCH_OUTCOME_UNKNOWN,
      cause: { status: 0 },
    });
    expect(error.cause).toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      "Idempotency-Key": IDEMPOTENCY_KEY,
    });
  });

  it("accepts a Location under a path-prefixed API base URL", async () => {
    const location = `https://api.test.layerv.ai/edge/v1/delegated-qurl-batches/${BATCH_ID}`;
    const fetch = mockFetch({
      status: 202,
      headers: { ...ACCEPTED_HEADERS, Location: location },
      body: acceptedBody(),
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai/edge",
      fetch,
    });

    await expect(
      client.createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({ location });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/edge/v1/delegated-qurl-batches",
      expect.any(Object),
    );
  });

  it("accepts relative Location and unordered Cache-Control directives", async () => {
    const location = `/v1/delegated-qurl-batches/${BATCH_ID}`;
    const fetch = mockFetch({
      status: 202,
      headers: {
        ...ACCEPTED_HEADERS,
        "Cache-Control": "no-store, max-age=0, private",
        Location: location,
      },
      body: acceptedBody(),
    });

    await expect(
      createClient(fetch).createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({
      location: `https://api.test.layerv.ai${location}`,
    });
  });

  it("resolves relative Location under a path-prefixed API base URL", async () => {
    const location = `/v1/delegated-qurl-batches/${BATCH_ID}`;
    const fetch = mockFetch({
      status: 202,
      headers: { ...ACCEPTED_HEADERS, Location: location },
      body: acceptedBody(),
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai/edge",
      fetch,
    });

    await expect(
      client.createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({
      location: `https://api.test.layerv.ai/edge${location}`,
    });
  });

  it("ignores additive response fields", async () => {
    const fetch = mockFetch({
      status: 202,
      headers: ACCEPTED_HEADERS,
      body: { ...acceptedBody({ trace: "new" }), extension: true },
    });

    await expect(
      createClient(fetch).createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({ batch_id: BATCH_ID });
  });

  it.each([
    ["missing Location", { "Cache-Control": "private, no-store", ETag: ETAG }, acceptedBody()],
    ["weak ETag", { ...ACCEPTED_HEADERS, ETag: `W/${ETAG}` }, acceptedBody()],
    ["unsafe Retry-After", { ...ACCEPTED_HEADERS, "Retry-After": "3601" }, acceptedBody()],
    ["invalid submitted_at", ACCEPTED_HEADERS, acceptedBody({ submitted_at: "invalid" })],
    [
      "foreign Location",
      {
        ...ACCEPTED_HEADERS,
        Location: `https://other.test/v1/delegated-qurl-batches/${BATCH_ID}`,
      },
      acceptedBody(),
    ],
  ])("classifies an accepted create with %s as outcome unknown", async (_label, headers, body) => {
    const fetch = mockFetch({ status: 202, headers, body });
    const error = await createClient(fetch)
      .createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY })
      .catch((caught: unknown) => caught as DelegatedBatchOutcomeUnknownError);

    expect(error).toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
    expect(error.batchId).toBe(BATCH_ID);
    expect(error.cause).toMatchObject({ status: 202, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a server failure after dispatch as outcome unknown", async () => {
    const fetch = mockFetch({
      status: 500,
      body: {
        error: {
          status: 500,
          code: "internal_error",
          title: "Internal Server Error",
          detail: "Failed to create delegated batch",
        },
        meta: { request_id: "req_failed_create" },
      },
    });

    const error = await createClient(fetch)
      .createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY })
      .catch((caught: unknown) => caught as DelegatedBatchOutcomeUnknownError);

    expect(error).toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
    expect(error.cause).toMatchObject({ status: 500, requestId: "req_failed_create" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies an ambiguous 408 after dispatch as outcome unknown", async () => {
    const fetch = mockFetch({
      status: 408,
      body: {
        error: {
          status: 408,
          code: "request_timeout",
          title: "Request Timeout",
          detail: "The service may have accepted the batch",
        },
        meta: { request_id: "req_timed_out" },
      },
    });

    await expect(
      createClient(fetch).createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([402, 404, 409, 422, 451])(
    "returns a definitive %i without an outcome-unknown wrapper",
    async (status) => {
      const fetch = mockFetch({
        status,
        body: {
          error: {
            status,
            code: "invalid_request",
            title: "Request Rejected",
            detail: "The request did not commit",
          },
          meta: { request_id: "req_rejected" },
        },
      });

      const error = await createClient(fetch)
        .createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY })
        .catch((caught: unknown) => caught);

      expect(error).not.toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
      expect(error).toMatchObject({ status, code: "invalid_request" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies a debug callback failure after dispatch as outcome unknown", async () => {
    const fetch = mockFetch({ status: 202, headers: ACCEPTED_HEADERS, body: acceptedBody() });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      debug: (message) => {
        if (message.includes("→ 202")) throw new Error("debug sink failed");
      },
    });

    const error = await client
      .createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY })
      .catch((caught: unknown) => caught as DelegatedBatchOutcomeUnknownError);

    expect(error).toBeInstanceOf(DelegatedBatchOutcomeUnknownError);
    expect(error.cause).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not report an outcome unknown before dispatch", async () => {
    const fetch = vi.fn();
    const debugFailure = new Error("debug sink failed");
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      debug: () => {
        throw debugFailure;
      },
    });

    await expect(
      client.createDelegatedQurlBatch(INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toBe(debugFailure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves 202 and 304 polling headers and sends If-None-Match", async () => {
    const fetch = mockFetches([
      {
        status: 202,
        headers: { ...COMMON_HEADERS, "Retry-After": "3" },
        body: pendingBody(),
      },
      {
        status: 304,
        headers: { ...COMMON_HEADERS, "Retry-After": "4" },
      },
    ]);
    const client = createClient(fetch);

    await expect(client.getDelegatedQurlBatch(BATCH_ID, { etag: ETAG })).resolves.toEqual({
      http_status: 202,
      batch_id: BATCH_ID,
      status: "running",
      item_count: 2,
      submitted_at: SUBMITTED_AT,
      etag: ETAG,
      retry_after: 3,
      request_id: "req_get",
    });
    await expect(client.getDelegatedQurlBatch(BATCH_ID, { etag: ETAG })).resolves.toEqual({
      http_status: 304,
      etag: ETAG,
      retry_after: 4,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ "If-None-Match": ETAG });
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toMatchObject({ "If-None-Match": ETAG });
  });

  it("accepts a 304 without optional response headers", async () => {
    const fetch = mockFetch({ status: 304, headers: { ETag: ETAG } });

    await expect(
      createClient(fetch).getDelegatedQurlBatch(BATCH_ID, { etag: ETAG }),
    ).resolves.toEqual({ http_status: 304, etag: ETAG });
  });

  it.each([
    ["without a request ETag", undefined, ETAG],
    ["with a changed response ETag", ETAG, '"different"'],
  ])("rejects a 304 %s", async (_label, requestEtag, responseEtag) => {
    const fetch = mockFetch({
      status: 304,
      headers: { ...COMMON_HEADERS, ETag: responseEtag, "Retry-After": "2" },
    });

    await expect(
      createClient(fetch).getDelegatedQurlBatch(BATCH_ID, { etag: requestEtag }),
    ).rejects.toMatchObject({ status: 304, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a strict, input-ordered terminal result", async () => {
    const body = {
      data: {
        batch_id: BATCH_ID,
        status: "partially_failed",
        item_count: 2,
        submitted_at: SUBMITTED_AT,
        completed_at: "2026-09-07T12:00:01Z",
        results: [
          {
            index: 0,
            status: "succeeded",
            qurl: {
              qurl_id: "q_0123456789a",
              qurl_link: "https://links.test/portal/?source=batch#secret-a",
              expires_at: "2026-09-07T13:00:00Z",
            },
          },
          {
            index: 1,
            status: "failed",
            error: { code: "creation_failed", message: "refused" },
          },
        ],
      },
      meta: { request_id: "req_terminal" },
    };
    const fetch = mockFetch({ status: 200, body });

    await expect(createClient(fetch).getDelegatedQurlBatch(BATCH_ID)).resolves.toEqual({
      http_status: 200,
      ...body.data,
      request_id: "req_terminal",
    });
  });

  it("accepts clock skew, fractional timestamps, and a forward-compatible failure code", async () => {
    const body = pendingBody({
      status: "failed",
      item_count: 1,
      submitted_at: "2026-09-07T12:00:01.125Z",
      completed_at: "2026-09-07T12:00:00.5Z",
      results: [{ index: 0, status: "failed", error: { code: "policy_denied", message: "no" } }],
    });
    const fetch = mockFetch({ status: 200, headers: COMMON_HEADERS, body });

    await expect(createClient(fetch).getDelegatedQurlBatch(BATCH_ID)).resolves.toMatchObject({
      submitted_at: "2026-09-07T12:00:01.125Z",
      completed_at: "2026-09-07T12:00:00.5Z",
      results: [{ error: { code: "policy_denied" } }],
    });
  });

  it("accepts explicit null for the inactive terminal result field", async () => {
    const body = pendingBody({
      status: "succeeded",
      item_count: 1,
      completed_at: "2026-09-07T12:00:01Z",
      results: [
        {
          index: 0,
          status: "succeeded",
          error: null,
          qurl: {
            qurl_id: QURL_ID,
            qurl_link: "https://links.test/#secret",
            expires_at: "2026-09-07T13:00:00Z",
          },
        },
      ],
    });

    await expect(
      createClient(mockFetch({ status: 200, body })).getDelegatedQurlBatch(BATCH_ID),
    ).resolves.toMatchObject({ status: "succeeded", results: [{ status: "succeeded" }] });
  });

  it.each([
    [
      "duplicate bearer data",
      pendingBody({
        status: "succeeded",
        completed_at: "2026-09-07T12:00:01Z",
        results: [
          {
            index: 0,
            status: "succeeded",
            qurl: {
              qurl_id: QURL_ID,
              qurl_link: "https://links.test/#same-secret",
              expires_at: "2026-09-07T13:00:00Z",
            },
          },
          {
            index: 1,
            status: "succeeded",
            qurl: {
              qurl_id: QURL_ID,
              qurl_link: "https://links.test/#same-secret",
              expires_at: "2026-09-07T13:00:00Z",
            },
          },
        ],
      }),
    ],
    [
      "a status that disagrees with its results",
      pendingBody({
        status: "succeeded",
        completed_at: "2026-09-07T12:00:01Z",
        results: [
          {
            index: 0,
            status: "succeeded",
            qurl: {
              qurl_id: QURL_ID,
              qurl_link: "https://links.test/#secret",
              expires_at: "2026-09-07T13:00:00Z",
            },
          },
          { index: 1, status: "failed", error: { code: "creation_failed", message: "no" } },
        ],
      }),
    ],
  ])("rejects a terminal response with %s", async (_label, body) => {
    await expect(
      createClient(mockFetch({ status: 200, body })).getDelegatedQurlBatch(BATCH_ID),
    ).rejects.toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });

  it.each([
    "http://links.test/#secret",
    "https://user:pass@links.test/#secret",
    "https://links.test/",
  ])("rejects unsafe delegated bearer link %s", async (qurlLink) => {
    const body = pendingBody({
      status: "succeeded",
      item_count: 1,
      completed_at: "2026-09-07T12:00:01Z",
      results: [
        {
          index: 0,
          status: "succeeded",
          qurl: { qurl_id: QURL_ID, qurl_link: qurlLink, expires_at: "2026-09-07T13:00:00Z" },
        },
      ],
    });

    await expect(
      createClient(mockFetch({ status: 200, body })).getDelegatedQurlBatch(BATCH_ID),
    ).rejects.toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });

  it("gets delegated qURLs and does not retry DELETE", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: {
            qurl_id: QURL_ID,
            status: "active",
            expires_at: "2026-09-07T13:00:00Z",
            one_time_use: false,
            max_sessions: 0,
            session_duration: 3600,
          },
          meta: { request_id: "req_get_qurl" },
        },
      },
      {
        status: 503,
        body: {
          error: {
            status: 503,
            code: "mutation_outcome_unknown",
            title: "Service Unavailable",
            detail: "Retry the same DELETE",
          },
          meta: { request_id: "req_delete_qurl" },
        },
      },
    ]);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 3,
    });

    await expect(client.getDelegatedQurl(QURL_ID)).resolves.toMatchObject({ qurl_id: QURL_ID });
    await expect(client.deleteDelegatedQurl(QURL_ID)).rejects.toMatchObject({
      status: 503,
      code: "mutation_outcome_unknown",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a different qURL ID", { qurl_id: "q_aaaaaaaaaaa" }],
    ["an unknown status", { status: "unknown" }],
    ["a non-numeric session duration", { session_duration: "3600" }],
  ])("rejects delegated qURL metadata with %s", async (_label, override) => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          qurl_id: QURL_ID,
          status: "active",
          expires_at: "2026-09-07T13:00:00Z",
          one_time_use: false,
          max_sessions: 0,
          session_duration: 3600,
          ...override,
        },
        meta: { request_id: "req_get_qurl" },
      },
    });

    await expect(createClient(fetch).getDelegatedQurl(QURL_ID)).rejects.toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      requestId: "req_get_qurl",
    });
  });

  it.each(["q_ABCDEF01234", "q_too-short"])(
    "rejects malformed delegated qURL ID %s before dispatch",
    async (qurlId) => {
      const fetch = vi.fn();
      const client = createClient(fetch as typeof globalThis.fetch);

      await expect(client.getDelegatedQurl(qurlId)).rejects.toBeInstanceOf(ValidationError);
      await expect(client.deleteDelegatedQurl(qurlId)).rejects.toBeInstanceOf(ValidationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects out-of-order terminal results", async () => {
    const body = pendingBody({
      item_count: 1,
      status: "failed",
      completed_at: "2026-09-07T12:00:01Z",
      results: [{ index: 1, status: "failed", error: { code: "creation_failed", message: "x" } }],
    });
    const fetch = mockFetch({ status: 200, headers: COMMON_HEADERS, body });

    await expect(createClient(fetch).getDelegatedQurlBatch(BATCH_ID)).rejects.toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it("rejects a terminal status on a 202 read response", async () => {
    const overrides = { status: "succeeded" };
    const body = pendingBody({ item_count: 1, ...overrides });
    const fetch = mockFetch({
      status: 202,
      headers: { ...COMMON_HEADERS, "Retry-After": "1" },
      body,
    });

    await expect(createClient(fetch).getDelegatedQurlBatch(BATCH_ID)).rejects.toMatchObject({
      status: 202,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it("leaves retry count and total poll deadline to the caller", async () => {
    const fetch = mockFetch({
      status: 503,
      body: {
        error: {
          status: 503,
          code: "service_unavailable",
          title: "Service Unavailable",
          detail: "Try later",
        },
        meta: { request_id: "req_unavailable" },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 3,
    });

    await expect(client.getDelegatedQurlBatch(BATCH_ID)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
