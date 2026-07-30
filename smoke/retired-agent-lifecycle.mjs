// Fail closed if the retired Connector enrollment surface re-enters either
// source or the published package. The files allowlist limits generated code to
// dist/, while npm also includes package metadata and README.md; scan all of
// those publishable inputs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cjs = require("@layervai/qurl");
const esm = await import("@layervai/qurl");

const expectedRuntimeExports = [
  "AuthenticationError",
  "AuthorizationError",
  "ERROR_CODE_AMBIGUOUS_RESOURCE",
  "ERROR_CODE_CLIENT_VALIDATION",
  "ERROR_CODE_NETWORK",
  "ERROR_CODE_RESOURCE_NOT_FOUND",
  "ERROR_CODE_RUNTIME",
  "ERROR_CODE_TIMEOUT",
  "ERROR_CODE_UNEXPECTED_RESPONSE",
  "ERROR_CODE_UNKNOWN",
  "NetworkError",
  "NotFoundError",
  "ProtectedResource",
  "QURLError",
  "QURLClient",
  "RateLimitError",
  "RuntimeError",
  "ServerError",
  "TimeoutError",
  "VERSION",
  "ValidationError",
  "createError",
].sort();

for (const [format, namespace] of [
  ["ESM", esm],
  ["CJS", cjs],
]) {
  assert.deepStrictEqual(
    Object.keys(namespace).sort(),
    expectedRuntimeExports,
    `${format} public runtime exports changed`,
  );
}

const client = new esm.QURLClient({ apiKey: "test-api-key" });
for (const method of [
  "protectUrl",
  "createPortal",
  "enterPortal",
  "create",
  "resolve",
  "listResources",
  "createResource",
  "listConnectorInstallations",
]) {
  assert.equal(typeof client[method], "function", `retained QURLClient.${method} is missing`);
}

const retiredNames = [
  ["register", "Agent"],
  ["bootstrap", "Agent"],
  ["Agent", "State"],
  ["Registration", "Error"],
  ["File", "AgentStateStore"],
  ["Memory", "AgentStateStore"],
].map((parts) => parts.join(""));
for (const name of retiredNames) {
  assert.equal(name in esm, false, `retired ESM export ${name} reappeared`);
  assert.equal(name in cjs, false, `retired CJS export ${name} reappeared`);
  assert.equal(name in esm.QURLClient.prototype, false, `retired QURLClient.${name} reappeared`);
}

const forbiddenWire = [
  ["/v1/agent/", "bootstrap"],
  ["/v1/agent/", "registration-info"],
  ["/v1/agent/", "registration/complete"],
  ["NHP_", "OTP"],
  ["NHP_", "REG"],
  ["NHP_", "RAK"],
  ["NHP_", "LST"],
  ["NHP_", "LRT"],
].map((parts) => parts.join(""));

function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = `${root}/${entry}`;
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const distRoot = fileURLToPath(new URL("../dist", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
const readme = fileURLToPath(new URL("../README.md", import.meta.url));
for (const file of [...filesUnder(sourceRoot), ...filesUnder(distRoot), packageJson, readme]) {
  const contents = readFileSync(file, "utf8");
  for (const forbidden of [...retiredNames, ...forbiddenWire]) {
    assert.equal(contents.includes(forbidden), false, `${forbidden} reappeared in ${file}`);
  }
}

console.log("Retired Connector lifecycle smoke ok");
