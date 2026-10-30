import { afterEach, describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  AuthorizationError,
  QURLError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./errors.js";
import {
  createClient,
  EXTERNAL_BINDING_RESPONSE,
  mockFetch,
  mockFetches,
} from "./__tests__/test-helpers.js";
import type { CreateExternalIdentityBindingInput } from "./types.js";

const input: CreateExternalIdentityBindingInput = {
  provider: "teams",
  external_id: "synthetic-tenant",
};
const options = { idempotencyKey: "0192f7c4-3b8a-7e2f-9d01-4cf8a1b6e3d2" };
afterEach(() => vi.useRealTimers());

describe("createExternalIdentityBinding", () => {
  it.each(["slack", "discord", "teams"] as const)(
    "binds %s with the supplied JWT and replay key",
    async (provider) => {
      const response = {
        ...EXTERNAL_BINDING_RESPONSE,
        provider,
        scopes:
          provider === "discord" ? ["qurl:read", "qurl:write"] : EXTERNAL_BINDING_RESPONSE.scopes,
      };
      const fetch = mockFetch({ status: 201, body: response });
      const debug = vi.fn();
      const client = new QURLClient({
        apiKey: "synthetic-oauth-jwt",
        baseUrl: "https://api.example.com",
        fetch,
        debug,
        maxRetries: 0,
      });
      expect(await client.createExternalIdentityBinding({ ...input, provider }, options)).toEqual(
        response,
      );
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/external-identity-bindings");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-oauth-jwt");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(options.idempotencyKey);
      expect(JSON.parse(init!.body as string)).toEqual({ ...input, provider });
      expect(JSON.stringify(debug.mock.calls)).not.toContain(response.api_key.plaintext);
      expect(JSON.stringify(debug.mock.calls)).not.toContain("synthetic-oauth-jwt");
    },
  );

  it("replays a lost response with the same caller-persisted key and body", async () => {
    const fetch = mockFetch({ status: 201, body: EXTERNAL_BINDING_RESPONSE });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("connection reset"));
    const client = createClient(fetch);
    await expect(client.createExternalIdentityBinding(input, options)).rejects.toThrow();
    expect(await client.createExternalIdentityBinding(input, options)).toEqual(
      EXTERNAL_BINDING_RESPONSE,
    );
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(new Headers(calls[0][1]?.headers).get("Idempotency-Key")).toBe(
      new Headers(calls[1][1]?.headers).get("Idempotency-Key"),
    );
  });

  it("preserves rotation fields and a 100-code-point display name", async () => {
    const name = "界".repeat(100);
    const fetch = mockFetch({
      status: 201,
      body: { ...EXTERNAL_BINDING_RESPONSE, display_name: name },
    });
    await createClient(fetch).createExternalIdentityBinding(
      { ...input, display_name: name, rotate_existing: true },
      options,
    );
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({
      ...input,
      display_name: name,
      rotate_existing: true,
    });
  });

  it.each([
    null,
    [],
    { ...input, provider: "unknown" },
    { ...input, external_id: "" },
    { ...input, external_id: "tenant#fragment" },
    { ...input, external_id: "tenant\n" },
    { ...input, external_id: "x".repeat(257) },
    { ...input, display_name: "界".repeat(101) },
    { ...input, display_name: "\ud800" },
    { ...input, rotate_existing: "true" },
    { ...input, scopes: ["qurl:agent"] },
  ])("rejects malformed input before HTTP", async (bad) => {
    const fetch = mockFetch({ status: 201, body: EXTERNAL_BINDING_RESPONSE });
    await expect(
      createClient(fetch).createExternalIdentityBinding(
        bad as CreateExternalIdentityBindingInput,
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { idempotencyKey: "short" },
    { idempotencyKey: "x".repeat(257) },
    { idempotencyKey: "x".repeat(32) + "\n" },
  ])("requires a valid caller-persisted replay key", async (bad) => {
    const fetch = mockFetch({ status: 201, body: EXTERNAL_BINDING_RESPONSE });
    await expect(
      createClient(fetch).createExternalIdentityBinding(input, bad as typeof options),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { data: EXTERNAL_BINDING_RESPONSE },
    { ...EXTERNAL_BINDING_RESPONSE, provider: "slack" },
    { ...EXTERNAL_BINDING_RESPONSE, external_id: "another-tenant" },
    { ...EXTERNAL_BINDING_RESPONSE, binding_id: "bad" },
    { ...EXTERNAL_BINDING_RESPONSE, api_key: null },
    {
      ...EXTERNAL_BINDING_RESPONSE,
      api_key: { ...EXTERNAL_BINDING_RESPONSE.api_key, plaintext: "" },
    },
    {
      ...EXTERNAL_BINDING_RESPONSE,
      api_key: { ...EXTERNAL_BINDING_RESPONSE.api_key, key_id: "bad" },
    },
    {
      ...EXTERNAL_BINDING_RESPONSE,
      api_key: { ...EXTERNAL_BINDING_RESPONSE.api_key, key_prefix: "wrong" },
    },
    { ...EXTERNAL_BINDING_RESPONSE, scopes: ["qurl:read", "qurl:write"] },
    { ...EXTERNAL_BINDING_RESPONSE, scopes: ["qurl:read", "qurl:write", "qurl:write"] },
    { ...EXTERNAL_BINDING_RESPONSE, created_at: "not-a-date" },
    { ...EXTERNAL_BINDING_RESPONSE, display_name: "\ud800" },
  ])("fails closed without echoing a malformed success body", async (body) => {
    const fetch = mockFetch({ status: 201, body });
    const error = await createClient(fetch)
      .createExternalIdentityBinding(input, options)
      .catch((error) => error);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("unexpected_response");
    expect(String(error)).not.toContain(EXTERNAL_BINDING_RESPONSE.api_key.plaintext);
  });

  it.each([200, 202, 204, 207])("refuses success status %s other than 201", async (status) => {
    const fetch = mockFetch({
      status,
      ...(status === 204 ? {} : { body: EXTERNAL_BINDING_RESPONSE }),
    });
    await expect(
      createClient(fetch).createExternalIdentityBinding(input, options),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    [403, "forbidden", AuthorizationError],
    [409, "already_exists", QURLError],
    [409, "idempotency_conflict", QURLError],
    [429, "rate_limited", RateLimitError],
    [503, "service_unavailable", ServerError],
    [503, "bindings_disabled", ServerError],
  ] as const)("preserves typed HTTP %s %s failures", async (status, code, errorType) => {
    const fetch = mockFetch({
      status,
      body: { error: { status, code, title: "Rejected", detail: "Synthetic refusal" } },
      headers: { "Retry-After": "5" },
    });
    const error = await createClient(fetch)
      .createExternalIdentityBinding(input, options)
      .catch((error) => error);
    expect(error).toBeInstanceOf(errorType);
    expect(error.code).toBe(code);
    if (status === 429 || status === 503) expect(error.retryAfter).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the same key during the shared transport's 429 retry", async () => {
    vi.useFakeTimers();
    const fetch = mockFetches([
      {
        status: 429,
        body: { error: { status: 429, code: "rate_limited" } },
        headers: { "Retry-After": "1" },
      },
      { status: 201, body: EXTERNAL_BINDING_RESPONSE },
    ]);
    const pending = new QURLClient({
      apiKey: "synthetic-jwt",
      fetch,
      maxRetries: 1,
    }).createExternalIdentityBinding(input, options);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(EXTERNAL_BINDING_RESPONSE);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(new Headers(calls[1][1]?.headers).get("Idempotency-Key")).toBe(options.idempotencyKey);
  });
});
