// Structural drift detector: a runtime name added to only one of the two
// builds (e.g. a future conditional export that ships in ESM but not CJS)
// would land in prod silently without this check — the per-build cjs.cjs
// and esm.mjs smokes can't see the other side.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const cjs = require("@layerv/qurl");
const esm = await import("@layerv/qurl");

// Raw Object.keys on both — no filtering. A `default` export landing in
// only one build is exactly the ESM-only drift this check exists to
// catch; filtering it would silently pass the asymmetric case. The
// Node-synthesized `default` for CJS-interop imports doesn't apply
// here since both sides are resolved through their own `exports`
// condition, not via cross-format interop.
//
// TS's CJS emit marks the namespace with `__esModule` via
// `Object.defineProperty(exports, "__esModule", { value: true })`,
// which is non-enumerable by default and so is correctly excluded
// from Object.keys. A future TS emit change that makes it enumerable
// would surface as a spurious "cjs has __esModule, esm doesn't" diff
// here — that's the correct outcome (loud signal to investigate).
const cjsKeys = Object.keys(cjs).sort();
const esmKeys = Object.keys(esm).sort();

assert.deepStrictEqual(
  cjsKeys,
  esmKeys,
  `ESM/CJS export drift:\n  cjs: ${cjsKeys.join(", ")}\n  esm: ${esmKeys.join(", ")}`,
);

console.log(`Parity ok (${cjsKeys.length} names)`);
