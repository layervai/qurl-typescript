import { parseStrictJson } from "./strict-json.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { FileAgentState } from "./file-agent-state.js";
import { encodeAgentJSON, type AgentStateStore } from "./agent-state.js";
import { agentRuntimeTesting, type AgentRuntimeOptions } from "./agent-runtime.js";
import { AgentTransportError, type AgentTransport } from "./agent-transport.js";
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
function setup(kind = "bootstrap", ticketTTL = 900_000) {
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
    if (exchange.type === 12) return undefined;
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
          registration: { key_id: "key_123456789012", key_kind: kind },
          assignment_ticket: "qat1.test",
          assignment_ticket_expires_at: new Date(Date.now() + ticketTTL)
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

  it("does not retry when authenticated Retry-After exceeds the operation budget", async () => {
    const test = setup();
    let calls = 0;
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, test.options, async () => {
          calls++;
          return {
            type: 6,
            flags: 0,
            counter: 1n,
            timestampNanos: 1n,
            body: encodeAgentJSON({ errCode: "52204", retryAfterSeconds: 9_223_372_036n }),
          };
        }),
      ).rejects.toMatchObject({ code: "52204" });
      expect(calls).toBe(1);
    } finally {
      test.store.close();
    }
  });

  it("retries a transient transport failure within the bounded lifecycle", async () => {
    const test = setup();
    let attempts = 0;
    try {
      const runtime = await agentRuntimeTesting.connectWithTransport(
        test.store,
        test.options,
        async (request) => {
          if (attempts++ === 0) throw new AgentTransportError();
          return test.transport(request);
        },
      );
      expect(attempts).toBe(4);
      runtime.close();
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
  it("cancels refresh lock waits when the runtime closes", async () => {
    const test = setup();
    const runtime = await agentRuntimeTesting.connectWithTransport(
      test.store,
      test.options,
      test.transport,
    );
    let release!: () => void;
    const held = test.store.withLock(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const refreshing = runtime.refresh();
      runtime.close();
      await expect(refreshing).rejects.toThrow();
    } finally {
      release();
      await held;
      runtime.close();
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

describe("account enrollment", () => {
  it.each([
    ["account", 900_000, "12345678", undefined],
    ["account", 900_000, "bad", "INVALID_OTP"],
    ["account", 600_000, "12345678", "OTP_NOT_AVAILABLE"],
    ["bootstrap", 900_000, "12345678", "ENROLLMENT_KIND_REFUSED"],
    ["account", 900_000, undefined, "OTP_NOT_AVAILABLE"],
  ])("validates %s enrollment with ticket TTL %i and OTP %s", async (kind, ttl, otp, error) => {
    const test = setup(kind, ttl);
    const challenges: boolean[] = [];
    const options = {
      ...test.options,
      headless: false,
      otpProvider:
        otp === undefined
          ? undefined
          : async (challenge: { pendingActivationRecovery: boolean }) => {
              challenges.push(challenge.pendingActivationRecovery);
              return otp;
            },
    };
    try {
      const result = agentRuntimeTesting.connectWithTransport(test.store, options, test.transport);
      if (error) await expect(result).rejects.toThrow(error);
      else {
        const runtime = await result;
        expect(challenges).toEqual([false]);
        expect(test.calls.filter((call) => call.type === 12)).toHaveLength(1);
        expect(test.calls.find((call) => call.type === 13)?.body.otp).toBe(otp);
        await runtime.close();
      }
    } finally {
      test.store.close();
    }
  });

  it("resumes interrupted account activation without sending another OTP request", async () => {
    const test = setup("account");
    const challenges: boolean[] = [];
    const options = {
      ...test.options,
      headless: false,
      otpProvider: async (challenge: { pendingActivationRecovery: boolean }) => {
        challenges.push(challenge.pendingActivationRecovery);
        return "12345678";
      },
    };
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, options, async (exchange) => {
          if (exchange.type === 13) throw new Error("interrupted registration");
          return test.transport(exchange);
        }),
      ).rejects.toThrow("interrupted registration");
      expect((await test.store.load()).pending_activation).toBeDefined();
      const runtime = await agentRuntimeTesting.connectWithTransport(
        test.store,
        options,
        test.transport,
      );
      expect(challenges).toEqual([false, true]);
      expect(test.calls.filter((call) => call.type === 12)).toHaveLength(1);
      await runtime.close();
    } finally {
      test.store.close();
    }
  });

  it("bounds account ticket replacement to one attempt and preserves its recovery horizon", async () => {
    const test = setup("account");
    const options = { ...test.options, headless: false, otpProvider: async () => "12345678" };
    const horizons: unknown[] = [];
    try {
      await expect(
        agentRuntimeTesting.connectWithTransport(test.store, options, async (exchange) => {
          const reply = await test.transport(exchange);
          // The replacement ticket has a later expiry: resetting the horizon
          // from this ticket would incorrectly extend credential recovery.
          if (exchange.type === 5 && horizons.length === 1) {
            const body = parseStrictJson(reply!.body, 4096) as unknown as {
              list: { assignment_ticket_expires_at: string };
            };
            body.list.assignment_ticket_expires_at = new Date(Date.now() + 960_000)
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z");
            return { ...reply!, body: encodeAgentJSON(body) };
          }
          if (exchange.type === 13) {
            const pending = (await test.store.load()).pending_activation!;
            horizons.push([pending.recovery_anchor_ticket_expires_at, pending.recovery_expires_at]);
            return { ...reply!, body: encodeAgentJSON({ errCode: "52101", aspId: "agent" }) };
          }
          return reply;
        }),
      ).rejects.toThrow("52101");
      expect(horizons).toHaveLength(2);
      expect(horizons[1]).toEqual(horizons[0]);
      expect(test.calls.filter((call) => call.type === 12)).toHaveLength(2);
    } finally {
      test.store.close();
    }
  });
});

it("reloads a rotated credential once per expiry and rejects identity replacement before HTTP", async () => {
  const test = setup();
  const credentials: (string | null)[] = [];
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    credentials.push(new Headers(init?.headers).get("Authorization"));
    return new Response(JSON.stringify({ data: {} }));
  };
  const runtime = await agentRuntimeTesting.connectWithTransport(
    test.store,
    { ...test.options, fetch: fetcher },
    test.transport,
  );
  const load = vi.spyOn(test.store, "load");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const state = await test.store.load();
    const original = state.device_api_key;
    state.device_api_key = "lv_live_" + Buffer.alloc(32, 8).toString("base64url");
    await test.store.save(state);
    load.mockClear();
    await runtime.client.getQuota();
    expect(credentials).toEqual([`Bearer ${original}`]);
    expect(load).not.toHaveBeenCalled();
    now += 60_001;
    await Promise.all([
      runtime.client.getQuota(),
      runtime.client.getQuota(),
      runtime.client.getQuota(),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(credentials.slice(1)).toEqual(Array(3).fill(`Bearer ${state.device_api_key}`));
    const pair = generateKeyPairSync("x25519");
    state.private_key_b64 = pair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .subarray(-32)
      .toString("base64");
    state.public_key_b64 = pair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64");
    await test.store.save(state);
    now += 60_001;
    await expect(runtime.client.getQuota()).rejects.toThrow("IDENTITY_CHANGED");
    expect(credentials).toHaveLength(4);
  } finally {
    clock.mockRestore();
    load.mockRestore();
    await runtime.close();
    test.store.close();
  }
}, 20_000);

it("keeps legacy completion readable but refuses migration without a deadline or UDP", async () => {
  const test = setup();
  test.failCompletion();
  try {
    await expect(
      agentRuntimeTesting.connectWithTransport(test.store, test.options, test.transport),
    ).rejects.toThrow("process interrupted");
    const legacy = await test.store.load();
    const pending = legacy.pending_completion!;
    legacy.schema_version = 5;
    await expect(test.store.save(legacy)).rejects.toThrow("INVALID_COMPLETION");
    delete pending.recovery_anchor_ticket_expires_at;
    delete pending.recovery_expires_at;
    await test.store.save(legacy);
    const before = await test.store.load();
    const calls = test.calls.length;
    await expect(
      agentRuntimeTesting.connectWithTransport(test.store, test.options, test.transport),
    ).rejects.toThrow("RECOVERY_MIGRATION_REQUIRED");
    expect(test.calls).toHaveLength(calls);
    expect(await test.store.load()).toEqual(before);
    await expect(test.store.save({ ...legacy, schema_version: 8 })).rejects.toThrow("INVALID_TIME");
  } finally {
    test.store.close();
  }
});

it("normalizes legacy activation zero times from its authenticated ticket before replay", async () => {
  const test = setup();
  try {
    await expect(
      agentRuntimeTesting.connectWithTransport(test.store, test.options, async (exchange) => {
        if (exchange.type === 13) throw new Error("registration interrupted");
        return test.transport(exchange);
      }),
    ).rejects.toThrow("registration interrupted");
    const legacy = await test.store.load();
    const pending = legacy.pending_activation!;
    legacy.schema_version = 5;
    await expect(test.store.save(legacy)).rejects.toThrow("INVALID_ACTIVATION");
    pending.recovery_anchor_ticket_expires_at = "0001-01-01T00:00:00Z";
    pending.recovery_expires_at = "0001-01-01T00:00:00Z";
    await test.store.save(legacy);
    const normalized = await test.store.load();
    expect(normalized.schema_version).toBe(6);
    expect(normalized.pending_activation?.recovery_anchor_ticket_expires_at).toBe(
      pending.assignment_ticket_expires_at,
    );
    const runtime = await agentRuntimeTesting.connectWithTransport(
      test.store,
      test.options,
      test.transport,
    );
    expect((await test.store.load()).schema_version).toBe(8);
    await runtime.close();
  } finally {
    test.store.close();
  }
});
