import { describe, it, expect, vi } from "vitest";
import { ConnectorResource, QURLClient } from "./client.js";
import {
  ConnectorResourceOutcomeUnknownError,
  ERROR_CODE_AMBIGUOUS_RESOURCE,
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ERROR_CODE_UNKNOWN,
  NetworkError,
  QURLError,
  ServerError,
  ValidationError,
} from "./errors.js";
import type { CreateInput, ExtendInput } from "./types.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";
import {
  TARGET_PATH_MAX_LENGTH,
  RESOURCE_CRID,
  SENSITIVE_ACCESS_TOKEN,
  RESPONSE_BODY_LIMIT,
  sizedJSON,
  sizedMultibyteJSON,
  CONNECTOR_RESOURCE_ID,
  connectorResourceData,
} from "./__tests__/client-fixtures.js";

describe("QURLClient", () => {
  it.each([204, 205, 304])("rejects a body-bearing HTTP %i shared mock", async (status) => {
    const fetch = mockFetch({ status, body: { forbidden: true } });

    await expect(fetch("https://example.test")).rejects.toThrow(
      `mock response status ${status} forbids a response body`,
    );
  });

  it("rejects unsupported informational statuses in the shared mock", async () => {
    const fetch = mockFetch({ status: 199 });

    await expect(fetch("https://example.test")).rejects.toThrow(
      "mock response status 199 is unsupported",
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

  it.each([
    [
      "create",
      (c: QURLClient): Promise<unknown> =>
        c.create({ target_url: "https://example.com", label: "" }),
    ],
    ["mintLink", (c: QURLClient): Promise<unknown> => c.mintLink(RESOURCE_CRID, { label: "" })],
  ])("%s rejects empty-string label client-side (server has minLength: 1)", async (_, call) => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await call(client).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("label");
    expect((error as ValidationError).detail).toContain("empty");
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

  it("create rejects custom_domain: '' (empty string)", async () => {
    // Symmetric with the empty-string label rejection — an untyped-JS
    // caller passing `""` would otherwise round-trip to the server.
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({ target_url: "https://example.com", custom_domain: "" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("custom_domain");
    expect((error as ValidationError).detail).toContain("must not be an empty string");
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

    for (const badUrl of [null, 42, { toString: () => "evil" }, []]) {
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

  it("create rejects non-boolean one_time_use for untyped callers", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .create({
        target_url: "https://example.com",
        one_time_use: "yes" as unknown as boolean,
      })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("one_time_use: must be a boolean");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("legacy write methods reject unknown fields before making requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const createError = await client
      .create({
        target_url: "https://example.com",
        ignored: true,
      } as unknown as Parameters<QURLClient["create"]>[0])
      .catch((e: unknown) => e as ValidationError);
    expect(createError).toBeInstanceOf(ValidationError);
    expect(createError.detail).toContain('create: unknown field "ignored"');

    const updateError = await client
      .update(RESOURCE_CRID, {
        description: "primary",
        ignored: true,
      } as unknown as Parameters<QURLClient["update"]>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(updateError).toBeInstanceOf(ValidationError);
    expect(updateError.detail).toContain('update: unknown field "ignored"');

    const mintError = await client
      .mintLink(RESOURCE_CRID, {
        expires_in: "1h",
        ignored: true,
      } as unknown as Parameters<QURLClient["mintLink"]>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(mintError).toBeInstanceOf(ValidationError);
    expect(mintError.detail).toContain('mintLink: unknown field "ignored"');
    expect(fetch).not.toHaveBeenCalled();
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
    const result = await client.get(RESOURCE_CRID);

    expect(result.resource_id).toBe("r_empty_tokens");
    expect(result.access_tokens).toEqual([]);
    // The wire-format key must be removed from the consumer-facing object.
    expect((result as unknown as { qurls?: unknown[] }).qurls).toBeUndefined();
  });

  it("new resource methods reject empty IDs before making requests", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(client.getResource("")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.revokeResourceQurl(RESOURCE_CRID, "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(client.listWebhookDeliveries("")).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["empty resource ID", "", "q_0123456789a"],
    ["whitespace-only resource ID", "   ", "q_0123456789a"],
    ["empty qURL ID", RESOURCE_CRID, ""],
    ["whitespace-only qURL ID", RESOURCE_CRID, "   "],
    ["dot-segment resource ID", ".", "q_0123456789a"],
    ["dot-segment qURL ID", RESOURCE_CRID, ".."],
    ["access-token resource ID", SENSITIVE_ACCESS_TOKEN, "q_0123456789a"],
    ["access-token qURL ID", RESOURCE_CRID, SENSITIVE_ACCESS_TOKEN],
  ])("revokeResourceQurl rejects a %s before fetch", async (_label, resourceId, qurlId) => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.revokeResourceQurl(resourceId, qurlId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource validates shared qURL token options client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createQurlForResource(RESOURCE_CRID, { max_sessions: 1001 })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("max_sessions");
    expect(error.detail).toContain("1000");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource rejects non-boolean one_time_use for untyped callers", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createQurlForResource(RESOURCE_CRID, { one_time_use: "yes" as unknown as boolean })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("one_time_use: must be a boolean");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource rejects non-object bodies before making requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createQurlForResource(
        RESOURCE_CRID,
        [] as Parameters<QURLClient["createQurlForResource"]>[1],
      )
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("createQurlForResource: input must be an object");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource rejects an empty target_path before making requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createQurlForResource(RESOURCE_CRID, { target_path: "" })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("target_path: must not be an empty string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource rejects target_path over 2048 UTF-8 bytes before requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);
    const overlongTargetPath = `/${"é".repeat(1024)}`;
    expect(new TextEncoder().encode(overlongTargetPath)).toHaveLength(TARGET_PATH_MAX_LENGTH + 1);

    const error = await client
      .createQurlForResource(RESOURCE_CRID, { target_path: overlongTargetPath })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain(
      `target_path: must be ${TARGET_PATH_MAX_LENGTH} UTF-8 bytes or fewer`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createQurlForResource rejects a non-string target_path before making requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createQurlForResource(RESOURCE_CRID, { target_path: 42 } as never)
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("target_path: must be a string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateResourceQurl validates shared qURL token options client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .updateResourceQurl(RESOURCE_CRID, "q_y", { max_sessions: 1001 })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("max_sessions");
    expect(error.detail).toContain("1000");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("new PATCH methods reject empty bodies before making requests", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(client.updateResource(RESOURCE_CRID, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(client.updateResourceQurl(RESOURCE_CRID, "q_y", {})).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(client.updateWebhook("wh_x", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(client.updateApiKey("key_x", {})).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("new PATCH methods normalize null fields before validation and serialization", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await client.updateResource(RESOURCE_CRID, {
      description: "primary",
      tags: null as unknown as string[],
      custom_domain: null as unknown as string,
      preserve_host: null as unknown as boolean,
    });
    await client.updateResourceQurl(RESOURCE_CRID, "q_y", {
      extend_by: null as unknown as string,
      expires_at: "2026-04-01T00:00:00Z",
      label: null as unknown as string,
    });
    await client.updateWebhook("wh_x", {
      description: null as unknown as string,
      events: null as unknown as string[],
      status: "disabled",
    });
    await client.updateApiKey("key_x", {
      name: "dashboard",
      scopes: null as unknown as string[],
    });

    const bodies = vi.mocked(fetch).mock.calls.map((call) => {
      return JSON.parse(call[1]?.body as string) as unknown;
    });
    expect(bodies).toEqual([
      { description: "primary" },
      { expires_at: "2026-04-01T00:00:00Z" },
      { status: "disabled" },
      { name: "dashboard" },
    ]);
  });

  it("new PATCH methods reject null-only bodies after normalization", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(
      client.updateResource(RESOURCE_CRID, { description: null as unknown as string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateResourceQurl(RESOURCE_CRID, "q_y", { extend_by: null as unknown as string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateWebhook("wh_x", { description: null as unknown as string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateApiKey("key_x", { scopes: null as unknown as string[] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateResource sends empty custom_domain as the clear-domain signal", async () => {
    const fetch = mockFetch({ status: 200, body: { data: { resource_id: "r_x" } } });
    const client = createClient(fetch);

    await client.updateResource(RESOURCE_CRID, { custom_domain: "" });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    expect(body).toEqual({ custom_domain: "" });
  });

  it("updateResource rejects unaccepted fields before making requests", async () => {
    const fetch = mockFetch({ status: 200, body: { data: { resource_id: "r_x" } } });
    const client = createClient(fetch);

    const error = await client
      .updateResource(RESOURCE_CRID, {
        description: "primary",
        target_url: "ftp://example.com",
      } as unknown as Parameters<QURLClient["updateResource"]>[1])
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain('updateResource: unknown field "target_url"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("new write methods reject unknown fields before making requests", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "createQurlForResource",
        () =>
          client.createQurlForResource(RESOURCE_CRID, {
            expires_in: "1h",
            ignored: true,
          } as unknown as Parameters<QURLClient["createQurlForResource"]>[1]),
      ],
      [
        "updateResourceQurl",
        () =>
          client.updateResourceQurl(RESOURCE_CRID, "q_y", {
            label: "primary",
            ignored: true,
          } as unknown as Parameters<QURLClient["updateResourceQurl"]>[2]),
      ],
      [
        "updateCustomer",
        () =>
          client.updateCustomer({
            spending_cap_cents: 5000,
            ignored: true,
          } as unknown as Parameters<QURLClient["updateCustomer"]>[0]),
      ],
      [
        "createBillingCheckout",
        () =>
          client.createBillingCheckout({
            plan: "starter",
            ignored: true,
          } as unknown as Parameters<QURLClient["createBillingCheckout"]>[0]),
      ],
      [
        "registerDomain",
        () =>
          client.registerDomain({
            domain: "example.com",
            ignored: true,
          } as unknown as Parameters<QURLClient["registerDomain"]>[0]),
      ],
      [
        "createWebhook",
        () =>
          client.createWebhook({
            url: "https://example.com/hook",
            events: ["qurl.created"],
            ignored: true,
          } as unknown as Parameters<QURLClient["createWebhook"]>[0]),
      ],
      [
        "updateWebhook",
        () =>
          client.updateWebhook("wh_x", {
            description: "primary",
            ignored: true,
          } as unknown as Parameters<QURLClient["updateWebhook"]>[1]),
      ],
      [
        "createApiKey",
        () =>
          client.createApiKey({
            name: "dashboard",
            scopes: ["qurl:read"],
            ignored: true,
          } as unknown as Parameters<QURLClient["createApiKey"]>[0]),
      ],
      [
        "updateApiKey",
        () =>
          client.updateApiKey("key_x", {
            name: "dashboard",
            ignored: true,
          } as unknown as Parameters<QURLClient["updateApiKey"]>[1]),
      ],
      [
        "redeemAccessCode",
        () =>
          client.redeemAccessCode({
            code: "invite-code",
            ignored: true,
          } as unknown as Parameters<QURLClient["redeemAccessCode"]>[0]),
      ],
      [
        "createAccessCode",
        () =>
          client.createAccessCode({
            resource_id: "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
            ignored: true,
          } as unknown as Parameters<QURLClient["createAccessCode"]>[0]),
      ],
    ];

    for (const [method, call] of cases) {
      const error = await call().catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.detail).toContain(`${method}: unknown field "ignored"`);
    }

    const multiFieldError = await client
      .createBillingCheckout({
        plan: "starter",
        ignored: true,
        also_ignored: true,
      } as unknown as Parameters<QURLClient["createBillingCheckout"]>[0])
      .catch((e: unknown) => e as ValidationError);
    expect(multiFieldError).toBeInstanceOf(ValidationError);
    expect(multiFieldError.detail).toContain(
      'createBillingCheckout: unknown fields "ignored", "also_ignored"',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateCustomer rejects invalid spending caps client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(client.updateCustomer({ spending_cap_cents: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(client.updateCustomer({ spending_cap_cents: 1.5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateCustomer rejects missing spending caps with a required-field error", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .updateCustomer({} as Parameters<QURLClient["updateCustomer"]>[0])
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("spending_cap_cents is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createWebhook rejects non-http URLs client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createWebhook({ url: "ftp://example.com/hook", events: ["qurl.created"] })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("url: must start with http:// or https://");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createWebhook rejects non-string event entries client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createWebhook({ url: "https://example.com/hook", events: ["" as never] })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("createWebhook: events[0] must be a non-empty string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createApiKey rejects non-string scope entries client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createApiKey({ name: "dashboard", scopes: ["" as never] })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("createApiKey: scopes[0] must be a non-empty string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createApiKey rejects missing required fields client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(
      client.createApiKey({ scopes: ["qurl:read"] } as Parameters<QURLClient["createApiKey"]>[0]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.createApiKey({ name: "dashboard" } as Parameters<QURLClient["createApiKey"]>[0]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createApiKey rejects target/claims on a durable api_key client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const field of ["target", "claims"] as const) {
      const error = await client
        .createApiKey({
          name: "dashboard",
          scopes: ["qurl:read"],
          [field]: field === "target" ? "connector" : [{ type: "connector", id: "prod-dashboard" }],
        })
        .catch((e: unknown) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.detail).toContain(`${field} is only accepted for kind 'enrollment_token'`);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createApiKey rejects scopes on an enrollment token client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createApiKey({
        kind: "enrollment_token",
        name: "bound enrollment",
        target: "agent",
        scopes: ["qurl:agent"],
      })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("not accepted for kind 'enrollment_token'");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing durable scopes", { name: "bad" }, "scopes"],
    [
      "a null claim",
      { kind: "enrollment_token", name: "bad", claims: [null] },
      "must be an object",
    ],
    [
      "an array claim",
      { kind: "enrollment_token", name: "bad", claims: [[]] },
      "must be an object",
    ],
    ["an unknown kind", { kind: "future", name: "bad", scopes: ["qurl:read"] }, "kind must be"],
    [
      "the system-only device kind",
      { kind: "device", name: "bad", scopes: ["qurl:read"] },
      "kind must be",
    ],
    [
      "expires_in on a durable key",
      { kind: "api_key", name: "bad", scopes: ["qurl:read"], expires_in: "1h" },
      "expires_in is only accepted",
    ],
    [
      "an unknown durable scope",
      { kind: "api_key", name: "bad", scopes: ["admin"] },
      "unsupported permission",
    ],
    [
      "an unknown target",
      { kind: "enrollment_token", name: "bad", target: "future" },
      "target must be",
    ],
    [
      "a non-string target",
      { kind: "enrollment_token", name: "bad", target: 42 },
      "target must be",
    ],
    [
      "a connector target without a claim",
      { kind: "enrollment_token", name: "bad", target: "connector" },
      "requires exactly one claim",
    ],
    [
      "a connector target with an empty claim list",
      { kind: "enrollment_token", name: "bad", target: "connector", claims: [] },
      "requires exactly one claim",
    ],
    [
      "more than one claim",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [
          { type: "connector", id: "one" },
          { type: "connector", id: "two" },
        ],
      },
      "at most one claim",
    ],
    [
      "more than one claim with an explicit connector target",
      {
        kind: "enrollment_token",
        name: "bad",
        target: "connector",
        claims: [
          { type: "connector", id: "one" },
          { type: "connector", id: "two" },
        ],
      },
      "at most one claim",
    ],
    [
      "a non-array claims value",
      { kind: "enrollment_token", name: "bad", claims: { type: "connector", id: "abc" } },
      "claims must be an array",
    ],
    [
      "a non-object claim",
      { kind: "enrollment_token", name: "bad", claims: ["abc"] },
      "claims[0] must be an object",
    ],
    [
      "an invalid claim",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [{ type: "connector", id: "Bad ID" }],
      },
      "not a valid connector slug",
    ],
    [
      "a two-character connector slug",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [{ type: "connector", id: "ab" }],
      },
      "not a valid connector slug",
    ],
    [
      "a 65-character connector slug",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [{ type: "connector", id: "a".repeat(65) }],
      },
      "not a valid connector slug",
    ],
    [
      "an unknown claim type",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [{ type: "agent", id: "prod-dashboard" }],
      },
      "claims[0].type must be 'connector'",
    ],
    [
      "an unknown claim field",
      {
        kind: "enrollment_token",
        name: "bad",
        claims: [{ type: "connector", id: "prod-dashboard", extra: true }],
      },
      'claims[0]: unknown field "extra"',
    ],
    [
      "a zero lifetime",
      { kind: "enrollment_token", name: "bad", expires_in: "0s" },
      "greater than zero and at most 24h",
    ],
    [
      "a lifetime over 24h",
      { kind: "enrollment_token", name: "bad", expires_in: "86401s" },
      "greater than zero and at most 24h",
    ],
    [
      "a one-week lifetime",
      { kind: "enrollment_token", name: "bad", expires_in: "1w" },
      "greater than zero and at most 24h",
    ],
    [
      "a non-string lifetime",
      { kind: "enrollment_token", name: "bad", expires_in: 3600 },
      "expires_in must be a duration string",
    ],
    [
      "a malformed lifetime",
      { kind: "enrollment_token", name: "bad", expires_in: "hour" },
      "must match",
    ],
  ])("createApiKey rejects %s before fetch", async (_name, input, expectedDetail) => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });

    const error = await createClient(fetch)
      .createApiKey(input as Parameters<QURLClient["createApiKey"]>[0])
      .catch((caught: unknown) => caught as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain(expectedDetail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateApiKey rejects scopes outside the current service request enum", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await expect(
      createClient(fetch).updateApiKey("key_abc123def456", { scopes: ["future:scope"] }),
    ).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("unsupported permission"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createApiKey rejects the retired key_type/tunnel_slug/purpose fields", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    for (const retired of ["key_type", "tunnel_slug", "purpose"]) {
      await expect(
        client.createApiKey({
          name: "dashboard",
          scopes: ["qurl:read"],
          [retired]: "x",
        } as Parameters<QURLClient["createApiKey"]>[0]),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("new required-body methods reject missing required fields client-side", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const cases: Array<[string, () => Promise<unknown>, string]> = [
      [
        "createBillingCheckout",
        () =>
          client.createBillingCheckout({} as Parameters<QURLClient["createBillingCheckout"]>[0]),
        "plan",
      ],
      [
        "redeemAccessCode",
        () => client.redeemAccessCode({} as Parameters<QURLClient["redeemAccessCode"]>[0]),
        "code",
      ],
      [
        "createAccessCode",
        () => client.createAccessCode({} as Parameters<QURLClient["createAccessCode"]>[0]),
        "resource_id",
      ],
    ];

    for (const [method, call, field] of cases) {
      const error = await call().catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.detail).toContain(method);
      expect(error.detail).toContain(field);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registerDomain rejects domains over the contract maximum", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .registerDomain({ domain: "a".repeat(254) })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("domain: must be 253 characters or fewer");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("domain path validators use domain-specific error labels", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const emptyCalls = [
      () => client.getDomain(""),
      () => client.deleteDomain(""),
      () => client.verifyDomain(""),
      () => client.regenerateDomainToken(""),
    ];
    for (const call of emptyCalls) {
      const error = await call().catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.detail).toContain("domain is required");
    }

    const whitespaceError = await client
      .getDomain(" example.com ")
      .catch((e: unknown) => e as ValidationError);
    expect(whitespaceError).toBeInstanceOf(ValidationError);
    expect(whitespaceError.detail).toContain(
      "domain must not include leading or trailing whitespace",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createResource validates shared resource fields client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createResource({ target_url: "ftp://example.com" })
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("http:// or https://");

    const emptyDomain = await client
      .createResource({ target_url: "https://example.com", custom_domain: "" })
      .catch((e: unknown) => e as ValidationError);
    expect(emptyDomain).toBeInstanceOf(ValidationError);
    expect(emptyDomain.detail).toContain("custom_domain: must not be an empty string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createResource rejects unknown fields before making requests", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createResource({
        type: "tunnel",
        slug: "prod-dashboard",
        target_url_override: "https://example.com",
      } as unknown as Parameters<QURLClient["createResource"]>[0])
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain('createResource: unknown field "target_url_override"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resource write methods reject non-boolean option fields client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    await expect(
      client.createResource({
        type: "tunnel",
        slug: "prod-dashboard",
        find_or_create: "yes" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateResource(RESOURCE_CRID, {
        description: "primary",
        preserve_host: "yes" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resource write methods reject non-string text fields client-side", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const createError = await client
      .createResource({
        type: "tunnel",
        slug: "prod-dashboard",
        description: 42 as unknown as string,
      })
      .catch((e: unknown) => e as ValidationError);
    expect(createError).toBeInstanceOf(ValidationError);
    expect(createError.detail).toContain("description: must be a string");

    const updateError = await client
      .updateResource(RESOURCE_CRID, {
        custom_domain: { hostname: "example.com" } as unknown as string,
      })
      .catch((e: unknown) => e as ValidationError);
    expect(updateError).toBeInstanceOf(ValidationError);
    expect(updateError.detail).toContain("custom_domain: must be a string");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("createResource aggregates resource field validation errors", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .createResource({
        type: 42,
        description: 42,
        custom_domain: "",
        alias: "",
        slug: "",
        find_or_create: "yes",
      } as unknown as Parameters<QURLClient["createResource"]>[0])
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("type: must be a string");
    expect(error.detail).toContain("description: must be a string");
    expect(error.detail).toContain("custom_domain: must not be an empty string");
    expect(error.detail).toContain("alias: must not be an empty string");
    expect(error.detail).toContain("slug: must not be an empty string");
    expect(error.detail).toContain("find_or_create: must be a boolean");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mints a portal from the validated Connector handle", async () => {
    const fetch = mockFetches([
      {
        status: 201,
        body: { data: connectorResourceData(), meta: { found_existing: false } },
      },
      {
        status: 201,
        body: {
          data: {
            resource_id: CONNECTOR_RESOURCE_ID,
            crid: RESOURCE_CRID,
            qurl_link: "https://qurl.link/#at_connector",
            target_path: "/api/detect",
          },
        },
      },
    ]);
    const client = createClient(fetch);

    const { resource } = await client.ensureConnectorResource("prod-dashboard");
    const portal = await resource.createPortal({ validFor: "5m", targetPath: "/api/detect" });

    expect(portal.crid).toBe(RESOURCE_CRID);
    expect(portal.targetPath).toBe("/api/detect");
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `https://api.test.layerv.ai/v1/resources/${RESOURCE_CRID}/qurls`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects an invalid connector ensure slug before dispatch", async () => {
    const fetch = mockFetch({ status: 201, body: { data: connectorResourceData() } });

    await expect(createClient(fetch).ensureConnectorResource("UPPER")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves pre-dispatch connector ensure validation as a known rejection", async () => {
    const fetch = mockFetch({ status: 201, body: {} });

    const error = await createClient(fetch)
      .ensureConnectorResource("prod-dashboard", { idempotencyKey: " padded " })
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error.code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails connector ensure closed without outcome-unknown when metadata is missing", async () => {
    const fetch = mockFetch({ status: 201, body: { data: connectorResourceData(), meta: {} } });

    const error = await createClient(fetch)
      .ensureConnectorResource("prod-dashboard")
      .catch((caught: unknown) => caught as QURLError);

    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error).toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: expect.stringContaining("reconcile by slug before retrying"),
    });
  });

  it("marks invalid connector ensure metadata as outcome-unknown", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: connectorResourceData(), meta: { found_existing: "yes" } },
    });

    await expect(
      createClient(fetch).ensureConnectorResource("prod-dashboard"),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      cause: { code: ERROR_CODE_UNEXPECTED_RESPONSE },
    });
  });

  it.each([false, 1, "metadata", []])(
    "marks invalid connector ensure meta container %j as outcome-unknown",
    async (meta) => {
      const fetch = mockFetch({
        status: 201,
        body: { data: connectorResourceData(), meta },
      });

      await expect(
        createClient(fetch).ensureConnectorResource("prod-dashboard"),
      ).rejects.toMatchObject({
        constructor: ConnectorResourceOutcomeUnknownError,
        cause: { code: ERROR_CODE_UNEXPECTED_RESPONSE },
      });
    },
  );

  it("preserves an authoritative connector ensure 4xx as a known rejection", async () => {
    const fetch = mockFetch({
      status: 409,
      body: { error: { status: 409, code: "slug_in_use", title: "Conflict" } },
    });

    const error = await createClient(fetch)
      .ensureConnectorResource("prod-dashboard")
      .catch((caught: unknown) => caught as QURLError);

    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error).toMatchObject({ status: 409, code: "slug_in_use" });
  });

  it.each([CONNECTOR_RESOURCE_ID, "r_private", "", "at_secret", `${RESOURCE_CRID}a`])(
    "rejects non-CRID Connector addresses before HTTP: %s",
    async (id) => {
      const fetch = mockFetch({ status: 204 });
      const client = createClient(fetch);
      await expect(client.getConnectorResource(id)).rejects.toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
      });
      await expect(client.deleteConnectorResource(id)).rejects.toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a valid Connector key response that does not match the requested CRID", async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", pair.publicKey));
    const otherResourceId = btoa(String.fromCharCode(...der))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const fetch = mockFetch({
      status: 200,
      body: { data: { resource: connectorResourceData({ resource_id: otherResourceId }) } },
    });

    await expect(createClient(fetch).getConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it.each([
    ["missing", []],
    ["ambiguous", [connectorResourceData(), connectorResourceData()]],
  ])("rejects a %s connector slug lookup result", async (kind, data) => {
    const fetch = mockFetch({ status: 200, body: { data } });
    const client = createClient(fetch);

    const error = await client
      .getConnectorResourceBySlug("prod-dashboard")
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    expect(error.code).toBe(kind === "missing" ? "resource_not_found" : "ambiguous_resource");
  });

  it("preserves an authoritative connector delete 4xx as a known rejection", async () => {
    const fetch = mockFetch({
      status: 409,
      body: { error: { status: 409, code: "resource_conflict", title: "Conflict" } },
    });

    const error = await createClient(fetch)
      .deleteConnectorResource(RESOURCE_CRID)
      .catch((caught: unknown) => caught as QURLError);

    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error).toMatchObject({ status: 409, code: "resource_conflict" });
  });

  it.each([
    ["ensure", (client: QURLClient) => client.ensureConnectorResource("prod-dashboard")],
    ["delete", (client: QURLClient) => client.deleteConnectorResource(RESOURCE_CRID)],
  ] as const)("preserves a connector %s HTTP 408 as a known rejection", async (_name, invoke) => {
    const fetch = mockFetch({
      status: 408,
      body: { error: { status: 408, code: "request_timeout", title: "Request Timeout" } },
    });

    const error = await invoke(createClient(fetch)).catch((caught: unknown) => caught as QURLError);

    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error).toMatchObject({ status: 408, code: "request_timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an authoritative repeated connector delete 404 as a known rejection", async () => {
    const fetch = mockFetch({
      status: 404,
      body: { error: { status: 404, code: "resource_not_found", title: "Not Found" } },
    });

    const error = await createClient(fetch)
      .deleteConnectorResource(RESOURCE_CRID)
      .catch((caught: unknown) => caught as QURLError);

    expect(error).not.toBeInstanceOf(ConnectorResourceOutcomeUnknownError);
    expect(error).toMatchObject({ status: 404, code: "resource_not_found" });
  });

  it("treats multiple rows as ambiguous before row validation", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [connectorResourceData({ status: "pending" }), connectorResourceData()],
      },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).rejects.toMatchObject({ code: ERROR_CODE_AMBIGUOUS_RESOURCE });
  });

  it.each([null, "not-an-object"])(
    "fails closed on malformed connector slug row %j",
    async (row) => {
      const fetch = mockFetch({ status: 200, body: { data: [row] } });

      await expect(
        createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
      ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
    },
  );

  it("fails closed on a malformed connector slug row alongside a valid row", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [null, connectorResourceData()] },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).rejects.toMatchObject({ code: ERROR_CODE_AMBIGUOUS_RESOURCE });
  });

  it.each([
    [
      "missing routing and admission IDs",
      { connector_routing_id: undefined, knock_resource_id: undefined },
    ],
    ["invalid CRID", { crid: 42 }],
  ])(
    "validates a revoked by-ID row with %s before lifecycle classification",
    async (_name, overrides) => {
      const fetch = mockFetch({
        status: 200,
        body: {
          data: { resource: connectorResourceData({ status: "revoked", ...overrides }) },
        },
      });

      await expect(createClient(fetch).getConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
      });
    },
  );

  it("rejects direct ConnectorResource construction outside validated client responses", () => {
    const client = createClient(mockFetch({ status: 200 }));

    expect(() => Reflect.construct(ConnectorResource, [client, connectorResourceData()])).toThrow(
      ValidationError,
    );
  });

  it.each(["", "ab", "UPPER", "-bad", "bad-"])(
    "rejects invalid connector slug %s before fetch",
    async (slug) => {
      const fetch = mockFetch({ status: 200, body: { data: [] } });
      const client = createClient(fetch);

      await expect(client.getConnectorResourceBySlug(slug)).rejects.toBeInstanceOf(ValidationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a connector resource ID whose DER is not a P-256 key before fetch", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(
      client.getConnectorResource(`A${CONNECTOR_RESOURCE_ID.slice(1)}`),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical connector resource ID spelling before fetch", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const nonCanonical = `${CONNECTOR_RESOURCE_ID.slice(0, -1)}B`;

    await expect(client.getConnectorResource(nonCanonical)).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical connector resource ID before delete fetch", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(
      client.deleteConnectorResource(`A${CONNECTOR_RESOURCE_ID.slice(1)}`),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects HTTP 202 for a no-content DELETE contract", async () => {
    const fetch = mockFetch({ status: 202, body: { data: {} } });

    await expect(createClient(fetch).delete(RESOURCE_CRID)).rejects.toMatchObject({
      status: 202,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: expect.stringContaining("received HTTP 202"),
      message: expect.stringContaining("may already have been applied"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty HTTP 200 for a no-content DELETE contract", async () => {
    const fetch = mockFetch({ status: 200 });

    await expect(createClient(fetch).delete(RESOURCE_CRID)).rejects.toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: expect.stringContaining("received HTTP 200 with an empty body"),
      message: expect.stringContaining("may already have been applied"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-empty body on a nominal 204 mutation response", async () => {
    const response = {
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers({}),
      body: undefined,
      text: () => Promise.resolve("unexpected"),
      json: () => Promise.resolve(undefined),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(
      createClient(fetch as typeof globalThis.fetch).delete(RESOURCE_CRID),
    ).rejects.toMatchObject({
      status: 204,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: expect.stringContaining("with response bytes"),
      message: expect.stringContaining("may already have been applied"),
    });
  });

  it("rejects non-CRID addressing: treats resource IDs as opaque and leaves endpoint grammar to the service", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.delete("future-resource-id-format")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects qURL display IDs before a destructive whole-resource delete", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const displayId = "q_0123456789a";
    const error = await client.delete(displayId).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("qURL display ID");
    expect((error as ValidationError).detail).toContain("revokeResourceQurl(crid, qurlId)");
    expect((error as ValidationError).detail).not.toContain(displayId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects access tokens before they can enter a request URL", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const accessToken = SENSITIVE_ACCESS_TOKEN;

    const error = await client.delete(accessToken).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).toContain("pass a CRID returned by the API");
    expect((error as ValidationError).detail).not.toContain(accessToken);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["AT_sensitive-token-value", "qurl.link/open?token=AT_sensitive-token-value"])(
    "delete rejects case-variant credential input %s",
    async (credential) => {
      const fetch = mockFetch({ status: 204 });

      const error = await createClient(fetch)
        .delete(credential)
        .catch((caught: unknown) => caught as ValidationError);

      expect(error).toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
        detail: expect.stringContaining("access token"),
      });
      expect((error as ValidationError).detail).not.toContain(credential);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("delete rejects a full qURL link before its token can enter a request URL", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const qurlLink = `https://qurl.link/#${SENSITIVE_ACCESS_TOKEN}`;

    const error = await client.delete(qurlLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(qurlLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a qURL link when its credential is in the query", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const qurlLink = `https://qurl.link/open?token=${SENSITIVE_ACCESS_TOKEN}`;

    const error = await client.delete(qurlLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(qurlLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a scheme-less link carrying an access token in its query", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const qurlLink = `qurl.link/open?token=${SENSITIVE_ACCESS_TOKEN}`;

    const error = await client.delete(qurlLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(qurlLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a scheme-less link whose first query value is an access token", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const qurlLink = `qurl.link/open?${SENSITIVE_ACCESS_TOKEN}`;

    const error = await client.delete(qurlLink).catch((e: unknown) => e as ValidationError);

    expect(error).toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("access token"),
    });
    expect((error as ValidationError).detail).not.toContain(qurlLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a scheme-less link whose access token is a path segment", async () => {
    const fetch = mockFetch({ status: 204 });
    const qurlLink = `qurl.link/${SENSITIVE_ACCESS_TOKEN}`;

    const error = await createClient(fetch)
      .delete(qurlLink)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error).toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("access token"),
    });
    expect((error as ValidationError).detail).not.toContain(qurlLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a percent-encoded bare access token", async () => {
    const fetch = mockFetch({ status: 204 });
    const encodedToken = "%61t_sensitive-token-value";

    const error = await createClient(fetch)
      .delete(encodedToken)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error).toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("access token"),
    });
    expect((error as ValidationError).detail).not.toContain(encodedToken);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["Bearer at_sensitive-token-value", "token:at_sensitive-token-value"])(
    "delete rejects the pasted credential form %s",
    async (credential) => {
      const fetch = mockFetch({ status: 204 });
      const error = await createClient(fetch)
        .delete(credential)
        .catch((caught: unknown) => caught as ValidationError);

      expect(error).toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
        detail: expect.stringContaining("access token"),
      });
      expect((error as ValidationError).detail).not.toContain(credential);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("delete rejects an access token pasted after a non-URL path fragment", async () => {
    const fetch = mockFetch({ status: 204 });
    const credential = `open/${SENSITIVE_ACCESS_TOKEN}`;

    const error = await createClient(fetch)
      .delete(credential)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.detail).toContain("access token");
    expect(error.detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a percent-encoded qURL link before its token can reach request logs", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const encodedLink = encodeURIComponent(`https://qurl.link/#${SENSITIVE_ACCESS_TOKEN}`);

    const error = await client.delete(encodedLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(encodedLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a repeatedly encoded qURL link before its token can reach request logs", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const encodedLink = encodeURIComponent(
      encodeURIComponent(`https://qurl.link/#${SENSITIVE_ACCESS_TOKEN}`),
    );

    const error = await client.delete(encodedLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(encodedLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects a triple-encoded qURL link at the bounded decode limit", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const encodedLink = encodeURIComponent(
      encodeURIComponent(encodeURIComponent(`https://qurl.link/#${SENSITIVE_ACCESS_TOKEN}`)),
    );

    const error = await client.delete(encodedLink).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("access token");
    expect((error as ValidationError).detail).not.toContain(encodedLink);
    expect((error as ValidationError).detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["%2e", "%2E", "%2e%2e", "%252e", "%252e%252e"])(
    "delete rejects the encoded URL dot-segment identifier %s",
    async (resourceId) => {
      const fetch = mockFetch({ status: 204 });
      const client = createClient(fetch);

      await expect(client.delete(resourceId)).rejects.toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
        detail: expect.stringContaining("invalid URL path segment"),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects non-CRID addressing: leaves input beyond the three-pass decode inspection bound to the service", async () => {
    const resourceId = "%2525252e";
    const fetch = mockFetch({ status: 204 });

    await expect(createClient(fetch).delete(resourceId)).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a pre-encoded qURL display ID before whole-resource deletion", async () => {
    const fetch = mockFetch({ status: 204 });

    await expect(createClient(fetch).delete("%71_0123456789a")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("qURL display ID"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deleteResource rejects qURL display IDs before whole-resource deletion", async () => {
    const fetch = mockFetch({ status: 204 });
    await expect(createClient(fetch).deleteResource("q_0123456789a")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("qURL display ID"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects future q_-prefixed display IDs before whole-resource deletion", async () => {
    const fetch = mockFetch({ status: 204 });

    await expect(createClient(fetch).delete("q_future-display-id")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("qURL display ID"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["Q_0123456789a", "%51_0123456789a"])(
    "rejects case-variant qURL display ID %s before whole-resource deletion",
    async (displayId) => {
      const fetch = mockFetch({ status: 204 });

      await expect(createClient(fetch).delete(displayId)).rejects.toMatchObject({
        code: ERROR_CODE_CLIENT_VALIDATION,
        detail: expect.stringContaining("qURL display ID"),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("bounds path identifier inspection before repeated decoding", async () => {
    const accepted = "x".repeat(4096);
    const acceptedFetch = mockFetch({ status: 204 });
    await expect(createClient(acceptedFetch).delete(accepted)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(acceptedFetch).not.toHaveBeenCalled();

    const rejected = "x".repeat(4097);
    const rejectedFetch = mockFetch({ status: 204 });
    const error = await createClient(rejectedFetch)
      .delete(rejected)
      .catch((caught: unknown) => caught as ValidationError);
    expect(error).toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("4096 characters or fewer"),
    });
    expect((error as ValidationError).detail).not.toContain(rejected);
    expect(rejectedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["get", (client: QURLClient, id: string) => client.get(id)],
    ["update", (client: QURLClient, id: string) => client.update(id, { label: "updated" })],
    ["extend", (client: QURLClient, id: string) => client.extend(id, { extend_by: "1h" })],
    ["mintLink", (client: QURLClient, id: string) => client.mintLink(id, {})],
  ])("%s rejects a case-variant bare access token before fetch", async (_name, invoke) => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await expect(invoke(createClient(fetch), "AT_sensitive-token-value")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("access token"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([".", ".."])("delete rejects the URL dot-segment identifier %s", async (resourceId) => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client.delete(resourceId).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("invalid URL path segment");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-CRID addressing: keeps opaque resource IDs inside one encoded URL segment", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.delete("a/../b?force=true")).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
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
      expect((error as ValidationError).detail).toContain("delete: id is required");
      expect((error as ValidationError).detail).toContain(
        badId === null ? "got null" : `got ${typeof badId}`,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delete rejects empty and whitespace-only IDs", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    for (const badId of ["", " ", "\t"]) {
      const error = await client.delete(badId).catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain("delete: id is required");
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

  it("path id validators reject leading or trailing whitespace before encoding", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const getError = await client.getResource(" r_x ").catch((e: unknown) => e as ValidationError);
    expect(getError).toBeInstanceOf(ValidationError);
    expect(getError.detail).toContain("leading or trailing whitespace");

    const deleteError = await client.delete(" r_x ").catch((e: unknown) => e as ValidationError);
    expect(deleteError).toBeInstanceOf(ValidationError);
    expect(deleteError.detail).toContain("leading or trailing whitespace");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("shared path id validation rejects URL dot segments before encoding", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client.deleteResource("..").catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("invalid URL path segment");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "revokeResourceQurl",
      (client: QURLClient, id: string) => client.revokeResourceQurl(RESOURCE_CRID, id),
    ],
    [
      "updateResourceQurl",
      (client: QURLClient, id: string) =>
        client.updateResourceQurl(RESOURCE_CRID, id, { extend_by: "1h" }),
    ],
  ])("%s applies path safety and length bounds to secondary qURL IDs", async (_name, invoke) => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    await expect(invoke(client, "Bearer at_sensitive-token-value")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("access token"),
    });
    await expect(invoke(client, "x".repeat(4097))).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("4096 characters or fewer"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([SENSITIVE_ACCESS_TOKEN, `https://qurl.link/#${SENSITIVE_ACCESS_TOKEN}`])(
    "shared path id validation rejects credential input %s",
    async (credential) => {
      const fetch = mockFetch({ status: 200, body: { data: {} } });
      const client = createClient(fetch);

      const error = await client
        .getResource(credential)
        .catch((e: unknown) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain("access token");
      expect((error as ValidationError).detail).not.toContain(credential);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("labels an invalid terminateResourceSession session ID accurately", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client
      .terminateResourceSession(RESOURCE_CRID, " ")
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("session id is required");
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

  it("extend validates id before input shape", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    const error = await client
      .extend("", null as unknown as ExtendInput)
      .catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("extend: id is required");
    expect(error.detail).not.toContain("input must be an object");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend rejects null/undefined input with structured ValidationError", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const badInput of [null, undefined]) {
      const error = await client
        .extend(RESOURCE_CRID, badInput as unknown as ExtendInput)
        .catch((e: unknown) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.detail).toContain("extend: input must be an object");
    }
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

  it("update throws ValidationError when extend_by and expires_at are both set", async () => {
    // `UpdateInput` is a non-XOR interface — both fields are optional, so
    // typed callers reach the runtime mutual-exclusion guard directly.
    // This is the regression for that runtime guard; untyped wider-object
    // callers also hit it via the same code path (allowlist + XOR check).
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update(RESOURCE_CRID, { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend throws ValidationError when extend_by and expires_at are both set", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    // ExtendInput makes this a compile error for typed callers. Cast through
    // unknown to simulate untyped JS callers and pin the runtime guard.
    const bothFields = { extend_by: "24h", expires_at: "2026-04-01T00:00:00Z" };
    const error = await client
      .extend(RESOURCE_CRID, bothFields as unknown as Parameters<typeof client.extend>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("extend:");
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extend() rejects empty input for untyped callers", async () => {
    // The ExtendInput type is a discriminated union that requires
    // exactly one of `extend_by` / `expires_at`; this locks in the
    // runtime guard for untyped-JS callers who bypass TypeScript.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .extend(RESOURCE_CRID, {} as unknown as Parameters<typeof client.extend>[1])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("extend:");
    expect((error as ValidationError).detail).toContain("exactly one");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink throws ValidationError when expires_in and expires_at are both set", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink(RESOURCE_CRID, { expires_in: "7d", expires_at: "2026-04-01T00:00:00Z" })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((error as ValidationError).detail).toContain("mutually exclusive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects label longer than 500 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink(RESOURCE_CRID, { label: "x".repeat(501) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("label");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects max_sessions above 1000", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .mintLink(RESOURCE_CRID, { max_sessions: 5000 })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("max_sessions");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects description longer than 500 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update(RESOURCE_CRID, { description: "x".repeat(501) })
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
        .update(RESOURCE_CRID, { description: badDescription as unknown as string })
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
      .update(RESOURCE_CRID, { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("tags");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects tags longer than 50 chars", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update(RESOURCE_CRID, { tags: ["x".repeat(51)] })
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
      .update(RESOURCE_CRID, { tags: ["-leading-dash"] })
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
      .update(RESOURCE_CRID, {
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
      .update(RESOURCE_CRID, { tags: {} as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(objError).toBeInstanceOf(ValidationError);
    expect((objError as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    expect((objError as ValidationError).detail).toContain("must be an array");
    expect((objError as ValidationError).detail).toContain("object");

    // Number.
    const numError = await client
      .update(RESOURCE_CRID, { tags: 42 as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(numError).toBeInstanceOf(ValidationError);
    expect((numError as ValidationError).detail).toContain("number");

    // String (also a common mistake — passing a single tag as a string
    // instead of wrapping in an array).
    const strError = await client
      .update(RESOURCE_CRID, { tags: "single-tag" as unknown as string[] })
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
      .update(RESOURCE_CRID, {
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
      .update(RESOURCE_CRID, { tags: null as unknown as string[] })
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("at least one field");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update rejects empty input pre-flight (no fields provided)", async () => {
    // update() must reject `{}` client-side — the server-side "at least
    // one field" check would otherwise be the only guard, and the
    // exhaustiveness pattern in UPDATE_FIELD_KEYS was introduced
    // specifically so a new UpdateInput field can't silently opt out of
    // this check.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update(RESOURCE_CRID, {})
      .catch((e: unknown) => e as ValidationError);
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
        .update(RESOURCE_CRID, { [key]: "" } as unknown as Parameters<typeof client.update>[1])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      const detail = (error as ValidationError).detail;
      expect(detail).toContain(key);
      expect(detail).toContain("must not be an empty string");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mintLink rejects empty-string timing/duration fields (expires_in / expires_at / session_duration)", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const key of ["expires_in", "expires_at", "session_duration"] as const) {
      const error = await client
        .mintLink(RESOURCE_CRID, { [key]: "" } as unknown as Parameters<typeof client.mintLink>[1])
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

    await client.mintLink(RESOURCE_CRID, {
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

  it("create rejects malformed access_policy shapes (untyped JS shape errors)", async () => {
    // Untyped JS callers commonly pass `geo_allowlist: "US"` instead of
    // `["US"]`, or stringify the whole policy. The shape guard returns
    // a structured ValidationError client-side instead of an opaque
    // server 400.
    const cases = [
      { policy: { geo_allowlist: "US" }, detail: "access_policy.geo_allowlist" },
      { policy: { ip_allowlist: "10.0.0.0/8" }, detail: "access_policy.ip_allowlist" },
      { policy: "deny-all", detail: "must be an object (got string)" },
      { policy: ["US"], detail: "must be an object (got array)" },
      { policy: { user_agent_allow_regex: ["^GPTBot"] }, detail: "user_agent_allow_regex" },
      { policy: { user_agent_deny_regex: 42 }, detail: "user_agent_deny_regex" },
      { policy: { ai_agent_policy: "block" }, detail: "ai_agent_policy: must be an object" },
      { policy: { ai_agent_policy: ["x"] }, detail: "ai_agent_policy: must be an object" },
      { policy: { ai_agent_policy: { block_all: "true" } }, detail: "block_all" },
      {
        policy: { ai_agent_policy: { deny_categories: "gptbot" } },
        detail: "ai_agent_policy.deny_categories",
      },
      {
        policy: { ai_agent_policy: { allow_categories: "search" } },
        detail: "ai_agent_policy.allow_categories",
      },
    ] as const;
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const c of cases) {
      const error = await client
        .create({
          target_url: "https://example.com",
          access_policy: c.policy,
        } as unknown as Parameters<typeof client.create>[0])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain(c.detail);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("update treats `{ extend_by: undefined }` as empty (no stealth empty-input)", async () => {
    // A caller who threads an `undefined` through their own types
    // should still hit the empty-input guard — the some()-based check
    // tests `input[key] !== undefined`, not `key in input`, so
    // explicit-undefined values are indistinguishable from omissions.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client
      .update(RESOURCE_CRID, { extend_by: undefined })
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
      .update(RESOURCE_CRID, { extend_by: undefined, expires_at: undefined })
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
    await expect(client.update(RESOURCE_CRID, { tags: [] })).resolves.toBeDefined();
  });

  it("parseError synthesizes a title from HTTP status when statusText is empty (HTTP/2)", async () => {
    // HTTP/2 omits reason-phrases — fallback must keep Error.message legible.
    const fetch = mockFetch({
      status: 404,
      statusText: "",
      body: { error: { status: 404, code: "not_found", detail: "no such resource" } },
    });
    const client = createClient(fetch);

    const error = await client.get(RESOURCE_CRID).catch((e: unknown) => e as QURLError);
    expect(error).toBeInstanceOf(QURLError);
    expect((error as QURLError).message).toContain("HTTP 404");
    expect((error as QURLError).message).not.toMatch(/^ \(/);
  });

  it("resolve() rejects empty string and non-string/non-object input client-side", async () => {
    // Symmetric with get/update/mintLink/delete: untyped-JS misuse must
    // surface as ValidationError, not a confusing server-side 400 or
    // a non-object body sent over the wire.
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    for (const bad of ["", null, undefined, 42, true]) {
      const error = await client
        .resolve(bad as unknown as string)
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    }
    // Object overload must reject empty / non-string access_token too.
    for (const bad of [{}, { access_token: "" }, { access_token: 42 }]) {
      const error = await client
        .resolve(bad as unknown as Parameters<typeof client.resolve>[0])
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(ERROR_CODE_CLIENT_VALIDATION);
    }
    expect(fetch).not.toHaveBeenCalled();
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

  it("rejects a redirect already followed by a custom fetch implementation", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: true,
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers(),
          body: null,
        }) satisfies Partial<Response> as Response,
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect(error.detail).toContain("followed redirect");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed non-empty response URL even when redirected is false", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          url: "https://redirected.example/v1/quota",
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers(),
          body: null,
        }) satisfies Partial<Response> as Response,
    );

    await expect(
      new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 2,
      }).getQuota(),
    ).rejects.toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("names an invalid custom Response.url without reflecting its value", async () => {
    const invalidResponseUrl = "/relative-response-url";
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          url: invalidResponseUrl,
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers(),
          body: null,
        }) satisfies Partial<Response> as Response,
    );

    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: "Refused invalid custom Response.url redirect response for GET",
      message:
        "Unexpected Response (200): Refused invalid custom Response.url redirect response for GET",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty 204 from a Response-like shim whose json() rejects", async () => {
    const response = {
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(createClient(fetch).delete(RESOURCE_CRID)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty 204 from a bodyless shim whose json() resolves null", async () => {
    const response = {
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      body: undefined,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve(null),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(createClient(fetch).delete(RESOURCE_CRID)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a Response-like shim whose text() method rejects", async () => {
    const response = {
      ok: true,
      redirected: false,
      status: 200,
      statusText: "OK",
      type: "basic",
      headers: new Headers(),
      body: undefined,
      text: () => Promise.reject(new Error("local response shim failed")),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(error.detail).toBe("Response-like fetch text() failed");
    expect(error.cause).toMatchObject({
      name: "ResponseBodyMaterializationError",
      message: "Response-like fetch text() failed",
    });
    expect(error.message).not.toContain("local response shim failed");
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("rejects apiKey containing CR/LF (header-injection guard)", () => {
    for (const bad of ["test-api-key\r\nX-Injected: 1", "test-api-key\nbar", "test-api-key\rxyz"]) {
      let thrown: unknown;
      try {
        new QURLClient({ apiKey: bad, fetch: mockFetch({ status: 200 }) });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError).detail).toContain("CR/LF");
    }
  });

  it("rejects userAgent containing CR/LF (header-injection guard)", () => {
    for (const bad of ["qurl-sdk\r\nX-Injected: 1", "qurl-sdk\nbar", "qurl-sdk\rxyz"]) {
      let thrown: unknown;
      try {
        new QURLClient({
          apiKey: "test-api-key",
          fetch: mockFetch({ status: 200 }),
          userAgent: bad,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError).detail).toContain("userAgent");
      expect((thrown as ValidationError).detail).toContain("CR/LF");
    }
  });

  it.each([
    {
      name: "JSON success with declared length",
      status: 200,
      contentType: "application/json",
      headers: "accurate" as const,
      body: () =>
        sizedJSON(
          '{"data":{"secret":"response-credential-marker","padding":"',
          '"}}',
          RESPONSE_BODY_LIMIT + 1,
        ),
    },
    {
      name: "JSON error without declared length",
      status: 503,
      contentType: "application/problem+json",
      headers: "absent" as const,
      body: () =>
        sizedJSON(
          '{"error":{"title":"Unavailable","detail":"response-credential-marker',
          '"}}',
          RESPONSE_BODY_LIMIT + 1,
        ),
    },
    {
      name: "JSON success without declared length",
      status: 200,
      contentType: "application/json",
      headers: "absent" as const,
      body: () =>
        sizedJSON(
          '{"data":{"secret":"response-credential-marker","padding":"',
          '"}}',
          RESPONSE_BODY_LIMIT + 1,
        ),
    },
    {
      name: "non-JSON success with inaccurate declared length",
      status: 200,
      contentType: "text/html",
      headers: "inaccurate" as const,
      body: () => `response-credential-marker${"x".repeat(RESPONSE_BODY_LIMIT)}`,
    },
    {
      name: "non-JSON error without declared length",
      status: 503,
      contentType: "text/plain",
      headers: "absent" as const,
      body: () => `response-credential-marker${"x".repeat(RESPONSE_BODY_LIMIT)}`,
    },
  ])("rejects oversized $name bodies with a bounded typed error", async (testCase) => {
    const body = testCase.body();
    const headers: Record<string, string> = { "content-type": testCase.contentType };
    if (testCase.headers === "accurate")
      headers["content-length"] = String(new TextEncoder().encode(body).byteLength);
    if (testCase.headers === "inaccurate") headers["content-length"] = "1";
    const debug = vi.fn();
    const fetch = vi.fn(async () => new Response(body, { status: testCase.status, headers }));
    const client = new QURLClient({
      apiKey: "request-credential-marker",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
      debug,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(testCase.status >= 500 ? ServerError : ValidationError);
    expect(error.status).toBe(testCase.status);
    expect(error.code).toBe(
      testCase.status >= 400 ? ERROR_CODE_UNKNOWN : ERROR_CODE_UNEXPECTED_RESPONSE,
    );
    expect(error.detail).toContain(`${RESPONSE_BODY_LIMIT}-byte limit`);
    expect(error.message.length).toBeLessThan(256);
    expect(error.message).not.toContain("response-credential-marker");
    expect(error.message).not.toContain("request-credential-marker");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("response-credential-marker");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("request-credential-marker");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const getReader = vi.fn(() => {
      throw new Error("body must not be read");
    });
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers({ "content-length": String(RESPONSE_BODY_LIMIT + 1) }),
          body: { cancel, getReader },
        }) satisfies Partial<Response> as Response,
    );

    await expect(
      new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
      }).getQuota(),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("bounds materialized text from a Response-like fetch without a body stream", async () => {
    const secret = `response-secret-${"x".repeat(RESPONSE_BODY_LIMIT)}`;
    const fetch = vi.fn(
      async () =>
        ({
          ok: false,
          redirected: false,
          status: 503,
          statusText: "Unavailable",
          type: "basic",
          headers: new Headers(),
          body: undefined,
          text: async () => secret,
        }) satisfies Partial<Response> as Response,
    );
    const error = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 503, code: ERROR_CODE_UNKNOWN });
    expect(error.message).not.toContain("response-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["text", "ASCII", sizedJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT), false],
    [
      "text",
      "multibyte",
      sizedMultibyteJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT),
      false,
    ],
    ["json", "ASCII", sizedJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT), false],
    [
      "json",
      "multibyte",
      sizedMultibyteJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT),
      false,
    ],
    [
      "text",
      "multibyte max+1",
      sizedMultibyteJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT + 1),
      true,
    ],
    [
      "json",
      "multibyte max+1",
      sizedMultibyteJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT + 1),
      true,
    ],
  ] as const)("bounds %s shim %s response bytes", async (source, _kind, body, wantReject) => {
    const parsed = source === "json" ? (JSON.parse(body) as unknown) : undefined;
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers(),
          body: undefined,
          text: async () => (source === "text" ? body : ""),
          json: async () => parsed,
        }) satisfies Partial<Response> as Response,
    );

    const result = await createClient(fetch as typeof globalThis.fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    if (wantReject) {
      expect(result).toBeInstanceOf(ValidationError);
      expect(result).toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    } else {
      expect((result as unknown as { padding: string }).padding.length).toBeGreaterThan(0);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats an undefined text result from a bodyless Response-like shim as empty", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          status: 204,
          statusText: "No Content",
          type: "basic",
          headers: new Headers(),
          body: undefined,
          text: async () => undefined,
          json: async () => undefined,
        }) satisfies Partial<Response> as Response,
    );

    await expect(
      createClient(fetch as typeof globalThis.fetch).delete(RESOURCE_CRID),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not report a Response-like JSON serialization failure as an empty body", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers(),
          body: undefined,
          text: async () => "",
          json: async () => ({ data: { unsupported: 1n } }),
        }) satisfies Partial<Response> as Response,
    );

    const error = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(error.detail).toBe(
      "Response-like fetch returned a value that cannot be serialized as JSON",
    );
    expect(error.cause).toMatchObject({ name: "ResponseBodyMaterializationError" });
    expect(error.detail).not.toContain("non-JSON");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds source work before normalizing a server diagnostic", async () => {
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          code: "bad_request",
          detail: `${"\0".repeat(512)}late server diagnostic`,
        },
      },
    });

    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error.detail).toBe("Bad Request");
    expect(error.message).not.toContain("late server diagnostic");
  });

  it("create rejects empty-string duration fields (expires_in / session_duration)", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const fields: readonly (keyof CreateInput)[] = ["expires_in", "session_duration"];
    for (const field of fields) {
      const error = await client
        .create({ target_url: "https://example.com", [field]: "" })
        .catch((e: unknown) => e as ValidationError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).detail).toContain(field);
      expect((error as ValidationError).detail).toContain("empty");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-https baseUrl to prevent bearer-token plaintext leakage", async () => {
    // Bearer token would otherwise be sent in the clear. The check is
    // a constructor-time sanity guard — production callers would notice
    // a typo'd or downgraded URL eventually, but the pre-flight stops
    // the leak on the first request.
    expect(
      () =>
        new QURLClient({
          apiKey: "test-api-key",
          baseUrl: "http://api.example.com",
        }),
    ).toThrow(/baseUrl: must use https:\/\//);

    expect(
      () =>
        new QURLClient({
          apiKey: "test-api-key",
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
        () => new QURLClient({ apiKey: "test-api-key", baseUrl: bad }),
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
          apiKey: "test-api-key",
          baseUrl: "not a url at all",
        }),
    ).toThrow(/baseUrl: must be a valid URL/);
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

  it("bounds, sanitizes, and caps structured invalid-field diagnostics", async () => {
    const invalidFields = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `field-${index}\u202E`,
        `${"€".repeat(300)}\n\u061C\u200E\u200Fsecret-tail`,
      ]),
    );
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: invalidFields,
        },
      },
    });

    const error = await createClient(fetch)
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(Object.keys(error.invalidFields ?? {}).length).toBeLessThan(100);
    let aggregateBytes = 0;
    for (const [key, value] of Object.entries(error.invalidFields ?? {})) {
      expect(key).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
      expect(value).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
      expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(512);
      expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(512);
      expect(value).not.toContain("secret-tail");
      aggregateBytes +=
        new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength;
    }
    expect(aggregateBytes).toBeLessThanOrEqual(8 << 10);
  });

  it("retains invalid-field diagnostics at the 8 KiB aggregate boundary", async () => {
    const fixedValue = "v".repeat(512);
    const invalidFields = Object.fromEntries([
      ...Array.from({ length: 8 }, (_, index) => [
        `${String(index).padStart(3, "0")}${"k".repeat(509)}`,
        fixedValue,
      ]),
      ["over-budget", "must not be retained"],
    ]);
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: invalidFields,
        },
      },
    });

    const error = await createClient(fetch)
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as ValidationError);

    expect(Object.keys(error.invalidFields ?? {})).toHaveLength(8);
    expect(error.invalidFields).not.toHaveProperty("over-budget");
    const aggregateBytes = Object.entries(error.invalidFields ?? {}).reduce(
      (total, [key, value]) =>
        total +
        new TextEncoder().encode(key).byteLength +
        new TextEncoder().encode(value).byteLength,
      0,
    );
    expect(aggregateBytes).toBe(8 << 10);
  });

  it("skips an over-budget invalid field and retains a later field that fits", async () => {
    const skippedKey = "s".repeat(200);
    const retainedKey = "keep";
    const invalidFields = Object.fromEntries([
      ...Array.from({ length: 7 }, (_, index) => [
        `${String(index).padStart(3, "0")}${"k".repeat(509)}`,
        "v".repeat(512),
      ]),
      ["n".repeat(400), "v".repeat(512)],
      [skippedKey, "v".repeat(200)],
      [retainedKey, "v".repeat(100)],
    ]);
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: invalidFields,
        },
      },
    });

    const error = await createClient(fetch)
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.invalidFields).not.toHaveProperty(skippedKey);
    expect(error.invalidFields).toHaveProperty(retainedKey, "v".repeat(100));
    const aggregateBytes = Object.entries(error.invalidFields ?? {}).reduce(
      (total, [key, value]) =>
        total +
        new TextEncoder().encode(key).byteLength +
        new TextEncoder().encode(value).byteLength,
      0,
    );
    expect(aggregateBytes).toBeLessThanOrEqual(8 << 10);
  });

  it("bounds inspected invalid-field entries when early values have the wrong type", async () => {
    const invalidFields = Object.fromEntries([
      ...Array.from({ length: 100 }, (_, index) => [`ignored-${index}`, index]),
      ["must-not-be-scanned", "late diagnostic"],
    ]);
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: invalidFields,
        },
      },
    });

    const error = await createClient(fetch)
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.invalidFields).toBeUndefined();
  });

  it("retains the first structured invalid-field diagnostic after normalized-key collisions", async () => {
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          status: 400,
          detail: "Invalid input",
          code: "validation_error",
          invalid_fields: { "target\u202E url": "first", "target url": "second" },
        },
      },
    });

    const error = await createClient(fetch)
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.invalidFields).toEqual({ "target url": "first" });
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
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    await client.getQuota().catch(() => {});

    const messages = debugFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(messages.some((m: string) => m.includes("unexpected error response shape"))).toBe(true);
  });

  it("bounds and sanitizes keys logged for an unexpected error response shape", async () => {
    const debugFn = vi.fn();
    const longKey = `${"€".repeat(300)}\n\u202Esecret-tail`;
    const body = Object.fromEntries([
      [longKey, true],
      ...Array.from({ length: 120 }, (_, index) => [`field-${index}`, true]),
    ]);
    const fetch = mockFetch({ status: 500, body });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    await client.getQuota().catch(() => {});

    const metadata = debugFn.mock.calls.find(([message]) =>
      String(message).includes("unexpected error response shape"),
    )?.[1] as { body_keys?: string[] };
    expect(metadata.body_keys).toHaveLength(100);
    for (const key of metadata.body_keys ?? []) {
      expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(512);
      expect(key).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
      expect(key).not.toContain("secret-tail");
    }
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

  it("bounds and sanitizes statusText on a non-JSON success response", async () => {
    const statusText = `${"€".repeat(300)}\n\u202Ecredential-tail`;
    const nonJsonOkFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText,
      headers: new Headers({ "content-type": "text/html" }),
      text: () => Promise.resolve("<html>broken response</html>"),
    } satisfies Partial<Response> as Response);

    const error = await createClient(nonJsonOkFetch as typeof globalThis.fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    const renderedTitle = error.message.split(" (200):", 1)[0];
    expect(new TextEncoder().encode(renderedTitle).byteLength).toBeLessThanOrEqual(512);
    expect(renderedTitle).not.toMatch(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u);
    expect(renderedTitle).not.toContain("credential-tail");
  });

  it("rejects malformed UTF-8 after a successful mutation without replaying it", async () => {
    const encoder = new TextEncoder();
    const malformedBody = new Uint8Array([
      ...encoder.encode(
        '{"data":{"resource_id":"r_new","target_url":"https://example.com","description":"',
      ),
      0xff,
      ...encoder.encode('"}}'),
    ]);
    const fetch = vi.fn(
      async () =>
        new Response(malformedBody, {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client
      .create({ target_url: "https://example.com" })
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 201, code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(error.detail).toContain("not valid UTF-8");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false])(
  "keeps a later Connector policy only on an existing resource (%s)",
  async (foundExisting) => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: connectorResourceData({
          private: true,
          consumer_access: { mode: "review", version: 3 },
        }),
        meta: { found_existing: foundExisting },
      },
    });
    const result = createClient(fetch).ensureConnectorResource("prod-dashboard", undefined, {
      mode: "review",
      version: 1,
    });
    if (foundExisting) expect((await result).foundExisting).toBe(true);
    else await expect(result).rejects.toThrow("private policy was not confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).consumer_access.version).toBe(1);
  },
);

describe("private resource create and device-key delta contracts", () => {
  const keyA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
  const keyB = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

  it.each([undefined, true, false])("preserves one-call privacy %s", async (privacy) => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);
    const input: CreateInput = { target_url: "https://example.com", private: privacy };
    await client.create(input);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual(
      privacy === undefined ? { target_url: input.target_url } : input,
    );
  });

  it("preserves explicit public privacy in batch creation", async () => {
    const fetch = mockFetch({
      status: 207,
      body: {
        data: {
          succeeded: 0,
          failed: 1,
          results: [
            { index: 0, success: false, error: { code: "invalid_input", message: "test" } },
          ],
        },
      },
    });
    await createClient(fetch).batchCreate({
      items: [{ target_url: "https://example.com", private: false }],
    });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).items[0].private).toBe(
      false,
    );
  });

  it("keeps privacy out of qURL creation for an existing resource", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    await expect(
      createClient(fetch).createQurlForResource(RESOURCE_CRID, { private: false } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the 256-key delta boundary", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const keys = Array.from({ length: 256 }, (_, n) => {
      const bytes = new Uint8Array(32).fill(1);
      bytes[31] = n;
      return btoa(String.fromCharCode(...bytes));
    });
    await createClient(fetch).updateResource(RESOURCE_CRID, { allowed_device_keys_add: keys });
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).allowed_device_keys_add,
    ).toEqual(keys);
  });

  it("sends additions and removals together without changing metadata", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const changes = { allowed_device_keys_add: [keyA], allowed_device_keys_remove: [keyB] };
    await createClient(fetch).updateResource(RESOURCE_CRID, changes);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]?.method).toBe("PATCH");
    expect(JSON.parse(call[1]?.body as string)).toEqual(changes);
  });

  it("allows empty delta lists as no-op fields", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    await createClient(fetch).updateResource(RESOURCE_CRID, { allowed_device_keys_add: [] });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      allowed_device_keys_add: [],
    });
  });

  it.each([
    { allowed_device_keys_add: "not-an-array" },
    { allowed_device_keys_remove: [42] },
    { allowed_device_keys_add: [keyA, keyA] },
    {
      allowed_device_keys_add: Array.from({ length: 257 }, (_, n) => {
        const bytes = new Uint8Array(32).fill(1);
        bytes[30] = n >> 8;
        bytes[31] = n & 255;
        return btoa(String.fromCharCode(...bytes));
      }),
    },
    { allowed_device_keys_add: [keyA.replace(/=$/, "")] },
    { allowed_device_keys_remove: ["A".repeat(42) + "B="] },
    { allowed_device_keys_add: [keyA], allowed_device_keys_remove: [keyA] },
    { allowed_device_keys_remove: [keyA], custom_domain: "" },
    {
      allowed_device_keys_add: [keyA],
      consumer_access: { mode: "keys", version: 1 },
      expected_consumer_access_version: 0,
    },
  ])("rejects invalid device-key changes before HTTP: %j", async (input) => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    await expect(
      createClient(fetch).updateResource(RESOURCE_CRID, input as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["false", null, 0])("rejects invalid one-call privacy %s", async (privacy) => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    await expect(
      createClient(fetch).create({ target_url: "https://example.com", private: privacy } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the service privacy_mismatch code", async () => {
    const fetch = mockFetch({
      status: 400,
      body: {
        error: { code: "privacy_mismatch", detail: "Existing resource has different privacy" },
      },
    });
    await expect(
      createClient(fetch).create({ target_url: "https://example.com", private: true }),
    ).rejects.toMatchObject({ status: 400, code: "privacy_mismatch" });
  });
});
