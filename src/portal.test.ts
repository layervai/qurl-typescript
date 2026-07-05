import { describe, it, expect, vi } from "vitest";
import { ProtectedResource } from "./client.js";
import { NotFoundError, QURLError, ValidationError } from "./errors.js";
import { createClient, mockFetch, mockFetches } from "./__tests__/test-helpers.js";

// Tests for the portal-verb surface (mirrors qurl-go's portal API and
// qurl-python's port of it): protectUrl → createPortal → enterPortal.

const RESOURCE_DATA = {
  resource_id: "r_abc123def45",
  target_url: "https://internal.example.com/dashboard",
  status: "active",
  alias: "prod-dashboard",
  tags: [],
  created_at: "2026-03-10T10:00:00Z",
};

const PORTAL_DATA = {
  resource_id: "r_abc123def45",
  qurl_link: "https://qurl.link/#at_portal1",
  qurl_site: "https://r_abc123def45.qurl.site",
  expires_at: "2026-03-10T10:05:00Z",
  qurl_id: "q_portal1",
  label: "Alice from Acme",
};

const RESOLVE_DATA = {
  target_url: "https://internal.example.com/dashboard",
  resource_id: "r_abc123def45",
  access_grant: {
    expires_in: 305,
    granted_at: "2026-03-10T15:30:00Z",
    src_ip: "203.0.113.42",
  },
};

function callRequest(
  fetch: typeof globalThis.fetch,
  index = 0,
): { url: string; init: RequestInit } {
  const [url, init] = vi.mocked(fetch).mock.calls[index];
  return { url: url as string, init: init as RequestInit };
}

function callBody(fetch: typeof globalThis.fetch, index = 0): unknown {
  return JSON.parse(callRequest(fetch, index).init.body as string);
}

function callHeaders(fetch: typeof globalThis.fetch, index = 0): Record<string, string> {
  return callRequest(fetch, index).init.headers as Record<string, string>;
}

describe("protectUrl", () => {
  it("posts the resource fields and returns a bound handle", async () => {
    const fetch = mockFetch({ status: 201, body: { data: RESOURCE_DATA } });
    const client = createClient(fetch);

    const resource = await client.protectUrl("https://internal.example.com/dashboard", {
      alias: "prod-dashboard",
      description: "Admin dashboard",
    });

    expect(callBody(fetch)).toEqual({
      target_url: "https://internal.example.com/dashboard",
      alias: "prod-dashboard",
      description: "Admin dashboard",
    });
    // Mutating portal verbs carry an auto-generated idempotency key.
    expect(callHeaders(fetch)["Idempotency-Key"]).toBeTruthy();
    expect(resource).toBeInstanceOf(ProtectedResource);
    expect(resource.id).toBe("r_abc123def45");
    expect(resource.targetUrl).toBe("https://internal.example.com/dashboard");
    expect(resource.details?.status).toBe("active");
    expect(resource.details?.alias).toBe("prod-dashboard");
  });

  it("rejects non-http targets", async () => {
    const client = createClient(mockFetch({ status: 500, body: {} }));
    await expect(client.protectUrl("ftp://internal.example.com")).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining("target_url"),
    });
  });

  it("rejects embedded credentials without echoing them (qurl-go parity)", async () => {
    const client = createClient(mockFetch({ status: 500, body: {} }));
    const err = await client
      .protectUrl("https://alice:hunter2@internal.example.com/dashboard")
      .catch((e: unknown) => e as ValidationError);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).detail).toContain("embedded credentials");
    expect((err as ValidationError).message).not.toContain("hunter2");

    // Bare userinfo without a password is rejected too, like Go's u.User check.
    await expect(
      client.protectUrl("https://alice@internal.example.com/dashboard"),
    ).rejects.toMatchObject({ detail: expect.stringContaining("embedded credentials") });
  });

  it("rejects hostless URLs", async () => {
    const client = createClient(mockFetch({ status: 500, body: {} }));
    await expect(client.protectUrl("https:///dashboard")).rejects.toMatchObject({
      detail: expect.stringContaining("must include a host"),
    });
    await expect(client.protectUrl("https://")).rejects.toMatchObject({
      detail: expect.stringContaining("must include a host"),
    });
  });

  it("rejects unknown option fields", async () => {
    const client = createClient(mockFetch({ status: 500, body: {} }));
    await expect(
      client.protectUrl("https://internal.example.com", {
        target_url: "https://other.example.com",
      } as never),
    ).rejects.toMatchObject({ detail: expect.stringContaining("unknown field") });
  });

  it.each([
    [{ description: "x".repeat(501) }, "description: must be 500 characters or fewer"],
    [{ alias: "" }, "alias: must not be an empty string"],
    [{ tags: ["ok", "!bad"] }, "tags[1]"],
  ])("rejects invalid resource metadata %j before any request", async (opts, message) => {
    const fetch = mockFetch({ status: 201, body: { data: RESOURCE_DATA } });
    await expect(
      createClient(fetch).protectUrl("https://internal.example.com", opts),
    ).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining(message),
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("keeps the caller target when the response redacts target_url", async () => {
    const redacted: Record<string, unknown> = { ...RESOURCE_DATA };
    delete redacted.target_url;
    const fetch = mockFetch({ status: 201, body: { data: redacted } });

    const resource = await createClient(fetch).protectUrl("https://internal.example.com/dashboard");
    expect(resource.targetUrl).toBe("https://internal.example.com/dashboard");
  });

  it("fails closed when the response is missing resource_id", async () => {
    const fetch = mockFetch({ status: 201, body: { data: { target_url: "https://x.example" } } });
    await expect(
      createClient(fetch).protectUrl("https://internal.example.com/dashboard"),
    ).rejects.toMatchObject({
      code: "unexpected_response",
      detail: expect.stringContaining("missing resource_id"),
    });
  });
});

