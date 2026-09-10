// Pin each dist tree's module format via a sidecar package.json so a
// future flip of the root `"type"` field can't silently mis-resolve
// downstream consumers.
import { writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve against this file's location rather than process.cwd() so
// the script behaves identically whether invoked via npm scripts
// (cwd = package root) or directly from another directory.
const esm = fileURLToPath(new URL("../dist/esm/package.json", import.meta.url));
const cjs = fileURLToPath(new URL("../dist/cjs/package.json", import.meta.url));

writeFileSync(esm, '{"type":"module"}\n');
writeFileSync(cjs, '{"type":"commonjs"}\n');

for (const format of ["esm", "cjs"]) {
  for (const extension of ["cjs", "d.cts"]) {
    copyFileSync(
      new URL(`../src/node/native-loader.${extension}`, import.meta.url),
      new URL(`../dist/${format}/node/native-loader.${extension}`, import.meta.url),
    );
  }
}
