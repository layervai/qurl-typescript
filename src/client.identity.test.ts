import { describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  AuthenticationError,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  NetworkError,
  TimeoutError,
} from "./errors.js";
import type { CallerIdentity } from "./index.js";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { callHeaders } from "./__tests__/client-fixtures.js";

describe("getIdentity", () => {
  it.each([
    { owner_id: "test-owner", auth_type: "jwt" },
    { owner_id: "test-owner", auth_type: "api_key" },
    { owner_id: "test-owner", auth_type: "api_key", api_key: {} },
    {
      owner_id: "test-owner",
      auth_type: "api_key",
      api_key: {
        key_id: "key_123456789012",
        key_prefix: "test-prefix",
        kind: "future_kind",
        scopes: ["qurl:read", "future:scope"],
      },
    },
  ] satisfies CallerIdentity[])("returns the caller identity for $auth_type", async (data) => {
    const fetch = mockFetch({ status: 200, body: { data } });
    const client = createClient(fetch);
    await expect(client.getIdentity()).resolves.toEqual(data);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.test.layerv.ai/v1/me");
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("GET");
    expect(callHeaders(fetch)["Authorization"]).toBe("Bearer test-api-key");
  });

  it("uses the configured User-Agent and does not retry rejected credentials", async () => {
    const fetch = mockFetch({
      status: 401,
      body: { error: { code: "api_key_invalid", title: "Unauthorized" } },
    });
    const client = new QURLClient({
      apiKey: "tenant-key",
      baseUrl: "https://api.example.com",
      userAgent: "identity-test",
      maxRetries: 0,
      fetch,
    });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callHeaders(fetch)["User-Agent"]).toBe("identity-test");
  });

  it.each([
    {},
    { data: null },
    { data: [] },
    { data: {} },
    { data: { owner_id: "", auth_type: "jwt" } },
    { data: { owner_id: 123, auth_type: "jwt" } },
    { data: { owner_id: "owner", auth_type: "" } },
    { data: { owner_id: "owner", auth_type: 123 } },
    { data: { owner_id: "owner", auth_type: "jwt", api_key: null } },
    { data: { owner_id: "owner", auth_type: "api_key", api_key: [] } },
  ])("rejects an invalid response envelope", async (body) => {
    await expect(
      createClient(mockFetch({ status: 200, body })).getIdentity(),
    ).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: "getIdentity: invalid caller identity response",
    });
  });

  it("uses the SDK transport error and caller's no-retry policy", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network failure"));
    const client = new QURLClient({
      apiKey: "tenant-key",
      baseUrl: "https://api.example.com",
      maxRetries: 0,
      fetch,
    });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds the request by the caller's timeout without retrying", async () => {
    const fetch = vi.fn(
      (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const client = new QURLClient({
      apiKey: "tenant-key",
      baseUrl: "https://api.example.com",
      timeout: 10,
      maxRetries: 0,
      fetch,
    });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(TimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
