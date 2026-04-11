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
import type { BatchCreateInput, CreateInput, MintInput } from "./types.js";

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
          qurl_id: "q_3a7f2c8e91b",
          resource_id: "r_abc123def45",
          qurl_link: "https://qurl.link/#at_test",
          qurl_site: "https://r_abc123def45.qurl.site",
          expires_at: "2026-03-15T10:00:00Z",
          label: "Test create",
        },
        meta: { request_id: "req_1" },
      },
    });

    const client = createClient(fetch);
    const result = await client.create({
      target_url: "https://example.com",
      expires_in: "24h",
      label: "Test create",
    });

    expect(result.qurl_id).toBe("q_3a7f2c8e91b");
    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.qurl_link).toBe("https://qurl.link/#at_test");
    expect(result.label).toBe("Test create");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // --- Spec-derived input validation (create) ---

  it("create rejects target_url longer than 2048 chars", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({ target_url: "https://a.com/" + "x".repeat(2048) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("target_url");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("create rejects label longer than 500 chars", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({ target_url: "https://example.com", label: "x".repeat(501) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("label");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("create rejects max_sessions above 1000", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({ target_url: "https://example.com", max_sessions: 1001 })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("max_sessions");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("create accepts max_sessions at the 0 and 1000 boundaries", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { qurl_id: "q_x", resource_id: "r_x", qurl_link: "x", qurl_site: "x" } },
    });
    const client = createClient(fetch);

    await expect(
      client.create({ target_url: "https://example.com", max_sessions: 0 }),
    ).resolves.toBeDefined();
    await expect(
      client.create({ target_url: "https://example.com", max_sessions: 1000 }),
    ).resolves.toBeDefined();
  });

  it("create rejects custom_domain longer than 253 chars", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({
        target_url: "https://example.com",
        custom_domain: "a".repeat(254),
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("custom_domain");
    expect(fetch).not.toHaveBeenCalled();
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

  it("gets a QURL by q_ display ID (API resolves to parent resource)", async () => {
    // Per the spec's QurlId parameter (openapi.yaml:2254), GET /v1/qurls/:id
    // accepts both r_ and q_ prefixes. Exercise the URL-construction path
    // for a q_ ID so the dual-prefix contract is a regression guard.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc123def45",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 1,
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("q_3a7f2c8e91b");

    // API resolves q_ → parent resource, so the result shape is a resource.
    expect(result.resource_id).toBe("r_abc123def45");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/q_3a7f2c8e91b",
      expect.objectContaining({ method: "GET" }),
    );
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

  it("list with empty input hits /v1/qurls with no query string", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);
    await client.list({});

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("deletes a QURL", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.delete("r_abc123def45")).resolves.toBeUndefined();
  });

  it("delete rejects q_ (display) IDs client-side", async () => {
    // Spec: DELETE /v1/qurls/:id requires a resource ID (r_ prefix).
    // To revoke a single token, the resources-scoped endpoint must be used.
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client.delete("q_3a7f2c8e91b").catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    expect((error as ValidationError).detail).toContain("r_ prefix");
    expect(fetch).not.toHaveBeenCalled();
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

  it("update throws ValidationError when extend_by and expires_at are both set", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend throws ValidationError when extend_by and expires_at are both set (inherits from update)", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // extend() delegates to update(), so it inherits the mutual-exclusion check.
    const error = await client
      .extend("r_abc", { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink throws ValidationError when expires_in and expires_at are both set", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink("r_abc", { expires_in: "7d", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects label longer than 500 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink("r_abc", { label: "x".repeat(501) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("label");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects max_sessions above 1000", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink("r_abc", { max_sessions: 5000 })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("max_sessions");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects description longer than 500 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { description: "x".repeat(501) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("description");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects more than 10 tags", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("tags");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects tags longer than 50 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { tags: ["x".repeat(51)] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("1-50 characters");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects tags that don't match the API pattern", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // Tags must start with an alphanumeric character.
    const error = await client
      .update("r_abc", { tags: ["-leading-dash"] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("alphanumeric");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update accepts empty tags array to clear all tags", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc",
          target_url: "https://example.com",
          status: "active",
          tags: [],
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });
    const client = createClient(fetch);
    await expect(client.update("r_abc", { tags: [] })).resolves.toBeDefined();
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
          instance: "/v1/qurls/r_notfound0000",
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
      // New: RFC 7807 type + instance surfaced on the error object.
      expect(qErr.type).toBe("https://api.qurl.link/problems/not_found");
      expect(qErr.instance).toBe("/v1/qurls/r_notfound0000");
    }
  });

  it("falls back to title when error.detail is missing (RFC 7807 detail is optional)", async () => {
    // Per RFC 7807, `detail` is optional. The API's Error schema only
    // requires type/title/status/code. Verify the SDK doesn't produce
    // "Title (403): undefined" when detail is absent.
    const fetch = mockFetch({
      status: 403,
      body: {
        error: {
          type: "https://api.qurl.link/problems/forbidden",
          title: "Forbidden",
          status: 403,
          code: "forbidden",
          // no detail
        },
      },
    });

    const client = createClient(fetch);
    const err = (await client.getQuota().catch((e: unknown) => e)) as QURLError;
    expect(err).toBeInstanceOf(QURLError);
    expect(err.detail).toBe("Forbidden");
    expect(err.message).not.toContain("undefined");
  });

  it("falls back to legacy error.message field (pre-RFC-7807 envelope)", async () => {
    // Back-compat: support the older { error: { code, message } } shape.
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          message: "legacy-format detail string",
        },
      },
    });

    const client = createClient(fetch);
    const err = (await client.getQuota().catch((e: unknown) => e)) as QURLError;
    expect(err).toBeInstanceOf(QURLError);
    expect(err.detail).toBe("legacy-format detail string");
    expect(err.message).not.toContain("undefined");
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
            // New field in this PR — assert it parses through.
            max_expiry_seconds: 2592000,
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
    expect(quota.rate_limits?.max_expiry_seconds).toBe(2592000);
    expect(quota.usage).toBeDefined();
    expect(quota.usage?.qurls_created).toBe(42);
    expect(quota.usage?.active_qurls).toBe(15);
    expect(quota.usage?.active_qurls_percent).toBe(1.5);
    expect(quota.usage?.total_accesses).toBe(200);
  });

  it("handles null active_qurls_percent (unlimited plans)", async () => {
    // Quota.usage.active_qurls_percent is nullable per the API spec —
    // when max_active_qurls is unlimited there's no denominator to compute
    // a percentage, so the API returns null. Exercise that branch
    // explicitly since the happy-path test only covers the numeric case.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          plan: "enterprise",
          period_start: "2026-03-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
          rate_limits: {
            create_per_minute: 100,
            create_per_hour: 10000,
            list_per_minute: 300,
            resolve_per_minute: 600,
            max_active_qurls: -1,
            max_tokens_per_qurl: -1,
            max_expiry_seconds: 2592000,
          },
          usage: {
            qurls_created: 9999,
            active_qurls: 5000,
            active_qurls_percent: null,
            total_accesses: 50000,
          },
        },
      },
    });

    const client = createClient(fetch);
    const quota = await client.getQuota();

    expect(quota.usage?.active_qurls_percent).toBeNull();
    expect(quota.rate_limits?.max_active_qurls).toBe(-1);
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

  it("listAll handles a single non-empty page (has_more: false on page 1)", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [
          { resource_id: "r_only1", status: "active", target_url: "https://a" },
          { resource_id: "r_only2", status: "active", target_url: "https://b" },
        ],
        meta: { has_more: false },
      },
    });
    const client = createClient(fetch);

    const ids: string[] = [];
    for await (const qurl of client.listAll()) {
      ids.push(qurl.resource_id);
    }

    expect(ids).toEqual(["r_only1", "r_only2"]);
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

  it("list serializes date filter params as query string", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    await client.list({
      created_after: "2026-01-01T00:00:00Z",
      created_before: "2026-12-31T23:59:59Z",
      expires_before: "2026-06-01T00:00:00Z",
      expires_after: "2026-03-01T00:00:00Z",
    });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("created_after=2026-01-01T00%3A00%3A00Z");
    expect(calledUrl).toContain("created_before=2026-12-31T23%3A59%3A59Z");
    expect(calledUrl).toContain("expires_before=2026-06-01T00%3A00%3A00Z");
    expect(calledUrl).toContain("expires_after=2026-03-01T00%3A00%3A00Z");
  });

  it("list ignores unknown properties on the input object", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    // Simulates a caller spreading an untyped object with extra properties.
    // The allowlist in list() should drop anything that isn't a known field.
    const untypedInput = { limit: 10, rogue: "should-not-appear" } as unknown as Parameters<
      typeof client.list
    >[0];
    await client.list(untypedInput);

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("limit=10");
    expect(calledUrl).not.toContain("rogue");
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

  // --- Batch create ---

  it("throws ValidationError on empty batch create", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    // Client-side pre-flight uses ValidationError with status 0 so callers
    // that catch ValidationError get a single error class to handle.
    const error = await client
      .batchCreate({ items: [] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(0);
    expect((error as ValidationError).code).toBe("client_validation");
    expect((error as ValidationError).detail).toContain("at least 1 item");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws ValidationError when batch create exceeds 100 items", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);
    const items = Array.from({ length: 101 }, (_, i) => ({
      target_url: `https://example.com/${i}`,
    }));

    const error = await client.batchCreate({ items }).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    expect((error as ValidationError).detail).toContain("at most 100 items");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch creates QURLs successfully", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 2,
          failed: 0,
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_batch1",
              qurl_link: "https://qurl.link/#at_b1",
              qurl_site: "https://r_batch1.qurl.site",
              expires_at: "2026-04-01T00:00:00Z",
            },
            {
              index: 1,
              success: true,
              resource_id: "r_batch2",
              qurl_link: "https://qurl.link/#at_b2",
              qurl_site: "https://r_batch2.qurl.site",
              expires_at: "2026-04-01T00:00:00Z",
            },
          ],
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.batchCreate({
      items: [
        { target_url: "https://example.com/1", expires_in: "24h" },
        { target_url: "https://example.com/2", expires_in: "48h" },
      ],
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(2);
    // Narrow on the discriminant before accessing success-only fields.
    const first = result.results[0];
    const second = result.results[1];
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success) expect(first.resource_id).toBe("r_batch1");
    if (second.success) expect(second.resource_id).toBe("r_batch2");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/batch",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("batch creates QURLs with partial failure", async () => {
    const fetch = mockFetch({
      status: 207,
      body: {
        data: {
          succeeded: 1,
          failed: 1,
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_batch_ok",
              qurl_link: "https://qurl.link/#at_ok",
              qurl_site: "https://r_batch_ok.qurl.site",
              expires_at: "2026-04-01T00:00:00Z",
            },
            {
              index: 1,
              success: false,
              error: { code: "validation_error", message: "Invalid target_url" },
            },
          ],
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.batchCreate({
      items: [
        { target_url: "https://example.com/ok", expires_in: "24h" },
        { target_url: "", expires_in: "24h" },
      ],
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);

    const first = result.results[0];
    expect(first.success).toBe(true);
    // Discriminated-union narrowing: the success branch has resource_id
    if (first.success) {
      expect(first.resource_id).toBe("r_batch_ok");
    }

    const second = result.results[1];
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.code).toBe("validation_error");
      expect(second.error.message).toBe("Invalid target_url");
    }
  });

  it("batch create accepts exactly 100 items (upper boundary)", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: { succeeded: 100, failed: 0, results: [] },
      },
    });
    const client = createClient(fetch);
    const items = Array.from({ length: 100 }, (_, i) => ({
      target_url: `https://example.com/${i}`,
    }));

    await expect(client.batchCreate({ items })).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("batch create accepts exactly 1 item (lower boundary)", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_solo",
              qurl_link: "https://qurl.link/#at_solo",
              qurl_site: "https://r_solo.qurl.site",
              expires_at: "2026-04-15T00:00:00Z",
            },
          ],
        },
      },
    });
    const client = createClient(fetch);

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com/solo" }],
    });
    expect(result.succeeded).toBe(1);
    expect(result.results).toHaveLength(1);
    const only = result.results[0];
    if (only.success) {
      expect(only.resource_id).toBe("r_solo");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("batch create rejects per-item validation failures before sending", async () => {
    // Each item goes through the same validateCreateInput the single
    // create() uses, so obvious mistakes fail fast with the offending
    // index rather than round-tripping the whole batch.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .batchCreate({
        items: [
          { target_url: "https://a.example.com" },
          { target_url: "https://b.example.com", max_sessions: 9999 },
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("items[1]");
    expect((error as ValidationError).detail).toContain("max_sessions");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch create sends items array in request body", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: { succeeded: 2, failed: 0, results: [] },
      },
    });
    const client = createClient(fetch);
    const items: CreateInput[] = [
      {
        target_url: "https://app1.example.com",
        expires_in: "24h",
        label: "App 1",
        one_time_use: true,
        max_sessions: 5,
        session_duration: "1h",
        custom_domain: "app1.qurl.link",
        access_policy: {
          ip_allowlist: ["10.0.0.0/8"],
          ai_agent_policy: { block_all: true },
        },
      },
      { target_url: "https://app2.example.com", expires_in: "48h" },
    ];

    await client.batchCreate({ items });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string) as BatchCreateInput;
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual(items[0]);
    expect(body.items[0].access_policy?.ai_agent_policy?.block_all).toBe(true);
    expect(body.items[1]).toEqual(items[1]);
  });

  it("mintLink forwards the full expanded input body", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          qurl_link: "https://qurl.link/#at_minted",
          expires_at: "2026-04-02T00:00:00Z",
        },
      },
    });
    const client = createClient(fetch);

    await client.mintLink("r_abc123def45", {
      expires_in: "7d",
      label: "Alice from Acme",
      one_time_use: false,
      max_sessions: 3,
      session_duration: "1h",
      access_policy: {
        geo_allowlist: ["US", "CA"],
        ai_agent_policy: { deny_categories: ["gptbot"] },
      },
    });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(callArgs.body as string) as MintInput;
    expect(parsed.expires_in).toBe("7d");
    expect(parsed.label).toBe("Alice from Acme");
    expect(parsed.one_time_use).toBe(false);
    expect(parsed.max_sessions).toBe(3);
    expect(parsed.session_duration).toBe("1h");
    expect(parsed.access_policy?.geo_allowlist).toEqual(["US", "CA"]);
    expect(parsed.access_policy?.ai_agent_policy?.deny_categories).toEqual(["gptbot"]);
  });

  it("batch create passes through HTTP 400 with per-item errors", async () => {
    // When every batch item fails validation, the API returns 400 with a
    // structured BatchCreateOutput body. rawRequest's passthroughStatuses
    // must allow this through instead of throwing a generic ValidationError.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: {
          succeeded: 0,
          failed: 2,
          results: [
            {
              index: 0,
              success: false,
              error: {
                code: "validation_error",
                message: "items[0]: target_url must be HTTPS",
              },
            },
            {
              index: 1,
              success: false,
              error: {
                code: "validation_error",
                message: "items[1]: target_url must be HTTPS",
              },
            },
          ],
        },
        meta: { request_id: "req_allfail" },
      },
    });

    const client = createClient(fetch);
    const result = await client.batchCreate({
      items: [
        { target_url: "http://insecure1.example.com" },
        { target_url: "http://insecure2.example.com" },
      ],
    });

    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.results).toHaveLength(2);
    const first = result.results[0];
    if (!first.success) {
      expect(first.error.code).toBe("validation_error");
      expect(first.error.message).toContain("target_url must be HTTPS");
    }
  });

  it("batch create surfaces ValidationError on unexpected 400 response shape", async () => {
    // If the API ever returns HTTP 400 with a non-BatchCreateOutput body
    // (e.g., a top-level malformed-request error), batchCreate should
    // surface that as a ValidationError rather than silently returning an
    // object with undefined fields. Defense-in-depth for the 400 passthrough.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: { unexpected: "not a batch response" },
      },
    });

    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("client_validation");
    // Error message is intentionally static (no raw body embedded) to
    // avoid leaking sensitive response content into client-side logs.
    expect((error as ValidationError).detail).toBe(
      "Unexpected response shape from POST /v1/qurls/batch",
    );
  });

  it("batch create still throws on non-400 error statuses (401, 429, 5xx)", async () => {
    // 400 is explicitly whitelisted for passthrough; other error codes must
    // continue to throw the appropriate QURLError subclass. Regression guard
    // that the passthrough mechanism is surgical, not a blanket disable.
    const fetch = mockFetch({
      status: 401,
      body: {
        error: {
          status: 401,
          code: "unauthorized",
          title: "Unauthorized",
          detail: "Invalid API key",
        },
      },
    });

    const client = createClient(fetch);
    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("batch create retries on 429 (mutating retry allows rate limits)", async () => {
    // POST is mutating, so RETRYABLE_STATUS_MUTATING only contains 429.
    // Verify the batch endpoint inherits this behavior.
    const rateLimitResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            status: 429,
            code: "rate_limited",
            title: "Rate Limited",
            detail: "Slow down",
          },
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
          data: { succeeded: 1, failed: 0, results: [] },
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

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    expect(result.succeeded).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("batch create does NOT retry on 502 (POST is mutating; 5xx is not retried)", async () => {
    // RETRYABLE_STATUS_MUTATING only includes 429, not 502/503/504, so POST
    // callers must not replay batch requests on 5xx (prevents duplicate
    // item creation). Regression guard for the mutating-retry policy.
    const badGatewayResponse = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            status: 502,
            code: "bad_gateway",
            title: "Bad Gateway",
            detail: "Upstream error",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValue(badGatewayResponse);
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 3,
    });

    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1); // No retries on 5xx for POST
  });
});
