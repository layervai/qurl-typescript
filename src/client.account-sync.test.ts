import { describe, expect, it, vi } from "vitest";
import { ERROR_CODE_UNEXPECTED_RESPONSE, QURLError, ValidationError } from "./errors.js";
import type { AccessRules, ReceivedHistory } from "./index.js";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { callHeaders, PUBLIC_RESOURCE_ID, RESOURCE_CRID } from "./__tests__/client-fixtures.js";

const call = (fetch: typeof globalThis.fetch, index = 0) => {
  const [url, init] = vi.mocked(fetch).mock.calls[index]!;
  return {
    url: String(url),
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    idempotencyKey: callHeaders(fetch, index)["Idempotency-Key"],
  };
};

const rules: AccessRules = {
  account_id: "test-account",
  version: 3,
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Paid",
      mode: "contract",
      contract_id: "customer-entitlement",
      payment: { price_id: "price_123", access_seconds: 0 },
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Quick look",
      mode: "public",
      link_limits: { expires_in: "1h", one_time_use: false },
    },
  ],
  built_ins: [{ id: "builtin.review", name: "People you approve", mode: "review" }],
  quick_share_rule_id: "review",
};

describe("access rules", () => {
  it("reads the library and tolerates the Quick share choice", async () => {
    const fetch = mockFetch({ status: 200, body: { data: rules } });
    await expect(createClient(fetch).getAccessRules()).resolves.toEqual(rules);
    expect(call(fetch)).toMatchObject({
      url: "https://api.test.layerv.ai/v1/me/access-rules",
      method: "GET",
    });
  });

  it("saves version and items only, without an idempotency key or retry", async () => {
    const fetch = mockFetch({ status: 200, body: { data: { ...rules, version: 4 } } });
    const saved = await createClient(fetch).saveAccessRules({
      version: rules.version,
      items: rules.items,
    });
    expect(saved.version).toBe(4);
    expect(call(fetch)).toEqual({
      url: "https://api.test.layerv.ai/v1/me/access-rules",
      method: "PUT",
      body: { version: 3, items: rules.items },
      idempotencyKey: undefined,
    });
  });

  it("surfaces a stale version as a 409 without replaying it", async () => {
    const fetch = mockFetch({
      status: 409,
      body: { error: { code: "conflict", title: "Conflict", status: 409 } },
    });
    await expect(
      createClient(fetch).saveAccessRules({ version: 1, items: [] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...rules, quick_share_rule_id: "once" }],
    [{ version: 1, items: [], built_ins: [] }],
    [{ version: -1, items: [] }],
    [{ version: 1, items: [null] }],
    [{ version: 1 }],
    [[]],
  ])("refuses an invalid save before HTTP: %j", async (input) => {
    const fetch = mockFetch({ status: 200, body: { data: rules } });
    await expect(createClient(fetch).saveAccessRules(input as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...rules, account_id: "" },
    { ...rules, version: undefined },
    { ...rules, items: undefined },
    { ...rules, built_ins: [{ id: "builtin.review", name: "x" }] },
    { ...rules, quick_share_rule_id: null },
  ])("rejects an invalid library response", async (data) => {
    await expect(
      createClient(mockFetch({ status: 200, body: { data } })).getAccessRules(),
    ).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
      detail: "getAccessRules: invalid access rules response",
    });
  });
});

