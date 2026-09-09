import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { FileAgentState } from "./file-agent-state.js";
import { connectAgentRuntime, recoverAgentRuntime } from "./agent-runtime.js";

// Only redirect DNS/socket destinations. Production packet encryption, UDP I/O,
// lifecycle transitions, and durable state all run unchanged against the Go peer.
const network = vi.hoisted(() => ({ port: 0, hosts: [] as string[] }));
vi.mock("./native-udp.js", async (original) => {
  const actual = await original<typeof import("./native-udp.js")>();
  return {
    ...actual,
    async resolvePublicAddresses(host: string) {
      expect(["hub.layerv.ai", "cell-1.layerv.ai", "cell-2.layerv.ai"]).toContain(host);
      network.hosts.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    },
    exchangeDatagram(...args: Parameters<typeof actual.exchangeDatagram>) {
      args[2] = network.port;
      return actual.exchangeDatagram(...args);
    },
  };
});

it.skipIf(!process.env.QURL_PARITY_RESPONDER)(
  "registers, reopens, relocates, retires and recovers over Go UDP",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qurl-agent-journey-"));
    const path = join(dir, "state.json");
    const keys = generateKeyPairSync("x25519");
    const publicKey = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64");
    const peer = spawn(process.env.QURL_PARITY_RESPONDER!, ["serve", publicKey], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    peer.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: peer.stdout });
    let store = new FileAgentState(path);
    let runtime: Awaited<ReturnType<typeof connectAgentRuntime>> | undefined;
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        once(peer, "exit").then(() => {
          throw new Error(`Go responder exited: ${stderr}`);
        }),
      ]);
      const endpoint = JSON.parse(line as string);
      network.port = endpoint.port;
      const hub = { host: "hub.layerv.ai", port: 443, server_public_key_b64: endpoint.key };
      await store.save({
        schema_version: 8,
        agent_id: "journey-agent",
        public_key_b64: publicKey,
        private_key_b64: keys.privateKey
          .export({ format: "der", type: "pkcs8" })
          .subarray(-32)
          .toString("base64"),
      });
      runtime = await connectAgentRuntime(store, {
        hub,
        headless: true,
        enrollmentCredential: "lv_live_" + "a".repeat(43),
      });
      const original = (await store.load()).device_api_key;
      expect(original).toMatch(/^lv_live_/);
      runtime.close();
      store.close();
      store = new FileAgentState(path);
      const requests = network.hosts.length;
      runtime = await connectAgentRuntime(store, { hub });
      expect(network.hosts).toHaveLength(requests);
      const vectors = JSON.parse(
        readFileSync(
          createRequire(import.meta.url).resolve("@layervai/qurl-conformance/crid_v1_vectors.json"),
          "utf8",
        ),
      );
      const grant = await runtime.knock("knock-resource", {
        runID: "0123456789abcdef",
        runAttempt: 18446744073709551615n,
        protectedResourceID: vectors.producer_cases[0].expected_crid,
      });
      expect(grant.receipt.sessionID).toBe(18446744073709551615n);
      await runtime.refresh();
      expect(runtime.assignment().cell_id).toBe("cell-2");
      expect(await runtime.retire(grant.receipt)).toEqual({
        closeEventID: "a".repeat(32),
        state: "closed",
      });
      expect(network.hosts.at(-1)).toBe("cell-1.layerv.ai");
      runtime.close();
      runtime = await recoverAgentRuntime(
        store,
        "lv_test_" + Buffer.alloc(32, 9).toString("base64url"),
        { hub },
      );
      const recovered = await store.load();
      expect(recovered.device_api_key).not.toBe(original);
      expect(recovered.pending_credential_recovery).toBeUndefined();
      expect(recovered.credential_recovery_refresh_required).toBeUndefined();
      expect(stderr).toBe("");
    } finally {
      runtime?.close();
      store.close();
      lines.close();
      peer.kill();
      await once(peer, "close");
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
