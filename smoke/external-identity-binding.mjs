import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cjs = require("@layervai/qurl");
const esm = await import("@layervai/qurl");
const body = {
  binding_id: "eib_Example0001",
  provider: "teams",
  external_id: "synthetic-tenant",
  api_key: {
    key_id: "key_Example00001",
    key_prefix: "lv_live_aaaa",
    plaintext: `lv_live_${"a".repeat(43)}`,
  },
  scopes: ["qurl:read", "qurl:write", "qurl:agent"],
  created_at: "2026-10-30T00:00:00Z",
};
const key = "0192f7c4-3b8a-7e2f-9d01-4cf8a1b6e3d2";
for (const { QURLClient, ValidationError } of [cjs, esm]) {
  let calls = 0;
  const client = new QURLClient({
    apiKey: "synthetic-provider-jwt",
    baseUrl: "https://api.example.com",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.example.com/v1/external-identity-bindings");
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("Idempotency-Key"), key);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-provider-jwt");
      assert.deepEqual(JSON.parse(init.body), {
        provider: "teams",
        external_id: "synthetic-tenant",
      });
      return new Response(JSON.stringify(body), { status: 201 });
    },
  });
  assert.deepEqual(
    await client.createExternalIdentityBinding(
      { provider: "teams", external_id: "synthetic-tenant" },
      { idempotencyKey: key },
    ),
    body,
  );
  await assert.rejects(
    client.createExternalIdentityBinding(
      { provider: "teams", external_id: "synthetic-tenant" },
      {},
    ),
    ValidationError,
  );
  assert.equal(calls, 1);
}
console.log("External identity binding ESM/CJS smoke passed");
