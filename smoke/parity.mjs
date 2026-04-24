// Structural drift detector: a runtime name added to only one of the two
// builds (e.g. a future conditional export that ships in ESM but not CJS)
// would land in prod silently without this check — the per-build cjs.cjs
// and esm.mjs smokes can't see the other side.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const cjs = require("@layerv/qurl");
const esm = await import("@layerv/qurl");

const cjsKeys = Object.keys(cjs).sort();
// `src/index.ts` has no default export, so this filter is a no-op today.
// Kept defensive against a future addition of `export default …` to only
// one build, which would otherwise surface as a spurious `default` key
// on the ESM side only and fail the parity check for the wrong reason.
const esmKeys = Object.keys(esm)
  .filter((k) => k !== "default")
  .sort();

assert.deepStrictEqual(
  cjsKeys,
  esmKeys,
  `ESM/CJS export drift:\n  cjs: ${cjsKeys.join(", ")}\n  esm: ${esmKeys.join(", ")}`,
);

console.log(`Parity ok (${cjsKeys.length} names)`);
