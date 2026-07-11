import { x25519 } from "@noble/curves/ed25519.js";
import {
  openInitiatorMessage,
  buildReply,
  pubKeyFingerprint,
  NHP_OTP,
  NHP_REG,
  NHP_RAK,
  NHP_COK,
} from "../crypto/index.js";
import type { AgentState, AgentStateStore } from "../agent-state.js";
import type { NHPServerPeerInfo } from "../types.js";

// Test harness for registerAgent: a single fetch mock that routes to the fake
// qurl-service HTTPS endpoints (GET /v1/agent/registration-info, POST
// /v1/agent/registration/complete) AND the fake NHP relay
// (POST {relayBase}/relay/{serverId}). The relay side opens the posted NHP
// OTP/REG packets in the responder role with the vendored crypto and answers a
// REG with a scripted NHP_RAK — the TS analogue of the Go fakeNHPServer +
// fakeService + registerHarness in register_test.go. The SAME vendored crypto is
// used on both ends, so this exercises the orchestration (paths, state machine,
// error mapping, persistence), not the handshake (which the wire self round-trip
// tests fence).

const RELAY_BASE = "https://relay.test.layerv.ai";
const API_BASE = "https://api.test.layerv.ai";
const NHP_HOST = "nhp.example.test";
const NHP_PORT = 62206;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fixedEphemeral(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

interface RegisterBody {
  usrId: string;
  devId: string;
  aspId: string;
  otp: string;
  usrData?: { hostname?: string; version?: string; takeover?: boolean };
}

interface OTPBody {
  usrId: string;
  devId: string;
  aspId: string;
  pass: string;
}

/** An in-memory store that exposes the persisted state to the harness (so it can
 * sync the device pubkey the responder-role open needs) and lets a test inject a
 * save failure at a chosen transition. */
export class HarnessStore implements AgentStateStore {
  state: AgentState | null = null;
  saveCount = 0;
  /** When set, saveAgentState throws for the first `failsLeft` saves whose state
   * matches the predicate. */
  failWhen?: (s: AgentState) => boolean;
  failsLeft = 0;
  failError: Error = new Error("injected store write failure");

  async loadAgentState(): Promise<AgentState | null> {
    return this.state === null ? null : { ...this.state };
  }

  async saveAgentState(state: AgentState): Promise<void> {
    this.saveCount++;
    if (this.failsLeft > 0 && this.failWhen?.(state)) {
      this.failsLeft--;
      throw this.failError;
    }
    this.state = { ...state };
  }
}

export interface HarnessConfig {
  keyKind?: "bootstrap" | "account";
  keyId?: string;
  maskedEmail?: string;
  deviceApiKey?: string;
  /** errCode the next REG's NHP_RAK carries ("0"/"" = success). */
  rakErrCode?: string;
  rakErrMsg?: string;
  /** When true, answer a REG with an overload NHP_COK instead of an NHP_RAK. */
  replyREGWithCOK?: boolean;
  /** When non-empty, asserts the REG body carried this credential. */
  expectCredential?: string;
  /** Asserts the Authorization bearer on the HTTPS endpoints. */
  expectedBearer?: string;
}

/** A scripted fake service + NHP relay behind one fetch mock. */
export class RegisterHarness {
  readonly serverPriv: Uint8Array;
  readonly serverPub: Uint8Array;
  readonly store: HarnessStore;

  cfg: Required<Omit<HarnessConfig, "expectCredential" | "expectedBearer" | "maskedEmail">> &
    Pick<HarnessConfig, "expectCredential" | "expectedBearer" | "maskedEmail">;

  // counters
  infoCalls = 0;
  completionCalls = 0;
  otpSends = 0;
  regCount = 0;
  lastReg?: RegisterBody;
  lastOTP?: OTPBody;

  // server enrollment state: completion only succeeds once a REG succeeded (or a
  // test pre-marks it) — models the server having a registered device.
  enrolled = false;

  // completion scripting
  completionStatus = 0; // 0 => success
  completionCode = "";
  registeredAt: string = new Date().toISOString();
  agentIdOverride = ""; // "" => echo the request device_id

  // per-endpoint override hook, for tests that need bespoke completion behavior
  completionOverride?: (deviceId: string) => { status: number; code?: string } | null;

  constructor(config: HarnessConfig = {}) {
    this.serverPriv = new Uint8Array(32).fill(9);
    this.serverPub = x25519.getPublicKey(this.serverPriv);
    this.store = new HarnessStore();
    this.cfg = {
      keyKind: config.keyKind ?? "bootstrap",
      keyId: config.keyId ?? "key_test123",
      deviceApiKey: config.deviceApiKey ?? "lv_device_secret",
      rakErrCode: config.rakErrCode ?? "0",
      rakErrMsg: config.rakErrMsg ?? "",
      replyREGWithCOK: config.replyREGWithCOK ?? false,
      maskedEmail: config.maskedEmail,
      expectCredential: config.expectCredential,
      expectedBearer: config.expectedBearer,
    };
  }

  serverId(): string {
    return pubKeyFingerprint(this.serverPub);
  }

  relayUrl(): string {
    return RELAY_BASE;
  }

  apiBase(): string {
    return API_BASE;
  }

  nhpPeer(): NHPServerPeerInfo {
    return { public_key_b64: b64(this.serverPub), host: NHP_HOST, port: NHP_PORT, expire_time: 0 };
  }

  /** The device public key the SDK persisted before its first network call, for
   * the responder-role open. */
  private devicePub(): Uint8Array {
    if (this.store.state === null) {
      throw new Error("harness: no persisted device key yet (SDK must save before knocking)");
    }
    const b64key = this.store.state.public_key_b64;
    const bin = atob(b64key);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** The fetch implementation to pass as the `fetch` option. */
  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Relay endpoint: binary NHP packet.
    if (url === `${RELAY_BASE}/relay/${this.serverId()}`) {
      return this.handleRelay(init);
    }
    // HTTPS registration endpoints.
    if (this.cfg.expectedBearer !== undefined) {
      const auth = headerOf(init, "authorization");
      if (auth !== `Bearer ${this.cfg.expectedBearer}`) {
        throw new Error(`harness: Authorization = ${auth}, want Bearer ${this.cfg.expectedBearer}`);
      }
    }
    if (method === "GET" && url === `${API_BASE}/v1/agent/registration-info`) {
      this.infoCalls++;
      return this.jsonResponse(200, {
        data: {
          key_kind: this.cfg.keyKind,
          key_id: this.cfg.keyId,
          nhp_server_peer: this.nhpPeer(),
          relay: { base_url: RELAY_BASE, server_id: this.serverId() },
          masked_email: this.cfg.maskedEmail ?? "",
        },
      });
    }
    if (method === "POST" && url === `${API_BASE}/v1/agent/registration/complete`) {
      this.completionCalls++;
      return this.handleCompletion(init);
    }
    throw new Error(`harness: unexpected request ${method} ${url}`);
  };

  private async handleRelay(init: RequestInit | undefined): Promise<Response> {
    const packet = toBytes(init?.body);
    const opened = await openInitiatorMessage(this.serverPriv, this.devicePub(), packet);
    if (opened.headerType === NHP_OTP) {
      this.otpSends++;
      this.lastOTP = JSON.parse(dec.decode(opened.body)) as OTPBody;
      return binaryResponse(202, new Uint8Array(0));
    }
    if (opened.headerType === NHP_REG) {
      this.regCount++;
      const body = JSON.parse(dec.decode(opened.body)) as RegisterBody;
      this.lastReg = body;
      if (this.cfg.expectCredential !== undefined && body.otp !== this.cfg.expectCredential) {
        throw new Error(`harness: REG credential = ${body.otp}, want ${this.cfg.expectCredential}`);
      }
      const success =
        !this.cfg.replyREGWithCOK && (this.cfg.rakErrCode === "" || this.cfg.rakErrCode === "0");
      if (success) {
        this.enrolled = true;
      }
      if (this.cfg.replyREGWithCOK) {
        const cok = buildReply({
          deviceStaticPriv: this.serverPriv,
          serverStaticPub: this.devicePub(),
          ephemeralPriv: fixedEphemeral(0x6b),
          timestampNanos: BigInt(Date.now()) * 1_000_000n,
          counter: opened.counter,
          preamble: 0x2b3c4d5e,
          headerType: NHP_COK,
          body: new Uint8Array(0),
        });
        return binaryResponse(200, cok);
      }
      const ackBody = enc.encode(
        JSON.stringify({
          errCode: this.cfg.rakErrCode,
          errMsg: this.cfg.rakErrMsg,
          aspId: "agent",
        }),
      );
      const rak = buildReply({
        deviceStaticPriv: this.serverPriv,
        serverStaticPub: this.devicePub(),
        ephemeralPriv: fixedEphemeral(0x5a),
        timestampNanos: BigInt(Date.now()) * 1_000_000n,
        counter: opened.counter,
        preamble: 0x1a2b3c4d,
        headerType: NHP_RAK,
        body: ackBody,
      });
      return binaryResponse(200, rak);
    }
    throw new Error(`harness: unexpected posted packet type ${opened.headerType}`);
  }

  private async handleCompletion(init: RequestInit | undefined): Promise<Response> {
    const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
      device_id?: string;
      device_pubkey_b64?: string;
    };
    const deviceId = reqBody.device_id ?? "";

    if (this.completionOverride) {
      const decision = this.completionOverride(deviceId);
      if (decision !== null) {
        return this.jsonResponse(decision.status, {
          error: { code: decision.code ?? "", detail: "scripted completion error" },
        });
      }
    }
    if (this.completionStatus !== 0) {
      return this.jsonResponse(this.completionStatus, {
        error: { code: this.completionCode, detail: "scripted completion error" },
      });
    }
    if (!this.enrolled) {
      return this.jsonResponse(404, {
        error: { code: "device_not_registered", detail: "device is not yet registered" },
      });
    }
    const agentId = this.agentIdOverride !== "" ? this.agentIdOverride : deviceId;
    return this.jsonResponse(200, {
      data: {
        agent_id: agentId,
        registered_at: this.registeredAt,
        nhp_server_peer: this.nhpPeer(),
        device_api_key: this.cfg.deviceApiKey,
      },
    });
  }

  private jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
  }
}

function binaryResponse(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/octet-stream" }),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    json: () => Promise.reject(new Error("binary body")),
    text: () => Promise.resolve(""),
  } as Response;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (h === undefined) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const rec = h as Record<string, string>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === name.toLowerCase()) return rec[k];
  }
  return undefined;
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error("harness: relay body is not binary");
}

/** A deterministic random-bytes source for tests: a simple counter-seeded PRNG so
 * device keys/ids are reproducible and every run produces valid 32-byte scalars.
 * NOT cryptographically strong — test-only. */
export function seededRandomBytes(seed = 1): (n: number) => Uint8Array {
  let state = seed >>> 0;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      // xorshift32
      state ^= state << 13;
      state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}
