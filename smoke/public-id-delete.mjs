// Exercise native fetch and both built exports through an actual HTTP server.
// This tests the SDK transport boundary; it does not simulate service storage.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const publicId =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";
const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const calls = [];
let status = 204;
let body;
const server = createServer((req, res) => {
  calls.push({ method: req.method, path: req.url });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const [name, sdk] of [
    ["ESM", await import("@layervai/qurl")],
    ["CJS", require("@layervai/qurl")],
  ]) {
    const client = new sdk.QURLClient({
      apiKey: "local-smoke-only",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      maxRetries: 3,
    });
    status = 204;
    body = undefined;
    for (const id of [crid]) {
      const before = calls.length;
      await client.delete(id);
      assert.equal(calls.length, before + 1);
      assert.deepEqual(calls.at(-1), {
        method: "DELETE",
        path: `/v1/qurls/${encodeURIComponent(id)}`,
      });
    }
    const before = calls.length;
    for (const id of [
      publicId,
      "resource/with?reserved#bytes",
      "%",
      "%zz",
      "q_0123456789a",
      "%71_0123456789a",
      "at_smoke",
      "..",
      "%252e%252e",
    ]) {
      await assert.rejects(client.delete(id), { code: sdk.ERROR_CODE_CLIENT_VALIDATION });
    }
    assert.equal(calls.length, before, "invalid identifiers reached the server");
    for (const nextStatus of [200, 429, 503]) {
      status = nextStatus;
      const before = calls.length;
      await assert.rejects(client.delete(crid), { status });
      assert.equal(calls.length, before + 1, "DELETE was replayed");
    }
    status = 200;
    for (const count of [undefined, null, "0", -1, Number.MAX_SAFE_INTEGER + 1, 0, 3]) {
      body = JSON.stringify({ data: { terminated: count }, meta: { request_id: "req_count" } });
      const before = calls.length;
      const pending = client.terminateAllResourceSessions(crid);
      if (count === 0 || count === 3) {
        assert.equal((await pending).terminated, count);
      } else {
        await assert.rejects(pending, {
          code: sdk.ERROR_CODE_UNEXPECTED_RESPONSE,
          requestId: "req_count",
        });
      }
      assert.equal(calls.length, before + 1, "session termination DELETE was replayed");
      assert.deepEqual(calls.at(-1), {
        method: "DELETE",
        path: `/v1/resources/${crid}/sessions?paged=true`,
      });
    }
    console.log(`${name}: CRID DELETE native HTTP smoke passed`);
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
