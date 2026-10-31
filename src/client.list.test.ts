import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ServerError,
  ValidationError,
} from "./errors.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";
import { RESOURCE_CRID } from "./__tests__/client-fixtures.js";

describe("QURLClient", () => {
  it("lists qURLs", async () => {
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

  it("list items with qurls field map to access_tokens (defensive)", async () => {
    // The list response is documented as a flat list of QURL resources
    // with no nested tokens, but client.list() defensively threads each
    // item through mapQurlsField in case the API ever surfaces nested
    // tokens on list items (e.g. embedded summaries). Locks in that
    // the rename happens consistently on the list path too.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [
          {
            resource_id: "r_with_tokens",
            target_url: "https://example.com",
            status: "active",
            created_at: "2026-03-10T10:00:00Z",
            qurls: [
              {
                qurl_id: "q_embedded",
                status: "active",
                one_time_use: false,
                max_sessions: 5,
                session_duration: 3600,
                use_count: 0,
                created_at: "2026-03-10T10:00:00Z",
                expires_at: "2026-04-10T10:00:00Z",
              },
            ],
          },
        ],
        meta: { has_more: false },
      },
    });

    const client = createClient(fetch);
    const result = await client.list();

    expect(result.qurls).toHaveLength(1);
    expect(result.qurls[0].access_tokens).toHaveLength(1);
    expect(result.qurls[0].access_tokens![0].qurl_id).toBe("q_embedded");
    // Wire-format key stripped from each item.
    expect((result.qurls[0] as unknown as { qurls?: unknown }).qurls).toBeUndefined();
  });

  it("list rejects limit: 0 below the spec's minimum", async () => {
    // Per OpenAPI (`GET /v1/qurls` → `limit: minimum: 1, maximum: 100`),
    // `limit` must be in [1, 100]. Client-side validation catches this
    // before a round-trip, matching the style used for other spec-
    // defined bounds (max_sessions, tag count, URL length).
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    const error = await client.list({ limit: 0 }).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("list: limit:");
    expect((error as ValidationError).detail).toContain("1 and 100");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list rejects limit: 101 above the spec's maximum", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    const error = await client.list({ limit: 101 }).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("1 and 100");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list rejects negative limit", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    const error = await client.list({ limit: -5 }).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("1 and 100");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list rejects non-integer limit (e.g. 2.5)", async () => {
    // Floats pass TypeScript's `number` type but violate the spec's
    // `type: integer`. The server would likely reject or coerce, but
    // we catch it client-side for a cleaner error.
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    const error = await client.list({ limit: 2.5 }).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("integer");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list accepts limit at the boundaries (1 and 100)", async () => {
    // Boundary regression guard — make sure the validation is
    // inclusive on both ends. A future refactor using a strict `< 100`
    // or `> 1` would silently shift the boundary.
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    await expect(client.list({ limit: 1 })).resolves.toBeDefined();
    await expect(client.list({ limit: 100 })).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("list allows omitted limit to use the server default", async () => {
    // Omitting `limit` entirely lets the server apply its default
    // (currently 20 per the OpenAPI spec). The validation must not
    // trip on `undefined`.
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);
    await expect(client.list({})).resolves.toBeDefined();
    // `limit` must NOT appear in the query string when omitted.
    const [url] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).not.toContain("limit=");
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

  it("listResources builds allowed query params and flattens pagination metadata", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [{ resource_id: "r_abc123def45" }],
        meta: {
          request_id: "req_x",
          page_size: 1,
          has_more: true,
          next_cursor: "cursor_2",
        },
      },
    });
    const client = createClient(fetch);

    const result = await client.listResources({
      limit: 1,
      cursor: "cursor_1",
      alias: "dev-dashboard",
      status: "active",
      type: "url",
    });

    expect(result.resources).toHaveLength(1);
    expect(result.next_cursor).toBe("cursor_2");
    expect(result.has_more).toBe(true);
    expect(result.request_id).toBe("req_x");
    expect(result.page_size).toBe(1);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("/v1/resources?");
    expect(url).toContain("limit=1");
    expect(url).toContain("cursor=cursor_1");
    expect(url).toContain("alias=dev-dashboard");
    expect(url).toContain("status=active");
    expect(url).toContain("type=url");
  });

  it("listResources infers has_more when the API returns next_cursor without a flag", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [{ resource_id: "r_abc123def45" }],
        meta: { next_cursor: "cursor_2" },
      },
    });
    const client = createClient(fetch);

    const result = await client.listResources();

    expect(result.next_cursor).toBe("cursor_2");
    expect(result.has_more).toBe(true);
  });

  it("list infers has_more when the API returns next_cursor without a flag", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [{ resource_id: "r_abc123def45" }],
        meta: { next_cursor: "cursor_2" },
      },
    });
    const client = createClient(fetch);

    const result = await client.list();

    expect(result.next_cursor).toBe("cursor_2");
    expect(result.has_more).toBe(true);
  });

  it.each([
    ["listConnectorInstallations", (client: QURLClient) => client.listConnectorInstallations()],
    ["listDomains", (client: QURLClient) => client.listDomains()],
    ["listWebhooks", (client: QURLClient) => client.listWebhooks()],
    ["listWebhookDeliveries", (client: QURLClient) => client.listWebhookDeliveries("wh_x")],
    ["listApiKeys", (client: QURLClient) => client.listApiKeys()],
  ])("%s infers has_more from next_cursor", async (_, call) => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { next_cursor: "cursor_2" } },
    });
    const client = createClient(fetch);

    const result = await call(client);

    expect(result.next_cursor).toBe("cursor_2");
    expect(result.has_more).toBe(true);
  });

  it("new list endpoints share limit and cursor type validation", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);

    const badLimit = await client
      .listResources({ limit: 0 })
      .catch((e: unknown) => e as ValidationError);
    expect(badLimit).toBeInstanceOf(ValidationError);
    expect(badLimit.detail).toContain("listResources: limit:");
    expect(badLimit.detail).toContain("1 and 100");

    const stringLimit = await client
      .listResources({ limit: "50" as unknown as number })
      .catch((e: unknown) => e as ValidationError);
    expect(stringLimit).toBeInstanceOf(ValidationError);
    expect(stringLimit.detail).toContain("listResources: limit:");
    expect(stringLimit.detail).toContain('"50"');

    const badCursor = await client
      .listDomains({ cursor: 42 as unknown as string })
      .catch((e: unknown) => e as ValidationError);
    expect(badCursor).toBeInstanceOf(ValidationError);
    expect(badCursor.detail).toContain("listDomains: cursor: must be a string");

    const arrayCursor = await client
      .listDomains({ cursor: [] as unknown as string })
      .catch((e: unknown) => e as ValidationError);
    expect(arrayCursor).toBeInstanceOf(ValidationError);
    expect(arrayCursor.detail).toContain("listDomains: cursor: must be a string (got array)");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("listAll wrappers validate ids and query params before iteration", () => {
    const fetch = mockFetch({ status: 200, body: { data: [], meta: {} } });
    const client = createClient(fetch);

    expect(() => client.listAllResources({ limit: 0 })).toThrow(ValidationError);
    expect(() => client.listAllWebhookDeliveries("", { limit: 10 })).toThrow(ValidationError);
    expect(() =>
      client.listAllApiKeys({
        limit: "50" as unknown as number,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      client.listAllResources({
        rogue: "should-fail",
      } as unknown as Parameters<typeof client.listAllResources>[0]),
    ).toThrow(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("listAllResources paginates and threads filters across pages", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page1" }],
          meta: { has_more: true, next_cursor: "cursor_2" },
        },
      },
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page2" }],
          meta: { has_more: false },
        },
      },
    ]);
    const client = createClient(fetch);

    const seen: string[] = [];
    for await (const resource of client.listAllResources({ limit: 10, status: "active" })) {
      seen.push(resource.resource_id);
    }

    expect(seen).toEqual(["r_page1", "r_page2"]);
    const firstUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    const secondUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(firstUrl).toContain("limit=10");
    expect(firstUrl).toContain("status=active");
    expect(firstUrl).not.toContain("cursor=");
    expect(secondUrl).toContain("limit=10");
    expect(secondUrl).toContain("status=active");
    expect(secondUrl).toContain("cursor=cursor_2");
  });

  it.each([
    {
      name: "listAllConnectorInstallations",
      path: "/v1/connectors/installations",
      run: (client: QURLClient): AsyncIterable<unknown> =>
        client.listAllConnectorInstallations({ limit: 10 }),
      page1: { data: [{ connector_id: "ci_page1" }] },
      page2: { data: [{ connector_id: "ci_page2" }] },
    },
    {
      name: "listAllBillingInvoices",
      path: "/v1/billing/invoices",
      run: (client: QURLClient): AsyncIterable<unknown> =>
        client.listAllBillingInvoices({ limit: 10 }),
      page1: { data: { invoices: [{ id: "inv_page1" }] } },
      page2: { data: { invoices: [{ id: "inv_page2" }] } },
    },
    {
      name: "listAllDomains",
      path: "/v1/domains",
      run: (client: QURLClient): AsyncIterable<unknown> => client.listAllDomains({ limit: 10 }),
      page1: { data: [{ domain: "page1.example.com" }] },
      page2: { data: [{ domain: "page2.example.com" }] },
    },
    {
      name: "listAllWebhooks",
      path: "/v1/webhooks",
      run: (client: QURLClient): AsyncIterable<unknown> => client.listAllWebhooks({ limit: 10 }),
      page1: { data: [{ id: "wh_page1" }] },
      page2: { data: [{ id: "wh_page2" }] },
    },
    {
      name: "listAllWebhookDeliveries",
      path: "/v1/webhooks/wh_x/deliveries",
      run: (client: QURLClient): AsyncIterable<unknown> =>
        client.listAllWebhookDeliveries("wh_x", { limit: 10 }),
      page1: { data: [{ id: "del_page1" }] },
      page2: { data: [{ id: "del_page2" }] },
    },
    {
      name: "listAllApiKeys",
      path: "/v1/api-keys",
      run: (client: QURLClient): AsyncIterable<unknown> => client.listAllApiKeys({ limit: 10 }),
      page1: { data: [{ id: "key_page1" }] },
      page2: { data: [{ id: "key_page2" }] },
    },
  ])("$name paginates and threads cursor across pages", async ({ run, path, page1, page2 }) => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          ...page1,
          meta: { has_more: true, next_cursor: "cursor_2" },
        },
      },
      {
        status: 200,
        body: {
          ...page2,
          meta: { has_more: false },
        },
      },
    ]);
    const client = createClient(fetch);

    const seen: unknown[] = [];
    for await (const item of run(client)) {
      seen.push(item);
    }

    expect(seen).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    const secondUrl = new URL(vi.mocked(fetch).mock.calls[1][0] as string);
    expect(firstUrl.pathname).toBe(path);
    expect(firstUrl.searchParams.get("limit")).toBe("10");
    expect(firstUrl.searchParams.has("cursor")).toBe(false);
    expect(secondUrl.pathname).toBe(path);
    expect(secondUrl.searchParams.get("limit")).toBe("10");
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor_2");
  });

  it("listAllResources stops when has_more is false even if a stale cursor is present", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page1" }],
          meta: { has_more: false, next_cursor: "stale_cursor" },
        },
      },
    ]);
    const client = createClient(fetch);

    const seen: string[] = [];
    for await (const resource of client.listAllResources()) {
      seen.push(resource.resource_id);
    }

    expect(seen).toEqual(["r_page1"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("listAllResources fails closed on duplicate cursors", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page1" }],
          meta: { has_more: true, next_cursor: "cursor_stuck" },
        },
      },
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page2" }],
          meta: { has_more: true, next_cursor: "cursor_stuck" },
        },
      },
    ]);
    const client = createClient(fetch);

    const seen: string[] = [];
    const error = await (async () => {
      for await (const resource of client.listAllResources()) {
        seen.push(resource.resource_id);
      }
    })().catch((e: unknown) => e);

    expect(seen).toEqual(["r_page1", "r_page2"]);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain(
      "listAllResources: server returned repeated cursor after 2 auto-pagination pages",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("listAllResources fails closed on nonconsecutive repeated cursors", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page1" }],
          meta: { has_more: true, next_cursor: "cursor_a" },
        },
      },
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page2" }],
          meta: { has_more: true, next_cursor: "cursor_b" },
        },
      },
      {
        status: 200,
        body: {
          data: [{ resource_id: "r_page3" }],
          meta: { has_more: true, next_cursor: "cursor_a" },
        },
      },
    ]);
    const client = createClient(fetch);

    const seen: string[] = [];
    const error = await (async () => {
      for await (const resource of client.listAllResources()) {
        seen.push(resource.resource_id);
      }
    })().catch((e: unknown) => e);

    expect(seen).toEqual(["r_page1", "r_page2", "r_page3"]);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain(
      "listAllResources: server returned repeated cursor after 3 auto-pagination pages",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("listBillingInvoices preserves the empty fallback for missing invoices arrays", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {}, meta: { has_more: false } } });
    const client = createClient(fetch);

    const result = await client.listBillingInvoices();

    expect(result.invoices).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it("listBillingInvoices preserves the empty fallback on 204 No Content", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const result = await client.listBillingInvoices();

    expect(result.invoices).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it("unpaginated list methods log additive pagination metadata without exposing paging", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: true, next_cursor: "cursor_2", request_id: "req_page" } },
    });
    const debug = vi.fn();
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug,
    });

    const accessCodes = await client.listAccessCodes();

    expect(accessCodes).toEqual({
      access_codes: [],
      request_id: "req_page",
      has_more: false,
      page_size: undefined,
    });
    expect(debug).toHaveBeenCalledWith(
      "listAccessCodes: pagination metadata surfaced on unpaginated endpoint",
      { has_more: true, next_cursor: "cursor_2" },
    );
  });

  it("unpaginated list methods warn on cursor-only pagination drift", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { next_cursor: "cursor_only" } },
    });
    const debug = vi.fn();
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug,
    });

    const accessCodes = await client.listAccessCodes();

    expect(accessCodes.has_more).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "listAccessCodes: pagination metadata surfaced on unpaginated endpoint",
      { has_more: undefined, next_cursor: "cursor_only" },
    );
  });

  it("unpaginated list methods preserve empty fallbacks on 204 No Content", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const sessions = await client.listResourceSessions(RESOURCE_CRID);
    const accessCodes = await client.listAccessCodes();

    expect(sessions.sessions).toEqual([]);
    expect(sessions.request_id).toBeUndefined();
    expect(sessions.has_more).toBe(false);
    expect(accessCodes.access_codes).toEqual([]);
    expect(accessCodes.request_id).toBeUndefined();
    expect(accessCodes.has_more).toBe(false);
  });

  it("paginated list methods preserve empty fallbacks on 204 No Content", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const qurls = await client.list();
    const resources = await client.listResources();
    const connectors = await client.listConnectorInstallations();
    const invoices = await client.listBillingInvoices();
    const domains = await client.listDomains();
    const webhooks = await client.listWebhooks();
    const deliveries = await client.listWebhookDeliveries("wh_x");
    const apiKeys = await client.listApiKeys();

    expect(qurls.qurls).toEqual([]);
    expect(qurls.has_more).toBe(false);
    expect(resources.resources).toEqual([]);
    expect(connectors.installations).toEqual([]);
    expect(invoices.invoices).toEqual([]);
    expect(domains.domains).toEqual([]);
    expect(webhooks.webhooks).toEqual([]);
    expect(deliveries.deliveries).toEqual([]);
    expect(apiKeys.api_keys).toEqual([]);
  });

  it("createApiKey accepts an explicit empty claim list for an unbound agent token", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });

    await createClient(fetch).createApiKey({
      kind: "enrollment_token",
      name: "unbound agent enrollment",
      claims: [],
    });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
      claims: [],
    });
  });

  it("mintLink rejects access_policy with non-array list field", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink(RESOURCE_CRID, {
        access_policy: { ip_allowlist: "10.0.0.0/8" },
      } as unknown as Parameters<typeof client.mintLink>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access_policy.ip_allowlist");
    expect(fetch).not.toHaveBeenCalled();
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
      apiKey: "test-api-key",
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

  it("listAll paginates across multiple pages and threads the cursor", async () => {
    // The reviewer flagged this as a gap: there's a single-page
    // listAll test and an error-propagation test, but no happy-path
    // multi-page test that verifies cursor threading. This is the
    // core use case of listAll — a refactor that broke cursor
    // threading (e.g. accidentally passing the same cursor on every
    // page) would silently drop data after page 1 and pass all
    // other tests. This test locks in the three-page contract:
    //   1. Every item across all pages is yielded in order
    //   2. Each request after the first carries the cursor from
    //      the previous page's response
    //   3. No extra round-trip fires after has_more=false
    const page1 = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [
            { resource_id: "r_p1a", status: "active", target_url: "https://p1a" },
            { resource_id: "r_p1b", status: "active", target_url: "https://p1b" },
          ],
          meta: { has_more: true, next_cursor: "cur_page2" },
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
          data: [
            { resource_id: "r_p2a", status: "active", target_url: "https://p2a" },
            { resource_id: "r_p2b", status: "active", target_url: "https://p2b" },
          ],
          meta: { has_more: true, next_cursor: "cur_page3" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const page3 = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_p3a", status: "active", target_url: "https://p3a" }],
          // No next_cursor — terminates the loop.
          meta: { has_more: false },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const ids: string[] = [];
    for await (const qurl of client.listAll()) {
      ids.push(qurl.resource_id);
    }

    // All 5 items yielded in page order.
    expect(ids).toEqual(["r_p1a", "r_p1b", "r_p2a", "r_p2b", "r_p3a"]);
    // Exactly 3 fetches — no extra round-trip after has_more=false.
    expect(fetch).toHaveBeenCalledTimes(3);
    // Cursor threading: page 1 has no cursor, pages 2+3 carry the
    // cursor from the previous response's `next_cursor`.
    const urls = fetch.mock.calls.map((call) => call[0] as string);
    expect(urls[0]).not.toContain("cursor=");
    expect(urls[1]).toContain("cursor=cur_page2");
    expect(urls[2]).toContain("cursor=cur_page3");
  });

  it("listAll threads filter params through to every page request", async () => {
    // Cross-SDK parity with qurl-python's
    // test_list_all_propagates_date_filters_to_every_page.
    // `listAll` accepts `Omit<ListInput, "cursor">` so callers can
    // filter (status, limit, date ranges, etc.) across the whole
    // iteration. The filter params must flow through to EVERY page
    // fetch, not just the first — otherwise pagination would silently
    // collect unfiltered data after page 1, which is exactly the kind
    // of bug this test guards against.
    const page1Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_f1", status: "active", target_url: "https://a" }],
          meta: { has_more: true, next_cursor: "cur_filt" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const page2Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_f2", status: "active", target_url: "https://b" }],
          meta: { has_more: false },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValueOnce(page1Response).mockResolvedValueOnce(page2Response);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const ids: string[] = [];
    for await (const qurl of client.listAll({
      status: "active",
      limit: 10,
      q: "search-term",
      created_after: "2026-03-01T00:00:00Z",
    })) {
      ids.push(qurl.resource_id);
    }

    expect(ids).toEqual(["r_f1", "r_f2"]);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Every HTTP call (not just the first) must carry all the filter
    // params. Check each URL independently — if page 2 dropped the
    // filters, a consumer would get unfiltered results from that
    // page onward and the bug would be invisible without this check.
    for (const call of fetch.mock.calls) {
      const url = call[0] as string;
      expect(url).toContain("status=active");
      expect(url).toContain("limit=10");
      expect(url).toContain("q=search-term");
      // URL-encoded ISO timestamp: colons become %3A
      expect(url).toContain("created_after=2026-03-01T00%3A00%3A00Z");
    }
    // Second request carries the cursor from page 1, first doesn't.
    expect(fetch.mock.calls[0][0] as string).not.toContain("cursor=");
    expect(fetch.mock.calls[1][0] as string).toContain("cursor=cur_filt");
  });

  it("listAll propagates errors mid-pagination after yielding prior pages", async () => {
    // If a page fetch throws mid-iteration (e.g. server hits a 500
    // after the first page succeeded), the generator must propagate
    // the error cleanly rather than silently truncating the stream.
    // Consumers relying on `listAll` should see the successfully-yielded
    // items AND a clear error, not a partial-completion that looks
    // like "we just ran out of data."
    const page1Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [
            { resource_id: "r_good1", status: "active", target_url: "https://a" },
            { resource_id: "r_good2", status: "active", target_url: "https://b" },
          ],
          meta: { has_more: true, next_cursor: "cur_mid" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const page2Error = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            status: 500,
            code: "internal_error",
            title: "Internal Server Error",
            detail: "Database connection lost",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValueOnce(page1Response).mockResolvedValueOnce(page2Error);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const yielded: string[] = [];
    let thrown: unknown;
    try {
      for await (const qurl of client.listAll()) {
        yielded.push(qurl.resource_id);
      }
    } catch (err) {
      thrown = err;
    }

    // Page 1 items were yielded before page 2 tripped the error.
    expect(yielded).toEqual(["r_good1", "r_good2"]);
    // The 500 propagated as a ServerError, not silently swallowed.
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("listAll preserves filter params AND propagates errors mid-pagination", async () => {
    // Combined regression guard: the two previous tests cover filter
    // threading AND error propagation separately, but the INTERACTION
    // between them isn't directly tested. A hypothetical bug where the
    // error path accidentally resets filter context (e.g. by re-trying
    // without them, or by re-entering listAll's input closure) would
    // slip past both individual tests. This one locks the combination
    // in: filters must be present on EVERY request including the one
    // that errors, and the error must still propagate cleanly.
    const page1Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_filt1", status: "active", target_url: "https://a" }],
          meta: { has_more: true, next_cursor: "cur_combined" },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    // Page 2 errors with a 500. The request must still carry the
    // filter params from the original listAll input.
    const page2Error = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            status: 500,
            code: "internal_error",
            title: "Internal Server Error",
            detail: "Mid-pagination failure",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValueOnce(page1Response).mockResolvedValueOnce(page2Error);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const yielded: string[] = [];
    let thrown: unknown;
    try {
      for await (const qurl of client.listAll({
        status: "active",
        limit: 10,
        q: "combined-test",
        created_after: "2026-03-01T00:00:00Z",
      })) {
        yielded.push(qurl.resource_id);
      }
    } catch (err) {
      thrown = err;
    }

    // Page 1 yielded before the error.
    expect(yielded).toEqual(["r_filt1"]);
    // Error surfaced cleanly.
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(2);

    // BOTH requests carry the filter params — including the one that
    // errored. If page 2's URL were missing `q=combined-test` or
    // `status=active`, that would mean the error path re-entered
    // without the original input context — a subtle bug that neither
    // of the two narrower tests above would catch.
    for (const call of fetch.mock.calls) {
      const url = call[0] as string;
      expect(url).toContain("status=active");
      expect(url).toContain("limit=10");
      expect(url).toContain("q=combined-test");
      expect(url).toContain("created_after=2026-03-01T00%3A00%3A00Z");
    }
    // Second (errored) request also carries the cursor from page 1.
    expect(fetch.mock.calls[1][0] as string).toContain("cursor=cur_combined");
  });

  it("listAll fails closed on duplicate cursor (stale-cursor guard)", async () => {
    // If the server has a bug and returns the same cursor on
    // consecutive pages, listAll should throw to make the truncated
    // traversal observable rather than re-requesting the same page forever.
    const page1Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_stale1" }],
          meta: { has_more: true, next_cursor: "cur_stuck" },
        }),
    } satisfies Partial<Response> as Response;

    const page2Response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          data: [{ resource_id: "r_stale2" }],
          // Server bug: returns the SAME cursor as page 1.
          meta: { has_more: true, next_cursor: "cur_stuck" },
        }),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValueOnce(page1Response).mockResolvedValueOnce(page2Response);

    const client = createClient(fetch as typeof globalThis.fetch);
    const items: string[] = [];
    const error = await (async () => {
      for await (const qurl of client.listAll()) {
        items.push((qurl as { resource_id: string }).resource_id);
      }
    })().catch((e: unknown) => e);
    // Both pages yielded, then the truncated traversal surfaced.
    expect(items).toEqual(["r_stale1", "r_stale2"]);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain(
      "listAll: server returned repeated cursor after 2 auto-pagination pages",
    );
    // Only 2 fetches — no infinite loop.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("listAll fails closed when pagination never terminates", async () => {
    let page = 0;
    const fetch = vi.fn(async () => {
      page += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        json: () =>
          Promise.resolve({
            data: [],
            meta: { has_more: true, next_cursor: `cur_${page}` },
          }),
      } satisfies Partial<Response> as Response;
    });

    const client = createClient(fetch as typeof globalThis.fetch);
    const error = await (async () => {
      for await (const qurl of client.listAll()) {
        void qurl;
      }
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain(
      "listAll: exceeded 10000 auto-pagination pages without termination",
    );
    expect(fetch).toHaveBeenCalledTimes(10_000);
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

  it("list rejects unknown properties on the input object", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    // Simulates a caller spreading an untyped object with extra properties.
    // The allowlist in list() should reject anything that isn't a known field.
    const untypedInput = { limit: 10, rogue: "should-fail" } as unknown as Parameters<
      typeof client.list
    >[0];
    const error = await client.list(untypedInput).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain('list: unknown field "rogue"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list filters null and empty-string filter params from the query string", async () => {
    // Untyped JS callers can pass `null` or `""` as a filter value
    // (e.g. from form state or a reset button). The allowlist loop
    // must skip these rather than emit `?status=&q=` garbage that
    // the API could interpret as an explicit empty filter.
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    const untypedInput = {
      limit: 10,
      status: null,
      q: "",
      cursor: null,
      sort: "",
    } as unknown as Parameters<typeof client.list>[0];
    await client.list(untypedInput);

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("limit=10");
    // None of the null/empty keys should appear in the query string.
    expect(calledUrl).not.toContain("status=");
    expect(calledUrl).not.toContain("q=");
    expect(calledUrl).not.toContain("cursor=");
    expect(calledUrl).not.toContain("sort=");
  });

  it("list rejects non-string/number filter values (untyped-JS safety)", async () => {
    // Regression guard: `String(value)` previously coerced anything
    // — `["a","b"]` became `"a,b"` (which accidentally matched `status`
    // CSV form but means nothing for `q` / `sort` / dates), and `{}`
    // became `"[object Object]"`. Both leak garbage into the query
    // string from untyped-JS callers spreading wider objects. The
    // allowlist loop now rejects non-string/number values explicitly.
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    for (const [key, value, expectedType] of [
      ["q", ["foo", "bar"], "string"],
      ["sort", { fieldName: "created_at" }, "string"],
      ["cursor", true, "string"],
    ] as const) {
      const error = await client
        .list({ [key]: value } as unknown as Parameters<typeof client.list>[0])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain(key);
      // Per-key type enforcement: cursor / q / sort are strings,
      // not numbers — `cursor: 42` would silently coerce without
      // this guard.
      expect(detail).toContain(`must be a ${expectedType}`);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list rejects numeric values for string-typed filter fields (e.g. cursor: 42)", async () => {
    // Per-key type enforcement: only `limit` is numeric per the
    // OpenAPI spec. `cursor: 42`, `status: 1`, etc. would silently
    // coerce to "42" / "1" through the previous broad
    // string-or-number guard. Now they fail fast with a per-key
    // ValidationError pointing at the expected type.
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    for (const key of ["cursor", "status", "q", "sort"] as const) {
      const error = await client
        .list({ [key]: 42 } as unknown as Parameters<typeof client.list>[0])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain(`list: ${key}:`);
      expect(detail).toContain("must be a string");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("list() with no arguments hits /v1/qurls with no query string", async () => {
    // Regression guard for the default-parameter path: calling
    // `client.list()` with zero arguments must behave identically
    // to `client.list({})` — no query string, bare URL. The default
    // parameter is straightforward but the test pins the contract
    // so a refactor that changes the default to something non-empty
    // (e.g. a sensible default `limit`) would trip here intentionally.
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { has_more: false } },
    });
    const client = createClient(fetch);

    await client.list();

    expect(fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Bare path, no query string at all.
    expect(calledUrl).toBe("https://api.test.layerv.ai/v1/qurls");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("session management pagination", () => {
  it("lists through empty pages and returns all sessions", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ session_id: "qs_first" }],
          meta: { has_more: true, next_cursor: "empty" },
        },
      },
      { status: 200, body: { data: [], meta: { has_more: true, next_cursor: "page/2" } } },
      {
        status: 200,
        body: {
          data: [{ session_id: "qs_last" }],
          meta: { has_more: false, page_size: 100, request_id: "last-page" },
        },
      },
    ]);
    const result = await createClient(fetch).listResourceSessions(RESOURCE_CRID);
    expect(result.sessions).toEqual([{ session_id: "qs_first" }, { session_id: "qs_last" }]);
    expect(result.has_more).toBe(false);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("paged")).toBe(
      "true",
    );
    expect(result.page_size).toBe(100);
    expect(result.request_id).toBe("last-page");
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.has("cursor")).toBe(
      false,
    );
    expect(new URL(vi.mocked(fetch).mock.calls[2][0] as string).searchParams.get("cursor")).toBe(
      "page/2",
    );
  });

  it("ends all pages and sums their counts", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: { data: { terminated: 2 }, meta: { has_more: true, next_cursor: "next" } },
      },
      { status: 200, body: { data: { terminated: 3 }, meta: { has_more: false } } },
    ]);
    expect((await createClient(fetch).terminateAllResourceSessions(RESOURCE_CRID)).terminated).toBe(
      5,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("paged")).toBe(
      "true",
    );
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.has("cursor")).toBe(
      false,
    );
    expect(new URL(vi.mocked(fetch).mock.calls[1][0] as string).searchParams.get("cursor")).toBe(
      "next",
    );
  });

  it.each([undefined, 1])(
    "rejects a missing later count or an unsafe total (%j)",
    async (count) => {
      const fetch = mockFetches([
        {
          status: 200,
          body: {
            data: { terminated: Number.MAX_SAFE_INTEGER },
            meta: { has_more: true, next_cursor: "next" },
          },
        },
        {
          status: 200,
          body: { data: { terminated: count }, meta: { has_more: false, request_id: "last-page" } },
        },
      ]);
      await expect(
        createClient(fetch).terminateAllResourceSessions(RESOURCE_CRID),
      ).rejects.toMatchObject({
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
        requestId: "last-page",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("reports a malformed later DELETE page without replaying it", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: { data: { terminated: 2 }, meta: { has_more: true, next_cursor: "next" } },
      },
      {
        status: 200,
        body: { data: { terminated: 1 }, meta: { has_more: true, request_id: "failed-page" } },
      },
    ]);
    await expect(
      createClient(fetch).terminateAllResourceSessions(RESOURCE_CRID),
    ).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      requestId: "failed-page",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("paged")).toBe(
      "true",
    );
  });

  it("fails without replay after a later DELETE returns 204 or 500", async () => {
    for (const status of [204, 500]) {
      const fetch = mockFetches([
        {
          status: 200,
          body: { data: { terminated: 2 }, meta: { has_more: true, next_cursor: "next" } },
        },
        {
          status,
          body:
            status === 204
              ? undefined
              : { error: { status, code: "internal_error", title: "Failure" } },
        },
      ]);
      await expect(
        createClient(fetch).terminateAllResourceSessions(RESOURCE_CRID),
      ).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("paged")).toBe(
        "true",
      );
    }
  });

  it("follows a cursor without has_more and rejects invalid termination counts", async () => {
    const pages = (data: unknown) =>
      mockFetches([
        { status: 200, body: { data, meta: { next_cursor: "next" } } },
        { status: 200, body: { data, meta: { has_more: false } } },
      ]);
    expect(
      (await createClient(pages([{ session_id: "s" }])).listResourceSessions(RESOURCE_CRID))
        .sessions,
    ).toHaveLength(2);
    expect(
      (await createClient(pages({ terminated: 1 })).terminateAllResourceSessions(RESOURCE_CRID))
        .terminated,
    ).toBe(2);
    for (const terminated of ["3", -1, 1.5, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      const fetch = mockFetch({ status: 200, body: { data: { terminated } } });
      await expect(
        createClient(fetch).terminateAllResourceSessions(RESOURCE_CRID),
      ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects missing and repeated cursors instead of claiming completion", async () => {
    for (const next_cursor of [undefined, "repeat"]) {
      const fetch = mockFetch({
        status: 200,
        body: { data: [], meta: { has_more: true, next_cursor } },
      });
      await expect(createClient(fetch).listResourceSessions(RESOURCE_CRID)).rejects.toMatchObject({
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
      });
      const terminateFetch = mockFetch({
        status: 200,
        body: { data: { terminated: 1 }, meta: { has_more: true, next_cursor } },
      });
      await expect(
        createClient(terminateFetch).terminateAllResourceSessions(RESOURCE_CRID),
      ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
    }
  });
});
