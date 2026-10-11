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
