// ESM consumer smoke test. Mirror of cjs.cjs through `exports.import`
// via a package self-reference.
import { QURLClient, QURLError, ValidationError, VERSION } from "@layerv/qurl";

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

console.log("ESM smoke ok");
