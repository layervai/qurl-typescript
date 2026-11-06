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

  it("rejects an empty name before sending", async () => {
    const fetch = mockFetch({ status: 201, body: { data: RESOURCE } });
    const client = createClient(fetch);
    const attempts = [
      client.protectUrl(TARGET, { name: " " }),
      client.protectUrl(TARGET, { name: " Team" }),
      client.protectUrl(TARGET, { name: "Team\ndashboard" }),
      client.createResource({ target_url: TARGET, name: "" }),
      client.createPortalForUrl(TARGET, { name: "" }),
      client.create({ target_url: TARGET, name: " " }),
      client.batchCreate({ items: [{ target_url: TARGET, name: "" }] }),
      client.ensureConnectorResource("prod-dashboard", undefined, undefined, ""),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "client_validation",
        detail: expect.stringContaining("name"),
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is rejected by createPortal, whose resource already exists", async () => {
    const fetch = mockFetch({ status: 201, body: { data: PORTAL } });
    await expect(
      createClient(fetch).resourceByCrid(CRID).createPortal({ name: "Team dashboard" }),
    ).rejects.toMatchObject({ code: "client_validation" });
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
