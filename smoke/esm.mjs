// ESM consumer smoke test. Mirror of cjs.cjs through `exports.import`
// via a package self-reference. Same scope as cjs.cjs — minimal happy-
// path; full-surface drift is caught by smoke/parity.mjs.
import assert from "node:assert/strict";
import { QURLClient, QURLError, ValidationError, VERSION } from "@layervai/qurl";

if (typeof QURLClient !== "function") {
  throw new Error("QURLClient is not a constructor");
}
if (typeof QURLError !== "function" || typeof ValidationError !== "function") {
  throw new Error("error classes did not load");
}
if (typeof VERSION !== "string") {
  throw new Error("VERSION not exported");
}

const client = new QURLClient({ apiKey: "test-api-key" });
if (typeof client.create !== "function" || typeof client.resolve !== "function") {
  throw new Error("client methods not callable");
}

const bindingKey = "tenant-obviously-fake-binding-0001";
let bindingRequest;
const bindingClient = new QURLClient({
  apiKey: "test-api-key",
  baseUrl: "https://api.test.layerv.ai",
  maxRetries: 0,
  fetch: async (_url, init) => {
    bindingRequest = init;
    return new Response(
      JSON.stringify({
        binding_id: "eib_esm_smoke",
        provider: "teams",
        external_id: "tenant-obviously-fake",
        api_key: {
          key_id: "key_esm_smoke",
          key_prefix: "qurl_test",
          plaintext: "qurl_test_obviously_fake_esm_secret",
        },
        scopes: ["qurl:read"],
        created_at: "2026-08-02T00:00:00Z",
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json",
          "X-Idempotency-Replayed": "true",
        },
      },
    );
  },
});

const binding = await bindingClient.createExternalIdentityBinding(
  { provider: "teams", external_id: "tenant-obviously-fake" },
  { idempotencyKey: bindingKey },
);
assert.equal(bindingRequest.headers["Idempotency-Key"], bindingKey);
assert.equal(binding.binding_id, "eib_esm_smoke");
assert.equal(binding.replayed, true);

console.log("ESM smoke ok");
