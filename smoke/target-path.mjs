import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const artifact = require("@layervai/qurl-conformance").targetPathV1Vectors();
const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const data = {
  resource_id:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
  crid,
  qurl_link: "https://qurl.link/#at_path",
};
for (const sdk of [require("@layervai/qurl"), await import("@layervai/qurl")]) {
  for (const tc of artifact.cases) {
    for (const mode of ["client", "handle", "rest"]) {
      let calls = 0;
      const client = new sdk.QURLClient({
        apiKey: "test-api-key",
        baseUrl: "https://api.example.test",
        maxRetries: 0,
        fetch: async (url, init) => {
          calls++;
          assert.equal(new URL(String(url)).pathname, `/v1/resources/${crid}/qurls`);
          const body = JSON.parse(init.body ?? "{}");
          assert.equal(Object.hasOwn(body, "target_path"), tc.present);
          assert.equal(body.target_path, tc.value);
          return new Response(
            JSON.stringify({ data: { ...data, ...(tc.present ? { target_path: tc.value } : {}) } }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        },
      });
      const opts = tc.present ? { targetPath: tc.value } : {};
      const invoke = () =>
        mode === "rest"
          ? client.createQurlForResource(crid, tc.present ? { target_path: tc.value } : {})
          : mode === "handle"
            ? client.resourceByCrid(crid).createPortal(opts)
            : client.createPortal(crid, opts);
      if (tc.outcome === "reject") {
        await assert.rejects(invoke, { code: "client_validation" });
        assert.equal(calls, 0);
      } else {
        const result = await invoke();
        assert.equal(result[mode === "rest" ? "target_path" : "targetPath"], tc.value);
        assert.equal(calls, 1);
      }
    }
  }
}
console.log(
  `Target-path contract: ${artifact.cases.length} cases passed through ESM and CommonJS.`,
);
