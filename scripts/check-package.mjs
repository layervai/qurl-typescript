import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [packed] = JSON.parse(readFileSync(0, "utf8"));
assert(Array.isArray(packed?.files), "npm pack did not return a file list");
const files = new Set(packed.files.map((file) => file.path));
const rootFiles = new Set(["LICENSE", "README.md", "package.json"]);
for (const path of rootFiles) assert(files.has(path), `Missing package metadata: ${path}`);
for (const path of files) {
  if (rootFiles.has(path)) continue;
  assert(/^dist\/(?:esm|cjs)\//.test(path), `Unexpected package file: ${path}`);
  assert(
    !/\.d\.(?:ts|cts)\.map$/.test(path),
    `Declaration map points outside the package: ${path}`,
  );
  assert(
    !/(?:^|\/)(?:__tests__|testdata|fixtures)(?:\/|$)|\.(?:test|spec)\./.test(path),
    `Test file in package: ${path}`,
  );
  assert(
    /(?:\.js(?:\.map)?|\.cjs|\.d\.(?:ts|cts)|\/package\.json)$/.test(path),
    `Unexpected dist file: ${path}`,
  );
}
for (const format of ["esm", "cjs"]) {
  for (const entry of [
    "index.js",
    "index.d.ts",
    "node.js",
    "node.d.ts",
    "node/native-loader.cjs",
    "node/native-loader.d.cts",
  ]) {
    const path = `dist/${format}/${entry}`;
    assert(files.has(path), `Missing package entry: ${path}`);
  }
}
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const targets = [manifest.main, manifest.module, manifest.types];
for (const entry of Object.values(manifest.exports)) {
  for (const format of [entry.import, entry.require]) targets.push(format.default, format.types);
}
for (const target of targets) {
  assert(
    typeof target === "string" && files.has(target.replace(/^\.\//, "")),
    `Missing declared package target: ${target}`,
  );
}
console.log(`Package contract passed: ${files.size} files`);
