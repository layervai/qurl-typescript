import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

// Reject credential prefixes even for fake values that cannot be verified.
const secret = /\blv_(?:live|test)_[A-Za-z0-9_-]+/;
assert.ok(secret.test(["lv", "live", "fixture"].join("_")));
assert.ok(secret.test(["lv", "test", "fixture"].join("_")));
assert.ok(!secret.test("test-api-key YOUR_API_KEY lv_live_ lv_test_"));

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
let failed = false;
for (const file of files) {
  if (!file || !lstatSync(file).isFile()) continue;
  const data = readFileSync(file);
  if (data.includes(0)) continue;
  for (const [index, line] of data.toString("utf8").split("\n").entries()) {
    if (!secret.test(line)) continue;
    // Report locations only: never copy a possible credential into CI logs.
    console.error(
      `${JSON.stringify(file)}:${index + 1}: secret-shaped fixture; use test-api-key or YOUR_API_KEY`,
    );
    failed = true;
  }
}
if (failed) process.exitCode = 1;
