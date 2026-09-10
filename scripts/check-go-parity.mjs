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
// The manifest records the reviewed baseline. Test the current candidate rather
// than requiring its tree to equal that baseline: release/dependency PRs must
// run the behavior gates without a self-referential manifest update.
const candidateSHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
console.log(`Testing TypeScript ${candidateSHA}; reviewed baseline ${manifest.typescript_sha}`);
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
assert.match(JSON.parse(readFileSync(join(root, "package.json"))).version, /^2\./);
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
    const legacy = {
      ...state,
      schema_version: 5,
      assignment: {
        cell_id: "parity-cell",
        assignment_generation: 1,
        endpoint_revision: 1,
        lease_expires_at: "2033-05-18T03:33:20Z",
        nhp_udp_endpoint: {
          host: "cell.layerv.ai",
          port: 443,
          server_public_key_b64: state.public_key_b64,
        },
      },
      pending_completion: {
        device_api_key: "lv_live_" + Buffer.alloc(32, 8).toString("base64url"),
        cell_id: "parity-cell",
        assignment_generation: 1,
      },
    };
    await store.save(legacy);
    const goLegacy = JSON.parse(execFileSync(binary, ["roundtrip", path], { encoding: "utf8" }));
    assert.equal(goLegacy.schema_version, 5);
    assert.equal(goLegacy.pending_completion.recovery_expires_at, "0001-01-01T00:00:00Z");
    const restoredLegacy = await store.load();
    assert.equal(restoredLegacy.schema_version, 5);
    assert.equal(
      restoredLegacy.pending_completion.device_api_key,
      legacy.pending_completion.device_api_key,
    );
    assert.equal(restoredLegacy.pending_completion.recovery_expires_at, undefined);
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
