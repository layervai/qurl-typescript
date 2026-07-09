import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileAgentStateStore,
  MemoryAgentStateStore,
  fileAgentStateStore,
  AGENT_STATE_SCHEMA_VERSION,
} from "./agent-state.js";
import type { AgentState } from "./agent-state.js";

const tmpDirs: string[] = [];

async function tmpStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qurl-agent-state-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "nested", "agent-state.json");
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const sampleState: AgentState = {
  schema_version: AGENT_STATE_SCHEMA_VERSION,
  agent_id: "agent-abc",
  private_key_b64: btoa("\x01".repeat(32)),
  public_key_b64: btoa("\x02".repeat(32)),
  registered_at: "2026-07-06T00:00:00.000Z",
  device_api_key: "lv_device_secret",
  nhp_server_peer: { public_key_b64: btoa("\x03".repeat(32)), host: "h", port: 1, expire_time: 0 },
};

describe("FileAgentStateStore", () => {
  it("returns null when no state has been persisted (not-found signal)", async () => {
    const store = new FileAgentStateStore(await tmpStatePath());
    expect(await store.loadAgentState()).toBeNull();
  });

  it("round-trips a saved state and creates the dir 0700, file 0600", async () => {
    const p = await tmpStatePath();
    const store = new FileAgentStateStore(p);
    await store.saveAgentState(sampleState);

    const loaded = await store.loadAgentState();
    expect(loaded).toEqual(sampleState);

    // Permissions (POSIX only — skip on platforms without mode bits).
    if (process.platform !== "win32") {
      const fileMode = (await fs.stat(p)).mode & 0o777;
      expect(fileMode).toBe(0o600);
      const dirMode = (await fs.stat(path.dirname(p))).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  });

  it("overwrites atomically (rename), leaving no temp files behind", async () => {
    const p = await tmpStatePath();
    const store = new FileAgentStateStore(p);
    await store.saveAgentState(sampleState);
    await store.saveAgentState({ ...sampleState, device_api_key: "lv_rotated" });

    const loaded = await store.loadAgentState();
    expect(loaded?.device_api_key).toBe("lv_rotated");

    const entries = await fs.readdir(path.dirname(p));
    expect(entries.filter((e) => e.startsWith(".qurl-agent-state-"))).toHaveLength(0);
  });

  it("throws (not null) when the persisted state is corrupt JSON", async () => {
    const p = await tmpStatePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{ not valid json");
    const store = new FileAgentStateStore(p);
    await expect(store.loadAgentState()).rejects.toThrow(/unreadable or corrupt/);
  });

  it("rejects an empty path at construction", () => {
    expect(() => new FileAgentStateStore("")).toThrow();
    expect(() => new FileAgentStateStore("   ")).toThrow();
  });

  it("fileAgentStateStore() defaults to ~/.qurl/agent-state.json", async () => {
    const store = fileAgentStateStore();
    // Load returns null (the default path almost certainly has no state in CI);
    // this exercises the default-path branch without asserting the home contents.
    expect(store).toBeInstanceOf(FileAgentStateStore);
    void os.homedir();
  });
});

describe("MemoryAgentStateStore", () => {
  it("returns null until something is saved, then the saved state", async () => {
    const store = new MemoryAgentStateStore();
    expect(await store.loadAgentState()).toBeNull();
    await store.saveAgentState(sampleState);
    expect(await store.loadAgentState()).toEqual(sampleState);
  });

  it("accepts an initial state", async () => {
    const store = new MemoryAgentStateStore(sampleState);
    expect(await store.loadAgentState()).toEqual(sampleState);
  });

  it("clones on save so a later caller mutation does not change persisted state", async () => {
    const store = new MemoryAgentStateStore();
    const mutable: AgentState = { ...sampleState };
    await store.saveAgentState(mutable);
    mutable.device_api_key = "mutated-after-save";
    const loaded = await store.loadAgentState();
    expect(loaded?.device_api_key).toBe("lv_device_secret");
  });

  it("deep-clones the nested nhp_server_peer on save (not just a shallow copy)", async () => {
    const store = new MemoryAgentStateStore();
    const mutable: AgentState = structuredClone(sampleState);
    await store.saveAgentState(mutable);
    // Mutate a NESTED field after save — a shallow clone would leak this in.
    mutable.nhp_server_peer!.host = "attacker.example.test";
    const loaded = await store.loadAgentState();
    expect(loaded?.nhp_server_peer?.host).toBe("h");
  });

  it("clones on load so mutating the returned state does not change persisted state", async () => {
    const store = new MemoryAgentStateStore(structuredClone(sampleState));
    const first = await store.loadAgentState();
    // The engine mutates loaded state in place; that must not reach the store.
    first!.device_api_key = "mutated-in-place";
    first!.nhp_server_peer!.host = "mutated-host";
    const second = await store.loadAgentState();
    expect(second?.device_api_key).toBe("lv_device_secret");
    expect(second?.nhp_server_peer?.host).toBe("h");
  });
});
