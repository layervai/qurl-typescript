import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkValidationBounds, validationBoundFindings } from "./check-validation-bounds.mjs";

const code = "const MAX_LABEL = 500; const MAX_BUDGET = 1 << 20;";
const source = { schema: "Input", property: "label", keyword: "maxLength" };
const manifest = {
  bounds: { MAX_LABEL: { expected: 500, sources: [source] } },
  local: { MAX_BUDGET: "Local memory budget" },
};
const spec = { components: { schemas: { Input: { properties: { label: { maxLength: 500 } } } } } };

test("every current API-client cap has an explicit contract or safety-budget classification", () => {
  assert.deepEqual(checkValidationBounds(), []);
  const current = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
  const actualManifest = JSON.parse(
    readFileSync(new URL("../contract/validation-bounds.json", import.meta.url)),
  );
  const findings = validationBoundFindings(current + "\nconst MAX_NEW_CAP = 2;", actualManifest);
  assert.ok(
    findings.some(
      (finding) =>
        finding.constant === "MAX_NEW_CAP" && finding.problem === "Unclassified SDK bound",
    ),
  );
});
test("compares SDK literals and producer numeric constraints independently", () => {
  assert.deepEqual(validationBoundFindings(code, manifest, spec), []);
  assert.deepEqual(validationBoundFindings(code.replace("500", "600"), manifest), [
    { constant: "MAX_LABEL", expected: 500, actual: 600 },
  ]);
  const changed = structuredClone(spec);
  changed.components.schemas.Input.properties.label.maxLength = 600;
  assert.deepEqual(validationBoundFindings(code, manifest, changed), [
    { constant: "MAX_LABEL", source, expected: 500, actual: 600 },
  ]);
  delete changed.components.schemas.Input.properties.label.maxLength;
  assert.equal(validationBoundFindings(code, manifest, changed)[0].actual, null);
});
test("local budgets are not widened to follow producer limits", () => {
  assert.deepEqual(validationBoundFindings(code.replace("1 << 20", "1 << 19"), manifest, spec), []);
  assert.ok(
    validationBoundFindings(code.replace("MAX_LABEL", "RENAMED"), manifest).some(
      (finding) => finding.problem === "Stale bound classification",
    ),
  );
  assert.throws(
    () => validationBoundFindings(code, { ...manifest, local: { MAX_LABEL: "duplicate" } }),
    /Duplicate/,
  );
  assert.throws(
    () => validationBoundFindings(code, { ...manifest, local: { MAX_BUDGET: "" } }),
    /reason/,
  );
});
test("tracks prose-only bounds without interpreting natural-language duration or byte rules", () => {
  const prose = {
    bounds: {
      MAX_TTL: {
        expected: 86400,
        sources: [{ schema: "TTL", keyword: "description", expected: "Maximum: 24h." }],
      },
    },
    local: {},
  };
  const doc = { components: { schemas: { TTL: { description: "Maximum: 24h." } } } };
  assert.deepEqual(validationBoundFindings("const MAX_TTL = 86400n;", prose, doc), []);
  doc.components.schemas.TTL.description = "Maximum: 48h.";
  assert.equal(validationBoundFindings("const MAX_TTL = 86400n;", prose, doc).length, 1);
  assert.equal(validationBoundFindings("const MAX_TTL = 172800n;", prose).length, 1);
});
test("reads array item, reusable header, and operation-header constraints", () => {
  const entries = {
    MAX_TAG: {
      expected: 50,
      sources: [{ schema: "Tags", property: "tags", items: true, keyword: "maxLength" }],
    },
    MAX_KEY: { expected: 256, sources: [{ parameterComponent: "Key", keyword: "maxLength" }] },
    MAX_ETAG: {
      expected: 96,
      sources: [{ operation: "getBatch", parameter: "If-None-Match", keyword: "maxLength" }],
    },
  };
  const document = {
    components: {
      schemas: { Tags: { properties: { tags: { items: { maxLength: 50 } } } } },
      parameters: { Key: { schema: { maxLength: 256 } } },
    },
    paths: {
      "/b": {
        get: {
          operationId: "getBatch",
          parameters: [
            { in: "header", name: "Unrelated", schema: { maxLength: 100 } },
            { in: "header", name: "If-None-Match", schema: { maxLength: 96 } },
          ],
        },
      },
    },
  };
  const text = "const MAX_TAG = 50; const MAX_KEY = 256; const MAX_ETAG = 96;";
  assert.deepEqual(validationBoundFindings(text, { bounds: entries, local: {} }, document), []);
  document.paths["x-note"] = document.paths["/b"];
  document.paths["/b"]["x-note"] = document.paths["/b"].get;
  assert.deepEqual(validationBoundFindings(text, { bounds: entries, local: {} }, document), []);
  document.paths["/b"].get.parameters.reverse();
  assert.deepEqual(validationBoundFindings(text, { bounds: entries, local: {} }, document), []);
  document.paths["/b"].get.parameters.find((parameter) => parameter.name === "If-None-Match").name =
    "if-none-match";
  assert.deepEqual(validationBoundFindings(text, { bounds: entries, local: {} }, document), []);
  document.paths["/b"].get.parameters.push({
    in: "header",
    name: "IF-NONE-MATCH",
    schema: { maxLength: 96 },
  });
  assert.equal(
    validationBoundFindings(text, { bounds: entries, local: {} }, document)[0].constant,
    "MAX_ETAG",
  );
  document.paths["/b"].get.parameters.pop();
  document.paths["/duplicate"] = document.paths["/b"];
  assert.equal(
    validationBoundFindings(text, { bounds: entries, local: {} }, document)[0].constant,
    "MAX_ETAG",
  );
});
test("syntax errors and nonliteral contract bounds cannot silently pass", () => {
  assert.throws(() => validationBoundFindings("const MAX_LABEL = (", manifest), /parse/);
  assert.equal(validationBoundFindings(code.replace("500", "250 * 2"), manifest).length, 1);
  assert.ok(
    validationBoundFindings(
      "declare const MAX_LABEL: number; const MAX_BUDGET = 1;",
      manifest,
    ).some((finding) => finding.constant === "MAX_LABEL" && finding.actual === null),
  );
});

test("the standalone CLI fails with structured findings when published bounds are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qurl-validation-bounds-"));
  try {
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify({ openapi: "3.0.3", paths: { "/fixture": { get: {} } } }));
    const script = fileURLToPath(new URL("./check-validation-bounds.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, path], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    const findings = JSON.parse(result.stderr);
    assert.ok(
      findings.some((finding) => finding.constant === "MAX_LABEL" && finding.actual === null),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
