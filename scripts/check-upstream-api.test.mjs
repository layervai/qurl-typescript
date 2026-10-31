import assert from "node:assert/strict";
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
  const report = renderReport(operations, ["GET /v1/old", "DELETE /v1/retired"]);
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
test("updates only its own report, including recovery, and stays quiet when unchanged", () => {
  const report = renderReport([], []);
  const calls = [];
  const existing = {
    id: 42,
    user: { login: "github-actions[bot]" },
    body: REPORT_MARKER + "old drift",
  };
  const api = (...args) => {
    calls.push(args);
    return [[{ ...existing, id: 1, user: { login: "justin-layerv" } }], [existing]];
  };
  assert.equal(publishReport(report, api), "updated");
  assert.deepEqual(calls[1], [
    "PATCH",
    "repos/layervai/qurl-typescript/issues/comments/42",
    { body: report },
  ]);
  calls.length = 0;
  existing.body = report;
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