describe("createPortal", () => {
  it("mints against /v1/resources/{id}/qurls via the handle", async () => {
    const fetch = mockFetches([
      { status: 201, body: { data: RESOURCE_DATA } },
      { status: 201, body: { data: PORTAL_DATA } },
    ]);
    const client = createClient(fetch);

    const resource = await client.protectUrl("https://internal.example.com/dashboard");
    const portal = await resource.createPortal({
      validFor: 5 * 60 * 1000,
      label: "Alice from Acme",
      oneTimeUse: true,
      maxSessions: 0,
    });

    const { url } = callRequest(fetch, 1);
    expect(new URL(url).pathname).toBe("/v1/resources/r_abc123def45/qurls");
    expect(callBody(fetch, 1)).toEqual({
      expires_in: "5m",
      label: "Alice from Acme",
      one_time_use: true,
      // Explicit 0 means unlimited and must survive body construction.
      max_sessions: 0,
    });
    expect(portal.resourceId).toBe("r_abc123def45");
    expect(portal.link).toBe("https://qurl.link/#at_portal1");
    expect(portal.site).toBe("https://r_abc123def45.qurl.site");
    expect(portal.qurlId).toBe("q_portal1");
    expect(portal.label).toBe("Alice from Acme");
    expect(portal.expiresAt).toBeInstanceOf(Date);
    expect(portal.expiresAt?.toISOString()).toBe("2026-03-10T10:05:00.000Z");
  });

  it("accepts a resource id string and an idempotency key override", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    const client = createClient(fetch);

    const portal = await client.createPortal(
      "r_abc123def45",
      { validFor: "45m" },
      { idempotencyKey: "mint-alice-1" },
    );

    expect(callBody(fetch)).toEqual({ expires_in: "45m" });
    expect(callHeaders(fetch)["Idempotency-Key"]).toBe("mint-alice-1");
    expect(portal.link).toBe("https://qurl.link/#at_portal1");
  });

  it("sends no body when every option is omitted, so the API default applies", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    const client = createClient(fetch);

    await client.resourceById("r_abc123def45").createPortal();
    expect(callRequest(fetch).init.body).toBeUndefined();
  });

  it("rejects a handle bound to a different client", async () => {
    const client = createClient(mockFetch({ status: 201, body: { data: PORTAL_DATA } }));
    const other = createClient(mockFetch({ status: 201, body: { data: PORTAL_DATA } }));

    const resource = other.resourceById("r_abc123def45");
    await expect(client.createPortal(resource)).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining("bound to a different client"),
    });
  });

  it.each([
    [{ validFor: 30_000 }, "validFor: must be at least 60s"],
    // Below-minimum wins over whole-seconds, matching qurl-go's check order.
    [{ validFor: 30_500 }, "validFor: must be at least 60s"],
    [{ validFor: 61_500 }, "validFor: must be whole seconds"],
    [{ validFor: Number.NaN }, "validFor: must be a finite number of milliseconds"],
    [{ validFor: "" }, "validFor: must be a non-empty duration string"],
    [{ validFor: true as unknown as string }, "validFor: must be a duration string"],
    [{ sessionDuration: 0 }, "sessionDuration: must be at least 1s"],
    [{ maxSessions: 1001 }, "maxSessions: must be an integer between 0 and 1000"],
    [{ label: "x".repeat(501) }, "label: must be 500 characters or fewer"],
    [{ label: "" }, "label: must not be empty"],
    [{ label: "   " }, "label: must not be empty"],
    [{ oneTimeUse: "yes" as unknown as boolean }, "oneTimeUse: must be a boolean"],
  ])("option guardrails reject %j before any request", async (options, message) => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    const client = createClient(fetch);

    await expect(client.resourceById("r_abc123def45").createPortal(options)).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining(message),
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it.each([
    [2 * 60 * 60 * 1000, "2h"],
    [5 * 60 * 1000, "5m"],
    [90 * 1000, "90s"],
    // Hours stay the largest unit, like qurl-go: one day is 24h, not 1d.
    [24 * 60 * 60 * 1000, "24h"],
    ["36h", "36h"],
  ])("validFor %s serializes to %s with hours as the largest unit", async (validFor, expected) => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    await createClient(fetch).createPortal("r_abc123def45", { validFor });
    expect(callBody(fetch)).toEqual({ expires_in: expected });
  });

  it("serializes sessionDuration onto the wire with the same grammar", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    await createClient(fetch).createPortal("r_abc123def45", { sessionDuration: 90_000 });
    expect(callBody(fetch)).toEqual({ session_duration: "90s" });
  });

  it("rejects unknown option fields, catching REST-shaped spellings", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    await expect(
      createClient(fetch).createPortal("r_abc123def45", { valid_for: "5m" } as never),
    ).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining('unknown field "valid_for"'),
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("fails closed when the mint response is missing qurl_link", async () => {
    const fetch = mockFetch({ status: 201, body: { data: { resource_id: "r_abc123def45" } } });
    await expect(createClient(fetch).createPortal("r_abc123def45")).rejects.toMatchObject({
      code: "unexpected_response",
      detail: expect.stringContaining("missing qurl_link"),
    });
  });

  it("leaves expiresAt unset when the API timestamp is unparseable", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { ...PORTAL_DATA, expires_at: "soon-ish" } },
    });
    const portal = await createClient(fetch).createPortal("r_abc123def45");
    expect(portal.expiresAt).toBeUndefined();
    expect(portal.link).toBe("https://qurl.link/#at_portal1");
  });
});

