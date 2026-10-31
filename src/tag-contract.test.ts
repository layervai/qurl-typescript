import { expect, it, vi } from "vitest";
import type { ListInput } from "./types.js";
import { createClient, mockFetches } from "./__tests__/test-helpers.js";

it("preserves space-bearing tags through updates and encodes search text independently", async () => {
  const resource = {
    resource_id: "r_tag_contract",
    target_url: "https://example.com",
    description: "example search",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    tags: ["my tag"],
  };
  const fetch = mockFetches([
    {
      status: 200,
      body: {
        data: { resource_id: resource.resource_id, qurl_link: "https://qurl.link/#at_test" },
      },
    },
    { status: 200, body: { data: [resource], meta: { has_more: false } } },
  ]);
  const client = createClient(fetch);
  await client.update("ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a", {
    tags: ["my tag"],
  });
  const page = await client.list({ q: "example search" });
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).tags).toEqual(["my tag"]);
  expect(page.qurls[0]?.tags).toEqual(["my tag"]);
  expect(new URL(vi.mocked(fetch).mock.calls[1][0] as string).searchParams.get("q")).toBe(
    "example search",
  );
  // The current list API has text search, not a separate tags-array filter.
  await expect(client.list({ tags: ["my tag"] } as unknown as ListInput)).rejects.toMatchObject({
    code: "client_validation",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
