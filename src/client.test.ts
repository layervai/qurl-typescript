import { describe, it, expect, vi } from "vitest";
import { ConnectorResource, isApiKeyRequestScope, QURLClient } from "./client.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectorResourceOutcomeUnknownError,
  ERROR_CODE_AMBIGUOUS_RESOURCE,
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_NETWORK,
  ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN,
  ERROR_CODE_CONNECTOR_RESOURCE_REVOKED,
  ERROR_CODE_RUNTIME,
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
import type { ApiKeyRequestScope, CredentialClaim, MintInput } from "./types.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";
import {
  TARGET_PATH_MAX_LENGTH,
  PUBLIC_RESOURCE_ID,
  RESOURCE_CRID,
  SENSITIVE_ACCESS_TOKEN,
  RESPONSE_BODY_LIMIT,
  sizedJSON,
  CONNECTOR_RESOURCE_ID,
  NON_P256_CONNECTOR_RESOURCE_ID,
  OFF_CURVE_CONNECTOR_RESOURCE_ID,
  CONNECTOR_ROUTING_ID,
  connectorResourceData,
  callHeaders,
} from "./__tests__/client-fixtures.js";

describe("QURLClient", () => {
  it("gives shared JSON mock responses the correct media type", async () => {
    const response = await mockFetch({ status: 200, body: { data: {} } })("https://example.test");

    expect(response.headers.get("content-type")).toBe("application/json");
  });

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

  it("create requires target_url for default url qURLs but allows omission for non-url resource types", async () => {
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

    const error = await client
      .create({} as Parameters<QURLClient["create"]>[0])
      .catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("target_url: is required for url qURLs");

    await expect(client.create({ type: "tunnel" })).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
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
              qurl_id: "q_token1",
              status: "active",
              one_time_use: false,
              max_sessions: 3,
              session_duration: 300,
              use_count: 1,
              created_at: "2026-03-10T10:00:00Z",
              expires_at: "2026-03-20T10:00:00Z",
            },
            {
              qurl_id: "q_token2",
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
    const result = await client.get(RESOURCE_CRID);

    expect(result.resource_id).toBe("r_abc123def45");
    expect(result.status).toBe("active");
    expect(result.qurl_count).toBe(2);
    expect(result.access_tokens).toHaveLength(2);
    expect(result.access_tokens![0].qurl_id).toBe("q_token1");
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
    const result = await client.get(RESOURCE_CRID);

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
        qurl_id: "q_existing",
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
    const result = await client.get(RESOURCE_CRID);

    expect(result.access_tokens).toEqual(accessTokens);
    // Wire-format key stripped from consumer-facing object.
    expect((result as unknown as { qurls?: unknown }).qurls).toBeUndefined();
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

  // TODO(upstream-contract): Keep these path and error assertions aligned with
  // qurl-go Client.RevokePortal, the authoritative portal-revoke contract.
  it.each([["CRID", RESOURCE_CRID]])(
    "revokeResourceQurl accepts the Go SDK's %s identifier form",
    async (_label, resourceId) => {
      const fetch = mockFetch({ status: 204 });
      const client = createClient(fetch);

      await expect(client.revokeResourceQurl(resourceId, "q_0123456789a")).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith(
        `https://api.test.layerv.ai/v1/resources/${resourceId}/qurls/q_0123456789a`,
        expect.objectContaining({ method: "DELETE" }),
      );
    },
  );

  it("revokeResourceQurl keeps both IDs inside one encoded path segment", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.revokeResourceQurl(RESOURCE_CRID, "q?/#2")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a/qurls/q%3F%2F%232",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revokeResourceQurl preserves the service's revoked error for typed branching", async () => {
    const fetch = mockFetch({
      status: 409,
      body: {
        error: {
          title: "Conflict",
          status: 409,
          detail: "qURL is not active",
          code: "revoked",
        },
      },
    });
    const client = createClient(fetch);

    const error = await client
      .revokeResourceQurl(RESOURCE_CRID, "q_0123456789a")
      .catch((e: unknown) => e as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    expect((error as QURLError).status).toBe(409);
    expect((error as QURLError).code).toBe("revoked");
    expect((error as QURLError).detail).toBe("qURL is not active");
  });

  it("createQurlForResource normalizes null optional fields before serialization", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { qurl_link: "https://qurl.link/#at_x" } },
    });
    const client = createClient(fetch);

    await client.createQurlForResource(RESOURCE_CRID, {
      expires_in: "1h",
      label: null as unknown as string,
      one_time_use: null as unknown as boolean,
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    expect(body).toEqual({ expires_in: "1h" });
  });

  it("createQurlForResource forwards target_path in the request body", async () => {
    // `target_path` is a server-validated resource-qURL field (sets the path a
    // tunnel qURL resolves to, e.g. for the Discord bot's detect tunnel). It
    // must survive the field allowlist + normalization and reach the wire.
    const fetch = mockFetch({
      status: 201,
      body: { data: { qurl_link: "https://qurl.link/#at_x" } },
    });
    const client = createClient(fetch);

    await client.createQurlForResource(RESOURCE_CRID, { target_path: "/api/detect" });

    const call = vi.mocked(fetch).mock.calls[0];
    expect(new URL(call[0] as string).pathname).toBe(
      "/v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a/qurls",
    );
    const body = JSON.parse(call[1]?.body as string) as unknown;
    expect(body).toEqual({ target_path: "/api/detect" });
  });

  it("createQurlForResource accepts target_path at the 2048-byte boundary", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { qurl_link: "https://qurl.link/#at_x" } },
    });
    const client = createClient(fetch);
    // The cap applies to the complete UTF-8 value, including the leading
    // slash. Use a multibyte character so this catches code-unit checks.
    const maxLengthTargetPath = `/${"é".repeat(1023)}a`;
    expect(new TextEncoder().encode(maxLengthTargetPath)).toHaveLength(TARGET_PATH_MAX_LENGTH);

    await client.createQurlForResource(RESOURCE_CRID, { target_path: maxLengthTargetPath });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    expect(body).toEqual({ target_path: maxLengthTargetPath });
  });

  it("body-returning methods throw on unexpected 204 No Content", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client.getCustomer().catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain(
      "Unexpected 204 No Content from GET /v1/customer; expected response body",
    );
  });

  it("terminateAllResourceSessions preserves the zero fallback when count is omitted", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {}, meta: { request_id: "req_x" } } });
    const debug = vi.fn();
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      debug,
      fetch,
      maxRetries: 0,
    });

    const result = await client.terminateAllResourceSessions(RESOURCE_CRID);

    expect(result.terminated).toBe(0);
    expect(result.request_id).toBe("req_x");
    expect(debug).toHaveBeenCalledWith(
      "terminateAllResourceSessions: missing terminated count; defaulting to zero",
      { request_id: "req_x" },
    );
  });

  it("terminateAllResourceSessions throws on unexpected 204 No Content", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    const error = await client
      .terminateAllResourceSessions(RESOURCE_CRID)
      .catch((e: unknown) => e as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    expect(error.code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect(error.message).toContain(
      "Unexpected 204 No Content from DELETE /v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a/sessions; expected response body",
    );
  });

  it("new write methods serialize request bodies exactly", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await client.createWebhook({
      url: "https://example.com/hook",
      events: ["qurl.created"],
      description: "primary",
    });
    await client.createApiKey({ name: "dashboard", scopes: ["qurl:read"] });
    await client.updateCustomer({ spending_cap_cents: 5000 });

    const webhookBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    const apiKeyBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string) as unknown;
    const customerBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string) as unknown;
    expect(webhookBody).toEqual({
      url: "https://example.com/hook",
      events: ["qurl.created"],
      description: "primary",
    });
    expect(apiKeyBody).toEqual({
      kind: "api_key",
      name: "dashboard",
      scopes: ["qurl:read"],
    });
    expect(customerBody).toEqual({ spending_cap_cents: 5000 });
  });

  it("POST write methods normalize optional null fields before serialization", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await client.createWebhook({
      url: "https://example.com/hook",
      events: ["qurl.created"],
      description: null as unknown as string,
    });
    await client.createApiKey({
      name: "dashboard",
      scopes: ["qurl:read"],
      expires_in: null as unknown as string,
      target: null as unknown as string,
      claims: null as unknown as CredentialClaim[],
    });
    await client.redeemAccessCode({
      code: "invite-code",
      honeypot: null as unknown as string,
      elapsed_ms: null as unknown as number,
    });
    await client.createAccessCode({
      resource_id: "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
      name: null as unknown as string,
      max_uses: null as unknown as number,
      expires_at: null as unknown as string,
    });

    const bodies = vi.mocked(fetch).mock.calls.map((call) => {
      return JSON.parse(call[1]?.body as string) as unknown;
    });
    expect(bodies).toEqual([
      { url: "https://example.com/hook", events: ["qurl.created"] },
      { kind: "api_key", name: "dashboard", scopes: ["qurl:read"] },
      { code: "invite-code" },
      { resource_id: RESOURCE_CRID },
    ]);
  });

  it("updateResource preserves alias null as the clear-alias signal", async () => {
    const fetch = mockFetch({ status: 200, body: { data: { resource_id: "r_x" } } });
    const client = createClient(fetch);

    await client.updateResource(RESOURCE_CRID, { alias: null });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    expect(body).toEqual({ alias: null });
  });

  it("createApiKey passes through an explicit durable credential kind", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });

    await createClient(fetch).createApiKey({
      kind: "api_key",
      name: "dashboard",
      scopes: ["qurl:read"],
    });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      kind: "api_key",
      name: "dashboard",
      scopes: ["qurl:read"],
    });
  });

  it("maps the durable credential kind returned by the service", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { key_id: "key_obviously_fake", kind: "api_key" } },
    });

    await expect(
      createClient(fetch).createApiKey({ name: "dashboard", scopes: ["qurl:read"] }),
    ).resolves.toMatchObject({ kind: "api_key" });
  });

  it("does not mutate a durable-key input when defaulting its kind", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const input = { name: "dashboard", scopes: ["qurl:read"] as ApiKeyRequestScope[] };

    await createClient(fetch).createApiKey(input);

    expect(input).not.toHaveProperty("kind");
  });

  it("createApiKey mints a bound Connector enrollment token", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    await client.createApiKey({
      kind: "enrollment_token",
      name: "prod-dashboard enrollment",
      target: "connector",
      claims: [{ type: "connector", id: "prod-dashboard" }],
      expires_in: "2h",
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      kind: "enrollment_token",
      name: "prod-dashboard enrollment",
      target: "connector",
      claims: [{ type: "connector", id: "prod-dashboard" }],
      expires_in: "2h",
    });
    // Enrollment-token scopes are server-assigned; sending them is a 400.
    expect(body).not.toHaveProperty("scopes");
  });

  it("returns current enrollment credential response fields", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: {
          key_id: "key_obviously_fake",
          kind: "enrollment_token",
          target: "connector",
          claims: [{ type: "connector", id: "prod-dashboard" }],
          api_key: "qurl_test_obviously_fake_enrollment_token",
        },
      },
    });

    const result = await createClient(fetch).createApiKey({
      kind: "enrollment_token",
      name: "prod-dashboard enrollment",
      target: "connector",
      claims: [{ type: "connector", id: "prod-dashboard" }],
    });

    expect(result).toMatchObject({
      kind: "enrollment_token",
      target: "connector",
      claims: [{ type: "connector", id: "prod-dashboard" }],
    });
  });

  it("createApiKey lets the server derive target from claims", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    await client.createApiKey({
      kind: "enrollment_token",
      name: "prod-dashboard enrollment",
      claims: [{ type: "connector", id: "prod-dashboard" }],
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      kind: "enrollment_token",
      name: "prod-dashboard enrollment",
      claims: [{ type: "connector", id: "prod-dashboard" }],
    });
    expect(body).not.toHaveProperty("scopes");
    expect(body).not.toHaveProperty("target");
  });

  it("createApiKey mints an unbound agent enrollment token", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });

    await createClient(fetch).createApiKey({
      kind: "enrollment_token",
      name: "unbound agent enrollment",
    });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      kind: "enrollment_token",
      name: "unbound agent enrollment",
    });
  });

  it("createApiKey accepts an explicit unbound agent target", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });

    await createClient(fetch).createApiKey({
      kind: "enrollment_token",
      name: "unbound agent enrollment",
      target: "agent",
    });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      kind: "enrollment_token",
      name: "unbound agent enrollment",
      target: "agent",
    });
  });

  it("exports a request-scope guard for narrowing forward-compatible responses", () => {
    const responseScope: string = "qurl:read";

    expect(isApiKeyRequestScope(responseScope)).toBe(true);
    expect(isApiKeyRequestScope("future:scope")).toBe(false);
  });

  it.each(["abc", "a".repeat(64)])(
    "createApiKey accepts the connector claim ID boundary %s",
    async (id) => {
      const fetch = mockFetch({ status: 201, body: { data: {} } });

      await createClient(fetch).createApiKey({
        kind: "enrollment_token",
        name: "bound agent enrollment",
        target: "agent",
        claims: [{ type: "connector", id }],
      });

      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["24h", "86400s", "1d"])(
    "createApiKey accepts the 24-hour boundary as %s",
    async (expiresIn) => {
      const fetch = mockFetch({ status: 201, body: { data: {} } });

      await createClient(fetch).createApiKey({
        kind: "enrollment_token",
        name: "boundary enrollment",
        expires_in: expiresIn,
      });

      expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
        expires_in: expiresIn,
      });
    },
  );

  it("updateApiKey accepts a scope in the current service request enum", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await createClient(fetch).updateApiKey("key_abc123def456", { scopes: ["qurl:agent"] });

    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
      scopes: ["qurl:agent"],
    });
  });

  it("createResource normalizes null optional fields before serialization", async () => {
    const fetch = mockFetch({ status: 201, body: { data: { resource_id: "r_x" } } });
    const client = createClient(fetch);

    await client.createResource({
      type: "tunnel",
      tags: null as unknown as string[],
      alias: null as unknown as string,
      slug: null as unknown as string,
      find_or_create: null as unknown as boolean,
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string) as unknown;
    expect(body).toEqual({ type: "tunnel" });
  });

  it("createResource requires target_url for default url resources", async () => {
    const fetch = mockFetch({ status: 201, body: { data: {} } });
    const client = createClient(fetch);

    const error = await client.createResource({}).catch((e: unknown) => e as ValidationError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.detail).toContain("target_url: is required for url resources");

    await expect(
      client.createResource({ type: "tunnel", slug: "prod-dashboard" }),
    ).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ensures a connector resource with the exact kind-first wire contract", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: connectorResourceData(),
        meta: { found_existing: true },
      },
    });
    const client = createClient(fetch);

    const result = await client.ensureConnectorResource("prod-dashboard");

    expect(result.foundExisting).toBe(true);
    expect(result.resource).toBeInstanceOf(ConnectorResource);
    expect(result.resource.resourcePublicKey).toBe(CONNECTOR_RESOURCE_ID);
    expect(result.resource.connectorRoutingId).toBe(CONNECTOR_ROUTING_ID);
    expect(result.resource.knockResourceId).toBe("asp-resource-1");
    expect(result.resource.slug).toBe("prod-dashboard");
    expect(result.resource.alias).toBe("dashboard-display-name");
    expect(result.resource.crid).toBe(connectorResourceData().crid);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/resources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "tunnel", slug: "prod-dashboard", find_or_create: true }),
      }),
    );
  });

  it("preflights SubtleCrypto before connector ensure can dispatch", async () => {
    const fetch = mockFetch({ status: 201, body: { data: connectorResourceData() } });
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(
        createClient(fetch).ensureConnectorResource("prod-dashboard"),
      ).rejects.toMatchObject({
        constructor: RuntimeError,
        code: ERROR_CODE_RUNTIME,
        detail: expect.stringContaining(
          "ensureConnectorResource: requires the Web Crypto SubtleCrypto API",
        ),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies an alternate connector ensure success status as outcome-unknown", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: connectorResourceData(), meta: { found_existing: false } },
    });

    await expect(
      createClient(fetch).ensureConnectorResource("prod-dashboard"),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      cause: { code: ERROR_CODE_UNEXPECTED_RESPONSE },
    });
  });

  it("marks a connector ensure 5xx as outcome-unknown without hiding the server error", async () => {
    const fetch = mockFetch({
      status: 503,
      body: { error: { status: 503, code: "service_unavailable", title: "Unavailable" } },
    });

    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 3,
    });

    await expect(
      client.ensureConnectorResource("prod-dashboard", {
        idempotencyKey: "connector-ensure-job-503",
      }),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      status: 0,
      cause: { constructor: ServerError, code: "service_unavailable", status: 503 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ensure", 429, (client: QURLClient) => client.ensureConnectorResource("prod-dashboard")],
    [
      "slug lookup",
      503,
      (client: QURLClient) => client.getConnectorResourceBySlug("prod-dashboard"),
    ],
  ] as const)(
    "does not pace or replay Connector %s after HTTP %i",
    async (_name, status, invoke) => {
      const fetch = mockFetch({
        status,
        body: { error: { status, code: "retryable", title: "Retryable" } },
      });
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: 3,
      });

      await expect(invoke(client)).rejects.toBeInstanceOf(QURLError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("marks a connector ensure transport failure as outcome-unknown", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 3,
    });

    await expect(client.ensureConnectorResource("prod-dashboard")).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      status: 0,
      code: ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN,
      cause: { code: "network_error" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies an unexpected throwable after connector ensure dispatch as outcome-unknown", async () => {
    const fetch = vi.fn(async () => {
      const response = { headers: new Headers() } as Response;
      Object.defineProperty(response, "status", {
        get() {
          throw new Error("custom response failure");
        },
      });
      return response;
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    await expect(client.ensureConnectorResource("prod-dashboard")).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      status: 0,
      cause: { constructor: RuntimeError, code: ERROR_CODE_RUNTIME },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a runtime capability loss after connector ensure dispatch as outcome-unknown", async () => {
    const fetch = vi.fn(async () => {
      vi.stubGlobal("crypto", undefined);
      return new Response(
        JSON.stringify({
          data: connectorResourceData(),
          meta: { found_existing: false },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    try {
      await expect(client.ensureConnectorResource("prod-dashboard")).rejects.toMatchObject({
        constructor: ConnectorResourceOutcomeUnknownError,
        cause: { constructor: RuntimeError, code: ERROR_CODE_RUNTIME },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks bootstrap-key consumption after connector ensure as outcome-unknown", async () => {
    const fetch = mockFetch({
      status: 409,
      body: {
        error: {
          status: 409,
          code: "bootstrap_key_consumed",
          title: "Bootstrap Key Consumed",
        },
      },
    });

    await expect(
      createClient(fetch).ensureConnectorResource("prod-dashboard"),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      status: 0,
      code: ERROR_CODE_CONNECTOR_RESOURCE_OUTCOME_UNKNOWN,
      cause: { status: 409, code: "bootstrap_key_consumed" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks a connector ensure slug mismatch as outcome-unknown", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: connectorResourceData({ slug: "other-dashboard" }),
        meta: { found_existing: false },
      },
    });

    await expect(
      createClient(fetch).ensureConnectorResource("prod-dashboard"),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      cause: { code: ERROR_CODE_UNEXPECTED_RESPONSE },
    });
  });

  it("marks a revoked connector ensure result as outcome-unknown", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: connectorResourceData({ status: "revoked" }),
        meta: { found_existing: true },
      },
    });

    await expect(
      createClient(fetch).ensureConnectorResource("prod-dashboard"),
    ).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      cause: { code: ERROR_CODE_UNEXPECTED_RESPONSE },
    });
  });

  it("deletes a Connector by CRID without SubtleCrypto", async () => {
    const fetch = mockFetch({ status: 204 });
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(
        createClient(fetch).deleteConnectorResource(RESOURCE_CRID),
      ).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gets a connector resource by CRID from the detail envelope", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { resource: connectorResourceData() } },
    });
    const client = createClient(fetch);

    const resource = await client.getConnectorResource(RESOURCE_CRID);

    expect(resource.resourcePublicKey).toBe(CONNECTOR_RESOURCE_ID);
    expect(fetch).toHaveBeenCalledWith(
      `https://api.test.layerv.ai/v1/resources/${RESOURCE_CRID}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    ["getConnectorResource", (client: QURLClient) => client.getConnectorResource(RESOURCE_CRID)],
    [
      "getConnectorResourceBySlug",
      (client: QURLClient) => client.getConnectorResourceBySlug("prod-dashboard"),
    ],
  ] as const)("does not pace or replay %s after a transport failure", async (_name, invoke) => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 3,
    });

    await expect(invoke(client)).rejects.toMatchObject({ code: ERROR_CODE_NETWORK });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when connector resource detail omits its nested resource", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await expect(createClient(fetch).getConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it.each([
    ["getConnectorResource", (client: QURLClient) => client.getConnectorResource(RESOURCE_CRID)],
  ] as const)("preflights SubtleCrypto before %s can dispatch", async (_method, invoke) => {
    const fetch = mockFetch({ status: 200, body: { data: { resource: connectorResourceData() } } });
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(invoke(createClient(fetch))).rejects.toMatchObject({
        constructor: RuntimeError,
        code: ERROR_CODE_RUNTIME,
        detail: expect.stringContaining(`${_method}: requires the Web Crypto SubtleCrypto API`),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("imports a returned connector resource key only once", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { resource: connectorResourceData() } },
    });
    const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey");

    try {
      await createClient(fetch).getConnectorResource(RESOURCE_CRID);
      expect(importKey).toHaveBeenCalledTimes(1);
    } finally {
      importKey.mockRestore();
    }
  });

  it("gets a connector resource by immutable slug without treating alias as identity", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [connectorResourceData()] } });
    const client = createClient(fetch);

    const resource = await client.getConnectorResourceBySlug("prod-dashboard");

    expect(resource.slug).toBe("prod-dashboard");
    expect(resource.alias).toBe("dashboard-display-name");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/resources?slug=prod-dashboard",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("preflights SubtleCrypto before connector slug lookup can dispatch", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [connectorResourceData()] } });
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(
        createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
      ).rejects.toMatchObject({ constructor: RuntimeError, code: ERROR_CODE_RUNTIME });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes a connector resource by CRID", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.deleteConnectorResource(RESOURCE_CRID)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `https://api.test.layerv.ai/v1/resources/${RESOURCE_CRID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([
    ["transport failure", () => Promise.reject(new TypeError("socket closed"))],
    [
      "alternate successful response",
      () => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    ],
  ])("marks connector delete %s as outcome-unknown", async (_name, response) => {
    const fetch = vi.fn().mockImplementation(response);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 3,
    });

    await expect(client.deleteConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      status: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a connector delete after a 503", async () => {
    const fetch = mockFetch({
      status: 503,
      body: { error: { status: 503, code: "service_unavailable", title: "Unavailable" } },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 3,
    });

    await expect(client.deleteConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      constructor: ConnectorResourceOutcomeUnknownError,
      cause: { status: 503 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing routing ID", { connector_routing_id: undefined }],
    ["cross-wired admission ID", { knock_resource_id: CONNECTOR_ROUTING_ID }],
    ["resource identity reused as admission ID", { knock_resource_id: CONNECTOR_RESOURCE_ID }],
    ["padded admission ID", { knock_resource_id: " asp-resource-1 " }],
    ["control character in admission ID", { knock_resource_id: "asp\u0000resource" }],
    ["non-canonical routing ID", { connector_routing_id: `${CONNECTOR_ROUTING_ID.slice(0, -1)}b` }],
    [
      "canonical base64url resource ID that is not a P-256 key",
      { resource_id: NON_P256_CONNECTOR_RESOURCE_ID },
    ],
    ["off-curve P-256 resource key", { resource_id: OFF_CURVE_CONNECTOR_RESOURCE_ID }],
    ["wrong type", { type: "url" }],
    ["wrong slug", { slug: "other-dashboard" }],
    ["invalid alias", { alias: "Prod Dashboard" }],
    ["invalid CRID type", { crid: 42 }],
    ["missing CRID", { crid: undefined }],
    ["empty CRID", { crid: "" }],
    [
      "wrong CRID key commitment",
      { crid: "ae4jqpd7eaoslq7jinmjv4yikgzmcxgpjfsuobiniqnko32lpw743ivbeyha" },
    ],
  ])("fails closed when a connector resource response has %s", async (_name, overrides) => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [connectorResourceData(overrides)] },
    });
    const client = createClient(fetch);

    const error = await client
      .getConnectorResourceBySlug("prod-dashboard")
      .catch((e: unknown) => e as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    expect(error.code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
  });

  it("fails closed when an active-only slug lookup returns a revoked row", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [connectorResourceData({ status: "revoked" })] },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });

  it("treats active and revoked rows as an ambiguous slug result", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: [connectorResourceData({ status: "revoked" }), connectorResourceData()],
      },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).rejects.toMatchObject({ code: ERROR_CODE_AMBIGUOUS_RESOURCE });
  });

  it("fails closed when a connector slug row omits status", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [connectorResourceData({ status: undefined })] },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });

  it("normalizes a null connector alias to undefined", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [connectorResourceData({ alias: null })] },
    });

    await expect(
      createClient(fetch).getConnectorResourceBySlug("prod-dashboard"),
    ).resolves.toMatchObject({ alias: undefined });
  });

  it("classifies a revoked by-ID result as a connector lifecycle error", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { resource: connectorResourceData({ status: "revoked" }) } },
    });

    await expect(createClient(fetch).getConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      code: ERROR_CODE_CONNECTOR_RESOURCE_REVOKED,
    });
  });

  it("fails closed on an unknown by-ID lifecycle status", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { resource: connectorResourceData({ status: "pending" }) } },
    });

    await expect(createClient(fetch).getConnectorResource(RESOURCE_CRID)).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it.each([
    [
      "getConnectorResource",
      (client: QURLClient) => client.getConnectorResource(RESOURCE_CRID),
      { data: { resource: connectorResourceData() } },
    ],
    [
      "getConnectorResourceBySlug",
      (client: QURLClient) => client.getConnectorResourceBySlug("prod-dashboard"),
      { data: [connectorResourceData()] },
    ],
  ])("%s requires exact HTTP 200", async (_name, call, body) => {
    const fetch = mockFetch({ status: 201, body });

    await expect(call(createClient(fetch))).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
  });

  it.each([["CRID", RESOURCE_CRID]])("deletes a qURL by its %s", async (_label, resourceId) => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);

    await expect(client.delete(resourceId)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `https://api.test.layerv.ai/v1/qurls/${encodeURIComponent(resourceId)}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([
    ["delete", (client: QURLClient) => client.delete(RESOURCE_CRID)],
    ["deleteResource", (client: QURLClient) => client.deleteResource(RESOURCE_CRID)],
    [
      "revokeResourceQurl",
      (client: QURLClient) => client.revokeResourceQurl(RESOURCE_CRID, "q_3a7f2c8e91b"),
    ],
    [
      "terminateResourceSession",
      (client: QURLClient) => client.terminateResourceSession(RESOURCE_CRID, "session-1"),
    ],
    ["deleteDomain", (client: QURLClient) => client.deleteDomain("app.example.com")],
    ["deleteWebhook", (client: QURLClient) => client.deleteWebhook("wh_abc")],
    ["revokeApiKey", (client: QURLClient) => client.revokeApiKey("key_abc")],
    ["revokeAccessCode", (client: QURLClient) => client.revokeAccessCode("code_abc")],
  ])("%s requires the endpoint's exact 204 success status", async (_name, invoke) => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await expect(invoke(createClient(fetch))).rejects.toMatchObject({
      status: 200,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: expect.stringContaining("received HTTP 200"),
      message: expect.stringContaining("may already have been applied"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("delete diagnoses a target URL without claiming it contains an access token", async () => {
    const fetch = mockFetch({ status: 204 });
    const client = createClient(fetch);
    const targetUrl = "https://docs.example.com/at_a_glance";

    const error = await client.delete(targetUrl).catch((e: unknown) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain("must be an identifier, not a URL");
    expect((error as ValidationError).detail).not.toContain("access token");
    expect((error as ValidationError).detail).not.toContain(targetUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not misdiagnose a benign at_-prefixed query value as a credential", async () => {
    const fetch = mockFetch({ status: 204 });
    const targetUrl = "https://docs.example.com/guide?tab=at_a_glance";

    const error = await createClient(fetch)
      .delete(targetUrl)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.detail).toContain("must be an identifier, not a URL");
    expect(error.detail).not.toContain("access token");
    expect(error.detail).not.toContain(targetUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("diagnoses a canonical access token pasted from a custom-domain URL", async () => {
    const fetch = mockFetch({ status: 204 });
    const qurlLink = "https://links.example.com/at_abcdefghijklmnopqrstuv";

    const error = await createClient(fetch)
      .delete(qurlLink)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.detail).toContain("access token");
    expect(error.detail).not.toContain(qurlLink);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives non-resource namespaces a generic recovery hint for pasted credentials", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    const error = await createClient(fetch)
      .getWebhook(`Bearer ${SENSITIVE_ACCESS_TOKEN}`)
      .catch((caught: unknown) => caught as ValidationError);

    expect(error.detail).toContain("pass the identifier returned by the API");
    expect(error.detail).not.toContain(SENSITIVE_ACCESS_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["createPortal", (client: QURLClient, id: string) => client.createPortal(id)],
    ["getResource", (client: QURLClient, id: string) => client.getResource(id)],
    [
      "updateResource",
      (client: QURLClient, id: string) => client.updateResource(id, { alias: "updated-alias" }),
    ],
    ["deleteResource", (client: QURLClient, id: string) => client.deleteResource(id)],
    [
      "createQurlForResource",
      (client: QURLClient, id: string) => client.createQurlForResource(id, {}),
    ],
    [
      "revokeResourceQurl",
      (client: QURLClient, id: string) => client.revokeResourceQurl(id, "q_0123456789a"),
    ],
    [
      "updateResourceQurl",
      (client: QURLClient, id: string) =>
        client.updateResourceQurl(id, "q_0123456789a", { extend_by: "1h" }),
    ],
    ["listResourceSessions", (client: QURLClient, id: string) => client.listResourceSessions(id)],
    [
      "terminateAllResourceSessions",
      (client: QURLClient, id: string) => client.terminateAllResourceSessions(id),
    ],
    [
      "terminateResourceSession",
      (client: QURLClient, id: string) => client.terminateResourceSession(id, "session-1"),
    ],
  ])("%s requires a CRID", async (_name, invoke) => {
    for (const id of [RESOURCE_CRID]) {
      const fetch = mockFetch({ status: 204 });
      const responseError = await invoke(createClient(fetch), id).then(
        () => null,
        (caught: unknown) => caught,
      );
      if (responseError !== null) {
        expect(responseError).toMatchObject({ detail: expect.stringContaining("Unexpected 204") });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0][0]).toContain(encodeURIComponent(id));
    }
    const fetch = mockFetch({ status: 204 });
    for (const id of [PUBLIC_RESOURCE_ID, "r_old"]) {
      await expect(invoke(createClient(fetch), id)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([RESOURCE_CRID])("resourceByCrid accepts current public resource identifier %s", (id) => {
    expect(() => createClient(mockFetch({ status: 204 })).resourceByCrid(id)).not.toThrow();
  });

  it("applies shared URL and dot-segment safety to non-resource namespaces", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await expect(client.getWebhook("https://example.com/at_a_glance")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("identifier, not a URL"),
    });
    await expect(client.getDomain("..")).rejects.toMatchObject({
      code: ERROR_CODE_CLIENT_VALIDATION,
      detail: expect.stringContaining("invalid URL path segment"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not apply resource access-token grammar to unrelated identifier namespaces", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);

    await client.getDomain("at_future-domain-id");
    await client.getWebhook("at_future-webhook-id");
    await client.updateApiKey("at_future-api-key-id", { name: "renamed" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.terminateResourceSession(RESOURCE_CRID, "at_future-session-id");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.test.layerv.ai/v1/domains/at_future-domain-id",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.test.layerv.ai/v1/webhooks/at_future-webhook-id",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://api.test.layerv.ai/v1/api-keys/at_future-api-key-id",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "https://api.test.layerv.ai/v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a/sessions/at_future-session-id",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps a bare hostname valid in the domain identifier namespace", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });

    await createClient(fetch).getDomain("links.example.com");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/domains/links.example.com",
      expect.objectContaining({ method: "GET" }),
    );
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
    const result = await client.extend(RESOURCE_CRID, { extend_by: "7d" });

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
    const result = await client.update(RESOURCE_CRID, {
      description: "Updated description",
    });

    expect(result.description).toBe("Updated description");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ description: "Updated description" }),
      }),
    );
  });

  it("mintLink({ expires_at }) round-trips the absolute expiry to the wire body", async () => {
    // Happy-path companion to the expires_in / mutual-exclusion tests.
    // Locks in the absolute-expiry path against accidental stripping by
    // future MINT_FIELD_KEYS / null-normalization changes.
    const fetch = mockFetch({
      status: 200,
      body: { data: { qurl_link: "https://qurl.link/#at_x", expires_at: "2026-04-01T00:00:00Z" } },
    });
    const client = createClient(fetch);

    await client.mintLink(RESOURCE_CRID, { expires_at: "2026-04-01T00:00:00Z" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ expires_at: "2026-04-01T00:00:00Z" });
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

    await client.mintLink(RESOURCE_CRID, {
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

    await client.mintLink(RESOURCE_CRID, {});
    await client.mintLink(RESOURCE_CRID);
    await client.mintLink(RESOURCE_CRID, { expires_in: null as unknown as string });

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const call of fetch.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBeNull();
    }
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

    await expect(client.mintLink(RESOURCE_CRID)).resolves.toBeDefined();
    // Body should be omitted (undefined) when no input is provided —
    // the server defaults fill in the unspecified fields.
    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(calledBody).toBeUndefined();
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
      client.update(RESOURCE_CRID, {
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
      client.update(RESOURCE_CRID, {
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
    await client.update(RESOURCE_CRID, { description: "" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.description).toBe("");
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
    const result = await client.update(RESOURCE_CRID, { description: "Updated" });

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
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    const result = await client.get(RESOURCE_CRID);

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
      branch: "both",
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
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });

    const result = await client.get(RESOURCE_CRID);
    expect((result as { qurls?: unknown }).qurls).toBeUndefined();
    expect((result as { access_tokens?: unknown }).access_tokens).toBeUndefined();
    const dropLog = debugFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("not an array"),
    );
    expect(dropLog).toBeDefined();
  });

  it.each([{ label: "null", qurls: null, needle: "was null", branch: "null" }])(
    "mapQurlsField logs when own-property `qurls` is $label",
    async ({ qurls, needle, branch }) => {
      const fetch = mockFetch({
        status: 200,
        body: {
          data: {
            resource_id: "r_x",
            target_url: "https://example.com",
            status: "active",
            qurls,
          },
        },
      });
      const debugFn = vi.fn();
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: 0,
        debug: debugFn,
      });

      const result = await client.get(RESOURCE_CRID);
      expect((result as { qurls?: unknown }).qurls).toBeUndefined();
      const log = debugFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(needle),
      );
      expect(log).toBeDefined();
      expect(log![1]).toEqual({ branch });
    },
  );

  it("mapQurlsField logs when a direct input has own-property `qurls: undefined`", () => {
    const debugFn = vi.fn();
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
      debug: debugFn,
    });
    const raw = {
      resource_id: "r_direct_undefined",
      target_url: "https://example.com",
      status: "active",
      qurls: undefined,
    };
    expect(Object.prototype.hasOwnProperty.call(raw, "qurls")).toBe(true);

    // TypeScript `private` is compile-time only, so the un-exported helper is
    // reachable through the runtime prototype without a test-only export.
    // Direct invocation is deliberate: wire JSON cannot express an
    // own-property `undefined`, so this branch is untestable through fetch.
    const descriptor = Object.getOwnPropertyDescriptor(QURLClient.prototype, "mapQurlsField");
    expect(typeof descriptor?.value).toBe("function");
    const mapQurlsField = descriptor?.value as (
      this: QURLClient,
      input: Record<string, unknown>,
    ) => Record<string, unknown>;
    const result = mapQurlsField.call(client, raw);

    expect(Object.prototype.hasOwnProperty.call(result, "qurls")).toBe(false);
    expect(result.access_tokens).toBeUndefined();
    expect(debugFn).toHaveBeenCalledWith("mapQurlsField: 'qurls' was undefined; dropping", {
      branch: "undefined",
    });
    expect(fetch).not.toHaveBeenCalled();
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
      access_token: "test-access-token",
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

  it("resolve() allowlist-rebuilds the body — extra keys from untyped-JS callers don't leak", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { target_url: "https://example.com", resource_id: "r_x" } },
    });
    const client = createClient(fetch);

    // JSON input gives __proto__ a real own data property, not a prototype setter.
    const widerPayload = JSON.parse(
      '{"access_token":"test-access-token","apiKey":"test-extra-api-key","arbitrary":"field","__proto__":"should-not-leak"}',
    );
    expect(Object.getOwnPropertyDescriptor(widerPayload, "__proto__")?.enumerable).toBe(true);
    expect(Object.getPrototypeOf(widerPayload)).toBe(Object.prototype);
    await client.resolve(widerPayload as unknown as Parameters<typeof client.resolve>[0]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ access_token: "test-access-token" });
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
          instance: "/v1/qurls/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
          code: "not_found",
        },
        meta: { request_id: "req_err" },
      },
    });

    const client = createClient(fetch);

    try {
      await client.get(RESOURCE_CRID);
      expect.fail("Expected QURLError");
    } catch (err) {
      expect(err).toBeInstanceOf(QURLError);
      const qErr = err as QURLError;
      expect(qErr.status).toBe(404);
      expect(qErr.code).toBe("not_found");
      expect(qErr.requestId).toBe("req_err");
      // New: RFC 7807 type + instance surfaced on the error object.
      expect(qErr.type).toBe("https://api.qurl.link/problems/not_found");
      expect(qErr.instance).toBe(
        "/v1/qurls/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
      );
    }
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
          Authorization: "Bearer test-api-key",
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
    const result = await client.mintLink(RESOURCE_CRID);

    expect(result.qurl_link).toBe("https://qurl.link/#at_newtoken");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.layerv.ai/v1/qurls/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a/mint_link",
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

  it.each([
    ["same-origin", "https://api.test.layerv.ai/redirect-target"],
    ["cross-origin", "https://redirect-target.invalid/collect"],
  ])("refuses %s redirects without forwarding credential headers", async (_kind, targetUrl) => {
    const target = vi.fn(async () => new Response(null, { status: 204 }));
    let originalHeaders: Record<string, string> | undefined;
    const fetch = vi.fn(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (String(url) === targetUrl) return target(url, init);
        originalHeaders = init?.headers as Record<string, string>;

        // Model fetch's redirect behavior: a missing/manual-misconfigured mode
        // would make a second request and expose the test to target().
        if (init?.redirect !== "manual") return target(targetUrl, init);
        return new Response("redirect response body", {
          status: 302,
          headers: { location: targetUrl },
        });
      },
    );
    const client = new QURLClient({
      apiKey: "redirect-test-secret",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client
      .create(
        { target_url: "https://example.com" },
        { idempotencyKey: "redirect-test-idempotency" },
      )
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(302);
    expect(error.code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(target).not.toHaveBeenCalled();
    expect(originalHeaders?.Authorization).toBe("Bearer redirect-test-secret");
    expect(originalHeaders?.["Idempotency-Key"]).toBe("redirect-test-idempotency");
    expect(error.message).not.toContain(targetUrl);
    expect(error.message).not.toContain("redirect-test-secret");
    expect(error.message).not.toContain("redirect-test-idempotency");
  });

  it.each([
    { method: "GET", invoke: (client: QURLClient) => client.getQuota() },
    {
      method: "POST",
      invoke: (client: QURLClient) =>
        client.create({ target_url: "https://example.com" }, { idempotencyKey: "redirect-post" }),
    },
    {
      method: "PATCH",
      invoke: (client: QURLClient) =>
        client.update(
          RESOURCE_CRID,
          { description: "updated" },
          { idempotencyKey: "redirect-patch" },
        ),
    },
    { method: "DELETE", invoke: (client: QURLClient) => client.delete(RESOURCE_CRID) },
  ])("uses manual redirect handling and refuses a redirect for $method", async ({ invoke }) => {
    const fetch = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(invoke(createClient(fetch))).rejects.toMatchObject({
      status: 302,
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("refuses filtered opaque redirects as unexpected responses", async () => {
    const fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 0,
        statusText: "",
        type: "opaqueredirect",
        headers: new Headers(),
        body: null,
      } satisfies Partial<Response> as Response;
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(0);
    expect(error.code).toBe(ERROR_CODE_UNEXPECTED_RESPONSE);
    expect(error.detail).toBe("Refused opaque redirect response for GET");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an equivalent normalized response URL", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: true,
          redirected: false,
          url: "https://API.TEST.LAYERV.AI:443/v1/quota",
          status: 200,
          statusText: "OK",
          type: "basic",
          headers: new Headers({ "content-type": "application/json" }),
          body: undefined,
          text: async () =>
            JSON.stringify({
              data: {
                plan: "growth",
                period_start: "2026-03-01",
                period_end: "2026-04-01",
              },
            }),
        }) satisfies Partial<Response> as Response,
    );

    await expect(
      new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 0,
      }).getQuota(),
    ).resolves.toMatchObject({ plan: "growth" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel HTTP 304 as a redirect", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 304,
          statusText: "Not Modified",
          // RFC 9110 permits this to describe the selected 200 representation.
          // It is not the byte length of a body on this 304 response.
          headers: { "content-length": String(RESPONSE_BODY_LIMIT + 1) },
        }),
    );
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 0,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(QURLError);
    expect(error.status).toBe(304);
    expect(error.detail).toBe("Not Modified");
    expect(error.detail).not.toContain("redirect");
    expect(error.detail).not.toContain("body exceeds");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a Response-like shim whose body is not a WHATWG ReadableStream", async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { pipe: () => undefined },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
        ),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(createClient(fetch).getQuota()).resolves.toMatchObject({ plan: "growth" });
  });

  it("does not replay a Response-like shim that omits headers.get", async () => {
    const response = {
      ok: true,
      redirected: false,
      status: 200,
      statusText: "OK",
      type: "basic",
      body: undefined,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
        ),
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
    expect(error.detail).toBe("Response-like fetch must provide headers.get(name)");
    expect(error.cause).toMatchObject({
      name: "ResponseBodyMaterializationError",
      message: "Response-like fetch must provide headers.get(name)",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a typed HTTP 503 error when a Response-like shim omits headers.get", async () => {
    const response = {
      ok: false,
      redirected: false,
      status: 503,
      statusText: "Service Unavailable",
      type: "basic",
      body: undefined,
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const error = await client.getQuota().catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 503, code: ERROR_CODE_UNKNOWN });
    expect(error.detail).toBe("Response-like fetch must provide headers.get(name)");
    expect(error.cause).toMatchObject({
      name: "ResponseBodyMaterializationError",
      message: "Response-like fetch must provide headers.get(name)",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a Response-like stream that yields a non-byte chunk", async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: "not bytes" }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      redirected: false,
      status: 200,
      statusText: "OK",
      type: "basic",
      headers: new Headers(),
      body: { getReader: () => reader },
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
    expect(error.detail).toBe("Response-like fetch body stream must yield Uint8Array chunks");
    expect(error.cause).toMatchObject({ name: "ResponseBodyMaterializationError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
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
      apiKey: "test-api-key",
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
      apiKey: "test-api-key",
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

  it("masks API key in toJSON for keys longer than 8 chars", () => {
    const client = new QURLClient({
      apiKey: "test-api-key-long",
      baseUrl: "https://api.test.layerv.ai",
      fetch: mockFetch({ status: 200 }),
    });

    const json = client.toJSON();
    expect(json.apiKey).toBe("test***long");
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
      apiKey: "test-api-key-long",
      baseUrl: "https://api.test.layerv.ai",
      fetch: mockFetch({ status: 200 }),
    });

    const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspectFn = (client as any)[inspectSymbol] as () => string;
    const output = inspectFn.call(client);
    expect(output).toContain("test***long");
    expect(output).not.toContain("test-api-key-long");
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
      apiKey: "test-api-key",
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

  it("uses the observed HTTP status when a problem body reports a conflicting status", async () => {
    const fetch = mockFetch({
      status: 503,
      body: {
        error: {
          status: 404,
          title: "Not Found",
          detail: "stale intermediary body",
          code: "not_found",
        },
      },
    });
    const error = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 503, code: "not_found" });
  });

  it("falls back to streamed accounting for a duplicated Content-Length header", async () => {
    const headers = new Headers();
    headers.append("Content-Length", String(RESPONSE_BODY_LIMIT + 1));
    headers.append("Content-Length", String(RESPONSE_BODY_LIMIT + 1));
    const fetch = vi.fn(
      async () => new Response("x".repeat(RESPONSE_BODY_LIMIT + 1), { status: 200, headers }),
    );

    await expect(
      new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 0,
      }).getQuota(),
    ).rejects.toMatchObject({ status: 200, code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });

  it.each([429, 503])(
    "does not replay DELETE after an oversized HTTP %i response",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response("x".repeat(RESPONSE_BODY_LIMIT + 1), {
            status,
            headers: { "content-type": "text/plain", "Retry-After": "0" },
          }),
      );
      const client = new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 3,
      });

      await expect(client.delete(RESOURCE_CRID)).rejects.toBeInstanceOf(QURLError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("parses success and error JSON bodies exactly at the response limit", async () => {
    const successBody = sizedJSON('{"data":{"padding":"', '"}}', RESPONSE_BODY_LIMIT);
    const successFetch = vi.fn(
      async () =>
        new Response(successBody, {
          status: 200,
          headers: { "content-length": String(RESPONSE_BODY_LIMIT) },
        }),
    );
    const success = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: successFetch as typeof globalThis.fetch,
      maxRetries: 0,
    }).getQuota();
    expect((success as unknown as { padding: string }).padding.length).toBeGreaterThan(0);

    const errorBody = sizedJSON(
      '{"error":{"title":"Boundary","code":"boundary_error","detail":"',
      '"}}',
      RESPONSE_BODY_LIMIT,
    );
    const errorFetch = vi.fn(
      async () =>
        new Response(errorBody, {
          status: 400,
          headers: { "content-length": String(RESPONSE_BODY_LIMIT) },
        }),
    );
    const error = await new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: errorFetch as typeof globalThis.fetch,
      maxRetries: 0,
    })
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("boundary_error");
    expect(error.detail.endsWith("...")).toBe(true);
    expect(new TextEncoder().encode(error.detail).byteLength).toBeLessThanOrEqual(512);
    expect(error.detail).not.toContain("byte limit");
  });

  it("keeps structured API error snippets single-line, dangerous-control-free, UTF-8-safe, and bounded", async () => {
    const detail = `  👩‍💻‌ ${"€".repeat(300)}\n\x00\x1b[2J\x85\u061C\u200E\u200F\u202Eresponse\u2066 tail  `;
    const fetch = mockFetch({
      status: 400,
      body: { error: { title: "Bad Request", code: "bad_request", detail } },
    });
    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error.detail.endsWith("...")).toBe(true);
    expect(error.detail).not.toContain("\n");
    expect(error.detail).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
    expect(new TextEncoder().encode(error.detail).byteLength).toBeLessThanOrEqual(512);
    expect(error.detail).toContain("‍");
    expect(error.detail).toContain("‌");
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(error.detail)),
    ).not.toThrow();
    expect(error.detail).not.toContain("\uFFFD");
  });

  it("maps an oversized structured API error code to the stable unknown discriminant", async () => {
    const code = `  ${"€".repeat(300)}\n\x00\x1b[2Jcode tail  `;
    const fetch = mockFetch({
      status: 400,
      body: { error: { title: "Bad Request", code, detail: "Invalid request" } },
    });
    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error.code).toBe(ERROR_CODE_UNKNOWN);
  });

  it("drops oversized exact API identifiers and request IDs", async () => {
    const long = `${"€".repeat(300)}\n\u202Ecredential-tail`;
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          title: "Bad Request",
          code: "bad_request",
          detail: "Invalid request",
          type: long,
          instance: long,
        },
        meta: { request_id: long },
      },
    });
    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    expect(error.type).toBeUndefined();
    expect(error.instance).toBeUndefined();
    expect(error.requestId).toBeUndefined();
  });

  it.each([
    ["code", " bad_request "],
    ["code", "bad\nrequest"],
    ["type", " https://errors.example/bad-request"],
    ["type", "https://errors.example/bad\u202Erequest"],
    ["instance", "/v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a "],
    ["instance", "/v1/resources/\u0000r_test"],
    ["request_id", " req_test"],
    ["request_id", "req\ttest"],
  ] as const)("drops %s when normalization would change its exact value", async (field, value) => {
    const body = {
      error: {
        title: "Bad Request",
        code: "bad_request",
        detail: "Invalid request",
        type: "https://errors.example/bad-request",
        instance: "/v1/resources/ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
      },
      meta: { request_id: "req_test" },
    };
    if (field === "request_id") {
      body.meta.request_id = value;
    } else {
      body.error[field] = value;
    }
    const fetch = mockFetch({ status: 400, body });
    const error = await createClient(fetch)
      .getQuota()
      .catch((caught: unknown) => caught as QURLError);

    if (field === "code") expect(error.code).toBe(ERROR_CODE_UNKNOWN);
    if (field === "type") expect(error.type).toBeUndefined();
    if (field === "instance") expect(error.instance).toBeUndefined();
    if (field === "request_id") expect(error.requestId).toBeUndefined();
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
      apiKey: "test-api-key",
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
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch,
        maxRetries: badRetries,
      });
      await expect(client.getQuota()).resolves.toBeDefined();
    }
    // Three constructions, three single-attempt fetches each.
    expect(fetch).toHaveBeenCalledTimes(3);
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
      apiKey: "test-api-key",
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
        () => new QURLClient({ apiKey: "test-api-key", baseUrl: allowed }),
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

    const err = await client.get(RESOURCE_CRID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(QURLError);
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
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    const result = await client.getQuota();
    expect(result.plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries GET when a successful response body fails mid-stream", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("successful response reset mid-body"));
      },
    });
    const failure = new Response(brokenBody, { status: 200, statusText: "OK" });
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

  it("reports a 503 mutation body transport failure without replaying the mutation", async () => {
    const brokenBody = new globalThis.ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("response body reset"));
      },
    });
    const fetch = vi.fn(
      async () => new Response(brokenBody, { status: 503, statusText: "Unavailable" }),
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

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 503, code: ERROR_CODE_UNKNOWN });
    expect(error.message).toContain("HTTP 503");
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("releases and cancels a response stream after a body-read failure", async () => {
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(
      async () =>
        ({
          ok: false,
          redirected: false,
          status: 503,
          statusText: "Unavailable",
          type: "basic",
          headers: new Headers(),
          body: {
            cancel,
            getReader: () => ({
              read: async () => {
                throw new TypeError("response body reset");
              },
              cancel: vi.fn(async () => undefined),
              releaseLock,
            }),
          },
        }) satisfies Partial<Response> as Response,
    );

    await expect(
      new QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.test.layerv.ai",
        fetch: fetch as typeof globalThis.fetch,
        maxRetries: 0,
      }).getQuota(),
    ).rejects.toBeInstanceOf(ServerError);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])("does not replay DELETE after a %i response", async (status) => {
    // A transport failure after dispatch makes the mutation outcome unknown.
    // The caller reconciles resource state before it chooses to issue another
    // delete; the HTTP verb alone cannot prove a replay safe.
    const gatewayResponse = {
      ok: false,
      status,
      statusText: "Gateway failure",
      headers: new Headers({}),
      json: () =>
        Promise.resolve({
          error: {
            title: "Bad Gateway",
            status,
            detail: "Upstream error",
            code: "bad_gateway",
          },
        }),
      text: () => Promise.resolve(""),
    } satisfies Partial<Response> as Response;

    const fetch = vi.fn().mockResolvedValue(gatewayResponse);
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    await expect(client.delete(RESOURCE_CRID)).rejects.toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(callHeaders(fetch, 0)).not.toHaveProperty("Idempotency-Key");
  });

  it("does not replay DELETE after a 429 response", async () => {
    // Match qurl-go's explicit-caller-retry model. A custom gateway can emit
    // 429 after dispatch, so receiving the status alone is not proof that a
    // destructive operation was never applied.
    const fetch = mockFetch({
      status: 429,
      body: {
        error: {
          title: "Rate Limited",
          status: 429,
          detail: "Slow down",
          code: "rate_limited",
        },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.delete(RESOURCE_CRID)).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay terminateAllResourceSessions after a 503 response", async () => {
    const fetch = mockFetch({
      status: 503,
      body: {
        error: {
          title: "Unavailable",
          status: 503,
          detail: "Outcome unknown",
          code: "unavailable",
        },
      },
    });
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch,
      maxRetries: 2,
    });

    await expect(client.terminateAllResourceSessions(RESOURCE_CRID)).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay DELETE after a fetch-level outcome-unknown failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket closed after dispatch"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new QURLClient({
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 2,
    });

    await expect(client.delete(RESOURCE_CRID)).rejects.toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
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
      apiKey: "test-api-key",
      baseUrl: "https://api.test.layerv.ai",
      fetch: fetch as typeof globalThis.fetch,
      maxRetries: 1,
    });

    const result = await client.create({ target_url: "https://example.com" });
    expect(result.resource_id).toBe("r_new");
    expect(fetch).toHaveBeenCalledTimes(2);
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

    await client.resolve("test-access-token");

    const calledBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(JSON.parse(calledBody)).toEqual({ access_token: "test-access-token" });
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
      apiKey: "test-api-key",
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

  it("retains debug body keys at the 8 KiB aggregate boundary", async () => {
    const debugFn = vi.fn();
    const body = Object.fromEntries([
      ...Array.from({ length: 16 }, (_, index) => [
        `${String(index).padStart(3, "0")}${"k".repeat(509)}`,
        true,
      ]),
      ["over-budget", true],
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
    expect(metadata.body_keys).toHaveLength(16);
    expect(metadata.body_keys).not.toContain("over-budget");
    expect(
      (metadata.body_keys ?? []).reduce(
        (total, key) => total + new TextEncoder().encode(key).byteLength,
        0,
      ),
    ).toBe(8 << 10);
  });

  it("skips an over-budget debug key and retains a later key that fits", async () => {
    const skippedKey = "s".repeat(200);
    const retainedKey = "z".repeat(100);
    const body = Object.fromEntries([
      ...Array.from({ length: 15 }, (_, index) => [
        `${String(index).padStart(3, "0")}${"k".repeat(509)}`,
        true,
      ]),
      ["n".repeat(400), true],
      [skippedKey, true],
      [retainedKey, true],
    ]);
    const debugFn = vi.fn();
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
    expect(metadata.body_keys).not.toContain(skippedKey);
    expect(metadata.body_keys).toContain(retainedKey);
    expect(
      (metadata.body_keys ?? []).reduce(
        (total, key) => total + new TextEncoder().encode(key).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(8 << 10);
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
      apiKey: "test-api-key",
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
    expect(new RuntimeError("unsupported")).toBeInstanceOf(QURLError);
  });

  it.each([
    ["NetworkError", (cause: unknown) => new NetworkError("fail", { cause })],
    ["TimeoutError", (cause: unknown) => new TimeoutError("timed out", { cause })],
    ["RuntimeError", (cause: unknown) => new RuntimeError("unsupported", { cause })],
  ] as const)("attaches %s cause with the native non-enumerable descriptor", (_name, makeError) => {
    const cause = new TypeError("transport detail");
    const error = makeError(cause);

    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain("cause");
    expect({ ...error }).not.toHaveProperty("cause");
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toEqual({
      value: cause,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  });

  it("distinguishes an omitted cause from an explicitly undefined cause", () => {
    const omitted = new NetworkError("fail");
    const explicit = new NetworkError("fail", { cause: undefined });

    expect(Object.hasOwn(omitted, "cause")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(explicit, "cause")).toEqual({
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  });

  it("API-key inventory callers can discard a cutover error and recreate the iterator", async () => {
    const fetch = mockFetches([
      {
        status: 200,
        body: {
          data: [{ key_id: "old-key" }],
          meta: { has_more: true, next_cursor: "cell-cursor" },
        },
      },
      {
        status: 400,
        body: {
          error: {
            status: 400,
            code: "invalid_cursor",
            title: "Bad Request",
            detail: "Invalid cursor",
          },
        },
      },
      { status: 200, body: { data: [{ key_id: "fresh-key" }], meta: { has_more: false } } },
    ]);
    const client = createClient(fetch);
    const keys: string[] = [];
    const old = client.listAllApiKeys({ limit: 10 });
    const first = await old.next();
    expect(first.done).toBe(false);
    if (!first.done) keys.push(first.value.key_id);
    let failure: unknown;
    try {
      await old.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(QURLError);
    expect(failure).toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(keys).toEqual(["old-key"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await old.next()).done).toBe(true);

    // The application discards partial data before publishing a replacement inventory.
    keys.length = 0;
    for await (const key of client.listAllApiKeys({ limit: 10 })) keys.push(key.key_id);
    expect(keys).toEqual(["fresh-key"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual(Array(3).fill("/v1/api-keys"));
    expect(urls.map((url) => url.searchParams.get("limit"))).toEqual(["10", "10", "10"]);
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "cell-cursor", null]);
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

    await client.mintLink(RESOURCE_CRID, {
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
});
