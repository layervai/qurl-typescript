// Built-package security smoke: exercise the redirect refusal and streaming
// response cap through both conditional exports, not the TypeScript source.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const builds = [
  ["ESM", await import("@layervai/qurl")],
  ["CJS", require("@layervai/qurl")],
];
const RESPONSE_LIMIT = 1 << 20;

function sizedJSON(prefix, suffix, size) {
  const paddingLength = size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(paddingLength >= 0);
  const body = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
  assert.equal(Buffer.byteLength(body), size);
  return body;
}

for (const [name, sdk] of builds) {
  let redirectCalls = 0;
  let targetCalls = 0;
  const redirectTarget = "https://redirect-target.invalid/collect";
  const redirectMarker = "redirect-response-secret";
  const redirectFetch = async (url, init) => {
    redirectCalls++;
    if (url === redirectTarget) {
      targetCalls++;
      return new Response(null, { status: 204 });
    }
    assert.equal(init.redirect, "manual");
    return new Response(redirectMarker, {
      status: 302,
      headers: { location: redirectTarget },
    });
  };
  const redirectClient = new sdk.QURLClient({
    apiKey: "smoke-secret-key",
    baseUrl: "https://api.test.layerv.ai",
    fetch: redirectFetch,
    maxRetries: 2,
  });
  const redirectError = await redirectClient
    .create({ target_url: "https://example.com" }, { idempotencyKey: "smoke-idempotency-key" })
    .catch((error) => error);
  assert.ok(redirectError instanceof sdk.QURLError);
  assert.equal(redirectError.status, 302);
  assert.equal(redirectError.code, sdk.ERROR_CODE_UNEXPECTED_RESPONSE);
  assert.equal(
    redirectError.message,
    "Unexpected Response (302): Refused HTTP 302 redirect response for POST",
  );
  assert.equal(redirectError.detail, "Refused HTTP 302 redirect response for POST");
  assert.equal(String(redirectError.message).includes(redirectMarker), false);
  assert.equal(String(redirectError.detail).includes(redirectMarker), false);
  assert.equal(redirectCalls, 1, `${name} redirect response was retried or followed`);
  assert.equal(targetCalls, 0, `${name} requested the redirect target`);

  let oversizedSuccessCalls = 0;
  const oversizedSuccessMarker = "success-response-secret-must-not-be-reflected";
  const oversizedSuccessClient = new sdk.QURLClient({
    apiKey: "smoke-secret-key",
    baseUrl: "https://api.test.layerv.ai",
    maxRetries: 2,
    fetch: async () => {
      oversizedSuccessCalls++;
      return new Response(`${oversizedSuccessMarker}${"x".repeat(RESPONSE_LIMIT)}`, {
        status: 200,
        headers: { "content-length": "1", "content-type": "application/json" },
      });
    },
  });
  const oversizedSuccessError = await oversizedSuccessClient.getQuota().catch((error) => error);
  assert.ok(oversizedSuccessError instanceof sdk.QURLError);
  assert.equal(oversizedSuccessError.status, 200);
  assert.equal(oversizedSuccessError.code, sdk.ERROR_CODE_UNEXPECTED_RESPONSE);
  assert.equal(String(oversizedSuccessError.message).includes(oversizedSuccessMarker), false);
  assert.equal(String(oversizedSuccessError.detail).includes(oversizedSuccessMarker), false);
  assert.equal(oversizedSuccessCalls, 1, `${name} oversized HTTP 200 response was retried`);

  let oversizedCalls = 0;
  const oversizedMarker = "response-secret-must-not-be-reflected";
  const oversizedClient = new sdk.QURLClient({
    apiKey: "smoke-secret-key",
    baseUrl: "https://api.test.layerv.ai",
    maxRetries: 2,
    fetch: async (_url, init) => {
      oversizedCalls++;
      assert.equal(init.redirect, "manual");
      if (oversizedCalls > 1) {
        return new Response(
          JSON.stringify({
            data: { plan: "growth", period_start: "2026-03-01", period_end: "2026-04-01" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`${oversizedMarker}${"x".repeat(RESPONSE_LIMIT)}`, {
        status: 503,
        // Deliberately inaccurate: streamed-byte accounting must still reject.
        headers: { "content-length": "1", "content-type": "application/json" },
      });
    },
  });
  const recovered = await oversizedClient.getQuota();
  assert.equal(recovered.plan, "growth");
  assert.equal(oversizedCalls, 2, `${name} oversized transient response was not retried once`);

  const boundaryBody = sizedJSON('{"data":{"padding":"', '"}}', RESPONSE_LIMIT);
  const boundaryClient = new sdk.QURLClient({
    apiKey: "smoke-secret-key",
    baseUrl: "https://api.test.layerv.ai",
    fetch: async () =>
      new Response(boundaryBody, {
        status: 200,
        headers: { "content-length": String(RESPONSE_LIMIT) },
      }),
  });
  const boundary = await boundaryClient.getQuota();
  assert.equal(typeof boundary.padding, "string", `${name} exact-limit body did not parse`);
}

console.log("Response hardening smoke ok (ESM + CJS)");
