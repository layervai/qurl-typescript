// CJS consumer smoke test. Resolves the package via its `exports.require`
// condition using a package self-reference, exactly like a downstream
// `require("@layerv/qurl")` would. Fails non-zero on any surface mismatch.
const { QURLClient, QURLError, ValidationError, VERSION } = require("@layerv/qurl");

if (typeof QURLClient !== "function") {
  throw new Error("QURLClient is not a constructor");
}
if (typeof QURLError !== "function" || typeof ValidationError !== "function") {
  throw new Error("error classes did not load");
}
if (typeof VERSION !== "string") {
  throw new Error("VERSION not exported");
}

const client = new QURLClient({ apiKey: "lv_live_smoke" });
if (typeof client.create !== "function" || typeof client.resolve !== "function") {
  throw new Error("client methods not callable");
}

console.log("CJS smoke ok");
