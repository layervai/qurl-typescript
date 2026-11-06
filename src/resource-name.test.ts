import { describe, it, expect, vi } from "vitest";
import { ERROR_CODE_NAME_REQUIRED, ValidationError } from "./errors.js";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { connectorResourceData } from "./__tests__/client-fixtures.js";

// The public resource name: sent by every call that can create a resource.

const CRID = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const RESOURCE_PUBLIC_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";
const RESOURCE = { resource_id: RESOURCE_PUBLIC_KEY, crid: CRID, status: "active" };
const PORTAL = {
  resource_id: RESOURCE_PUBLIC_KEY,
  crid: CRID,
  qurl_link: "https://qurl.link/#at_portal1",
  qurl_site: `https://${CRID}.qurl.site`,
  qurl_id: "q_portal1",
};
const TARGET = "https://internal.example.com/dashboard";

function sentBody(fetch: typeof globalThis.fetch): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("resource name", () => {
  it("is sent by protectUrl, createResource, createPortalForUrl, and create", async () => {
    const calls: [unknown, (c: ReturnType<typeof createClient>) => Promise<unknown>][] = [
      [{ data: RESOURCE }, (c) => c.protectUrl(TARGET, { name: "Team dashboard" })],
      [{ data: RESOURCE }, (c) => c.createResource({ target_url: TARGET, name: "Team dashboard" })],
      [{ data: PORTAL }, (c) => c.createPortalForUrl(TARGET, { name: "Team dashboard" })],
      [{ data: PORTAL }, (c) => c.create({ target_url: TARGET, name: "Team dashboard" })],
    ];
    for (const [body, call] of calls) {
      const fetch = mockFetch({ status: 201, body });
      await call(createClient(fetch));
      expect(sentBody(fetch)).toMatchObject({ name: "Team dashboard" });
    }
  });

  it("is sent by each batchCreate item", async () => {
    const fetch = mockFetch({
      status: 201,
      body: {
        data: { succeeded: 1, failed: 0, results: [{ index: 0, success: true, ...PORTAL }] },
      },
    });
    await createClient(fetch).batchCreate({
      items: [{ target_url: TARGET, name: "Team dashboard" }],
    });
    expect(sentBody(fetch)).toMatchObject({ items: [{ name: "Team dashboard" }] });
  });

  it("is sent by ensureConnectorResource", async () => {
    const fetch = mockFetch({
      status: 201,
      body: { data: connectorResourceData(), meta: { found_existing: false } },
    });
    await createClient(fetch).ensureConnectorResource(
      "prod-dashboard",
      undefined,
      undefined,
      "Team dashboard",
    );
    expect(sentBody(fetch)).toEqual({
      type: "tunnel",
      slug: "prod-dashboard",
      find_or_create: true,
      name: "Team dashboard",
    });
  });

  it("accepts non-ASCII names and refuses ZWJ like the service", async () => {
    for (const name of ["Café ダッシュボード", "Ünïcode — dashboard ✓", "😀".repeat(100)]) {
      const fetch = mockFetch({ status: 201, body: { data: RESOURCE } });
      await createClient(fetch).protectUrl(TARGET, { name });
      expect(sentBody(fetch)).toMatchObject({ name });
    }
    // qurl-service ValidatePreviewName refuses all of Cf, including U+200D.
    const fetch = mockFetch({ status: 201, body: { data: RESOURCE } });
    await expect(
      createClient(fetch).protectUrl(TARGET, { name: "\u{1F469}\u200D\u{1F4BB} Dev portal" }),
    ).rejects.toMatchObject({ code: "client_validation" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is sent with a consumer policy by ensureConnectorResource", async () => {
    const policy = { mode: "invite_only", version: 1 } as const;
    const fetch = mockFetch({
      status: 201,
      body: {
        data: connectorResourceData({ private: true, consumer_access: policy }),
        meta: { found_existing: false },
      },
    });
    await createClient(fetch).ensureConnectorResource("prod-dashboard", undefined, policy, "Prod");
    expect(sentBody(fetch)).toMatchObject({
      name: "Prod",
      private: true,
      consumer_access: policy,
    });
  });

  it("rejects an empty name before sending", async () => {
    const fetch = mockFetch({ status: 201, body: { data: RESOURCE } });
    const client = createClient(fetch);
    const attempts = [
      () => client.protectUrl(TARGET, { name: " " }),
      () => client.protectUrl(TARGET, { name: " Team" }),
      () => client.protectUrl(TARGET, { name: "Team\ndashboard" }),
      () => client.protectUrl(TARGET, { name: "Team\u2028dashboard" }),
      () => client.protectUrl(TARGET, { name: "Team\u202edashboard" }),
      () => client.protectUrl(TARGET, { name: "x".repeat(101) }),
      () => client.createResource({ target_url: TARGET, name: "" }),
      () => client.createPortalForUrl(TARGET, { name: "" }),
      () => client.createPortalForUrl(TARGET, { name: "Team\ndashboard" }),
      () => client.create({ target_url: TARGET, name: " " }),
      () => client.batchCreate({ items: [{ target_url: TARGET, name: "" }] }),
      () => client.ensureConnectorResource("prod-dashboard", undefined, undefined, ""),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        code: "client_validation",
        detail: expect.stringContaining("name"),
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is left out when not set", async () => {
    type Client = ReturnType<typeof createClient>;
    const connector = { data: connectorResourceData(), meta: { found_existing: true } };
    for (const [body, call] of [
      [{ data: RESOURCE }, (c: Client) => c.protectUrl(TARGET)],
      [{ data: RESOURCE }, (c: Client) => c.createResource({ target_url: TARGET })],
      [{ data: PORTAL }, (c: Client) => c.createPortalForUrl(TARGET)],
      [{ data: PORTAL }, (c: Client) => c.createPortalForUrl(TARGET, { name: null as never })],
      [{ data: PORTAL }, (c: Client) => c.create({ target_url: TARGET })],
      [connector, (c: Client) => c.ensureConnectorResource("prod-dashboard")],
    ] as const) {
      const fetch = mockFetch({ status: 201, body });
      await call(createClient(fetch));
      expect(sentBody(fetch)).not.toHaveProperty("name");
    }
  });

  it("is rejected on calls whose resource already exists", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL } });
    const client = createClient(fetch);
    for (const name of ["Team dashboard", ""]) {
      await expect(client.resourceByCrid(CRID).createPortal({ name })).rejects.toMatchObject({
        code: "client_validation",
        detail: expect.stringContaining("this resource exists"),
      });
    }
    await expect(
      client.createQurlForResource(CRID, { name: "Team dashboard" } as never),
    ).rejects.toMatchObject({ code: "client_validation", detail: expect.stringContaining("name") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the server's name_required refusal as a ValidationError", async () => {
    const fetch = mockFetch({
      status: 400,
      body: {
        error: {
          code: "name_required",
          title: "Bad Request",
          detail: "name is required: the public name recipients see for this resource",
        },
      },
    });
    const error = await createClient(fetch)
      .protectUrl(TARGET)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: ERROR_CODE_NAME_REQUIRED });
  });
});
