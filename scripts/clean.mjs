// Pre-build cleanup. Extracted from an inline `node -e` in package.json
// to match the style of postbuild.mjs and stay robust to any future
// Node default-module-type change.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
rmSync(dist, { recursive: true, force: true });
