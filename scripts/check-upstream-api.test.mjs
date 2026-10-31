import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  operationsFromSpec,
  publishReport,
  renderReport,
  REPORT_MARKER,
} from "./check-upstream-api.mjs";

const spec = {
  openapi: "3.0.3",
  paths: { "/v1/new": { summary: "Not an operation", post: {} }, "/v1/old": { get: {} } },
};
test("captures producer-only operations and ignores path metadata", () => {
  assert.deepEqual(operationsFromSpec(spec), ["GET /v1/old", "POST /v1/new"]);
  assert.deepEqual(
    operationsFromSpec({ ...spec, paths: { ...spec.paths, "x-note": "extension" } }),
    operationsFromSpec(spec),
  );
});
test("rejects missing, empty, malformed, or unresolved producer documents", () => {
  for (const input of [
    undefined,
    {},
    { openapi: 3 },
    { openapi: "3.0.3", paths: {} },
    { ...spec, paths: { "/v1/a": null } },
    { ...spec, paths: { "/v1/a": { $ref: "#/components/pathItems/A" } } },
    { ...spec, paths: { "/v1/a": { get: null } } },
  ]) {
    assert.throws(() => operationsFromSpec(input));
  }
});
test("reports additions and removals without making unchanged reports noisy", () => {
  const operations = operationsFromSpec(spec);
  const report = renderReport(operations, ["DELETE /v1/retired", "GET /v1/old"]);
  assert.ok(report.startsWith(REPORT_MARKER));
  assert.match(report, /POST \/v1\/new/);
  assert.match(report, /DELETE \/v1\/retired/);
  assert.match(renderReport(operations, operations), /No operation drift/);
  assert.equal(
    renderReport([...operations], [...operations]),
    renderReport(operations, operations),
  );
  assert.ok(!renderReport(["GET /```"], []).includes("GET /```"));
});
test("creates one tracking comment on the existing issue", () => {
  const calls = [];
  const api = (...args) => {
    calls.push(args);
    return [[], []];
  };
  const report = renderReport([], []);
  assert.equal(publishReport(report, api), "created");
  assert.deepEqual(calls[1], [
    "POST",
    "repos/layervai/qurl-typescript/issues/50/comments",
    { body: report },
  ]);
});
test("posts changes and recovery, but uses only the latest bot report to suppress duplicates", () => {
  const report = renderReport([], []);
  const calls = [];
  const existing = {
    id: 42,
    user: { login: "github-actions[bot]" },
    body: REPORT_MARKER + "old drift",
  };
  const api = (...args) => {
    calls.push(args);
    return [
      [{ ...existing, id: 1 }],
      [existing, { ...existing, id: 99, user: { login: "justin-layerv" } }],
    ];
  };
  assert.equal(publishReport(report, api), "changed");
  assert.deepEqual(calls[1], [
    "POST",
    "repos/layervai/qurl-typescript/issues/50/comments",
    { body: report },
  ]);
  calls.length = 0;
  existing.body = report.replaceAll("\n", "\r\n") + "\r\n";
  assert.equal(publishReport(report, api), "unchanged");
  assert.equal(calls.length, 1);
});
test("invalid reports and GitHub failures cannot look successful", () => {
  assert.throws(() => publishReport("not a report", () => assert.fail("must not call API")));
  assert.throws(
    () =>
      publishReport(renderReport([], []), () => {
        throw new Error("API unavailable");
      }),
    /API unavailable/,
  );
});

test("rejects malformed, duplicate, and unsorted committed baselines", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("../contract/upstream-operations.json", import.meta.url)),
  );
  assert.doesNotThrow(() => renderReport(baseline, baseline));
  for (const input of [null, {}, [1], ["GET"], ["GET /a", "GET /a"], ["POST /b", "GET /a"]]) {
    assert.throws(() => renderReport([], input), /sorted, unique/);
  }
});
test("the real CLI generates snapshots, reports drift, and fails on invalid input", () => {
  const dir = mkdtempSync(join(tmpdir(), "qurl-api-drift-"));
  const input = join(dir, "spec.json");
  const script = fileURLToPath(new URL("./check-upstream-api.mjs", import.meta.url));
  try {
    writeFileSync(input, JSON.stringify(spec));
    const run = (mode) =>
      execFileSync(process.execPath, [script, mode, input], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(run("snapshot")), operationsFromSpec(spec));
    const report = run("check");
    assert.ok(report.startsWith(REPORT_MARKER));
    assert.match(report, /POST \/v1\/new/);
    assert.notEqual(spawnSync(process.execPath, [script, "unknown", input]).status, 0);
    writeFileSync(input, "not an OpenAPI document");
    assert.notEqual(spawnSync(process.execPath, [script, "check", input]).status, 0);
    assert.notEqual(spawnSync(process.execPath, [script, "publish", input]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
