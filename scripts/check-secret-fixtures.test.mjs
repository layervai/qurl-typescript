import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("rejects both literal key formats without logging values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "qurl-fixture-guard-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const file = "fixture with space.txt";
    writeFileSync(join(cwd, file), "test-api-key YOUR_API_KEY");
    execFileSync("git", ["add", file], { cwd });
    const script = fileURLToPath(new URL("./check-secret-fixtures.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
    assert.equal(run().status, 0);
    writeFileSync(join(cwd, file), 'api_key: `lv_live_${"a".repeat(43)}`');
    assert.equal(run().status, 0);
    for (const mode of ["live", "test"]) {
      const value = ["lv", mode, "syntheticvalue"].join("_");
      writeFileSync(join(cwd, file), value);
      const result = run();
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(file));
      assert.ok(!result.stderr.includes(value));
      assert.ok(!result.stdout.includes(value));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
