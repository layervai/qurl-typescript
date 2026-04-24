// Pin each dist tree's module format via a sidecar package.json so a
// future flip of the root `"type"` field can't silently mis-resolve
// downstream consumers.
import { writeFileSync } from "node:fs";

writeFileSync("dist/cjs/package.json", '{"type":"commonjs"}\n');
writeFileSync("dist/esm/package.json", '{"type":"module"}\n');