describe("resourceById", () => {
  it("returns a handle without making a request", () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const resource = createClient(fetch).resourceById("r_abc123def45");
    expect(resource).toBeInstanceOf(ProtectedResource);
    expect(resource.id).toBe("r_abc123def45");
    expect(resource.targetUrl).toBeUndefined();
    expect(resource.details).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it.each([[""], ["   "], [" r_abc123def45 "]])("rejects invalid id %j", (id) => {
    const client = createClient(mockFetch({ status: 200, body: { data: {} } }));
    expect(() => client.resourceById(id)).toThrow(ValidationError);
  });
});

describe("connectorResource", () => {
  it("looks up the slug and returns a bound handle", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [RESOURCE_DATA] } });
    const client = createClient(fetch);

    const resource = await client.connectorResource("prod-dashboard");

    const { url } = callRequest(fetch);
    expect(new URL(url).searchParams.get("slug")).toBe("prod-dashboard");
    expect(resource.id).toBe("r_abc123def45");
    expect(resource.targetUrl).toBe("https://internal.example.com/dashboard");
    expect(resource.details?.alias).toBe("prod-dashboard");
  });

  it("throws NotFoundError when no resource matches", async () => {
    const fetch = mockFetch({ status: 200, body: { data: [] } });
    const err = await createClient(fetch)
      .connectorResource("missing-conn")
      .catch((e: unknown) => e as NotFoundError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).status).toBe(0);
    expect((err as NotFoundError).code).toBe("resource_not_found");
  });

  it("throws on an ambiguous lookup", async () => {
    const second = { ...RESOURCE_DATA, resource_id: "r_other9999999" };
    const fetch = mockFetch({ status: 200, body: { data: [RESOURCE_DATA, second] } });
    const err = await createClient(fetch)
      .connectorResource("prod-dashboard")
      .catch((e: unknown) => e as QURLError);
    expect(err).toBeInstanceOf(QURLError);
    expect((err as QURLError).code).toBe("ambiguous_resource");
  });

  it("throws when the returned alias does not match", async () => {
    const mismatched = { ...RESOURCE_DATA, alias: "some-other-alias" };
    const fetch = mockFetch({ status: 200, body: { data: [mismatched] } });
    await expect(createClient(fetch).connectorResource("prod-dashboard")).rejects.toMatchObject({
      code: "unexpected_response",
      detail: expect.stringContaining("missing or different alias"),
    });
  });

  it("requires a connector id", async () => {
    const client = createClient(mockFetch({ status: 200, body: { data: [] } }));
    await expect(client.connectorResource("   ")).rejects.toMatchObject({
      code: "client_validation",
      detail: expect.stringContaining("connector id"),
    });
  });
});

