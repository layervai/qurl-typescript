// CJS consumer smoke test. Resolves the package via its `exports.require`
// condition using a package self-reference, exactly like a downstream
// `require("@layervai/qurl")` would. Intentionally covers only a minimal
// happy-path surface — full-surface drift between the two builds is
// caught by smoke/parity.mjs, and end-to-end client behavior is covered
// by the vitest suite. Don't pad this out.
const assert = require("node:assert/strict");
const { QURLClient, QURLError, ValidationError, VERSION } = require("@layervai/qurl");

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

async function smokeExternalIdentityBinding() {
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
          binding_id: "eib_cjs_smoke",
          provider: "slack",
          external_id: "workspace-obviously-fake",
          api_key: {
            key_id: "key_cjs_smoke",
            key_prefix: "qurl_test",
            plaintext: "qurl_test_obviously_fake_cjs_secret",
          },
          scopes: ["qurl:read"],
          created_at: "2026-08-02T00:00:00Z",
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            "Idempotency-Replayed": "true",
          },
        },
      );
    },
  });

  const binding = await bindingClient.createExternalIdentityBinding(
    { provider: "slack", external_id: "workspace-obviously-fake" },
    { idempotencyKey: bindingKey },
  );
  assert.equal(bindingRequest.headers["Idempotency-Key"], bindingKey);
  assert.equal(binding.binding_id, "eib_cjs_smoke");
  assert.equal(binding.replayed, true);
  assert.equal(binding.api_key.plaintext, "qurl_test_obviously_fake_cjs_secret");
  assert.ok(!("plaintext" in { ...binding.api_key }));
  assert.ok(!("plaintext" in JSON.parse(JSON.stringify(binding.api_key))));
}

smokeExternalIdentityBinding()
  .then(() => console.log("CJS smoke ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
