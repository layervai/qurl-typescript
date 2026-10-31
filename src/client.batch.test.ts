import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  AuthenticationError,
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ServerError,
  ValidationError,
} from "./errors.js";
import type { BatchCreateInput, CreateInput } from "./types.js";
import { mockFetch, createClient } from "./__tests__/test-helpers.js";
import { UUID_V7_RE, callHeaders } from "./__tests__/client-fixtures.js";

describe("QURLClient", () => {
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
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("at least 1 item");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batchCreate rejects non-array items with structured ValidationError (untyped-JS safety)", async () => {
    // Regression guard: without the Array.isArray pre-check, an untyped
    // JS caller passing `{}` / `{ items: undefined }` / `null` would
    // hit a raw TypeError on `input.items.length`. batchCreate is the
    // new public surface — programmatic helpers building items can
    // produce undefined once and would otherwise swallow the SDK's
    // structured error contract. Match the typeof-guard pattern used
    // by the rest of the validators.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const badInput of [{}, { items: undefined }, { items: null }, { items: "nope" }, null]) {
      const error = await client
        .batchCreate(badInput as unknown as { items: CreateInput[] })
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      expect((error as ValidationError).detail).toContain("items must be an array");
    }
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
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("at most 100 items");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch creates qURLs successfully", async () => {
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

  it("batch creates qURLs with partial failure", async () => {
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
    // Both URLs are syntactically valid — the client-side checks are
    // purely "obvious mistake" guards. The second item is flagged as
    // a per-item failure by the MOCKED API response above, so this
    // test still exercises the partial-failure envelope parsing.
    const result = await client.batchCreate({
      items: [
        { target_url: "https://example.com/ok", expires_in: "24h" },
        { target_url: "https://example.com/fail", expires_in: "24h" },
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
    // results[] must have the same count as succeeded+failed now that
    // the shape guard enforces `succeeded + failed === results.length`.
    // Populate 100 minimal success entries to match `succeeded: 100`.
    const results = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      success: true,
      resource_id: `r_b${i}`,
      qurl_link: `https://qurl.link/#at_b${i}`,
      qurl_site: `https://r_b${i}.qurl.site`,
    }));
    const fetch = mockFetch({
      status: 201,
      body: {
        data: { succeeded: 100, failed: 0, results },
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

  it("batch create reports validation failure at index 0 (first-item failure)", async () => {
    // Complementary to the items[1] test above — ensures the loop
    // correctly attributes failures at index 0 too, not just
    // later indices. Regression guard against a refactor that might
    // accidentally skip the first item or off-by-one the index.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .batchCreate({
        items: [
          { target_url: "https://bad.example.com", max_sessions: 9999 },
          { target_url: "https://good.example.com" },
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("items[0]");
    expect((error as ValidationError).detail).toContain("max_sessions");
    // items[1] is well-formed so it shouldn't appear in the error at
    // all (the collect-all change in this round only reports items
    // that actually failed validation).
    expect((error as ValidationError).detail).not.toContain("items[1]");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch create collects ALL per-item validation errors in one throw", async () => {
    // Fail-fast used to surface the first bad item only; callers had to
    // fix-re-run-repeat. The new behavior collects every per-item
    // validation failure into one ValidationError so callers see the
    // full picture in one pass. Lock this UX in — a refactor that
    // reverts to fail-fast would trip this test.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .batchCreate({
        items: [
          { target_url: "https://a.example.com", max_sessions: 9999 }, // bad
          { target_url: "https://b.example.com" }, // good
          { target_url: "not-a-url" }, // bad (missing scheme)
          { target_url: "https://d.example.com", label: "x".repeat(501) }, // bad
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = (error as ValidationError).detail;
    // All three bad items must appear in the error message.
    expect(detail).toContain("items[0]");
    expect(detail).toContain("items[2]");
    expect(detail).toContain("items[3]");
    // The good item must NOT appear.
    expect(detail).not.toContain("items[1]");
    // Each per-item problem is spelled out.
    expect(detail).toContain("max_sessions");
    expect(detail).toContain("http:// or https://");
    expect(detail).toContain("label");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch create propagates server request_id into the returned output", async () => {
    // Consumers filing support tickets on partial or total batch
    // failures need the correlation ID. The 400 passthrough previously
    // discarded `meta.request_id`; locks in that it flows through to
    // BatchCreateOutput.
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
              resource_id: "r_req_id_test",
              qurl_link: "https://qurl.link/#at_req",
              qurl_site: "https://r_req_id_test.qurl.site",
            },
          ],
        },
        meta: { request_id: "req_batch_abc123" },
      },
    });
    const client = createClient(fetch);

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    expect(result.request_id).toBe("req_batch_abc123");
  });

  it("batch create propagates request_id from the 400-passthrough path", async () => {
    // Same request_id propagation on the 400 partial/total-failure
    // branch — this is the most load-bearing case for support flows.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: {
          succeeded: 0,
          failed: 1,
          results: [
            {
              index: 0,
              success: false,
              error: { code: "validation_error", message: "target_url must be HTTPS" },
            },
          ],
        },
        meta: { request_id: "req_batch_400_xyz" },
      },
    });
    const client = createClient(fetch);

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    expect(result.failed).toBe(1);
    expect(result.request_id).toBe("req_batch_400_xyz");
  });

  it("batch create logs when request_id appears on BOTH data and meta with different values", async () => {
    // Meta wins (canonical source per the type), but the divergence
    // must be observable for operators chasing envelope-shape bugs.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          request_id: "req_data_side",
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_x",
              qurl_link: "https://qurl.link/#at_x",
              qurl_site: "https://r_x.qurl.site",
            },
          ],
        },
        meta: { request_id: "req_meta_side" },
      },
    });
    const debugMessages: string[] = [];
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      debug: (msg) => {
        debugMessages.push(msg);
      },
    });

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    // Meta wins.
    expect(result.request_id).toBe("req_meta_side");
    expect(debugMessages.some((m) => m.includes("BOTH data and meta"))).toBe(true);
  });

  it("batch create throws unexpected_response when an entry's index is out of range", async () => {
    // Server contract violation: `index` must be in [0, items.length).
    // A buggy proxy could attribute to a non-existent slot otherwise.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [
            {
              index: 999,
              success: true,
              resource_id: "r_x",
              qurl_link: "https://qurl.link/#at_x",
              qurl_site: "https://r_x.qurl.site",
            },
          ],
        },
        meta: { request_id: "req_oor" },
      },
    });
    const client = createClient(fetch);

    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).detail).toContain("index out of range");
    expect((error as ValidationError).requestId).toBe("req_oor");
  });

  it("batch create throws unexpected_response when entries have duplicate index values", async () => {
    // Per-item attribution silently breaks under duplicates. Fail closed.
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
              resource_id: "r_a",
              qurl_link: "https://qurl.link/#at_a",
              qurl_site: "https://r_a.qurl.site",
            },
            {
              index: 0,
              success: true,
              resource_id: "r_b",
              qurl_link: "https://qurl.link/#at_b",
              qurl_site: "https://r_b.qurl.site",
            },
          ],
        },
        meta: { request_id: "req_dup" },
      },
    });
    const client = createClient(fetch);

    const error = await client
      .batchCreate({
        items: [{ target_url: "https://a.example.com" }, { target_url: "https://b.example.com" }],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).detail).toContain("duplicate index");
    expect((error as ValidationError).requestId).toBe("req_dup");
  });

  it("batch create logs when request_id appears on data only (meta absent)", async () => {
    // Data-side value passes through; debug log surfaces the divergence.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          request_id: "req_data_only_abc",
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_data_only",
              qurl_link: "https://qurl.link/#at_x",
              qurl_site: "https://r_data_only.qurl.site",
            },
          ],
        },
      },
    });
    const debugMessages: string[] = [];
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      debug: (msg) => {
        debugMessages.push(msg);
      },
    });

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    // Data-side value preserved (no over-eager strip).
    expect((result as { request_id?: unknown }).request_id).toBe("req_data_only_abc");
    expect(debugMessages.some((m) => m.includes("request_id on data only"))).toBe(true);
  });

  it("batch create omits request_id when the server doesn't provide one", async () => {
    // Optional field — older API versions or non-JSON edge responses
    // may omit `meta.request_id`. The returned output should simply
    // not set the field rather than crashing or using a placeholder.
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
              resource_id: "r_no_req",
              qurl_link: "https://qurl.link/#at_x",
              qurl_site: "https://r_no_req.qurl.site",
            },
          ],
        },
        // no meta
      },
    });
    const client = createClient(fetch);

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    expect(result.request_id).toBeUndefined();
  });

  it("batch create sends items array in request body", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 2,
          failed: 0,
          // results[] matches the counts per the arithmetic invariant
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_app1",
              qurl_link: "https://qurl.link/#at_app1",
              qurl_site: "https://r_app1.qurl.site",
            },
            {
              index: 1,
              success: true,
              resource_id: "r_app2",
              qurl_link: "https://qurl.link/#at_app2",
              qurl_site: "https://r_app2.qurl.site",
            },
          ],
        },
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

  it("batch create attributes failure to the correct item with nested access_policy", async () => {
    // Regression guard for the reviewer-noted gap: a batch item with a
    // fully-populated AccessPolicy + nested AIAgentPolicy must
    //   1. serialize its nested policy through to the wire body (the
    //      client-side pre-flight passes access_policy through untouched
    //      rather than validating it — that's the server's job), AND
    //   2. have its per-item error correctly attributed to the right
    //      index when the server rejects the item in a 400 passthrough.
    // Previously we had tests for (1) via serialization coverage and
    // (2) via the generic 400 passthrough, but nothing exercised both
    // in the same call path.
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
              resource_id: "r_ok_policy",
              qurl_link: "https://qurl.link/#at_ok",
              qurl_site: "https://r_ok_policy.qurl.site",
            },
            {
              index: 1,
              success: false,
              error: {
                code: "invalid_ai_agent_policy",
                message: "items[1]: ai_agent_policy.allow_categories[0] must be a known category",
              },
            },
          ],
        },
        meta: { request_id: "req_mixed_policy" },
      },
    });

    const client = createClient(fetch);
    const result = await client.batchCreate({
      items: [
        {
          target_url: "https://good.example.com",
          access_policy: {
            ai_agent_policy: {
              allow_categories: ["claude", "chatgpt"],
            },
          },
        },
        {
          target_url: "https://bad.example.com",
          access_policy: {
            ai_agent_policy: {
              // Nonsense category — server will reject
              allow_categories: ["this-is-not-a-real-category"],
            },
          },
        },
      ],
    });

    // 2: failure is attributed to the correct index, and error fields
    // are populated as the discriminated union promises.
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const bad = result.results[1];
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.index).toBe(1);
      expect(bad.error.code).toBe("invalid_ai_agent_policy");
      expect(bad.error.message).toContain("ai_agent_policy.allow_categories");
    }

    // 1: the nested AccessPolicy serialized through to the wire body
    // on BOTH items — locks in that client-side pre-flight doesn't
    // mangle or strip complex policy structures.
    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].access_policy.ai_agent_policy.allow_categories).toEqual([
      "claude",
      "chatgpt",
    ]);
    expect(parsed.items[1].access_policy.ai_agent_policy.allow_categories).toEqual([
      "this-is-not-a-real-category",
    ]);

    // request_id from meta still propagates through the mixed-result path.
    expect(result.request_id).toBe("req_mixed_policy");
  });

  it("batch create handles HTTP 207 Multi-Status for mixed results", async () => {
    // Per the OpenAPI spec, mixed success/failure batches return 207
    // instead of 201. `response.ok` covers the entire 200-299 range
    // (including 207), so the generic success path handles it without
    // needing an explicit passthrough — this test locks that contract
    // in against a refactor that might accidentally restrict `ok`
    // handling to only 2xx-minus-207.
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
              resource_id: "r_ok207",
              qurl_link: "https://qurl.link/#at_ok207",
              qurl_site: "https://r_ok207.qurl.site",
              expires_at: "2026-04-02T00:00:00Z",
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
        meta: { request_id: "req_mixed207" },
      },
    });

    const client = createClient(fetch);
    const result = await client.batchCreate({
      items: [
        { target_url: "https://good.example.com" },
        { target_url: "https://bad.example.com" },
      ],
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(2);

    // Discriminated-union narrowing for the success branch.
    const ok = result.results[0];
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.resource_id).toBe("r_ok207");
      expect(ok.qurl_link).toBe("https://qurl.link/#at_ok207");
      expect(ok.expires_at).toBe("2026-04-02T00:00:00Z");
    }

    // And the failure branch.
    const bad = result.results[1];
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.code).toBe("validation_error");
      expect(bad.error.message).toContain("must be HTTPS");
    }

    // request_id from meta still propagates on the 207 path.
    expect(result.request_id).toBe("req_mixed207");
  });

  it("batch create propagates request_id to shape-guard ValidationError", async () => {
    // Operators debugging "unexpected response" tickets need the
    // server-side correlation ID on the *error* path too — not just
    // on the success/passthrough returns. Locks in that
    // unexpectedResponseError carries `meta.request_id` through to
    // QURLError.requestId.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: { unexpected: "not a batch response" },
        meta: { request_id: "req_shape_guard_correlation" },
      },
    });

    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).requestId).toBe("req_shape_guard_correlation");
    // request_id also lands in the message string itself so a stack
    // trace pasted into a support ticket carries the correlation
    // handle without a follow-up round-trip.
    expect((error as ValidationError).detail).toContain("[request_id=req_shape_guard_correlation]");
  });

  it("drops batch shape-guard request IDs that cannot be preserved exactly", async () => {
    const requestId = `${"€".repeat(300)}\n\u202Esecret-tail`;
    const fetch = mockFetch({
      status: 400,
      body: {
        data: { unexpected: "not a batch response" },
        meta: { request_id: requestId },
      },
    });

    const error = await createClient(fetch)
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.requestId).toBeUndefined();
    expect(error.detail).not.toContain("[request_id=");
  });

  it("batch create shape-guard error has undefined requestId when meta is absent", async () => {
    // Inverse of the propagation test above: a 400 passthrough with
    // no `meta` envelope at all (just `{ data: <bad shape> }`) must
    // surface a ValidationError with `.requestId === undefined`,
    // and the detail must NOT contain a `[request_id=...]` suffix.
    // We don't fabricate correlation IDs.
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
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).requestId).toBeUndefined();
    expect((error as ValidationError).detail).not.toContain("[request_id=");
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
    // Distinct from `client_validation` — the shape guard uses its own
    // code so callers can branch on "server returned bad data" vs.
    // "I passed bad input locally."
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    // Error detail includes the HTTP status for diagnostics so
    // operators can distinguish "400 with non-batch body" (proxy/
    // gateway error envelope) from "201/207 with malformed success
    // body" (API schema drift). The detail still intentionally omits
    // raw body content to avoid leaking sensitive data into logs.
    expect((error as ValidationError).detail).toBe(
      "Unexpected response shape from POST /v1/qurls/batch (HTTP 400)",
    );
  });

  it("batch create shape-guard error includes HTTP 201 in detail for success-path malformation", async () => {
    // Complementary to the 400 test above — locks in that a
    // success-status response with a malformed body surfaces the
    // 201 in the error detail, distinct from the 400 case. This is
    // the "API schema drift on the happy path" scenario where a
    // future server change might return 201 with a body that no
    // longer matches BatchCreateOutput. Operators need to see HTTP
    // 201 in the error to distinguish this from the proxy-error
    // 400 case.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: { wrong: "shape", not_a_batch_output: true },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).detail).toBe(
      "Unexpected response shape from POST /v1/qurls/batch (HTTP 201)",
    );
  });

  it("batch create per-entry shape-guard error includes HTTP status", async () => {
    // The per-entry shape guard (for entries missing required
    // non-optional fields) must also include the HTTP status in the
    // error detail. A 207 response with a per-entry defect is
    // distinct from a 400 with the same defect — different
    // root-cause branches for operators.
    const fetch = mockFetch({
      status: 207,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [
            // Missing resource_id / qurl_link / qurl_site
            { index: 0, success: true },
          ],
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    const detail = (error as ValidationError).detail;
    expect(detail).toContain("(HTTP 207)");
    expect(detail).toContain("results[0]");
    expect(detail).toContain("resource_id");
  });

  it("batch create per-entry shape guard reports the FIRST invalid index in a mixed result set", async () => {
    // Coverage gap: previous tests exercise one bad entry per response.
    // This locks in the contract that with multiple bad entries
    // interleaved among valid ones, the shape guard reports the
    // *first* invalid index (which is what the per-entry loop does
    // — it throws on the first reason !== null). Operators relying on
    // "the index in the error message points at the entry to debug
    // first" need this to stay stable.
    const fetch = mockFetch({
      status: 207,
      body: {
        data: {
          succeeded: 2,
          failed: 1,
          results: [
            // index 0: valid success
            {
              index: 0,
              success: true,
              resource_id: "r_first",
              qurl_link: "https://qurl.link/#at_a",
              qurl_site: "https://r_first.qurl.site",
            },
            // index 1: INVALID — success branch missing qurl_link
            { index: 1, success: true, resource_id: "r_second", qurl_site: "https://x.qurl.site" },
            // index 2: INVALID (also) — would be reported if loop kept going
            { index: 2, success: false, error: { code: "x" /* missing message */ } },
          ],
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({
        items: [
          { target_url: "https://a.com" },
          { target_url: "https://b.com" },
          { target_url: "https://c.com" },
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    const detail = (error as ValidationError).detail;
    // First-bad-index reporting: results[1] is the first failure.
    expect(detail).toContain("results[1]");
    expect(detail).toContain("qurl_link");
    // Must NOT report the later bad index — the loop short-circuits.
    expect(detail).not.toContain("results[2]");
  });

  it("batch create distinguishes client_validation from unexpected_response", async () => {
    // Regression guard for the two distinct codes: a client-side
    // preflight failure (bad target_url) must surface as
    // `client_validation`, while a server response shape mismatch
    // must surface as `unexpected_response`. Locks in the
    // discriminability the reviewer requested.
    const client = createClient(
      mockFetch({
        status: 201,
        body: { data: { succeeded: 1, failed: 0, results: [] } },
      }),
    );

    // Client-side preflight failure (bad scheme) → client_validation
    const clientSide = await client
      .batchCreate({ items: [{ target_url: "not-a-url" }] })
      .catch((e: unknown) => e as ValidationError);
    expect((clientSide as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);

    // Server response shape mismatch → unexpected_response
    const fetchBadShape = mockFetch({
      status: 201,
      body: { data: { wrong: "shape" } },
    });
    const serverSide = await createClient(fetchBadShape)
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect((serverSide as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
  });

  it("batch create surfaces clean QURLError when 400 passthrough body is non-JSON", async () => {
    // Regression guard for the passthrough JSON-parse hardening.
    // A proxy/CDN/WAF (Cloudflare, ALB, nginx) returning HTTP 400
    // with an HTML error page, a truncated body, or a plaintext
    // gateway error previously caused `response.json()` inside
    // `rawRequest`'s passthrough path to throw an untyped
    // `SyntaxError` that bypassed BOTH `validateBatchCreateResponse`
    // AND the structured error parser. Now it surfaces as a clean
    // `QURLError` (via createError → ValidationError for
    // `unexpected_response`) so callers catching by-class get a
    // typed error and operators see the HTTP status in the detail.
    //
    // Mirrors qurl-python's
    // `test_batch_create_falls_through_to_parse_error_on_non_json_body`
    // regression test (PR #8 commit 73ada8a).
    const nonJsonFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: new Headers({ "content-type": "text/html" }),
      // Cloudflare-style HTML error page — valid body, NOT valid JSON.
      json: () =>
        Promise.reject(new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON")),
      text: () => Promise.resolve("<html><body><h1>400 Bad Request</h1></body></html>"),
    } satisfies Partial<Response> as Response);

    const client = createClient(nonJsonFetch as typeof globalThis.fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);

    // Typed as ValidationError (createError maps code
    // "unexpected_response" to ValidationError).
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as ValidationError).status).toBe(400);
    // Detail mentions non-JSON so operators can distinguish this from
    // a structured bad-shape body (which produces a different message).
    expect((error as ValidationError).detail).toContain("non-JSON");
    expect((error as ValidationError).detail).toContain("HTTP 400");
    // Raw HTML body is NOT echoed — information leak prevention.
    expect((error as ValidationError).detail).not.toContain("<html>");
    expect((error as ValidationError).detail).not.toContain("400 Bad Request");
  });

  it("batch create rejects success entries missing resource_id", async () => {
    // Per-entry shape guard: BatchItemSuccess has resource_id as a
    // non-optional string. An API response with {success: true} but
    // no resource_id would land as `undefined` on a field typed as
    // `string` — break the type contract loudly rather than silently.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [
            // Missing resource_id/qurl_link/qurl_site
            { index: 0, success: true, expires_at: "2026-04-01T00:00:00Z" },
          ],
        },
      },
    });
    const client = createClient(fetch);
    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("batch create shape-guard errors include entry index + field context", async () => {
    // The shape guard used to throw a single static message for every
    // failure mode. Now it reports the offending entry index and the
    // specific field — entry VALUES are never echoed (info-leak
    // policy), only field NAMES. Callers debugging a bad API response
    // can pinpoint which entry and which field tripped the guard.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 2,
          failed: 0,
          results: [
            // Good entry
            {
              index: 0,
              success: true,
              resource_id: "r_ok",
              qurl_link: "https://qurl.link/#ok",
              qurl_site: "https://r_ok.qurl.site",
            },
            // Bad entry: missing qurl_link
            {
              index: 1,
              success: true,
              resource_id: "r_bad",
              qurl_site: "https://r_bad.qurl.site",
            },
          ],
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({
        items: [{ target_url: "https://a.com" }, { target_url: "https://b.com" }],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    const detail = (error as ValidationError).detail;
    // Must identify the bad entry by index.
    expect(detail).toContain("results[1]");
    // Must name the missing field.
    expect(detail).toContain("qurl_link");
    // Must NOT echo entry values — only field names and shape
    // descriptors. The info-leak policy stays intact.
    expect(detail).not.toContain("r_bad");
    expect(detail).not.toContain("qurl.site");
  });

  it("batch create shape-guard error names the missing discriminant field", async () => {
    // A different failure mode: entry lacks a `success` boolean
    // entirely. The error should name 'success' specifically rather
    // than the generic "not an object" message.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [{ index: 0, resource_id: "r_x" }], // no `success`
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("results[0]");
    expect((error as ValidationError).detail).toContain("success");
  });

  it("batch create rejects failure entries missing error object", async () => {
    // Per-entry shape guard: BatchItemFailure has error.code /
    // error.message as non-optional strings. Missing them would
    // land the caller in undefined-property territory on the failure
    // branch — trip the guard instead.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: {
          succeeded: 0,
          failed: 1,
          results: [
            // Missing error object entirely
            { index: 0, success: false },
          ],
        },
      },
    });
    const client = createClient(fetch);
    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("batch create rejects failure entries with malformed error object", async () => {
    // The error object must carry string code/message — a truthy
    // non-object or an object missing either field fails the guard.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: {
          succeeded: 0,
          failed: 1,
          results: [{ index: 0, success: false, error: { code: "validation" } }], // missing message
        },
      },
    });
    const client = createClient(fetch);
    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("batch create rejects entries missing the success discriminant", async () => {
    // An entry without a boolean `success` fails the guard entirely
    // — locks in the original (pre-tightening) discriminant check.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          succeeded: 1,
          failed: 0,
          results: [{ index: 0, resource_id: "r_x" }], // no `success`
        },
      },
    });
    const client = createClient(fetch);
    await expect(
      client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("batch create rejects responses with counts/results length mismatch", async () => {
    // Arithmetic invariant: succeeded + failed must equal results.length.
    // This catches the edge case where a proxy or CDN returns a body that
    // *happens* to have `succeeded`/`failed`/`results` fields but with
    // inconsistent counts (e.g. a generic error counter from a gateway).
    // Without this check, the shape guard would pass and the consumer
    // would get garbage data. Mirrors the qurl-python SDK regression test
    // `test_batch_create_rejects_counts_arithmetic_mismatch`.
    const fetch = mockFetch({
      status: 400,
      body: {
        data: {
          succeeded: 5, // claims 5 succeeded
          failed: 0,
          // …but only 1 entry in results
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_only1",
              qurl_link: "https://qurl.link/#at_x",
              qurl_site: "https://r_only1.qurl.site",
            },
          ],
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({ items: [{ target_url: "https://example.com" }] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    const detail = (error as ValidationError).detail;
    // Error message should name the specific inconsistency so
    // operators can debug — "counts/results length mismatch" plus
    // the actual numbers.
    expect(detail).toContain("counts/results length mismatch");
    expect(detail).toContain("succeeded=5");
    expect(detail).toContain("failed=0");
    expect(detail).toContain("results.length=1");
    // Still carries the HTTP status suffix from the previous round's fix.
    expect(detail).toContain("(HTTP 400)");
  });

  it("batch create rejects responses where results.length does not match request item count", async () => {
    // Per OpenAPI contract: one result per input item. A server that drops
    // an item (e.g. 3 sent → 2 returned with succeeded=1, failed=1) passes
    // the arithmetic invariant AND every per-entry check, but the consumer
    // keying by `r.index` would silently lose the dropped item. This guard
    // closes that gap.
    const fetch = mockFetch({
      status: 207,
      body: {
        data: {
          succeeded: 1,
          failed: 1,
          // results.length === 2 but we sent 3 items
          results: [
            {
              index: 0,
              success: true,
              resource_id: "r_a",
              qurl_link: "https://qurl.link/#at_a",
              qurl_site: "https://r_a.qurl.site",
            },
            {
              index: 2,
              success: false,
              error: {
                status: 400,
                code: "validation_error",
                title: "Invalid",
                detail: "x",
              },
            },
          ],
        },
      },
    });
    const client = createClient(fetch);
    const error = await client
      .batchCreate({
        items: [
          { target_url: "https://a.example.com" },
          { target_url: "https://b.example.com" },
          { target_url: "https://c.example.com" },
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    const detail = (error as ValidationError).detail;
    expect(detail).toContain("results.length (2) does not match request item count (3)");
    expect(detail).toContain("(HTTP 207)");
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

  it("batch create retries on 429 with the same Idempotency-Key", async () => {
    // POST requests carry Idempotency-Key, so retry attempts should
    // deduplicate server-side instead of creating a second batch.
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
          data: {
            succeeded: 1,
            failed: 0,
            // results[] matches the counts per the arithmetic invariant.
            results: [
              {
                index: 0,
                success: true,
                resource_id: "r_rl1",
                qurl_link: "https://qurl.link/#at_rl1",
                qurl_site: "https://r_rl1.qurl.site",
              },
            ],
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });
    expect(result.succeeded).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstKey = callHeaders(fetch, 0)["Idempotency-Key"];
    const secondKey = callHeaders(fetch, 1)["Idempotency-Key"];
    expect(firstKey).toMatch(UUID_V7_RE);
    expect(secondKey).toBe(firstKey);
  });

  it("batch create reuses Idempotency-Key across network-error retries", async () => {
    const successResponse = {
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: {
            succeeded: 1,
            failed: 0,
            results: [
              {
                index: 0,
                success: true,
                resource_id: "r_batch_retry",
                qurl_link: "https://qurl.link/#at_batch_retry",
                qurl_site: "https://r_batch_retry.qurl.site",
              },
            ],
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

    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com" }],
    });

    expect(result.succeeded).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstKey = callHeaders(fetch, 0)["Idempotency-Key"];
    const secondKey = callHeaders(fetch, 1)["Idempotency-Key"];
    expect(firstKey).toMatch(UUID_V7_RE);
    expect(secondKey).toBe(firstKey);
  });

  it("batch create 400 passthrough works after a 429 retry boundary", async () => {
    // Edge case: first attempt returns 429 (retry-eligible for POST),
    // retry gets 400 with a populated
    // BatchCreateOutput body (per-item errors). The 400 passthrough
    // logic must work ACROSS retry boundaries, not just on a clean
    // first attempt — otherwise a 429 → 400 sequence would mis-route
    // the 400 through the error path and the caller would lose the
    // per-item errors.
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

    const passthroughResponse = {
      // 400 with a populated BatchCreateOutput body — the shape guard
      // should surface this as a normal return value (not an error)
      // because 400 is in BATCH_PASSTHROUGH_STATUSES.
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
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
          meta: { request_id: "req_retry_passthrough" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(passthroughResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    // Should return the BatchCreateOutput (passthrough), NOT throw.
    // If the retry path mis-routed the 400 to the error branch,
    // this would reject with a ValidationError and the test would
    // fail — so the happy-path resolution is the load-bearing
    // assertion.
    const result = await client.batchCreate({
      items: [{ target_url: "https://example.com/a" }, { target_url: "https://example.com/b" }],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.request_id).toBe("req_retry_passthrough");
    // Per-item errors come through with correct attribution.
    const first = result.results[0];
    expect(first.success).toBe(false);
    if (!first.success) {
      expect(first.error.code).toBe("validation_error");
    }
  });

  it("batch create does NOT retry POST on 5xx but still sends Idempotency-Key", async () => {
    // POST status-code retries stay 429-only; network errors are the
    // retry path protected by Idempotency-Key for batch creates.
    const cases = [
      { status: 502, code: "bad_gateway", title: "Bad Gateway" },
      { status: 503, code: "service_unavailable", title: "Service Unavailable" },
      { status: 504, code: "gateway_timeout", title: "Gateway Timeout" },
    ] as const;
    for (const c of cases) {
      const errorResponse = {
        ok: false,
        status: c.status,
        statusText: c.title,
        headers: new Headers({}),
        json: () =>
          Promise.resolve({
            error: { status: c.status, code: c.code, title: c.title, detail: "x" },
          }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response> as Response;

      const fetch = vi.fn().mockResolvedValue(errorResponse);
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 3,
      });

      await expect(
        client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
      ).rejects.toBeInstanceOf(ServerError);
      expect(fetch, `status ${c.status}`).toHaveBeenCalledTimes(1);
      expect(callHeaders(fetch)["Idempotency-Key"], `status ${c.status}`).toMatch(UUID_V7_RE);
    }
  });
});
