import { createPrivateKey, createPublicKey } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNHPMessage } from "../dist/esm/node/nhp-wire.js";
import { openSealedFileAgentState } from "../dist/esm/node/sealed-agent-state.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "parity-manifest.json")));
assert.match(manifest.typescript_sha, /^[0-9a-f]{40}$/);
// Squash merges do not retain the implementation commit in main's ancestry.
// Fetch that immutable revision only when the local checkout does not have it.
try {
  execFileSync("git", ["cat-file", "-e", `${manifest.typescript_sha}^{commit}`], {
    cwd: root,
    stdio: "pipe",
  });
} catch {
  execFileSync("git", ["fetch", "--no-tags", "origin", manifest.typescript_sha], {
    cwd: root,
    stdio: "inherit",
  });
}
execFileSync(
  "git",
  [
    "diff",
    "--exit-code",
    manifest.typescript_sha,
    "--",
    "src",
    "packages",
    "scripts",
    ".github",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.cjs.json",
    "vitest.config.ts",
    "README.md",
  ],
  { cwd: root, stdio: "pipe" },
);
const reference = resolve(process.env.QURL_GO_REFERENCE ?? "../qurl-go-parity-reference");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: reference, encoding: "utf8" }).trim(),
  manifest.go_sha,
);
assert.equal(
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: reference,
    encoding: "utf8",
  }).trim(),
  "",
  "Go reference must be clean",
);
assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, manifest.sdk_version);
assert.match(manifest.sdk_version, /^2\./);
assert.equal(manifest.nhp_version, "1.1");
const dir = mkdtempSync(join(tmpdir(), "qurl-parity-"));
try {
  writeFileSync(
    join(dir, "go.mod"),
    `module github.com/layervai/qurl-go/relayknock/parity\n\ngo 1.25.13\n\nrequire github.com/layervai/qurl-go v0.0.0\nreplace github.com/layervai/qurl-go => ${reference}\n`,
  );
  const binary = join(dir, "reference");
  writeFileSync(join(dir, "main.go"), readFileSync(join(root, "scripts/parity/main.go")));
  writeFileSync(join(dir, "serve.go"), readFileSync(join(root, "scripts/parity/serve.go")));
  execFileSync("go", ["build", "-mod=mod", "-o", binary, "."], {
    cwd: dir,
    env: { ...process.env, GOWORK: "off" },
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "src/node/agent-journey.test.ts"],
    { cwd: root, env: { ...process.env, QURL_PARITY_RESPONDER: binary }, stdio: "inherit" },
  );
  const packets = JSON.parse(execFileSync(binary, [], { encoding: "utf8" }));
  for (const type of [1, 5, 8, 12, 13, 16, 105]) {
    const { packet } = buildNHPMessage({
      type: type === 105 ? 5 : type,
      hubProof: type === 105,
      devicePrivateKey: Buffer.alloc(32, 9),
      serverPublicKey: rawPublicFromPrivate(Buffer.alloc(32, 4)),
      ephemeralPrivateKey: Buffer.alloc(32, 7),
      timestampNanos: 2000000000000000000n,
      counter: 18446744073709551615n,
      preamble: 12345,
      body: Buffer.from('{"devId":"parity-agent"}'),
      ...(type === 8 || type === 105 ? { cookie: Buffer.alloc(32, 6) } : {}),
    });
    assert.equal(Buffer.from(packet).toString("base64"), packets[type], `NHP type ${type}`);
  }
  const path = join(dir, "state", "agent.json");
  const wrapper = {
    async wrapKey(key) {
      return { version: 1, ciphertext: Buffer.from(key), metadata: { test: "cross-language" } };
    },
    async unwrapKey(wrapped) {
      return Buffer.from(wrapped.ciphertext);
    },
  };
  const store = openSealedFileAgentState(path, "parity-test", wrapper);
  try {
    const state = {
      schema_version: 8,
      agent_id: "parity-agent",
      private_key_b64: Buffer.alloc(32, 9).toString("base64"),
      public_key_b64: Buffer.from(rawPublicFromPrivate(Buffer.alloc(32, 9))).toString("base64"),
    };
    await store.save(state);
    const returned = JSON.parse(execFileSync(binary, ["roundtrip", path], { encoding: "utf8" }));
    assert.equal(returned.agent_id, state.agent_id);
    assert.deepEqual(await store.load(), state);
  } finally {
    store.close();
  }
  console.log(`Go/TypeScript wire and sealed-state parity passed at ${manifest.go_sha}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function rawPublicFromPrivate(key) {
  return createPublicKey(
    createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), key]),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .subarray(-32);
}
