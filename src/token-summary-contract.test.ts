import { expect, it } from "vitest";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";

it("keeps an omitted token-summary expiry optional when mapping wire qurls", async () => {
  const token = {
    qurl_id: "q_0123456789a",
    status: "active",
    one_time_use: false,
    max_sessions: 1,
    session_duration: 3600,
    use_count: 0,
    created_at: "2026-01-01T00:00:00Z",
  };
  const client = createClient(
    mockFetch({
      status: 200,
      body: { data: { resource_id: "r_summary_contract", qurls: [token] } },
    }),
  );
  const resource = await client.get("ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a");
  expect(resource.access_tokens).toEqual([token]);
  expect(resource.access_tokens?.[0]).not.toHaveProperty("expires_at");
});