describe("inbox state", () => {
  it("reads and saves the state at the read version", async () => {
    const state = { version: 2, seen_through: "2026-11-01T00:00:00Z", dismissed: ["crid:ask:1"] };
    const fetch = mockFetch({ status: 200, body: { data: state } });
    const client = createClient(fetch);
    await expect(client.getInboxState()).resolves.toEqual(state);
    await client.saveInboxState({ version: 2, dismissed: ["crid:ask:1"] });
    expect(call(fetch, 1)).toMatchObject({
      url: "https://api.test.layerv.ai/v1/me/inbox-state",
      method: "PUT",
      body: { version: 2, dismissed: ["crid:ask:1"] },
    });
  });

  it.each([
    { version: 0 },
    { version: 0, dismissed: [""] },
    { version: 0, dismissed: [], seen_through: 1 },
    { version: 0, dismissed: [], extra: true },
  ])("refuses an invalid state before HTTP", async (input) => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    await expect(createClient(fetch).saveInboxState(input as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a state response without dismissed keys", async () => {
    await expect(
      createClient(mockFetch({ status: 200, body: { data: { version: 0 } } })).getInboxState(),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });
});

describe("received history", () => {
  const history: ReceivedHistory = {
    version: 5,
    cleared_at: 1_700_000_000_000,
    items: [{ crid: RESOURCE_CRID, opened_at: 1_700_000_000_500, name: "Report" }],
  };

  it("reads, saves and clears the history", async () => {
    const fetch = mockFetch({ status: 200, body: { data: history } });
    const client = createClient(fetch);
    await expect(client.getReceivedHistory()).resolves.toEqual(history);
    await client.saveReceivedHistory({ version: 5, items: history.items });
    await client.clearReceivedHistory();
    expect(call(fetch, 1)).toMatchObject({
      method: "PUT",
      body: { version: 5, items: history.items },
    });
    expect(call(fetch, 2)).toMatchObject({
      url: "https://api.test.layerv.ai/v1/me/received-history",
      method: "DELETE",
      body: undefined,
    });
  });

  it("does not replay a clear that conflicts", async () => {
    const fetch = mockFetch({
      status: 409,
      body: { error: { code: "conflict", title: "Conflict", status: 409 } },
    });
    await expect(createClient(fetch).clearReceivedHistory()).rejects.toBeInstanceOf(QURLError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses the read-only cleared_at in a save", async () => {
    const fetch = mockFetch({ status: 200, body: { data: history } });
    await expect(createClient(fetch).saveReceivedHistory(history as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { version: 0, items: [{ crid: RESOURCE_CRID }] },
    { version: 0, items: [], cleared_at: 0 },
    { version: 0, items: [{ crid: RESOURCE_CRID, opened_at: 1, added_at: "1" }] },
  ])("rejects an invalid history response", async (data) => {
    await expect(
      createClient(mockFetch({ status: 200, body: { data } })).getReceivedHistory(),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });
});

describe("resource link defaults", () => {
  const resource = { resource_id: PUBLIC_RESOURCE_ID, crid: RESOURCE_CRID };

  it("sends a replacement object and null to remove", async () => {
    const defaults = { expires_in: "1h", one_time_use: true, rule_name: "Quick look" };
    const fetch = mockFetch({
      status: 200,
      body: { data: { ...resource, link_defaults: defaults } },
    });
    const client = createClient(fetch);
    const updated = await client.updateResource(RESOURCE_CRID, { link_defaults: defaults });
    expect(updated.link_defaults).toEqual(defaults);
    await client.updateResource(RESOURCE_CRID, { link_defaults: null });
    expect(call(fetch, 0).body).toEqual({ link_defaults: defaults });
    expect(call(fetch, 1)).toMatchObject({ method: "PATCH", body: { link_defaults: null } });
  });

  it.each([
    { link_defaults: {} },
    { link_defaults: { expires_in: "" } },
    { link_defaults: { expires_in: "1h", one_time_use: "yes" } },
    { link_defaults: { expires_in: "1h", extra: 1 } },
  ])("refuses invalid link defaults before HTTP: %j", async (input) => {
    const fetch = mockFetch({ status: 200, body: { data: resource } });
    await expect(
      createClient(fetch).updateResource(RESOURCE_CRID, input as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("rule-backed consumer policies", () => {
  const target = "https://example.com";
  const created = (consumer_access: Record<string, unknown>) =>
    mockFetch({
      status: 201,
      body: {
        data: {
          resource_id: PUBLIC_RESOURCE_ID,
          crid: RESOURCE_CRID,
          private: true,
          consumer_access,
        },
      },
    });

  it("publishes an email-domain policy with mailbox exceptions", async () => {
    const policy = {
      mode: "email_domain" as const,
      version: 1,
      email_domain: "acme.com",
      allowed_emails: ["Partner@outside.example", "ops@vendor.example"],
    };
    const fetch = created(policy);
    await createClient(fetch).protectUrl(target, { consumerAccess: policy });
    expect(call(fetch).body.consumer_access).toEqual(policy);
    await expect(
      createClient(
        created({ ...policy, allowed_emails: [...policy.allowed_emails].reverse() }),
      ).protectUrl(target, {
        consumerAccess: policy,
      }),
    ).rejects.toThrow("private policy was not confirmed");
  });

  it.each([
    ["7d", "7d"],
    ["1w", "7d"],
    ["168h", "7d"],
    ["90m", "1h30m0s"],
  ])("confirms approval lifetime %s stored as %s", async (sent, stored) => {
    const policy = { mode: "review" as const, version: 1, approval_expires_in: sent };
    await createClient(created({ ...policy, approval_expires_in: stored })).protectUrl(target, {
      consumerAccess: policy,
    });
  });

  it("refuses a dropped approval lifetime", async () => {
    const policy = { mode: "keys" as const, version: 1, approval_expires_in: "7d" };
    await expect(
      createClient(created({ ...policy, approval_expires_in: undefined })).protectUrl(target, {
        consumerAccess: policy,
      }),
    ).rejects.toThrow("private policy was not confirmed");
  });

  it.each([
    { mode: "email_domain", version: 1 },
    { mode: "review", version: 1, email_domain: "acme.com" },
    { mode: "email_domain", version: 1, email_domain: "acme.com", allowed_emails: [""] },
    { mode: "invite_only", version: 1, approval_expires_in: "7d" },
    { mode: "review", version: 1, approval_expires_in: "" },
  ])("refuses an invalid policy before HTTP: %j", async (policy) => {
    const fetch = created(policy);
    await expect(
      createClient(fetch).protectUrl(target, { consumerAccess: policy as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
