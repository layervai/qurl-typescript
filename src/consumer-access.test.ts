import { describe, it, expect } from "vitest";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { ValidationError } from "./errors.js";

const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const decision = "a".repeat(64);

describe("consumer publisher operations", () => {
  it("refuses unknown policy modes and mixed metadata updates before HTTP", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    const client = createClient(fetch);
    await expect(
      client.createResource({
        target_url: "https://example.com",
        private: true,
        consumer_access: { mode: "unknown", version: 1 },
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateResource(crid, {
        consumer_access: { mode: "review", version: 2 },
        expected_consumer_access_version: 1,
        description: "mixed",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.createResource({
        target_url: "https://example.com",
        private: false,
        consumer_access: { mode: "review", version: 1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps review approval scoped and versioned without unrelated identity", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: { id: decision, status: "active", version: 2 } },
    });
    const client = createClient(fetch);
    const result = await client.approveConsumerGrant(crid, decision, { expected_version: 1 });
    expect(result.version).toBe(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain(`/v1/resources/${crid}/consumer-grants/${decision}/approve`);
    expect(JSON.parse(String(init?.body))).toEqual({ expected_version: 1 });
  });
  it("returns the existing list cursor shape", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { data: [], meta: { next_cursor: "next-page" } },
    });
    const result = await createClient(fetch).listConsumerGrants(crid);
    expect(result.grants).toEqual([]);
    expect(result.next_cursor).toBe("next-page");
  });
  it("does not send invalid decision versions", async () => {
    const fetch = mockFetch({ status: 200, body: { data: {} } });
    await expect(createClient(fetch).revokeConsumerGrant(crid, decision, 0)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("protects a URL with the exact private policy and refuses missing confirmation", async () => {
  const resource = {
    resource_id:
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
    crid,
    private: true,
    consumer_access: { version: 1, mode: "review" },
    target_url: "https://example.com",
  };
  const fetch = mockFetch({ status: 201, body: { data: resource } });
  const result = await createClient(fetch).protectUrl("https://example.com", {
    consumerAccess: { mode: "review", version: 1 },
  });
  expect(result.crid).toBe(crid);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
    private: true,
    consumer_access: { mode: "review", version: 1 },
  });
  const absent = mockFetch({
    status: 201,
    body: { data: { ...resource, consumer_access: undefined } },
  });
  await expect(
    createClient(absent).protectUrl("https://example.com", {
      consumerAccess: { mode: "review", version: 1 },
    }),
  ).rejects.toThrow("private policy was not confirmed");
});

it("refuses a later policy version before ensuring a Connector resource", async () => {
  const fetch = mockFetch({ status: 201, body: { data: {} } });
  await expect(
    createClient(fetch).ensureConnectorResource("app", undefined, { mode: "review", version: 2 }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false, undefined])(
  "keeps a later URL policy only on a confirmed existing resource (%s)",
  async (foundExisting) => {
    const resource = {
      resource_id:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
      crid,
      private: true,
      consumer_access: { mode: "review", version: 3 },
      target_url: "https://example.com",
    };
    const fetch = mockFetch({
      status: 201,
      body: { data: resource, meta: { found_existing: foundExisting } },
    });
    const result = createClient(fetch).protectUrl("https://example.com", {
      consumerAccess: { mode: "review", version: 1 },
    });
    if (foundExisting === true) expect((await result).details?.consumer_access?.version).toBe(3);
    else await expect(result).rejects.toThrow("private policy was not confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).consumer_access.version).toBe(1);
  },
);

it("returns email-backed grants but refuses email credential claims in publisher input", async () => {
  const grant = {
    id: decision,
    status: "active",
    version: 2,
    credential_kind: "email",
    email: "reader@example.com",
    email_verified_at: "2026-10-15T00:00:00Z",
  };
  const fetch = mockFetch({ status: 200, body: { data: [grant] } });
  expect((await createClient(fetch).listConsumerGrants(crid)).grants).toEqual([grant]);
  const rejected = mockFetch({ status: 200, body: { data: grant } });
  await expect(
    createClient(rejected).approveConsumerGrant(crid, decision, {
      expected_version: 1,
      credential_kind: "email",
    } as never),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(rejected).not.toHaveBeenCalled();
});

it("validates payment policies and refuses a changed Stripe price in confirmation", async () => {
  const payment = { account_id: "acct_publisher", price_id: "price_product", access_seconds: 3600 };
  const policy = { mode: "contract" as const, version: 1, contract_id: "sale", payment };
  const resource = {
    resource_id:
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
    crid,
    private: true,
    consumer_access: policy,
    target_url: "https://example.com",
  };
  const fetch = mockFetch({ status: 201, body: { data: resource } });
  await createClient(fetch).protectUrl("https://example.com", { consumerAccess: policy });
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).consumer_access.payment).toEqual(
    payment,
  );
  const changed = mockFetch({
    status: 201,
    body: {
      data: {
        ...resource,
        consumer_access: { ...policy, payment: { ...payment, price_id: "price_other" } },
      },
    },
  });
  await expect(
    createClient(changed).protectUrl("https://example.com", { consumerAccess: policy }),
  ).rejects.toThrow("private policy was not confirmed");
  const never = mockFetch({ status: 201, body: { data: resource } });
  await expect(
    createClient(never).createResource({
      target_url: "https://example.com",
      private: true,
      consumer_access: { ...policy, payment: { ...payment, access_seconds: -1 } },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(never).not.toHaveBeenCalled();
});

it("refuses Stripe onboarding redirects outside the approved host and changed fees", async () => {
  for (const url of [
    "http://connect.stripe.com/oauth",
    "https://connect.stripe.com.attacker.test/",
    "https://user@connect.stripe.com/oauth",
  ]) {
    await expect(
      createClient(mockFetch({ status: 200, body: { data: { url } } })).connectPublisherStripe(),
    ).rejects.toBeInstanceOf(ValidationError);
  }
  await expect(
    createClient(
      mockFetch({
        status: 200,
        body: { data: { account_id: "acct_publisher", layerv_fee_percent: 4 } },
      }),
    ).publisherStripeAccount(),
  ).rejects.toBeInstanceOf(ValidationError);
});