describe("createPortalForUrl", () => {
  it("posts to /v1/qurls and returns both the portal and a reusable handle", async () => {
    const fetch = mockFetches([
      { status: 201, body: { data: PORTAL_DATA } },
      { status: 201, body: { data: PORTAL_DATA } },
    ]);
    const client = createClient(fetch);

    const { portal, resource } = await client.createPortalForUrl(
      "https://internal.example.com/dashboard",
      { validFor: 5 * 60 * 1000 },
    );

    expect(new URL(callRequest(fetch).url).pathname).toBe("/v1/qurls");
    expect(callBody(fetch)).toEqual({
      target_url: "https://internal.example.com/dashboard",
      expires_in: "5m",
    });
    expect(portal.link).toBe("https://qurl.link/#at_portal1");
    expect(resource.id).toBe("r_abc123def45");
    expect(resource.targetUrl).toBe("https://internal.example.com/dashboard");
    // Only id + caller-supplied target URL are populated on this path.
    expect(resource.details).toBeUndefined();

    // The returned handle mints more portals without re-protecting.
    await resource.createPortal({ validFor: "1h" });
    expect(new URL(callRequest(fetch, 1).url).pathname).toBe("/v1/resources/r_abc123def45/qurls");
    expect(callBody(fetch, 1)).toEqual({ expires_in: "1h" });
  });

  it("rejects embedded credentials", async () => {
    const client = createClient(mockFetch({ status: 500, body: {} }));
    await expect(
      client.createPortalForUrl("https://bob:secret@internal.example.com"),
    ).rejects.toMatchObject({ detail: expect.stringContaining("embedded credentials") });
  });

  it("sends only target_url when no options are given", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL_DATA } });
    await createClient(fetch).createPortalForUrl("https://internal.example.com/dashboard");
    expect(callBody(fetch)).toEqual({ target_url: "https://internal.example.com/dashboard" });
  });
});

