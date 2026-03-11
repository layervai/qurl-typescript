import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import { QURLError } from "./errors.js";

function mockFetch(response: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.status === 200 ? "OK" : "Error",
    headers: new Headers(response.headers ?? {}),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  } satisfies Partial<Response> as Response);
}

function createClient(fetchFn: typeof globalThis.fetch): QURLClient {
  return new QURLClient({
    apiKey: "lv_live_test",
    baseUrl: "https://api.test.layerv.ai",
    fetch: fetchFn,
    maxRetries: 0,
  });
}

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
      "https://api.test.layerv.ai/v1/qurl",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gets a QURL", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("r_abc123def45");

    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.status).toBe("active");
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

    const start = Date.now();
    const result = await client.getQuota();
    const elapsed = Date.now() - start;

    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
    // Retry-After: 2 means 2000ms delay; allow some tolerance
    expect(elapsed).toBeGreaterThanOrEqual(1500);
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
});
