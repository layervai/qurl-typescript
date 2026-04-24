import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  AuthenticationError,
  AuthorizationError,
  NetworkError,
  NotFoundError,
  QURLError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
import { mockFetch, createClient } from "./test-helpers.js";

describe("QURLClient", () => {
  it("creates a QURL", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          resource_id: "r_abc123def45",
          qurl_link: "https://qurl.link/#at_test",
          qurl_site: "https://r_abc123def45.qurl.site",
          expires_at: "2026-03-15T10:00:00Z",
        },
        meta: { request_id: "req_1" },
      },
    });

    const client = createClient(fetch);
    const result = await client.create({
      target_url: "https://example.com",
      expires_in: "24h",
    });

    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.qurl_link).toBe("https://qurl.link/#at_test");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gets a QURL with access tokens", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 2,
          // API wire format uses "qurls"; client.get() maps to "access_tokens"
          qurls: [
            {
              qurl_id: "at_token1",
              status: "active",
              one_time_use: false,
              max_sessions: 3,
              session_duration: 300,
              use_count: 1,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
            {
              qurl_id: "at_token2",
              status: "consumed",
              one_time_use: true,
              max_sessions: 1,
              session_duration: 300,
              use_count: 1,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
          ],
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("r_abc123def45");

    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.status).toBe("active");
    expect(result.qurl_count).toBe(2);
    expect(result.access_tokens).toHaveLength(2);
    expect(result.access_tokens![0].qurl_id).toBe("at_token1");
    expect(result.access_tokens![0].one_time_use).toBe(false);
    expect(result.access_tokens![0].max_sessions).toBe(3);
    expect(result.access_tokens![1].status).toBe("consumed");
    expect(result.access_tokens![1].one_time_use).toBe(true);
  });

  it("gets a QURL without access tokens", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 0,
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("r_abc123def45");

    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.qurl_count).toBe(0);
    expect(result.access_tokens).toBeUndefined();
  });

  it("lists QURLs", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [
          {
            resource_id: "r_abc123def45",
            target_url: "https://example.com",
            status: "active",
            created_at: "2026-03-10T10:00:00Z",
          },
        ],
        meta: { has_more: false, page_size: 20 },
      },
    });

    const client = createClient(fetch);
    const result = await client.list({ status: "active", limit: 10 });

    expect(result.qurls).toHaveLength(1);
    expect(result.qurls[0].resource_id).toBe("r_abc123def45");
    expect(result.has_more).toBe(false);
  });

  it("passes limit: 0 as a query parameter", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [],
        meta: { has_more: false, page_size: 0 },
      },
    });

    const client = createClient(fetch);
    await client.list({ limit: 0 });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls?limit=0",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("deletes a QURL", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.delete("r_abc123def45")).resolves.toBeUndefined();
  });

  it("extends a QURL", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          created_at: "2026-03-10T10:00:00Z",
          expires_at: "2026-03-20T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.extend("r_abc123def45", { extend_by: "7d" });

    expect(result.expires_at).toBe("2026-03-20T10:00:00Z");
  });

  it("updates a QURL description", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          description: "Updated description",
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.update("r_abc123def45", {
      description: "Updated description",
    });

    expect(result.description).toBe("Updated description");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/r_abc123def45",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ description: "Updated description" }),
      }),
    );
  });

  it("update maps qurls to access_tokens", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          description: "Updated",
          qurl_count: 1,
          qurls: [
            {
              qurl_id: "q_abc12345678",
              status: "active",
              one_time_use: false,
              max_sessions: 5,
              session_duration: 300,
              use_count: 0,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
          ],
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.update("r_abc123def45", { description: "Updated" });

    expect(result.access_tokens).toHaveLength(1);
    expect(result.access_tokens![0].qurl_id).toBe("q_abc12345678");
    expect((result as Record<string, unknown>).qurls).toBeUndefined();
  });

  it("resolves a QURL token", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          target_url: "https://api.example.com/data",
          resource_id: "r_abc123def45",
          access_grant: {
            expires_in: 305,
            granted_at: "2026-03-10T15:30:00Z",
            src_ip: "203.0.113.42",
          },
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.resolve({
      access_token: "at_k8xqp9h2sj9lx7r4a",
    });

    expect(result.target_url).toBe("https://api.example.com/data");
    expect(result.access_grant?.expires_in).toBe(305);
    expect(result.access_grant?.src_ip).toBe("203.0.113.42");
  });

  it("throws QURLError on API errors", async () => {
    const fetch = mockFetch({
      status: 404,
      body: {
        error: {
          type: "https://api.qurl.link/problems/not_found",
          title: "Not Found",
          status: 404,
          detail: "QURL not found",
          code: "not_found",
        },
        meta: { request_id: "req_err" },
      },
    });

    const client = createClient(fetch);

    try {
      await client.get("r_notfound0000");
      expect.fail("Expected QURLError");
    } catch (err) {
      expect(err).toBeInstanceOf(QURLError);
      const qErr = err as QURLError;
      expect(qErr.status).toBe(404);
      expect(qErr.code).toBe("not_found");
      expect(qErr.requestId).toBe("req_err");
    }
  });

  it("sends correct auth header", async () => {
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

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer lv_live_test",
        }),
      }),
    );
  });

  it("mints a link", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          qurl_link: "https://qurl.link/#at_newtoken",
          expires_at: "2026-03-15T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.mintLink("r_abc123def45");

    expect(result.qurl_link).toBe("https://qurl.link/#at_newtoken");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/r_abc123def45/mint_link",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not send Content-Type header on GET requests", async () => {
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

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(calledHeaders).not.toHaveProperty("Content-Type");
  });

  it("sends Content-Type header on POST requests with body", async () => {
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

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(calledHeaders["Content-Type"]).toBe("application/json");
  });

  it("throws when apiKey is empty", () => {
    expect(
      () =>
        new QURLClient({
          apiKey: "",
          fetch: mockFetch({ status: 200 }),
        }),
    ).toThrow("apiKey is required");
  });

  it("retries on 429 and succeeds", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            title: "Rate Limited",
            status: 429,
            detail: "Too many requests",
            code: "rate_limited",
          },
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
          data: {
            plan: "growth",
            period_start: "2026-03-01",
            period_end: "2026-04-01",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const result = await client.getQuota();

    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws last error after exhausting retries", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            title: "Rate Limited",
            status: 429,
            detail: "Too many requests",
            code: "rate_limited",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValue(rateLimitResponse);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    try {
      await client.getQuota();
      expect.fail("Expected QURLError");
    } catch (err) {
      expect(err).toBeInstanceOf(QURLError);
      const qErr = err as QURLError;
      expect(qErr.status).toBe(429);
      expect(qErr.code).toBe("rate_limited");
    }

    // 1 initial + 2 retries = 3 attempts
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors and re-throws after exhausting retries", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    await expect(client.getQuota()).rejects.toThrow("fetch failed");
    // 1 initial + 1 retry = 2 attempts
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns quota response shape", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "growth",
          period_start: "2026-03-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
          rate_limits: {
            create_per_minute: 10,
            create_per_hour: 100,
            list_per_minute: 30,
            resolve_per_minute: 60,
            max_active_qurls: 1000,
            max_tokens_per_qurl: 5,
          },
          usage: {
            qurls_created: 42,
            active_qurls: 15,
            active_qurls_percent: 1.5,
            total_accesses: 200,
          },
        },
      },
    });

    const client = createClient(fetch);
    const quota = await client.getQuota();

    expect(quota.plan).toBe("growth");
    expect(quota.period_start).toBe("2026-03-01T00:00:00Z");
    expect(quota.period_end).toBe("2026-04-01T00:00:00Z");
    expect(quota.rate_limits).toBeDefined();
    expect(quota.rate_limits?.create_per_minute).toBe(10);
    expect(quota.rate_limits?.max_active_qurls).toBe(1000);
    expect(quota.usage).toBeDefined();
    expect(quota.usage?.qurls_created).toBe(42);
    expect(quota.usage?.active_qurls).toBe(15);
    expect(quota.usage?.total_accesses).toBe(200);
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
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      timeout: 5000,
    });

    await client.getQuota();

    const calledOptions = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(calledOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("masks API key in toJSON for keys longer than 8 chars", () => {
    const client = new QURLClient({
      apiKey: "lv_live_abcdefgh1234",
      baseUrl: "https://api.test.layerv.ai",
      fetch: mockFetch({ status: 200 }),
    });

    const json = client.toJSON();
    expect(json.apiKey).toBe("lv_l***1234");
    expect(json.baseUrl).toBe("https://api.test.layerv.ai");
  });

  it("masks API key completely in toJSON for short keys", () => {
    const client = new QURLClient({
      apiKey: "short123",
      baseUrl: "https://api.test.layerv.ai",
      fetch: mockFetch({ status: 200 }),
    });

    const json = client.toJSON();
    expect(json.apiKey).toBe("***");
  });

  it("masks API key in Node.js inspect output", () => {
    const client = new QURLClient({
      apiKey: "lv_live_abcdefgh1234",
      baseUrl: "https://api.test.layerv.ai",
      fetch: mockFetch({ status: 200 }),
    });

    const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspectFn = (client as any)[inspectSymbol] as () => string;
    const output = inspectFn.call(client);
    expect(output).toContain("lv_l***1234");
    expect(output).not.toContain("lv_live_abcdefgh1234");
  });

  it("handles non-JSON error responses", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      json: () => Promise.reject(new Error("not JSON")),
      text: () => Promise.resolve("Internal Server Error"),
    } satisfies Partial<Response> as Response);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    try {
      await client.getQuota();
      expect.fail("Expected QURLError");
    } catch (err) {
      expect(err).toBeInstanceOf(QURLError);
      const qErr = err as QURLError;
      expect(qErr.status).toBe(500);
      expect(qErr.code).toBe("unknown");
      expect(qErr.message).toContain("Internal Server Error");
    }
  });

  it("respects Retry-After header on 429 responses", async () => {
    vi.useFakeTimers();

    const retryAfterResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Retry-After": "2" }),
      json: () =>
        Promise.resolve({
          error: {
            title: "Rate Limited",
            status: 429,
            detail: "Too many requests",
            code: "rate_limited",
          },
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
          data: {
            plan: "growth",
            period_start: "2026-03-01",
            period_end: "2026-04-01",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce(successResponse);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const promise = client.getQuota();
    // Allow first fetch to resolve, but retry should not fire yet
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Advance past the 2000ms Retry-After delay
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("normalizes trailing slash in baseUrl", async () => {
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
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai/",
      fetch,
      maxRetries: 0,
    });

    await client.getQuota();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/quota",
      expect.objectContaining({ method: "GET" }),
    );
  });

  // --- Error subclass mapping ---

  it("throws AuthenticationError on 401", async () => {
    const fetch = mockFetch({
      status: 401,
      body: {
        error: {
          title: "Unauthorized",
          status: 401,
          detail: "Invalid API key",
          code: "unauthorized",
        },
      },
    });
    const client = createClient(fetch);

    await expect(client.getQuota()).rejects.toThrow(AuthenticationError);
  });

  it("throws AuthorizationError on 403", async () => {
    const fetch = mockFetch({
      status: 403,
      body: {
        error: { title: "Forbidden", status: 403, detail: "Missing scope", code: "forbidden" },
      },
    });
    const client = createClient(fetch);

    await expect(client.getQuota()).rejects.toThrow(AuthorizationError);
  });

  it("throws NotFoundError on 404", async () => {
    const fetch = mockFetch({
      status: 404,
      body: {
        error: { title: "Not Found", status: 404, detail: "QURL not found", code: "not_found" },
      },
    });
    const client = createClient(fetch);

    const err = await client.get("r_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(QURLError);
  });

  it("throws ValidationError on 400", async () => {
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: { target_url: "required" },
        },
      },
    });
    const client = createClient(fetch);

    const err = await client.create({ target_url: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).invalidFields).toEqual({ target_url: "required" });
  });

  it("throws ValidationError on 422", async () => {
    const fetch = mockFetch({
      status: 422,
      body: {
        error: { title: "Unprocessable", status: 422, detail: "Bad entity", code: "unprocessable" },
      },
    });
    const client = createClient(fetch);

    await expect(client.create({ target_url: "bad" })).rejects.toThrow(ValidationError);
  });

  it("throws RateLimitError on 429", async () => {
    const fetch = mockFetch({
      status: 429,
      headers: { "Retry-After": "5" },
      body: {
        error: {
          title: "Rate Limited",
          status: 429,
          detail: "Too many requests",
          code: "rate_limited",
        },
      },
    });
    const client = createClient(fetch);

    const err = await client.getQuota().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(5);
  });

  it("throws ServerError on 500", async () => {
    const fetch = mockFetch({
      status: 500,
      body: {
        error: {
          title: "Internal Error",
          status: 500,
          detail: "Something broke",
          code: "internal",
        },
      },
    });
    const client = createClient(fetch);

    await expect(client.getQuota()).rejects.toThrow(ServerError);
  });

  it("throws ServerError on 503", async () => {
    const fetch = mockFetch({
      status: 503,
      body: {
        error: { title: "Unavailable", status: 503, detail: "Maintenance", code: "unavailable" },
      },
    });
    const client = createClient(fetch);

    await expect(client.getQuota()).rejects.toThrow(ServerError);
  });

  // --- Network error wrapping ---

  it("wraps TypeError into NetworkError", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = createClient(fetch);

    const err = await client.getQuota().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toContain("fetch failed");
  });

  it("wraps DOMException timeout into TimeoutError", async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));
    const client = createClient(fetch);

    const err = await client.getQuota().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toContain("timed out");
  });

  // --- Mutating-safe retry ---

  it("does not retry POST on 502", async () => {
    const fetch = mockFetch({
      status: 502,
      body: {
        error: { title: "Bad Gateway", status: 502, detail: "Upstream error", code: "bad_gateway" },
      },
    });
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.create({ target_url: "https://example.com" })).rejects.toThrow(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry PATCH on 502", async () => {
    const fetch = mockFetch({
      status: 502,
      body: {
        error: { title: "Bad Gateway", status: 502, detail: "Upstream error", code: "bad_gateway" },
      },
    });
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.update("r_abc", { description: "test" })).rejects.toThrow(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries GET on 502", async () => {
    const errorResponse = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            title: "Bad Gateway",
            status: 502,
            detail: "Upstream error",
            code: "bad_gateway",
          },
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
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const result = await client.getQuota();
    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries POST on 429", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: { title: "Rate Limited", status: 429, detail: "Slow down", code: "rate_limited" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const successResponse = {
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: { resource_id: "r_new", qurl_link: "https://qurl.link/#at_new" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const result = await client.create({ target_url: "https://example.com" });
    expect(result.resource_id).toBe("r_new");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // --- listAll auto-pagination ---

  it("paginates through all pages with listAll", async () => {
    const page1 = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_1", status: "active" }],
          meta: { has_more: true, next_cursor: "cursor_abc" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const page2 = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_2", status: "active" }],
          meta: { has_more: false },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const ids: string[] = [];
    for await (const qurl of client.listAll({ status: "active" })) {
      ids.push(qurl.resource_id);
    }

    expect(ids).toEqual(["r_1", "r_2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Second call should include cursor
    const secondUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondUrl).toContain("cursor=cursor_abc");
  });

  // --- resolve string overload ---

  it("accepts a plain token string in resolve", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          target_url: "https://example.com",
          resource_id: "r_abc",
          access_grant: { expires_in: 305, granted_at: "2026-03-10T15:30:00Z", src_ip: "1.2.3.4" },
        },
      },
    });
    const client = createClient(fetch);

    await client.resolve("at_token123");

    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(JSON.parse(calledBody)).toEqual({ access_token: "at_token123" });
  });

  // --- debug logging ---

  it("calls debug callback on requests", async () => {
    const debugFn = vi.fn();
    const fetch = mockFetch({
      status: 200,
      body: {
        data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
      },
    });

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    await client.getQuota();

    expect(debugFn).toHaveBeenCalled();
    const messages = debugFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(messages.some((m: string) => m.includes("GET"))).toBe(true);
  });

  // --- error hierarchy ---

  it("all error subclasses extend QURLError", () => {
    const data = { status: 400, code: "test", title: "Test", detail: "test" };
    expect(new AuthenticationError(data)).toBeInstanceOf(QURLError);
    expect(new AuthorizationError(data)).toBeInstanceOf(QURLError);
    expect(new NotFoundError(data)).toBeInstanceOf(QURLError);
    expect(new ValidationError(data)).toBeInstanceOf(QURLError);
    expect(new RateLimitError(data)).toBeInstanceOf(QURLError);
    expect(new ServerError(data)).toBeInstanceOf(QURLError);
    expect(new NetworkError("fail")).toBeInstanceOf(QURLError);
    expect(new TimeoutError()).toBeInstanceOf(QURLError);
  });

  // --- edge cases ---

  it("listAll handles empty first page", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [],
        meta: { has_more: false },
      },
    });
    const client = createClient(fetch);

    const items: unknown[] = [];
    for await (const qurl of client.listAll()) {
      items.push(qurl);
    }

    expect(items).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("list passes all filter params simultaneously", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    await client.list({
      limit: 5,
      cursor: "cur_1",
      status: "active",
      q: "test",
      sort: "created_at",
    });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).toContain("cursor=cur_1");
    expect(calledUrl).toContain("status=active");
    expect(calledUrl).toContain("q=test");
    expect(calledUrl).toContain("sort=created_at");
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
});
