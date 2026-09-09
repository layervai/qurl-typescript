import { parseStrictJson } from "./strict-json.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { FileAgentState } from "./file-agent-state.js";
import { encodeAgentJSON, type AgentStateStore } from "./agent-state.js";
import { agentRuntimeTesting, type AgentRuntimeOptions } from "./agent-runtime.js";
import type { AgentTransport } from "./agent-transport.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const vectors = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@layervai/qurl-conformance/crid_v1_vectors.json"),
    "utf8",
  ),
);

interface TestBody {
  usrData: Record<string, string>;
  devId: string;
  resId: string;
  runId: string;
  runAttempt: bigint;
  [key: string]: unknown;
}
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "qurl-runtime-test-"));
  dirs.push(dir);
  const store = new FileAgentState(join(dir, "state.json"));
  const publicKey = generateKeyPairSync("x25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  const hub = { host: "hub.layerv.ai", port: 443, server_public_key_b64: publicKey };
  let assignment = {
    cell_id: "cell-a",
    assignment_generation: 1,
    endpoint_revision: 1,
    lease_expires_at: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    nhp_udp_endpoint: { ...hub, host: "cell-a.layerv.ai" },
  };
  const calls: { type: number; host: string; body: TestBody }[] = [];
  let failCompletion = false;
  let failRefresh = false;
  const transport: AgentTransport = async (exchange) => {
    exchange.beforeSend();
    const body = parseStrictJson(exchange.body, 4096) as unknown as TestBody;
    calls.push({ type: exchange.type, host: exchange.endpoint.host, body });
    let reply: unknown;
    if (exchange.type === 13) {
      expect((await store.load()).pending_activation?.assignment_ticket).toBe(
        body.usrData.assignment_ticket,
      );
      reply = { errCode: "0", aspId: "agent" };
    } else if (body.usrData?.query === "cell_assignment") {
      if (body.usrData.mode === "refresh" && failRefresh) throw new Error("refresh offline");
      const list: Record<string, unknown> = {
        query: "cell_assignment",
        version: 1,
        mode: body.usrData.mode,
        agent_id: body.devId,
        assignment,
      };
      if (body.usrData.mode === "enroll")
        Object.assign(list, {
          registration: { key_id: "key_123456789012", key_kind: "bootstrap" },
          assignment_ticket: "qat1.test",
          assignment_ticket_expires_at: new Date(Date.now() + 900_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        });
      if (body.usrData.mode === "recover")
        Object.assign(list, {
          recovery_grant: "qrg1.test",
          recovery_grant_issued_at: new Date(Math.floor(Date.now() / 1000) * 1000)
            .toISOString()
            .replace(".000Z", "Z"),
          recovery_grant_expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 900_000)
            .toISOString()
            .replace(".000Z", "Z"),
        });
      reply = { errCode: "0", list };
    } else if (exchange.type === 5) {
      if (failCompletion) throw new Error("process interrupted");
      const persisted = await store.load();
      expect(
        persisted.pending_completion?.device_api_key ??
          persisted.pending_credential_recovery?.device_api_key,
      ).toBe(body.usrData.device_api_key);
      reply = {
        errCode: "0",
        list: { query: body.usrData.query, version: 1, device_api_key_id: "key_abcdefghijkl" },
      };
    } else if (exchange.type === 1) {
      reply = {
        errCode: "0",
        sessId: 18446744073709551615n,
        cellId: assignment.cell_id,
        sessIssuedAtMillis: 12345,
        runId: body.runId,
        runAttempt: body.runAttempt,
        opnTime: 900,
        agentAddr: "1.2.3.4:1234",
        acTokens: { [body.resId]: "token" },
        resHost: { [body.resId]: "private.example" },
      };
    } else {
      reply = { ...body, errCode: "0", closeEventId: "a".repeat(32), state: "closed" };
      delete (reply as Record<string, unknown>).headerType;
      delete (reply as Record<string, unknown>).aspId;
    }
    return {
      type: exchange.type === 13 ? 14 : exchange.type === 5 ? 6 : 2,
      flags: 0,
      counter: 1n,
      timestampNanos: 1n,
      body: encodeAgentJSON(reply),
    };
  };
  const options: AgentRuntimeOptions = {
    hub,
    headless: true,
    enrollmentCredential: "lv_live_" + "a".repeat(43),
  };
  return {
    store,
    transport,
    options,
    calls,
    failCompletion: () => {
      failCompletion = true;
    },
    resume: () => {
      failCompletion = false;
    },
    failRefresh: () => {
      failRefresh = true;
    },
    restoreRefresh: () => {
      failRefresh = false;
    },
    relocate: () => {
      assignment = {
        ...assignment,
        cell_id: "cell-b",
        assignment_generation: 2,
        nhp_udp_endpoint: { ...hub, host: "cell-b.layerv.ai" },
      };
    },
  };
}

