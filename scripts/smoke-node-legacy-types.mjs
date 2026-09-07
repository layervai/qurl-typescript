import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "qurl-node-legacy-types-"));
const packageLink = join(directory, "node_modules", "@layervai", "qurl");
const nodeTypesLink = join(directory, "node_modules", "@types", "node");
const undiciTypesLink = join(directory, "node_modules", "undici-types");

try {
  mkdirSync(dirname(packageLink), { recursive: true });
  symlinkSync(root, packageLink, process.platform === "win32" ? "junction" : "dir");
  // Model a real Node TypeScript consumer: the Node-only subpath requires the
  // platform declarations, and the smoke must type-check our emitted files.
  mkdirSync(dirname(nodeTypesLink), { recursive: true });
  symlinkSync(
    join(root, "node_modules", "@types", "node"),
    nodeTypesLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    join(root, "node_modules", "undici-types"),
    undiciTypesLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  cpSync(join(root, "smoke", "node-legacy-types.ts"), join(directory, "node-legacy-types.ts"));
  cpSync(
    join(root, "smoke", "tsconfig.node-legacy.json"),
    join(directory, "tsconfig.node-legacy.json"),
  );
  execFileSync(join(root, "node_modules", ".bin", "tsc6"), ["-p", "tsconfig.node-legacy.json"], {
    cwd: directory,
    stdio: "inherit",
  });
  console.log("node legacy TypeScript smoke ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
