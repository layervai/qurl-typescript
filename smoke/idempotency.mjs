// Runtime smoke for the generated Idempotency-Key path. This intentionally
// runs from dist through the package export, so CI can execute it on the
// declared minimum Node version after the Node 22 build step.
import assert from "node:assert/strict";
import { QURLClient } from "@layervai/qurl";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let requestHeaders;
let requestBody;

const fetch = async (_url, init) => {
  assert.equal(init.method, "POST");
  requestHeaders = init.headers;
  requestBody = JSON.parse(init.body);

  return new Response(
    JSON.stringify({
      data: {
        qurl_id: "q_smoke",
        resource_id: "r_smoke",
        qurl_link: "https://qurl.link/#at_smoke",
        qurl_site: "https://r_smoke.qurl.site",
        expires_at: "2026-03-15T10:00:00Z",
        label: "Smoke",
      },
    }),
    {
      status: 201,
      headers: { "content-type": "application/json" },
    },
  );
};

const client = new QURLClient({
  apiKey: "lv_live_smoke",
  baseUrl: "https://api.test.layerv.ai",
  fetch,
});

const result = await client.create({
  target_url: "https://example.com",
  label: "Smoke",
});

assert.equal(requestBody.target_url, "https://example.com");
assert.equal(result.resource_id, "r_smoke");
assert.match(requestHeaders["Idempotency-Key"], UUID_V7_RE);

console.log("Idempotency smoke ok");