describe("producer lifecycle durability", () => {
  it.each([
    { errCode: "52201", errMsg: null },
    { errCode: "52201", errMsg: {} },
    { errCode: "0", errMsg: "unexpected" },
  ])("rejects malformed lifecycle envelope %j", async (body) => {
    const test = setup();
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, test.options, async () => ({
          type: 6,
          flags: 0,
          counter: 1n,
          timestampNanos: 1n,
          body: encodeAgentJSON(body),
        })),
      ).rejects.toThrow("INVALID_REPLY");
      expect((await test.store.load()).assignment).toBeUndefined();
    } finally {
      test.store.close();
    }
  });

  it("saves replay authority before REG/completion and reopens warm state without network", async () => {
    const test = setup();
    try {
      const runtime = await agentRuntimeTesting.connectWithTransport(
        test.store,
        test.options,
        test.transport,
      );
      expect(test.calls.map((call) => call.type)).toEqual([5, 13, 5]);
      const state = await test.store.load();
      expect(state.registered_at).toBeDefined();
      expect(state.pending_completion).toBeUndefined();
      runtime.close();
      test.calls.length = 0;
      const reopened = await agentRuntimeTesting.connectWithTransport(
        test.store,
        {},
        test.transport,
      );
      expect(test.calls).toHaveLength(0);
      expect(reopened.agentID).toBe(state.agent_id);
      reopened.close();
    } finally {
      test.store.close();
    }
  });
  it("reuses the exact completion candidate after interruption without a new assignment or REG", async () => {
    const test = setup();
    test.failCompletion();
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, test.options, test.transport),
      ).rejects.toThrow("interrupted");
      const candidate = (await test.store.load()).pending_completion!.device_api_key;
      test.resume();
      test.calls.length = 0;
      const runtime = await agentRuntimeTesting.connectWithTransport(
        test.store,
        {},
        test.transport,
      );
      expect(test.calls).toHaveLength(1);
      expect(test.calls[0].body.usrData.device_api_key).toBe(candidate);
      expect((await test.store.load()).device_api_key).toBe(candidate);
      runtime.close();
    } finally {
      test.store.close();
    }
  });
  it("does not send completion when the candidate cannot be persisted", async () => {
    const test = setup();
    const wrapped: AgentStateStore = {
      load: test.store.load.bind(test.store),
      save: test.store.save.bind(test.store),
      withLock: (fn) =>
        test.store.withLock((locked) =>
          fn({
            ...locked,
            save: async (state, signal) => {
              if (state.pending_completion) throw new Error("disk full");
              await locked.save(state, signal);
            },
          }),
        ),
    };
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(wrapped, test.options, test.transport),
      ).rejects.toThrow("disk full");
      expect(test.calls.map((call) => call.type)).toEqual([5, 13]);
      expect((await test.store.load()).pending_activation).toBeDefined();
    } finally {
      test.store.close();
    }
  });
  it("retires the issuing cell after relocation and refuses reconstructed receipts", async () => {
    const test = setup();
    try {
      const runtime = await agentRuntimeTesting.connectWithTransport(
        test.store,
        test.options,
        test.transport,
      );
      const grant = await runtime.knock("knock-resource", {
        runID: "0123456789abcdef",
        runAttempt: 1n,
        protectedResourceID: vectors.producer_cases[0].expected_crid,
      });
      test.relocate();
      await runtime.refresh();
      expect(runtime.assignment().cell_id).toBe("cell-b");
      await runtime.retire(grant.receipt);
      expect(test.calls.at(-1)?.host).toBe("cell-a.layerv.ai");
      await expect(runtime.retire({ ...grant.receipt })).rejects.toThrow("INVALID_SESSION_RECEIPT");
      runtime.close();
    } finally {
      test.store.close();
    }
  });
  it("persists recovered credentials before mandatory refresh and resumes without reissuing recovery", async () => {
    const test = setup();
    try {
      (
        await agentRuntimeTesting.connectWithTransport(test.store, test.options, test.transport)
      ).close();
      test.failRefresh();
      const recovery = `lv_test_${Buffer.alloc(32, 9).toString("base64url")}`;
      await expect(
        agentRuntimeTesting.recoverWithTransport(
          test.store,
          recovery,
          { hub: test.options.hub },
          test.transport,
        ),
      ).rejects.toThrow("refresh offline");
      expect((await test.store.load()).credential_recovery_refresh_required).toBe(true);
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, {}, test.transport),
      ).rejects.toThrow("REFRESH_REQUIRED");
      test.restoreRefresh();
      test.calls.length = 0;
      const runtime = await agentRuntimeTesting.recoverWithTransport(
        test.store,
        "unused",
        { hub: test.options.hub },
        test.transport,
      );
      expect(test.calls).toHaveLength(1);
      expect(test.calls[0].body.usrData.mode).toBe("refresh");
      expect((await test.store.load()).credential_recovery_refresh_required).toBeUndefined();
      runtime.close();
    } finally {
      test.store.close();
    }
  });
});
