import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  renameSync,
  symlinkSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  linkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentState } from "./file-agent-state.js";
import { decodeAgentState, encodeAgentState, type AgentState } from "./agent-state.js";
import {
  openSealedFileAgentState,
  createSealedAgentStateCodec,
  type AgentStateKeyWrapper,
} from "./sealed-agent-state.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), "qurl-state-test-"));
  directories.push(dir);
  return join(dir, "state.json");
}
function state(): AgentState {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    schema_version: 8,
    agent_id: "test-agent",
    private_key_b64: privateKey
      .export({ type: "pkcs8", format: "der" })
      .subarray(-32)
      .toString("base64"),
    public_key_b64: publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
  };
}
// Test-only wrapper: returns the DEK directly so envelope interoperability can be inspected.
const wrapper: AgentStateKeyWrapper = {
  async wrapKey(key) {
    return { version: 1, ciphertext: Buffer.from(key), metadata: { z: "<&>", a: 1 } };
  },
  async unwrapKey(wrapped) {
    return Buffer.from(wrapped.ciphertext);
  },
};

describe("native agent state boundary", () => {
  it("persists across handles, uses private modes, and serializes independent writers", async () => {
    const name = path();
    const first = new FileAgentState(name);
    const second = new FileAgentState(name);
    const value = state();
    try {
      await expect(first.load()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await first.save(value);
      expect(await second.load()).toEqual(value);
      expect(statSync(name).mode & 0o777).toBe(0o600);
      const events: string[] = [];
      let release!: () => void;
      const held = first.withLock(async () => {
        events.push("first");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const waiting = second.withLock(async () => {
        events.push("second");
      });
      expect(events).toEqual(["first"]);
      release();
      await Promise.all([held, waiting]);
      expect(events).toEqual(["first", "second"]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("does not commit when the lock signal is aborted during encoding", async () => {
    const name = path();
    const controller = new AbortController();
    const store = new FileAgentState(name, {
      async encode(value) {
        controller.abort(new Error("cancelled while sealing"));
        return encodeAgentState(value);
      },
      async decode(value) {
        return decodeAgentState(value);
      },
    });
    try {
      await expect(
        store.withLock((locked) => locked.save(state()), controller.signal),
      ).rejects.toThrow("cancelled while sealing");
      await expect(store.load()).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      store.close();
    }
  });

  it("rejects replaced parent paths and lock entries while a transition is active", async () => {
    const name = path();
    const store = new FileAgentState(name);
    try {
      await expect(
        store.withLock(async (locked) => {
          renameSync(`${name}.lock`, `${name}.old-lock`);
          writeFileSync(`${name}.lock`, "", { mode: 0o600 });
          await locked.save(state());
        }),
      ).rejects.toMatchObject({ code: "STATE_CONTINUITY" });
      const parent = name.slice(0, name.lastIndexOf("/"));
      renameSync(parent, `${parent}-moved`);
      directories.push(`${parent}-moved`);
      symlinkSync(`${parent}-moved`, parent);
      await expect(store.load()).rejects.toMatchObject({ code: "STATE_CONTINUITY" });
    } finally {
      store.close();
    }
  });

  it("refuses symlinks, hardlinks, permissive files, and malformed state without replacing them", async () => {
    for (const kind of ["symlink", "hardlink", "mode", "malformed"]) {
      const name = path();
      const target = `${name}.target`;
      const value = encodeAgentState(state());
      writeFileSync(target, value, { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, name);
      if (kind === "hardlink") linkSync(target, name);
      if (kind === "mode") {
        writeFileSync(name, value, { mode: 0o600 });
        chmodSync(name, 0o644);
      }
      if (kind === "malformed") writeFileSync(name, "{bad", { mode: 0o600 });
      const store = new FileAgentState(name);
      try {
        await expect(store.load()).rejects.toThrow();
        expect(readFileSync(target)).toEqual(value);
      } finally {
        store.close();
      }
    }
  });

  it("authenticates sealed identity, metadata and ciphertext, with fresh envelopes", async () => {
    const codec = createSealedAgentStateCodec("test", wrapper, "test-agent");
    const value = state();
    const first = await codec.encode(value);
    const second = await codec.encode(value);
    expect(first.equals(second)).toBe(false);
    expect(first.toString()).not.toContain(value.private_key_b64);
    expect(await codec.decode(first)).toEqual(value);
    for (const change of ["agent_id", "provider_id", "ciphertext", "metadata"]) {
      const envelope = JSON.parse(first.toString());
      if (change === "metadata") envelope.wrapped_key.metadata.a = 2;
      else
        envelope[change] = change === "ciphertext" ? randomBytes(128).toString("base64") : "other";
      await expect(codec.decode(Buffer.from(JSON.stringify(envelope)))).rejects.toThrow();
    }
  });

  it("preserves state when key wrapping fails and rejects stale lock capabilities", async () => {
    const name = path();
    const plain = new FileAgentState(name);
    const value = state();
    await plain.save(value);
    plain.close();
    const broken = new FileAgentState(
      name,
      createSealedAgentStateCodec("test", {
        ...wrapper,
        async wrapKey() {
          throw new Error("KMS unavailable");
        },
      }),
    );
    try {
      await expect(broken.save(value)).rejects.toThrow("KMS unavailable");
      expect(decodeAgentState(readFileSync(name))).toEqual(value);
    } finally {
      broken.close();
    }
  });
});

it("preserves durable state when wrapped keys cannot decrypt before commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qurl-key-roundtrip-"));
  try {
    const store = openSealedFileAgentState(join(dir, "state.json"), "test", {
      async wrapKey() {
        return { version: 1, ciphertext: Buffer.alloc(32, 1) };
      },
      async unwrapKey() {
        return Buffer.alloc(32, 2);
      },
    });
    try {
      await expect(store.save(state())).rejects.toThrow("INVALID_ENVELOPE");
      await expect(store.load()).rejects.toThrow("NOT_FOUND");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