describe("enterPortal", () => {
  it("extracts the token from a platform link and returns the handle", async () => {
    const fetch = mockFetch({ status: 200, body: { data: RESOLVE_DATA } });
    const client = createClient(fetch);

    const handle = await client.enterPortal("https://qurl.link/#at_k8xqp9h2sj9lx7r4a");

    expect(new URL(callRequest(fetch).url).pathname).toBe("/v1/resolve");
    expect(callBody(fetch)).toEqual({ access_token: "at_k8xqp9h2sj9lx7r4a" });
    expect(handle.resourceUrl).toBe("https://internal.example.com/dashboard");
    expect(handle.openSeconds).toBe(305);
    expect(handle.resourceId).toBe("r_abc123def45");
  });

  it("accepts a bare access token", async () => {
    const fetch = mockFetch({ status: 200, body: { data: RESOLVE_DATA } });
    const handle = await createClient(fetch).enterPortal("at_k8xqp9h2sj9lx7r4a");
    expect(callBody(fetch)).toEqual({ access_token: "at_k8xqp9h2sj9lx7r4a" });
    expect(handle.openSeconds).toBe(305);
  });

  it("rejects tokenless links without echoing the input (links are credentials)", async () => {
    const client = createClient(mockFetch({ status: 200, body: { data: RESOLVE_DATA } }));

    await expect(client.enterPortal("https://qurl.link/")).rejects.toMatchObject({
      detail: expect.stringContaining("no access token found"),
    });
    await expect(client.enterPortal("https://qurl.link/#")).rejects.toMatchObject({
      detail: expect.stringContaining("no access token found"),
    });

    const err = await client
      .enterPortal("https://qurl.link/#at bad token")
      .catch((e: unknown) => e as ValidationError);
    expect((err as ValidationError).detail).toContain("no access token found");
    expect((err as ValidationError).message).not.toContain("bad token");
  });

  it("rejects non-string input from untyped callers", async () => {
    const client = createClient(mockFetch({ status: 200, body: { data: RESOLVE_DATA } }));
    await expect(client.enterPortal(42 as never)).rejects.toMatchObject({
      code: "client_validation",
      detail: "qurlLink: must be a non-empty string",
    });
  });

  it("rejects qurl-go's offline signed-fragment links with a precise error, no echo", async () => {
    const client = createClient(mockFetch({ status: 200, body: { data: RESOLVE_DATA } }));

    const err = await client
      .enterPortal("https://qurl.link/#v2.claimspart.secretpart.sigpart")
      .catch((e: unknown) => e as ValidationError);
    expect((err as ValidationError).detail).toContain("signed qURL link");
    expect((err as ValidationError).message).not.toContain("secretpart");

    // A bare signed fragment (no link wrapper) is caught the same way.
    await expect(client.enterPortal("v2.claimspart.secretpart.sigpart")).rejects.toMatchObject({
      detail: expect.stringContaining("signed qURL link"),
    });
  });

  it("fails closed when access is granted but no resource URL comes back", async () => {
    const fetch = mockFetch({ status: 200, body: { data: { resource_id: "r_abc123def45" } } });
    await expect(createClient(fetch).enterPortal("at_k8xqp9h2sj9lx7r4a")).rejects.toMatchObject({
      code: "unexpected_response",
      detail: expect.stringContaining("no resource URL"),
    });
  });

  it("reports zero open seconds when the response carries no access grant", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          target_url: "https://internal.example.com/dashboard",
          resource_id: "r_abc123def45",
        },
      },
    });
    const handle = await createClient(fetch).enterPortal("at_k8xqp9h2sj9lx7r4a");
    expect(handle.openSeconds).toBe(0);
  });

  it("reports zero open seconds when the grant omits expires_in", async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        data: {
          target_url: "https://internal.example.com/dashboard",
          resource_id: "r_abc123def45",
          access_grant: { granted_at: "2026-03-10T15:30:00Z", src_ip: "203.0.113.42" },
        },
      },
    });
    const handle = await createClient(fetch).enterPortal("at_k8xqp9h2sj9lx7r4a");
    expect(handle.openSeconds).toBe(0);
  });
});
