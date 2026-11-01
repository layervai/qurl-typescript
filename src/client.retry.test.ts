import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  ERROR_CODE_NETWORK,
  ERROR_CODE_RUNTIME,
  ERROR_CODE_TIMEOUT,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ERROR_CODE_UNKNOWN,
  NetworkError,
  NotFoundError,
  QURLError,
  RateLimitError,
  RuntimeError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";
import {
  UUID_V7_RE,
  RESOURCE_CRID,
  RESPONSE_BODY_LIMIT,
  connectorResourceData,
  callHeaders,
} from "./__tests__/client-fixtures.js";

describe("QURLClient", () => {
  it("forwards a caller idempotency key on connector ensure", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: connectorResourceData(), meta: { found_existing: false } },
    });

    const result = await createClient(fetch).ensureConnectorResource("prod-dashboard", {
      idempotencyKey: "connector-ensure-job-1",
    });

    expect(result.foundExisting).toBe(false);
    expect(callHeaders(fetch)["Idempotency-Key"]).toBe("connector-ensure-job-1");
  });

  it("does not generate an idempotency key for connector ensure", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: connectorResourceData(), meta: { found_existing: true } },
    });

    await createClient(fetch).ensureConnectorResource("prod-dashboard");

    expect(callHeaders(fetch)).not.toHaveProperty("Idempotency-Key");
  });

  it("sends a UUIDv7 Idempotency-Key on POST requests", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          resource_id: "r_abc123def45",
          qurl_link: "https://qurl.link/#at_test",
          qurl_site: "https://r_abc123def45.qurl.site",
        },
      },
    });

    const client = createClient(fetch);
    await client.create({ target_url: "https://example.com" });

    expect(callHeaders(fetch)["Idempotency-Key"]).toMatch(UUID_V7_RE);
  });

  it("sends a UUIDv7 Idempotency-Key on POST requests without a body", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { url: "https://billing.example.com/portal" } },
    });

    const client = createClient(fetch);
    await client.createBillingPortal();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/billing/portal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(callHeaders(fetch)["Idempotency-Key"]).toMatch(UUID_V7_RE);
    expect(callHeaders(fetch)).not.toHaveProperty("Content-Type");
  });

  it("generates a fresh Idempotency-Key for separate logical calls", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          resource_id: "r_abc123def45",
          qurl_link: "https://qurl.link/#at_test",
          qurl_site: "https://r_abc123def45.qurl.site",
        },
      },
    });

    const client = createClient(fetch);
    await client.create({ target_url: "https://example.com/a" });
    await client.create({ target_url: "https://example.com/b" });

    const firstKey = callHeaders(fetch, 0)["Idempotency-Key"];
    const secondKey = callHeaders(fetch, 1)["Idempotency-Key"];
    expect(firstKey).toMatch(UUID_V7_RE);
    expect(secondKey).toMatch(UUID_V7_RE);
    expect(secondKey).not.toBe(firstKey);
  });

  it("does not send Idempotency-Key on read-only requests", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "growth",
          period_start: "2026-03-01",
          period_end: "2026-04-01",
        },
      },
    });

    const client = createClient(fetch);
    await client.getQuota();

    expect(callHeaders(fetch)).not.toHaveProperty("Idempotency-Key");
  });

  it("uses caller-provided Idempotency-Key override", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          resource_id: "r_abc123def45",
          qurl_link: "https://qurl.link/#at_test",
          qurl_site: "https://r_abc123def45.qurl.site",
        },
      },
    });

    const client = createClient(fetch);
    await client.create(
      { target_url: "https://example.com" },
      { idempotencyKey: "upstream-job-123" },
    );

    expect(callHeaders(fetch)["Idempotency-Key"]).toBe("upstream-job-123");
  });

  it.each([300, 301, 302, 303, 305, 307, 308])(
    "refuses HTTP %i redirect responses without retrying",
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 2,
      });

      await expect(client.getQuota()).rejects.toMatchObject({
        status,
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid Idempotency-Key overrides before making a request", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { resource_id: "r_unused", qurl_link: "https://qurl.link/#at_unused" } },
    });
    const client = createClient(fetch);

    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: "" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: "job-1\tbad" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create(
        { target_url: "https://example.com" },
        { idempotencyKey: "job-1\r\nX-Injected: 1" },
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: " job-1" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: "job-1 " }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: 123 } as never),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: null } as never),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.create({ target_url: "https://example.com" }, { idempotencyKey: "x".repeat(257) }),
    ).rejects.toThrow(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses caller-provided Idempotency-Key override when global crypto is unavailable", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { resource_id: "r_override", qurl_link: "https://qurl.link/#at_override" } },
    });
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      const client = createClient(fetch);
      const result = await client.create(
        { target_url: "https://example.com" },
        { idempotencyKey: "upstream-job-123" },
      );

      expect(result.resource_id).toBe("r_override");
      expect(callHeaders(fetch)["Idempotency-Key"]).toBe("upstream-job-123");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });

  it("throws RuntimeError when generating Idempotency-Key without Web Crypto", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { resource_id: "r_unused", qurl_link: "https://qurl.link/#at_unused" } },
    });
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      const client = createClient(fetch);

      let thrown: unknown;
      try {
        await client.create({ target_url: "https://example.com" });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(RuntimeError);
      expect((thrown as RuntimeError).code).toBe(ERROR_CODE_RUNTIME);
      expect((thrown as RuntimeError).detail).toContain("globalThis.crypto.getRandomValues");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });

  it("retries on network errors and re-throws after exhausting retries", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    await expect(client.getQuota()).rejects.toThrow("fetch failed");
    // 1 initial + 1 retry = 2 attempts
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses Idempotency-Key across POST network-error retries", async () => {
    const successResponse = {
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: {
            resource_id: "r_after_retry",
            qurl_link: "https://qurl.link/#at_after_retry",
            qurl_site: "https://r_after_retry.qurl.site",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket reset"))
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const result = await client.create({ target_url: "https://example.com" });

    expect(result.resource_id).toBe("r_after_retry");
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstKey = callHeaders(fetch, 0)["Idempotency-Key"];
    const secondKey = callHeaders(fetch, 1)["Idempotency-Key"];
    expect(firstKey).toMatch(UUID_V7_RE);
    expect(secondKey).toBe(firstKey);
  });

  it("does not replay a mutation for an injected fetch TimeoutError", async () => {
    const successResponse = {
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: {
            resource_id: "r_after_timeout",
            qurl_link: "https://qurl.link/#at_after_timeout",
            qurl_site: "https://r_after_timeout.qurl.site",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("deadline exceeded", "TimeoutError"))
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const error = await client
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ status: 0, code: ERROR_CODE_NETWORK });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callHeaders(fetch)["Idempotency-Key"]).toMatch(UUID_V7_RE);
  });

  it("handles partial Quota responses (rate_limits and usage absent)", async () => {
    // Locks in the type contract: Quota.rate_limits and Quota.usage
    // are both optional (older deployments / partial responses /
    // plan-tier variation may omit them). Inner fields are also
    // optional so consumers must guard each one — calling
    // `quota.rate_limits.max_expiry_seconds` directly on this response
    // would have been `undefined` at runtime under the previous types,
    // and a typed consumer would not have known to guard it.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "free",
          period_start: "2026-03-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const quota = await client.getQuota();

    expect(quota.plan).toBe("free");
    expect(quota.rate_limits).toBeUndefined();
    expect(quota.usage).toBeUndefined();
  });

  it("handles partial Quota responses (rate_limits / usage with subset of fields)", async () => {
    // Locks in the inner-fields-optional contract: a partial
    // rate_limits or usage object (missing some inner fields) must
    // parse cleanly. The optional inner fields force consumers to
    // guard each access individually rather than trusting the parent's
    // presence to imply the full inner shape.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "growth",
          period_start: "2026-03-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
          rate_limits: { create_per_minute: 10 },
          usage: { qurls_created: 5 },
        },
      },
    });

    const client = createClient(fetch);
    const quota = await client.getQuota();

    expect(quota.rate_limits?.create_per_minute).toBe(10);
    expect(quota.rate_limits?.max_expiry_seconds).toBeUndefined();
    expect(quota.usage?.qurls_created).toBe(5);
    expect(quota.usage?.active_qurls).toBeUndefined();
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "growth",
          period_start: "2026-03-01",
          period_end: "2026-04-01",
        },
      },
    });

    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      timeout: 5000,
    });

    await client.getQuota();

    const calledOptions = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries an oversized error body when the status and method are retryable", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("x".repeat(RESPONSE_BODY_LIMIT + 1), {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    await expect(client.getQuota()).resolves.toMatchObject({ plan: "growth" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the status error class and Retry-After for an oversized 429 body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("x".repeat(RESPONSE_BODY_LIMIT + 1), {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
    );
    const error = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({
      status: 429,
      code: ERROR_CODE_UNKNOWN,
      retryAfter: 7,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable status even when its error body is non-JSON", async () => {
    vi.useFakeTimers();
    try {
      const responseBody = "<html>transient proxy response</html>";
      const fetch = vi.fn(
        async () =>
          new Response(responseBody, {
            status: 503,
            headers: { "content-type": "text/html" },
          }),
      );
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 2,
      });

      const errorPromise = client.getQuota().catch((caught: unknown) => caught as QURLError);
      await vi.runAllTimersAsync();
      const error = await errorPromise;

      expect(error).toBeInstanceOf(ServerError);
      expect(error.status).toBe(503);
      expect(error.code).toBe(ERROR_CODE_UNKNOWN);
      expect(error.message.length).toBeLessThan(256);
      expect(error.message).not.toContain(responseBody);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects Retry-After header on 429 responses", async () => {
    vi.useFakeTimers();
    try {
      const fetch = mockFetches([
        {
          status: 429,
          body: {
            error: {
              title: "Rate Limited",
              status: 429,
              detail: "Too many requests",
              code: "rate_limited",
            },
          },
          headers: { "Retry-After": "2" },
        },
        {
          status: 200,
          body: { data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" } },
        },
      ]);
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: 1,
      });

      const promise = client.getQuota();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects Retry-After header on 503 responses too (RFC 7231 §7.1.3)", async () => {
    // Per RFC 7231, Retry-After is allowed on 429 AND 503. Earlier
    // versions only honored it on 429; a 503 with Retry-After: 30
    // would otherwise fall through to ≤30s exponential-with-jitter.
    vi.useFakeTimers();
    try {
      const retryAfter503 = mockFetches([
        {
          status: 503,
          body: {
            error: {
              title: "Service Unavailable",
              status: 503,
              detail: "Maintenance",
              code: "service_unavailable",
            },
          },
          headers: { "Retry-After": "2" },
        },
        {
          status: 200,
          body: { data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" } },
        },
      ]);
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: retryAfter503,
        maxRetries: 1,
      });

      const promise = client.getQuota();
      // Just before the 2s server directive: must NOT have retried.
      await vi.advanceTimersByTimeAsync(1999);
      expect(retryAfter503).toHaveBeenCalledTimes(1);
      // Just after the directive: retry fires.
      await vi.advanceTimersByTimeAsync(2);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(retryAfter503).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Retry-After: 0 (immediate retry, not exponential backoff)", async () => {
    // RFC 7231 §7.1.3 allows Retry-After: 0 ("retry immediately"). A
    // truthy check on `lastError.retryAfter` would misclassify 0 as
    // "unset" and fall through to exponential backoff (~500ms). The
    // current `!== undefined` guard preserves the literal 0. Locks in
    // the semantic against future regressions: the 50ms budget below
    // is well under the 500ms exponential floor a truthy bug would hit.
    vi.useFakeTimers();
    try {
      const retryAfterZero = {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "0" }),
        json: () =>
          Promise.resolve({
            error: { title: "Rate Limited", status: 429, detail: "x", code: "rate_limited" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const successResponse = {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        json: () =>
          Promise.resolve({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const fetch = vi
        .fn()
        .mockResolvedValueOnce(retryAfterZero)
        .mockResolvedValueOnce(successResponse);

      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 1,
      });

      const promise = client.getQuota();
      // 50ms is well under the 500ms exponential floor a truthy bug
      // would hit, so it cleanly distinguishes "Retry-After: 0 honored"
      // from "fell through to exponential backoff."
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Retry-After: 0 on 503 (parity with 429)", async () => {
    // Companion to the 429 case above. parseRetryAfter returns 0 on both
    // statuses; the immediate-retry semantic must hold for either.
    vi.useFakeTimers();
    try {
      const retryAfterZero = {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: new Headers({ "Retry-After": "0" }),
        json: () =>
          Promise.resolve({
            error: { title: "Unavailable", status: 503, detail: "x", code: "service_unavailable" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const successResponse = {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        json: () =>
          Promise.resolve({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const fetch = vi
        .fn()
        .mockResolvedValueOnce(retryAfterZero)
        .mockResolvedValueOnce(successResponse);

      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 1,
      });

      const promise = client.getQuota();
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Retry-After exceeding parse limit falls through to exponential backoff (logged)", async () => {
    // Pathological `Retry-After` (30 days) > the parse-time limit
    // (= RETRY_AFTER_HARD_CAP_MS / 1000) is rejected at parse with a
    // debug log; retryDelay then uses exponential backoff. Without the
    // parse-time guard, very large values would propagate through the
    // *1000 ms-conversion before the hard cap clamped them.
    vi.useFakeTimers();
    try {
      const huge = 86400 * 30; // 30 days, well past the 1h parse limit
      const retryAfterHuge = mockFetches([
        {
          status: 429,
          body: {
            error: { title: "Rate Limited", status: 429, detail: "x", code: "rate_limited" },
          },
          headers: { "Retry-After": String(huge) },
        },
        {
          status: 200,
          body: { data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" } },
        },
      ]);

      const debugMessages: string[] = [];
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: retryAfterHuge,
        maxRetries: 1,
        debug: (msg) => {
          debugMessages.push(msg);
        },
      });

      const promise = client.getQuota();
      // Exponential backoff is capped at RETRY_MAX_DELAY_MS (30s) + 50%
      // jitter ≤ 45s. Advancing 60s guarantees the retry has fired.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(retryAfterHuge).toHaveBeenCalledTimes(2);
      expect(debugMessages.some((m) => m.includes("Retry-After header exceeded parse limit"))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Retry-After with trailing garbage (e.g. '60abc') as non-numeric", async () => {
    // `parseInt("60abc", 10)` returns 60 — a malformed header would
    // silently get honored without the digit-only pre-check. The strict
    // regex makes the malformed-header path observable (debug log) and
    // falls through to exponential backoff so the SDK doesn't act on
    // a half-parsed value.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
      },
      headers: { "Retry-After": "60abc" },
    });
    let lastDebug: string | undefined;
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: (msg) => {
        lastDebug = msg;
      },
    });
    // The 200 success path doesn't actually call parseRetryAfter
    // (only 429 does). Use the QURLError construction path: a 429
    // with malformed header surfaces .retryAfter === undefined.
    const fetch429 = mockFetch({
      status: 429,
      body: { error: { title: "Rate Limited", status: 429, detail: "x", code: "rate_limited" } },
      headers: { "Retry-After": "60abc" },
    });
    const client429 = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch429,
      maxRetries: 0,
      debug: (msg) => {
        lastDebug = msg;
      },
    });
    const err = (await client429.getQuota().catch((e: unknown) => e)) as QURLError;
    expect(err).toBeInstanceOf(RateLimitError);
    // Malformed Retry-After must NOT propagate — retryAfter stays undefined.
    expect(err.retryAfter).toBeUndefined();
    // Debug log fires so operators can spot the drift.
    expect(lastDebug).toContain("non-numeric");
    // Sanity-check the 200-path client wasn't broken by the Retry-After test.
    await expect(client.getQuota()).resolves.toBeDefined();
  });

  it("does not clamp Retry-After against RETRY_MAX_DELAY_MS (server directive wins)", async () => {
    // RFC 7231 §7.1.3 — when the server tells us 60s, retrying at 30s
    // (the exponential-backoff cap) just re-trips the rate limit.
    // The server-supplied path bypasses the clamp; only the local
    // exponential-backoff branch is capped.
    vi.useFakeTimers();
    try {
      const retryAfter60 = {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "60" }),
        json: () =>
          Promise.resolve({
            error: { title: "Rate Limited", status: 429, detail: "x", code: "rate_limited" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const successResponse = {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        json: () =>
          Promise.resolve({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const fetch = vi
        .fn()
        .mockResolvedValueOnce(retryAfter60)
        .mockResolvedValueOnce(successResponse);

      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 1,
      });

      const promise = client.getQuota();
      // Advance past the local cap (30s) but short of the server-asked
      // 60s. If the SDK clamped the server directive, the retry would
      // already have fired by now.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      // Now advance past the server directive — retry should fire.
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await promise;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.plan).toBe("growth");
    } finally {
      vi.useRealTimers();
    }
  });

  it("floors fractional maxRetries (no off-by-one in the retry loop)", async () => {
    // `Math.floor` on a positive fractional input — `2.7` → `2`, not
    // `3`. The retry loop uses `attempt <= this.maxRetries`, so a
    // non-integer would still work numerically but reading the value
    // back via debug or telemetry would be confusing. Floor for
    // determinism.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2.7,
    });
    await expect(client.getQuota()).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to default timeout on NaN/Infinity/negative (immediate-abort guard)", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" } },
    });
    for (const badTimeout of [NaN, Infinity, -Infinity, -1, 0]) {
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: 0,
        timeout: badTimeout,
      });
      await expect(client.getQuota()).resolves.toBeDefined();
    }
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("preserves Retry-After on a non-envelope 429 response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("rate limited by gateway", {
          status: 429,
          headers: { "Retry-After": "9", "content-type": "text/plain" },
        }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, code: ERROR_CODE_UNKNOWN, retryAfter: 9 });
  });

  // --- Network error wrapping ---

  it("wraps TypeError into NetworkError", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = createClient(fetch);

    const err = await client.getQuota().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toContain("fetch failed");
  });

  it("does not retry or mislabel an injected fetch TimeoutError", async () => {
    const injectedSignal = AbortSignal.timeout(1);
    await new Promise<void>((resolve) => {
      injectedSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    const fetch = vi.fn().mockRejectedValue(injectedSignal.reason);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const err = await client.getQuota().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ status: 0, code: ERROR_CODE_NETWORK });
    expect((err as NetworkError).cause).toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies only the SDK-owned fetch deadline as TimeoutError", async () => {
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
      timeout: 5,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ status: 0, code: ERROR_CODE_TIMEOUT });
    expect(error.cause).toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry or mislabel an injected fetch AbortError", async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException("wrapper cancelled", "AbortError"));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ status: 0, code: ERROR_CODE_NETWORK });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // --- Mutating-safe retry ---

  it("does not retry POST on 502 but still sends Idempotency-Key", async () => {
    const fetch = mockFetch({
      status: 502,
      body: {
        error: { title: "Bad Gateway", status: 502, detail: "Upstream error", code: "bad_gateway" },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.create({ target_url: "https://example.com" })).rejects.toThrow(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callHeaders(fetch)["Idempotency-Key"]).toMatch(UUID_V7_RE);
  });

  it("does not retry PATCH on 502 but still sends Idempotency-Key", async () => {
    const fetch = mockFetch({
      status: 502,
      body: {
        error: { title: "Bad Gateway", status: 502, detail: "Upstream error", code: "bad_gateway" },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.update(RESOURCE_CRID, { description: "test" })).rejects.toThrow(
      ServerError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callHeaders(fetch)["Idempotency-Key"]).toMatch(UUID_V7_RE);
  });

  it("reuses caller-provided Idempotency-Key across PATCH network-error retries", async () => {
    const successResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: {
            resource_id: "r_abc",
            target_url: "https://example.com",
            status: "active",
            created_at: "2026-03-15T10:00:00Z",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket reset"))
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const result = await client.update(
      RESOURCE_CRID,
      { description: "test" },
      { idempotencyKey: "upstream-patch-job-123" },
    );

    expect(result.resource_id).toBe("r_abc");
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstKey = callHeaders(fetch, 0)["Idempotency-Key"];
    const secondKey = callHeaders(fetch, 1)["Idempotency-Key"];
    expect(firstKey).toBe("upstream-patch-job-123");
    expect(secondKey).toBe(firstKey);
  });

  it("retries GET when a retryable response body fails mid-stream", async () => {
    let reads = 0;
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
        } else {
          controller.error(new TypeError("upstream reset mid-body"));
        }
      },
    });
    const failure = new Response(brokenBody, { status: 503, statusText: "Unavailable" });
    const success = new Response(
      JSON.stringify({
        data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetch = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    await expect(client.getQuota()).resolves.toMatchObject({ plan: "growth" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry GET when a 404 response body fails mid-stream", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("not-found response reset mid-body"));
      },
    });
    const failure = new Response(brokenBody, { status: 404, statusText: "Not Found" });
    const fetch = vi.fn().mockResolvedValue(failure);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: ERROR_CODE_UNKNOWN });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay POST after a retryable 429 response body transport failure", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("rate-limit body reset"));
      },
    });
    const rateLimited = new Response(brokenBody, {
      status: 429,
      headers: { "Retry-After": "0" },
    });
    const fetch = vi.fn().mockResolvedValue(rateLimited);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const error = await client
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as QURLError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, code: ERROR_CODE_UNKNOWN, retryAfter: 0 });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves status-derived errors and Retry-After on non-success body failures", async () => {
    const brokenResponse = (status: number, retryAfter?: string): Response =>
      new Response(
        new globalThis.ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("response body reset"));
          },
        }),
        {
          status,
          headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
        },
      );

    const serverError = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: vi.fn(async () => brokenResponse(503)) as typeof globalThis.fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);
    expect(serverError).toBeInstanceOf(ServerError);
    expect(serverError).toMatchObject({ status: 503, code: ERROR_CODE_UNKNOWN });
    expect(serverError.message).toContain("HTTP 503");
    expect(serverError.retryAfter).toBeUndefined();
    expect(serverError.cause).toBeInstanceOf(TypeError);
    expect(Object.keys(serverError)).not.toContain("cause");
    expect({ ...serverError }).not.toHaveProperty("cause");
    expect(Object.getOwnPropertyDescriptor(serverError, "cause")).toEqual({
      value: serverError.cause,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const rateLimitError = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: vi.fn(async () => brokenResponse(429, "7")) as typeof globalThis.fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);
    expect(rateLimitError).toBeInstanceOf(RateLimitError);
    expect(rateLimitError).toMatchObject({ status: 429, code: ERROR_CODE_UNKNOWN });
    expect(rateLimitError.message).toContain("HTTP 429");
    expect(rateLimitError.retryAfter).toBe(7);
    expect(rateLimitError.cause).toBeInstanceOf(TypeError);
  });

  it("reports a successful response body reset as a typed network failure", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("successful response reset mid-body"));
      },
    });
    const fetch = vi.fn(async () => new Response(brokenBody, { status: 200, statusText: "OK" }));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ status: 0, code: ERROR_CODE_NETWORK });
    expect(error.message).toContain("HTTP 200");
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["AbortError", "TimeoutError"])(
    "does not retry or mislabel an independent response-body %s",
    async (errorName) => {
      const brokenBody = new globalThis.ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DOMException("wrapper cancelled body", errorName));
        },
      });
      const fetch = vi.fn(async () => new Response(brokenBody, { status: 200, statusText: "OK" }));
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 2,
      });

      const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

      expect(error).toBeInstanceOf(NetworkError);
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect(error).toMatchObject({ status: 0, code: ERROR_CODE_NETWORK });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the observed non-success class for an independent body AbortError", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException("wrapper cancelled error body", "AbortError"));
      },
    });
    const fetch = vi.fn(
      async () => new Response(brokenBody, { status: 404, statusText: "Not Found" }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: ERROR_CODE_UNKNOWN });
    expect(error.cause).toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a successful mutation body timeout without replaying the mutation", async () => {
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const signal = init?.signal;
        const slowBody = new globalThis.ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(signal.reason ?? new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(slowBody, { status: 201, statusText: "Created" });
      },
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
      timeout: 5,
    });

    const error = await client
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ status: 0, code: ERROR_CODE_TIMEOUT });
    expect(error.message).toContain("HTTP 201");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 503 with maxRetries: 0", async () => {
    const fetch = mockFetch({
      status: 503,
      body: {
        error: { title: "Unavailable", status: 503, detail: "Down", code: "unavailable" },
      },
    });
    const client = createClient(fetch);

    await expect(client.getQuota()).rejects.toThrow(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry GET after a successful response with malformed UTF-8", async () => {
    const encoder = new TextEncoder();
    const malformedBody = new Uint8Array([
      ...encoder.encode('{"data":{"plan":"'),
      0xff,
      ...encoder.encode('","period_start":"2026-03-01","period_end":"2026-04-01"}}'),
    ]);
    const fetch = vi.fn(
      async () =>
        new Response(malformedBody, {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    await expect(client.getQuota()).rejects.toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a retryable error status retryable when its body has malformed UTF-8", async () => {
    vi.useFakeTimers();
    try {
      const malformed = new Response(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
        status: 503,
        statusText: "Service Unavailable",
      });
      const success = new Response(
        JSON.stringify({
          data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      const fetch = vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(success);
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 1,
      });

      const resultPromise = client.getQuota();
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toMatchObject({ plan: "growth" });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
