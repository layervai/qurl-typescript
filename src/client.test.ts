import { describe, it, expect, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  AuthenticationError,
  AuthorizationError,
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ERROR_CODE_UNKNOWN,
  NetworkError,
  NotFoundError,
  QURLError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
import type { BatchCreateInput, CreateInput, MintInput } from "./types.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";

describe("QURLClient", () => {
  it("creates a qURL", async () => {
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

  it("create forwards session_duration in the request body", async () => {
    // `session_duration` is a spec-documented create field, but the
    // original "creates a qURL" test doesn't exercise it — mintLink
    // tests cover the same field on a different endpoint. Plug the
    // gap so a refactor that accidentally drops session_duration
    // from the create-path serialization (e.g. through an overly
    // aggressive body filter) would trip this test.
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          qurl_id: "q_sd",
          resource_id: "r_sd",
          qurl_link: "https://qurl.link/#at_sd",
          qurl_site: "https://r_sd.qurl.site",
        },
      },
    });
    const client = createClient(fetch);
    await client.create({
      target_url: "https://example.com",
      expires_in: "24h",
      session_duration: "1h",
    });

    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.target_url).toBe("https://example.com");
    expect(parsed.expires_in).toBe("24h");
    expect(parsed.session_duration).toBe("1h");
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

  it("validateCreateInput collects ALL field errors (not fail-fast)", async () => {
    // Documented batchCreate UX: "All failures are collected into a
    // single ValidationError" — must hold per-item too. Previously
    // requireValidTargetUrl threw first and hid the label/max_sessions
    // failures, so a caller fixing a bad batch had to fix one issue,
    // re-run, fix the next, re-run... Now every check runs and the
    // detail aggregates `; `-separated.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({
        target_url: "ftp://nope.com", // bad scheme
        label: "x".repeat(501), // too long
        custom_domain: "x".repeat(254), // too long
        max_sessions: 9999, // out of range
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    const detail = (error as ValidationError).detail;
    // All four failures must appear in the aggregated detail.
    expect(detail).toContain("target_url");
    expect(detail).toContain("label");
    expect(detail).toContain("custom_domain");
    expect(detail).toContain("max_sessions");
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

  it("create rejects target_url without http/https scheme", async () => {
    // Matches the qurl-python SDK's _ALLOWED_URL_SCHEMES check. Fail
    // fast for the common "forgot the protocol" mistake and reject
    // schemes the SDK doesn't usefully support (ftp://, file://,
    // javascript:). The server is still the authoritative validator.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const badUrl of ["example.com", "ftp://files.example.com", "javascript:alert(1)", ""]) {
      const error = await client
        .create({ target_url: badUrl })
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain("http:// or https://");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("create rejects null/undefined input with structured ValidationError (not raw TypeError)", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const badInput of [null, undefined]) {
      const error = await client
        .create(badInput as unknown as Parameters<typeof client.create>[0])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      expect((error as ValidationError).detail).toContain("must be an object");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("create accepts target_url with whitespace inside the path", async () => {
    // Path grammar lives server-side; client validator checks
    // scheme + length only. Pass-through behavior locked in.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    await expect(
      client.create({ target_url: "https://example.com/with spaces/and%20encoded" }),
    ).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.target_url).toBe("https://example.com/with spaces/and%20encoded");
  });

  it("create accepts http:// and https:// schemes", async () => {
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

    await expect(client.create({ target_url: "http://example.com" })).resolves.toBeDefined();
    await expect(client.create({ target_url: "https://example.com" })).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("create rejects non-string target_url with a 'must be a string' error (untyped-JS safety)", async () => {
    // Regression guard: requireValidTargetUrl splits the type guard from
    // the scheme check so the error message pinpoints the actual failure
    // mode. A non-string `target_url` (number, null, plain object) gets a
    // "must be a string" message matching the rest of the validators
    // (requireMaxLength, requireValidTags); only an actual string with a
    // bad scheme gets the "http:// or https://" message. Previously both
    // failure modes shared the scheme message, which misled callers.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const badUrl of [null, undefined, 42, { toString: () => "evil" }, []]) {
      const error = await client
        // Deliberately bypassing the type system to simulate untyped-JS callers.
        .create({ target_url: badUrl as unknown as string })
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain("target_url");
      expect(detail).toContain("must be a string");
      // Must NOT mislead with the scheme message — that's reserved for
      // actual string inputs with the wrong scheme.
      expect(detail).not.toContain("http:// or https://");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gets a qURL with access tokens", async () => {
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

  it("gets a qURL without access tokens", async () => {
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

  it("handles qurls: null with access_tokens already present (truthy short-circuit)", async () => {
    // Exercises the `qurls && ...` branches in mapQurlsField. With
    // qurls being null (not absent), the rename branch is entered
    // (presence check passes), but the truthy short-circuit means
    // we keep access_tokens as-is and drop the wire-format key.
    // Defends against a future refactor that flips presence-vs-truthy
    // and accidentally surfaces qurls: null on a typed QURL.
    const accessTokens = [
      {
        qurl_id: "at_existing",
        status: "active",
        one_time_use: false,
        max_sessions: 5,
        session_duration: 3600,
        use_count: 0,
        created_at: "2026-03-10T10:00:00Z",
        expires_at: "2026-04-10T10:00:00Z",
      },
    ];
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_dual",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 1,
          created_at: "2026-03-10T10:00:00Z",
          qurls: null,
          access_tokens: accessTokens,
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("r_dual");

    expect(result.access_tokens).toEqual(accessTokens);
    // Wire-format key stripped from consumer-facing object.
    expect((result as unknown as { qurls?: unknown }).qurls).toBeUndefined();
  });

  it("preserves empty qurls: [] as access_tokens: []", async () => {
    // Defense against a future refactor flipping the truthiness check
    // in mapQurlsField from `"qurls" in raw` to `if (raw.qurls)`. An
    // empty array is truthy as a value but falsy in a boolean coerce
    // ONLY for length-zero strings — so the in-check correctly preserves
    // `[]` while a `if (raw.qurls)` would fall through to the no-rename
    // path and leave the consumer staring at `qurls: []` on a typed
    // qURL resource where they expected `access_tokens: []`.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_empty_tokens",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 0,
          created_at: "2026-03-10T10:00:00Z",
          qurls: [],
        },
      },
    });

    const client = createClient(fetch);
    const result = await client.get("r_empty_tokens");

    expect(result.resource_id).toBe("r_empty_tokens");
    expect(result.access_tokens).toEqual([]);
    // The wire-format key must be removed from the consumer-facing object.
    expect((result as unknown as { qurls?: unknown[] }).qurls).toBeUndefined();
  });

  it("gets a qURL by q_ display ID (API resolves to parent resource)", async () => {
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
                qurl_id: "at_xyz",
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
    expect(result.qurls[0].access_tokens![0].qurl_id).toBe("at_xyz");
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

  it("deletes a qURL", async () => {
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
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("r_ prefix");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete error message reports only the 2-char prefix (no raw ID leak)", async () => {
    // Info-leak hardening: the error message should not echo the raw
    // caller-supplied ID (even truncated). Echoing just the prefix
    // ("q_", "at_", etc.) gives the caller enough context to fix their
    // code without leaking identifiers into observability pipelines.
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client
      .delete("q_3a7f2c8e91b_sensitive_suffix")
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = (error as ValidationError).detail;
    expect(detail).toContain('starting with "q_"');
    // Must not echo the full ID or any sensitive suffix.
    expect(detail).not.toContain("3a7f2c8e91b");
    expect(detail).not.toContain("sensitive_suffix");
  });

  it("delete rejects non-string ids with a structured ValidationError (untyped-JS safety)", async () => {
    // Regression guard: without the typeof-string guard, an untyped JS
    // caller passing `undefined`/`null`/`42` would hit a raw
    // `TypeError: Cannot read properties of undefined (reading 'length')`
    // from `id.length`, bypassing the SDK's structured error envelope.
    // Match the typeof-guard pattern used in requireValidTags /
    // requireValidTargetUrl / requireMaxLength.
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    for (const badId of [undefined, null, 42, {}]) {
      const error = await client
        .delete(badId as unknown as string)
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      // Must mention the type — operators need to know what came in.
      const detail = (error as ValidationError).detail;
      expect(detail).toMatch(/undefined|null|number|object/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete gives a distinct error for too-short / empty IDs", async () => {
    // An empty string or 1-2 char input isn't a plausible ID — the
    // "starting with X" wording would just echo noise (or nothing) and
    // confuse callers. Assert the short-input branch uses a clearer
    // "invalid or empty identifier" message.
    //
    // Also covers the edge case where the input is EXACTLY the prefix
    // with no suffix (`"r_"` or `"q_"`): these pass/fail `startsWith`
    // differently, but the length check runs first and catches both
    // uniformly. Without this ordering, bare `"r_"` would slip through
    // the prefix check and hit `DELETE /v1/qurls/r_` on the wire.
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    for (const badId of ["", "x", "ab", "r_", "q_", "at"]) {
      const error = await client.delete(badId).catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain("invalid or empty identifier");
      // Short-input branch must NOT fall through to the "starting with"
      // wording that's meant for plausible-but-wrong-prefix IDs.
      expect(detail).not.toContain("starting with");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("get rejects empty id", async () => {
    // Empty id produces `GET /v1/qurls/` which hits the list endpoint,
    // not get. The client-side check catches this before a round-trip.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const error = await client.get("").catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects empty id", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const error = await client
      .update("", { description: "test" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend rejects empty id", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const error = await client
      .extend("", { extend_by: "24h" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects empty id", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const error = await client.mintLink("").catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("get/update/extend/mintLink reject whitespace-only id", async () => {
    // Regression guard: without `.trim()` in requireNonEmptyId, a
    // whitespace-only id passes the falsy check and round-trips as
    // `encodeURIComponent("   ") === "%20%20%20"`, returning a server 404.
    // The pre-flight error is more actionable than the eventual 404.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const call of [
      () => client.get("   "),
      () => client.update("   ", { description: "x" }),
      () => client.extend("   ", { extend_by: "24h" }),
      () => client.mintLink("   "),
    ]) {
      const error = await call().catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain("id is required");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extends a qURL", async () => {
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

  it("updates a qURL description", async () => {
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
    // `UpdateInput` is a non-XOR interface — both fields are optional, so
    // typed callers reach the runtime mutual-exclusion guard directly.
    // This is the regression for that runtime guard; untyped wider-object
    // callers also hit it via the same code path (allowlist + XOR check).
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend throws ValidationError when extend_by and expires_at are both set (inherits from update)", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // extend() delegates to update(), so it inherits the mutual-exclusion
    // check. The new `ExtendInput` discriminated union makes this a
    // COMPILE error for typed callers, but the runtime check is still
    // load-bearing for untyped JS callers who bypass the type system —
    // cast through `unknown` to simulate that path and lock the
    // runtime guard in as a regression.
    const bothFields = { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" };
    const error = await client
      .extend("r_abc", bothFields as unknown as Parameters<typeof client.extend>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend() rejects empty input at compile time (discriminated union)", async () => {
    // The ExtendInput type is a discriminated union that requires
    // exactly one of `extend_by` / `expires_at`. This test documents
    // the compile-time guarantee for typed callers — the runtime
    // "at least one field" check in update() still catches the
    // untyped-JS path (also tested separately).
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // Untyped-JS path: empty object bypassed compile-time type check
    // via unknown cast, hits the update() runtime "at least one
    // field" guard.
    const error = await client
      .extend("r_abc", {} as unknown as Parameters<typeof client.extend>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("at least one field");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink throws ValidationError when expires_in and expires_at are both set", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink("r_abc", { expires_in: "7d", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink normalizes null fields like update() (untyped-JS null-safety)", async () => {
    // Symmetry with update()'s null-normalization. An untyped-JS caller
    // passing `{ expires_in: null, expires_at: "2026-..." }` previously
    // would (a) bypass the XOR check (which uses `!== undefined`) and
    // (b) leak `"expires_in": null` into the wire body via JSON.stringify.
    // mintLink now strips null/undefined before validation, mirroring
    // update().
    const fetch = mockFetch({
      status: 200,
      body: { data: { qurl_link: "https://qurl.link/#at_x", expires_at: "2026-04-01T00:00:00Z" } },
    });
    const client = createClient(fetch);

    await client.mintLink("r_abc", {
      expires_in: null as unknown as string,
      expires_at: "2026-04-01T00:00:00Z",
      label: null as unknown as string,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    // Stripped fields must NOT appear in the wire body.
    expect(body).not.toHaveProperty("expires_in");
    expect(body).not.toHaveProperty("label");
    expect(body.expires_at).toBe("2026-04-01T00:00:00Z");
  });

  it("mintLink({}) and mintLink() produce the same wire request (no body)", async () => {
    // Empty input → `undefined` → no Content-Type, no body — matches
    // `mintLink(id)`. Three shapes exercise distinct strip-path branches.
    const fetch = mockFetch({
      status: 200,
      body: { data: { qurl_link: "https://qurl.link/#at_x" } },
    });
    const client = createClient(fetch);

    await client.mintLink("r_abc", {});
    await client.mintLink("r_abc");
    await client.mintLink("r_abc", { expires_in: null as unknown as string });

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const call of fetch.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBeNull();
    }
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

  it("mintLink accepts being called with no input argument", async () => {
    // Regression guard: `input` is optional on `mintLink`, and the
    // method guards every property access with `input?.` / a presence
    // check. Lock that behavior in so a refactor that accidentally
    // hard-accesses `input.max_sessions` would trip this test.
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

    await expect(client.mintLink("r_abc123def45")).resolves.toBeDefined();
    // Body should be omitted (undefined) when no input is provided —
    // the server defaults fill in the unspecified fields.
    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(calledBody).toBeUndefined();
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

  it("requireMaxLength rejects non-string inputs (untyped-JS safety)", async () => {
    // Regression guard: without the typeof-string guard inside
    // requireMaxLength, an untyped JS caller passing `description: 42`
    // would silently sail through to the wire — `(42).length` is
    // `undefined`, and `undefined > 500` is `false`. Same surface as
    // requireValidTags / requireValidTargetUrl. Exercise via update()
    // since it's the most direct user of requireMaxLength.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const badDescription of [42, true, {}, []]) {
      const error = await client
        .update("r_abc", { description: badDescription as unknown as string })
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain("description");
      expect(detail).toContain("must be a string");
    }
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

  it("update collects ALL invalid tag errors in a single throw", async () => {
    // Collect-all pattern for tag validation, matching the batchCreate
    // collect-all UX. A caller passing multiple bad tags should see all
    // of them reported at once with per-index attribution, not just
    // the first one.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", {
        tags: [
          "good-tag",
          "-leading-dash", // bad: pattern
          "ok",
          "x".repeat(51), // bad: too long
          "also bad!!", // bad: pattern (special chars)
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = (error as ValidationError).detail;
    // All three bad tags must appear with their indices.
    expect(detail).toContain("tags[1]");
    expect(detail).toContain("tags[3]");
    expect(detail).toContain("tags[4]");
    // Good indices must NOT appear.
    expect(detail).not.toContain("tags[0]");
    expect(detail).not.toContain("tags[2]");
    // Each per-tag problem is spelled out.
    expect(detail).toContain("alphanumeric");
    expect(detail).toContain("1-50 characters");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects non-array tags with a clean ValidationError (untyped-JS safety)", async () => {
    // Regression guard: an untyped JS caller passing a plain object
    // (or a number, or a string) where an array is expected used to
    // fall through to a TypeError on `.length`. Now it surfaces as
    // a proper ValidationError with `code: "client_validation"` so
    // callers catching by-class still work.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // Plain object passed as tags (common untyped-JS mistake).
    const objError = await client
      .update("r_abc", { tags: {} as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(objError).toBeInstanceOf(ValidationError);
    expect((objError as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((objError as ValidationError).detail).toContain("must be an array");
    expect((objError as ValidationError).detail).toContain("object");

    // Number.
    const numError = await client
      .update("r_abc", { tags: 42 as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(numError).toBeInstanceOf(ValidationError);
    expect((numError as ValidationError).detail).toContain("number");

    // String (also a common mistake — passing a single tag as a string
    // instead of wrapping in an array).
    const strError = await client
      .update("r_abc", { tags: "single-tag" as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(strError).toBeInstanceOf(ValidationError);
    expect((strError as ValidationError).detail).toContain("string");

    // None of the above should have reached the fetch layer.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects non-string tag elements with per-index attribution (untyped-JS safety)", async () => {
    // Regression guard: without the per-element `typeof tag !== "string"`
    // check, a non-string element would silently pass (a number coerces
    // in `TAG_PATTERN.test`; `(42).length` is `undefined` so the length
    // check skips it) or hard-crash (`null.length` is a TypeError outside
    // our ValidationError envelope). Every bad element must surface as
    // a clean ValidationError with its index, collect-all-style, so a
    // caller fixing multiple bad tags sees all problems at once.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", {
        tags: [
          "good-tag",
          42 as unknown as string, // bad: number
          "also-good",
          null as unknown as string, // bad: null (would TypeError without guard)
          {} as unknown as string, // bad: plain object
          undefined as unknown as string, // bad: undefined (would TypeError without guard)
        ],
      })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    const detail = (error as ValidationError).detail;
    // All four bad indices with their concrete types.
    expect(detail).toContain("tags[1]");
    expect(detail).toContain("number");
    expect(detail).toContain("tags[3]");
    expect(detail).toContain("null");
    expect(detail).toContain("tags[4]");
    expect(detail).toContain("object");
    expect(detail).toContain("tags[5]");
    expect(detail).toContain("undefined");
    // Good indices must NOT appear.
    expect(detail).not.toContain("tags[0]");
    expect(detail).not.toContain("tags[2]");
    // Never reaches the wire.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update treats null tags as 'no change' (untyped-JS null-safety)", async () => {
    // Matching the list() filter's null-tolerance: `tags: null` from
    // an untyped JS caller is treated the same as `tags: undefined`
    // ("don't touch tags"), not as "clear all tags" (which is `[]`).
    // Without normalization, `null.length` would TypeError inside
    // requireValidTags AND `null` would leak into the wire body as
    // "tags": null via JSON.stringify. update() now normalizes
    // null/undefined to "omitted" at the top of the method, so both
    // paths are handled consistently.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc",
          target_url: "https://example.com",
          status: "active",
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });
    const client = createClient(fetch);

    // With another real field present, `tags: null` should just be
    // dropped from the request body — no ValidationError, no crash,
    // no `"tags": null` in the JSON wire body.
    await expect(
      client.update("r_abc", {
        description: "real update",
        tags: null as unknown as string[],
      }),
    ).resolves.toBeDefined();

    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.description).toBe("real update");
    // The null-tags field must be stripped entirely — it should not
    // appear in the body, with or without a value. Locks in the
    // "null means no change" semantic at the wire layer.
    expect("tags" in parsed).toBe(false);
  });

  it("update empty-input guard catches null-only tags input (no stealth empty)", async () => {
    // Edge case: if the ONLY field a caller passes is `tags: null`,
    // the normalization should drop it, and then the hasAnyField
    // check should trip because the normalized object is empty.
    // Without the normalization, the hasAnyField check would pass
    // (since null !== undefined) and a garbage request would be
    // sent — or requireValidTags would crash. Locks in the
    // normalized-then-checked order.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { tags: null as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("at least one field");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update null-strips extend_by before the mutual-exclusion check", async () => {
    // Edge case reviewer flagged: `{ extend_by: null, expires_at: "..." }`
    // from an untyped JS caller. If the mutual-exclusion check ran
    // BEFORE null normalization, this would spuriously trip
    // "mutually exclusive" because both fields are defined. The
    // normalization must strip `extend_by: null` first, leaving only
    // `expires_at`, and the request should succeed.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc",
          target_url: "https://example.com",
          status: "active",
          expires_at: "2026-04-01T00:00:00Z",
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });
    const client = createClient(fetch);

    // Cast through unknown because TypeScript would reject null on
    // a `string | undefined` field — the test specifically simulates
    // an untyped-JS caller bypassing the type system.
    await expect(
      client.update("r_abc", {
        extend_by: null as unknown as string,
        expires_at: "2026-04-01T00:00:00Z",
      }),
    ).resolves.toBeDefined();

    // Wire body should contain only expires_at, not both fields.
    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.expires_at).toBe("2026-04-01T00:00:00Z");
    expect("extend_by" in parsed).toBe(false);
  });

  it("update rejects empty input pre-flight (no fields provided)", async () => {
    // update() must reject `{}` client-side — the server-side "at least
    // one field" check would otherwise be the only guard, and the
    // exhaustiveness pattern in UPDATE_FIELD_KEYS was introduced
    // specifically so a new UpdateInput field can't silently opt out of
    // this check.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client.update("r_abc", {}).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("at least one field");
    // Message should enumerate every current UpdateInput field so
    // callers know their options — if a field is missing from this
    // list the exhaustiveness check in client.ts should have failed.
    expect((error as ValidationError).detail).toContain("extend_by");
    expect((error as ValidationError).detail).toContain("expires_at");
    expect((error as ValidationError).detail).toContain("description");
    expect((error as ValidationError).detail).toContain("tags");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects empty-string timing fields (extend_by / expires_at)", async () => {
    // Empty string is always a caller mistake on timing fields —
    // typically uninitialized form state. `description: ""` has
    // documented clear-the-field semantics (see UpdateInput JSDoc)
    // and is preserved; the timing fields don't, so they get a
    // structured ValidationError instead of round-tripping garbage.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const key of ["extend_by", "expires_at"] as const) {
      const error = await client
        .update("r_abc", { [key]: "" } as unknown as Parameters<typeof client.update>[1])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain(key);
      expect(detail).toContain("must not be an empty string");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update preserves description: '' (documented clear-the-field semantic)", async () => {
    // Mirror image of the timing-field rejection above: `description: ""`
    // is a documented way to clear the resource's description and must
    // round-trip to the API as-is. Locks in that the empty-string
    // rejection is timing-field-only.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc",
          target_url: "https://example.com",
          status: "active",
          created_at: "2026-03-10T10:00:00Z",
        },
      },
    });
    const client = createClient(fetch);
    await client.update("r_abc", { description: "" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.description).toBe("");
  });

  it("mintLink rejects empty-string timing fields (expires_in / expires_at)", async () => {
    // Symmetric with update() — empty string on timing fields is
    // always a caller mistake, never a meaningful value.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const key of ["expires_in", "expires_at"] as const) {
      const error = await client
        .mintLink("r_abc", { [key]: "" } as unknown as Parameters<typeof client.mintLink>[1])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain(key);
      expect(detail).toContain("must not be an empty string");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink passes access_policy through unvalidated (server is authoritative)", async () => {
    // Locks in the documented "server is authoritative for nested
    // policy contents" rationale (mirrors validateCreateInput).
    // Bogus CIDR / ISO-3166 / regex values must round-trip to the
    // wire untouched — the SDK doesn't pre-validate them, the server
    // does. If a client-side IP/geo/regex validator is ever added,
    // this test should fail intentionally so the change is visible.
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          qurl_link: "https://qurl.link/#at_x",
          expires_at: "2026-04-01T00:00:00Z",
        },
      },
    });
    const client = createClient(fetch);

    await client.mintLink("r_abc", {
      access_policy: {
        ip_allowlist: ["not-a-cidr"],
        geo_allowlist: ["XX"],
        user_agent_allow_regex: "(unbalanced",
        ai_agent_policy: { deny_categories: ["fictional-category"] },
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    // Round-tripped verbatim — the SDK didn't reject or normalize.
    expect(body.access_policy.ip_allowlist).toEqual(["not-a-cidr"]);
    expect(body.access_policy.geo_allowlist).toEqual(["XX"]);
    expect(body.access_policy.user_agent_allow_regex).toBe("(unbalanced");
    expect(body.access_policy.ai_agent_policy.deny_categories).toEqual(["fictional-category"]);
  });

  it("update treats `{ extend_by: undefined }` as empty (no stealth empty-input)", async () => {
    // A caller who threads an `undefined` through their own types
    // should still hit the empty-input guard — the some()-based check
    // tests `input[key] !== undefined`, not `key in input`, so
    // explicit-undefined values are indistinguishable from omissions.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { extend_by: undefined })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("at least one field");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update treats both fields explicitly-undefined as empty input", async () => {
    // Defense against a future refactor that switches the empty-input
    // accumulator from value-based to key-based: `{ extend_by:
    // undefined, expires_at: undefined }` must still surface as
    // empty input, not as "two fields provided."
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update("r_abc", { extend_by: undefined, expires_at: undefined })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("at least one field");
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

  it("mapQurlsField keeps access_tokens when the API returns BOTH qurls and access_tokens", async () => {
    // Defense-in-depth: the API spec returns exactly one of the two
    // fields, but a future spec migration (or a partial deploy) could
    // produce both. When that happens, mapQurlsField is authoritative:
    // it keeps `access_tokens` (the SDK-canonical name), drops `qurls`
    // (the legacy wire name), and emits a debug log so operators can
    // spot the divergence. This test locks in the "shouldn't happen
    // but we'll handle it" branch — without it, a future refactor
    // could silently flip the precedence and no test would catch it.
    const debugFn = vi.fn();
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_dualfield",
          target_url: "https://example.com",
          status: "active",
          qurl_count: 2,
          // Both fields populated with DIFFERENT data so we can
          // unambiguously assert which one won. `access_tokens` has
          // one entry, `qurls` has two — the assertion below pins
          // `access_tokens` as the winner.
          access_tokens: [
            {
              qurl_id: "q_winner00001",
              status: "active",
              one_time_use: false,
              max_sessions: 5,
              session_duration: 300,
              use_count: 0,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
          ],
          qurls: [
            {
              qurl_id: "q_loser000001",
              status: "active",
              one_time_use: false,
              max_sessions: 5,
              session_duration: 300,
              use_count: 0,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
            {
              qurl_id: "q_loser000002",
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

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    const result = await client.get("r_dualfield");

    // `access_tokens` wins the merge — exactly one entry (from
    // access_tokens), not two (from qurls).
    expect(result.access_tokens).toHaveLength(1);
    expect(result.access_tokens![0].qurl_id).toBe("q_winner00001");
    // `qurls` is dropped from the returned shape entirely.
    expect((result as Record<string, unknown>).qurls).toBeUndefined();

    // Debug log fires with both counts so operators can spot the
    // divergence. The content assertion is on the log message prefix
    // and the structured context so this test doesn't brittle-couple
    // to exact phrasing, just the observable contract.
    const debugCalls = debugFn.mock.calls;
    const dualFieldLog = debugCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("mapQurlsField"),
    );
    expect(dualFieldLog).toBeDefined();
    expect(dualFieldLog![0]).toContain("received both");
    expect(dualFieldLog![1]).toEqual({
      qurls_count: 2,
      access_tokens_count: 1,
    });
  });

  it("mapQurlsField drops `qurls` if it isn't an array (defensive)", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          resource_id: "r_abc",
          target_url: "https://example.com",
          status: "active",
          qurls: { not: "an array" },
        },
      },
    });
    const debugFn = vi.fn();
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    const result = await client.get("r_abc");
    expect((result as { qurls?: unknown }).qurls).toBeUndefined();
    expect((result as { access_tokens?: unknown }).access_tokens).toBeUndefined();
    const dropLog = debugFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("not an array"),
    );
    expect(dropLog).toBeDefined();
  });

  it("parseError synthesizes a title from HTTP status when statusText is empty (HTTP/2)", async () => {
    // HTTP/2 omits reason-phrases — fallback must keep Error.message legible.
    const fetch = mockFetch({
      status: 404,
      statusText: "",
      body: { error: { status: 404, code: "not_found", detail: "no such resource" } },
    });
    const client = createClient(fetch);

    const error = await client.get("r_abc").catch((e: unknown) => e as QURLError);
    expect(error).toBeInstanceOf(QURLError);
    expect((error as QURLError).message).toContain("HTTP 404");
    expect((error as QURLError).message).not.toMatch(/^ \(/);
  });

  it("resolves a qURL token", async () => {
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
    // URL path construction: resolve() must POST to /v1/resolve.
    // Existing tests cover the body shape (both string and object
    // overloads) but not the URL path — if a future refactor
    // accidentally changed the path to `/v1/qurls/resolve` or
    // similar, the body-only assertions wouldn't catch it.
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/resolve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws QURLError on API errors", async () => {
    const fetch = mockFetch({
      status: 404,
      body: {
        error: {
          type: "https://api.qurl.link/problems/not_found",
          title: "Not Found",
          status: 404,
          detail: "qURL not found",
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

  it("throws ValidationError (not generic Error) when apiKey is empty", () => {
    let thrown: unknown;
    try {
      new QURLClient({ apiKey: "", fetch: mockFetch({ status: 200 }) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((thrown as ValidationError).detail).toContain("apiKey");
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
      expect(qErr.code).toBe(ERROR_CODE_UNKNOWN);
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

  it("falls back to exponential backoff when Retry-After is an HTTP-date", async () => {
    // Per RFC 7231 §7.1.3, Retry-After can be either a numeric
    // delay-seconds OR an HTTP-date. The current implementation
    // uses `parseInt`, which returns `NaN` for HTTP-date strings —
    // `Number.isNaN(seconds)` catches that and returns `undefined`,
    // so the retry falls back to exponential backoff. This test
    // documents that intent: the SDK currently does NOT parse
    // HTTP-date values; it silently ignores them and uses backoff
    // instead. If we ever add HTTP-date support, this test should
    // be flipped to assert the date is parsed and respected.
    const retryAfterResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      // Valid RFC 7231 HTTP-date format — the SDK should NOT parse this.
      headers: new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
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
          data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
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

    // Should still retry and succeed — just via exponential backoff
    // instead of the HTTP-date value. Don't assert exact timing; the
    // important contract is "retry happens, doesn't wait for a parsed
    // date value, and doesn't throw on the unparseable header."
    const result = await client.getQuota();
    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
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
        apiKey: "lv_live_test",
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

  it("Retry-After exceeding hard cap is truncated and logged", async () => {
    // Pathological `Retry-After` >2^31-1 ms overflows Node's setTimeout
    // to 1ms — hot-loop hazard. Cap honored, retry attempted only after
    // the cap (not before).
    vi.useFakeTimers();
    try {
      const huge = 86400 * 30; // 30 days, well past the 1h cap
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
        apiKey: "lv_live_test",
        baseUrl: "https://api.test.layerv.ai",
        fetch: retryAfterHuge,
        maxRetries: 1,
        debug: (msg) => {
          debugMessages.push(msg);
        },
      });

      const promise = client.getQuota();
      // Just under the cap: must NOT have fired the second fetch yet.
      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(retryAfterHuge).toHaveBeenCalledTimes(1);
      // Past the cap: retry fires.
      await vi.advanceTimersByTimeAsync(2);
      const result = await promise;
      expect(result.plan).toBe("growth");
      expect(retryAfterHuge).toHaveBeenCalledTimes(2);
      expect(debugMessages.some((m) => m.includes("Retry-After exceeded hard cap"))).toBe(true);
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
      apiKey: "lv_live_test",
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
      apiKey: "lv_live_test",
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
        apiKey: "lv_live_test",
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

  it("clamps negative maxRetries to 0 (defensive against caller misuse)", async () => {
    // A negative maxRetries would cause the retry loop
    //   for (let attempt = 0; attempt <= this.maxRetries; attempt++)
    // to skip entirely — meaning ZERO attempts, not even the initial
    // request. The constructor clamps to Math.max(0, ...) so this
    // can never happen. Verify the happy path still works with a
    // negative input and does exactly one fetch (the initial attempt,
    // no retries).
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
      maxRetries: -5, // would-be footgun
    });
    await expect(client.getQuota()).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to default maxRetries on NaN/Infinity (would skip every attempt)", async () => {
    // `Math.max(0, NaN) === NaN` and `attempt <= NaN` is `false`, so
    // a `parseInt`-failed `maxRetries: NaN` would silently skip every
    // attempt — including the initial request. The Number.isFinite
    // guard falls back to DEFAULT_MAX_RETRIES so the request still
    // fires. The default is 3, so a happy 200 still resolves with a
    // single fetch (the initial attempt, no retries needed).
    const fetch = mockFetch({
      status: 200,
      body: {
        data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
      },
    });

    for (const badRetries of [NaN, Infinity, -Infinity]) {
      const client = new QURLClient({
        apiKey: "lv_live_test",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: badRetries,
      });
      await expect(client.getQuota()).resolves.toBeDefined();
    }
    // Three constructions, three single-attempt fetches each.
    expect(fetch).toHaveBeenCalledTimes(3);
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
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2.7,
    });
    await expect(client.getQuota()).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("rejects non-https baseUrl to prevent bearer-token plaintext leakage", async () => {
    // Bearer token would otherwise be sent in the clear. The check is
    // a constructor-time sanity guard — production callers would notice
    // a typo'd or downgraded URL eventually, but the pre-flight stops
    // the leak on the first request.
    expect(
      () =>
        new QURLClient({
          apiKey: "lv_live_test",
          baseUrl: "http://api.example.com",
        }),
    ).toThrow(/baseUrl: must use https:\/\//);

    expect(
      () =>
        new QURLClient({
          apiKey: "lv_live_test",
          baseUrl: "ftp://api.example.com",
        }),
    ).toThrow(/baseUrl: must use http:\/\/ or https:\/\//);
  });

  it("rejects loopback-prefix bypass attempts in baseUrl", async () => {
    // Security regression guard: a `startsWith("http://localhost")`
    // implementation would accept `http://localhost.attacker.com` and
    // silently send the bearer token in plaintext to an arbitrary
    // host. The hostname-based check (URL parser + exact match)
    // closes this. Cover IPv4, IPv6, and name-based variants.
    const bypassAttempts = [
      "http://localhost.evil.com",
      "http://localhostfoo",
      "http://localhost-evil",
      "http://127.0.0.1.evil.com",
      "http://127.0.0.1evil",
      "http://[::1].evil.com",
    ];
    for (const bad of bypassAttempts) {
      expect(
        () => new QURLClient({ apiKey: "lv_live_test", baseUrl: bad }),
        `bypass attempt should be rejected: ${bad}`,
      ).toThrow(/baseUrl/);
    }
  });

  it("rejects malformed baseUrl with a structured ValidationError", async () => {
    // A URL that fails to parse at construction time should surface
    // as a ValidationError, not a raw TypeError from `new URL()`.
    expect(
      () =>
        new QURLClient({
          apiKey: "lv_live_test",
          baseUrl: "not a url at all",
        }),
    ).toThrow(/baseUrl: must be a valid URL/);
  });

  it("allows http://localhost, 127.0.0.1, and [::1] baseUrl for local development", async () => {
    // The escape hatch — keeps the SDK usable against a non-TLS
    // dev server without forcing every test harness to spin up TLS.
    // Covers IPv4, IPv6, and name-based loopback.
    for (const allowed of [
      "http://localhost:8080",
      "http://127.0.0.1:3000",
      "http://[::1]:9000",
      "http://localhost",
    ]) {
      expect(
        () => new QURLClient({ apiKey: "lv_live_test", baseUrl: allowed }),
        `loopback should be allowed: ${allowed}`,
      ).not.toThrow();
    }
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
        error: { title: "Not Found", status: 404, detail: "qURL not found", code: "not_found" },
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

    // Uses a syntactically-valid target_url so the client-side scheme
    // check passes and the mocked 400 response is what trips the
    // ValidationError — the test is asserting error-envelope parsing,
    // not the client-side scheme check.
    const err = await client.create({ target_url: "https://example.com" }).catch((e: unknown) => e);
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

    // Syntactically-valid target_url so the client-side scheme check
    // passes — this test asserts the 422 error-envelope path, not
    // client-side validation.
    await expect(client.create({ target_url: "https://example.com" })).rejects.toThrow(
      ValidationError,
    );
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

  it("retries DELETE on 502 (idempotent — not in the mutating retry set)", async () => {
    // DELETE is intentionally classified as non-mutating for retry
    // purposes: HTTP DELETE is idempotent by spec (deleting an
    // already-deleted resource is a no-op), and 204 responses carry
    // no body to duplicate. Retrying 5xx on DELETE is safe and
    // desirable. Lock this behavior in — a refactor that naively
    // unified DELETE with POST/PATCH under the mutating retry set
    // would silently regress this.
    const badGatewayResponse = {
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

    const noContentResponse = {
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers({}),
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(badGatewayResponse)
      .mockResolvedValueOnce(noContentResponse);
    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    await expect(client.delete("r_abc123def45")).resolves.toBeUndefined();
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

  it("accepts a ResolveInput object in resolve", async () => {
    // The object-overload path is tested indirectly elsewhere, but
    // having an explicit regression lock-in test makes the dual
    // overload contract unambiguous.
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

    await client.resolve({ access_token: "at_object_overload" });

    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(JSON.parse(calledBody)).toEqual({ access_token: "at_object_overload" });
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

  it("parseError logs when the error envelope is missing the `error` key", async () => {
    // Defense-in-depth: if the API ever returns a valid-JSON body that
    // lacks the `error` envelope, parseError falls back to the
    // status-only error shape. That fallback should surface through
    // debugFn so operators can spot the divergence instead of silently
    // serving degraded error messages.
    const debugFn = vi.fn();
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      json: () => Promise.resolve({ unexpected_shape: true, code: "oops" }),
      text: () => Promise.resolve('{"unexpected_shape":true}'),
    } satisfies Partial<Response> as Response);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    await client.getQuota().catch(() => {});

    const messages = debugFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(messages.some((m: string) => m.includes("unexpected error response shape"))).toBe(true);
  });

  it("5xx with JSON body but missing `error` envelope surfaces as ServerError with .code === 'unknown'", async () => {
    // Locks in the documented `.code === "unknown"` sentinel for the
    // parseError fallback path (JSON parses, `error` envelope absent).
    const fetch = mockFetch({ status: 500, body: { unexpected_shape: true } });
    const client = createClient(fetch);

    const error = await client.getQuota().catch((e: unknown) => e as ServerError);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(500);
    expect((error as ServerError).code).toBe(ERROR_CODE_UNKNOWN);
  });

  it("parseError logs when the error body is not valid JSON", async () => {
    // Same operator-observability argument as the unexpected-shape
    // case: a non-JSON error response falls back to the status-only
    // error shape, which should be visible through debugFn.
    const debugFn = vi.fn();
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers({ "content-type": "text/html" }),
      json: () => Promise.reject(new Error("not JSON")),
      text: () => Promise.resolve("<html>upstream down</html>"),
    } satisfies Partial<Response> as Response);

    const client = new QURLClient({
      apiKey: "lv_live_test",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    await client.getQuota().catch(() => {});

    const messages = debugFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(messages.some((m: string) => m.includes("non-JSON error response"))).toBe(true);
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
      apiKey: "lv_live_test",
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
      apiKey: "lv_live_test",
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
      apiKey: "lv_live_test",
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
      apiKey: "lv_live_test",
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

  it("listAll terminates on duplicate cursor (stale-cursor guard)", async () => {
    // If the server has a bug and returns the same cursor on
    // consecutive pages, listAll should break to prevent an
    // infinite loop rather than re-requesting the same page forever.
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
    for await (const qurl of client.listAll()) {
      items.push((qurl as { resource_id: string }).resource_id);
    }
    // Both pages yielded, then iteration stopped.
    expect(items).toEqual(["r_stale1", "r_stale2"]);
    // Only 2 fetches — no infinite loop.
    expect(fetch).toHaveBeenCalledTimes(2);
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
      expect(detail).toContain(key);
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
      apiKey: "lv_live_test",
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

  it("rawRequest wraps non-JSON success (ok path) body in a typed QURLError", async () => {
    // Complementary to the passthrough test above: on the OK path
    // (200-299), a non-JSON body is a server contract violation.
    // Previously this threw a raw SyntaxError with no SDK metadata;
    // now it's wrapped in a QURLError so consumers catching by-class
    // get status/code/detail.
    const nonJsonOkFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      json: () =>
        Promise.reject(new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON")),
      text: () => Promise.resolve("<html>broken response</html>"),
    } satisfies Partial<Response> as Response);

    const client = createClient(nonJsonOkFetch as typeof globalThis.fetch);
    const error = await client.getQuota().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QURLError);
    expect((error as QURLError).status).toBe(200);
    expect((error as QURLError).code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect((error as QURLError).detail).toContain("non-JSON");
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

  it("batch create 400 passthrough works after a 429 retry boundary", async () => {
    // Edge case: first attempt returns 429 (retry-eligible per
    // RETRYABLE_STATUS_MUTATING), retry gets 400 with a populated
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
      apiKey: "lv_live_test",
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
