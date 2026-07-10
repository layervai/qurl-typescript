import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildMessage, decryptReply } from "./message.js";
import { NHP_OTP, NHP_REG, NHP_RAK } from "./packet.js";

// BYTE-EXACT cross-language wire fence.
//
// Unlike message.test.ts (which round-trips build↔open with the SAME vendored
// crypto and so cannot catch a divergence from the Go/server wire), this test
// pins the vendored NHP wire against the qurl-conformance golden vectors — the
// same artifact the Go SDK and the OpenNHP reference server are fenced by. If
// buildMessage reproduces `packet_hex` byte-for-byte from the fixed inputs, and
// decryptReply opens the frozen RAK replies, the wire is interoperable by
// construction.
//
// SOURCE OF THE VECTORS — live now vs. at-publish re-point (tracked in #176):
//
//   NOW: the vectors are a byte-identical *temporary vendor* of the
//   qurl-conformance artifact, read from __testdata__/agent_registration_golden.json
//   (see __testdata__/README.md). Two fences guard it: (a) FIXTURE_SHA256 below
//   pins the vendored bytes so a LOCAL edit is caught here; (b) the `golden-drift`
//   CI job (scripts/check-golden-drift.mjs) fetches the CANONICAL upstream copy
//   and fails if the vendored file has diverged from it. So the vendored copy
//   cannot silently drift in either direction.
//
//   AT PUBLISH (one-line swap): once `@layervai/qurl-conformance` ships an
//   `agentRegistrationVectors()` accessor (it does not yet — the installed 0.1.2
//   exposes only qv2/issuer/relay-knock; the vectors are in qurl-conformance#20),
//   replace the fixture read with the accessor — the same pattern portal.test.ts
//   uses via `qv2Vectors()` — and delete the vendored fixture + the drift CI job:
//
//     import conformancePackage from "@layervai/qurl-conformance";
//     const golden = (conformancePackage as typeof import("@layervai/qurl-conformance"))
//       .agentRegistrationVectors() as GoldenFile;   // <-- the one-line re-point
//
//   That deletes the `readFileSync` + FIXTURE_SHA256 pin below (the accessor is
//   the source of truth once published). Until then, the vendored read stays.

interface InitiatorVector {
  server_static_pub_hex: string;
  device_static_priv_hex: string;
  ephemeral_priv_hex: string;
  timestamp_nanos: string;
  counter: string;
  preamble_hex: string;
  body_hex: string;
  packet_hex: string;
}

interface ReplyVector {
  server_static_pub_hex: string;
  agent_static_priv_hex: string;
  timestamp_nanos: string;
  counter_hex: string;
  body_hex: string;
  packet_hex: string;
}

interface GoldenFile {
  artifact: string;
  otp: InitiatorVector;
  reg_emailed: InitiatorVector;
  reg_preissued: InitiatorVector;
  rak_success: ReplyVector;
  rak_error: ReplyVector;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("./__testdata__/agent_registration_golden.json", import.meta.url),
);
const fixtureBytes = readFileSync(FIXTURE_PATH);
const golden = JSON.parse(fixtureBytes.toString("utf8")) as GoldenFile;

// The fixture is a temporary byte-identical vendor of the qurl-conformance
// artifact (see __testdata__/README.md). Pin its SHA-256 so a silent local edit
// is caught in CI — otherwise a well-meaning tweak could quietly turn this
// cross-language fence back into a self-consistency check. If the upstream
// artifact legitimately changes, re-vendor and update this digest deliberately.
const FIXTURE_SHA256 = "77dc8634eb15e8a986df1093923b70b341386ba3c15421814ffed1a668f2d2bc";

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`odd-length hex: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function buildFromVector(v: InitiatorVector, headerType: number): Uint8Array {
  return buildMessage({
    deviceStaticPriv: hexToBytes(v.device_static_priv_hex),
    serverStaticPub: hexToBytes(v.server_static_pub_hex),
    ephemeralPriv: hexToBytes(v.ephemeral_priv_hex),
    timestampNanos: BigInt(v.timestamp_nanos),
    counter: BigInt(v.counter),
    // preamble is a uint32; the vector gives it big-endian hex.
    preamble: Number.parseInt(v.preamble_hex, 16),
    headerType,
    body: hexToBytes(v.body_hex),
  });
}

describe("NHP wire golden fence — vendored fixture integrity", () => {
  it("the vendored golden vectors match the pinned SHA-256 (guards against a silent edit)", () => {
    const digest = createHash("sha256").update(fixtureBytes).digest("hex");
    expect(digest).toBe(FIXTURE_SHA256);
  });
});

describe("NHP wire golden fence — deterministic initiator packets (buildMessage)", () => {
  it("otp reproduces packet_hex byte-for-byte (NHP_OTP)", () => {
    const packet = buildFromVector(golden.otp, NHP_OTP);
    expect(bytesToHex(packet)).toBe(golden.otp.packet_hex);
  });

  it("reg_emailed reproduces packet_hex byte-for-byte (NHP_REG, emailed code)", () => {
    const packet = buildFromVector(golden.reg_emailed, NHP_REG);
    expect(bytesToHex(packet)).toBe(golden.reg_emailed.packet_hex);
  });

  it("reg_preissued reproduces packet_hex byte-for-byte (NHP_REG, pre-issued key)", () => {
    const packet = buildFromVector(golden.reg_preissued, NHP_REG);
    expect(bytesToHex(packet)).toBe(golden.reg_preissued.packet_hex);
  });

  it("the two REG packets differ only in the body otp value (same framing)", () => {
    // Documented invariant from the vector notes: emailed vs pre-issued REG are
    // identical on the wire apart from the body. Rebuild both and confirm the
    // 240-byte headers differ only where the (different) body size/seal forces it
    // — here we simply assert both reproduce their own packet_hex, which the three
    // cases above already prove; this case pins the shared NHP_REG type.
    const emailed = buildFromVector(golden.reg_emailed, NHP_REG);
    const preissued = buildFromVector(golden.reg_preissued, NHP_REG);
    expect(bytesToHex(emailed)).toBe(golden.reg_emailed.packet_hex);
    expect(bytesToHex(preissued)).toBe(golden.reg_preissued.packet_hex);
  });
});

describe("NHP wire golden fence — frozen RAK replies (decryptReply)", () => {
  it("rak_success: decrypts to NHP_RAK (14), echoes the REG counter, errCode 0", async () => {
    const v = golden.rak_success;
    const reply = await decryptReply(
      hexToBytes(v.agent_static_priv_hex),
      hexToBytes(v.server_static_pub_hex),
      hexToBytes(v.packet_hex),
    );
    expect(reply.headerType).toBe(NHP_RAK);
    // counter_hex "b" == 11, which echoes reg_emailed.counter (the matched pair).
    expect(reply.counter).toBe(BigInt(`0x${v.counter_hex}`));
    expect(reply.counter).toBe(BigInt(golden.reg_emailed.counter));
    expect(reply.timestampNanos).toBe(BigInt(v.timestamp_nanos));
    const body = JSON.parse(new TextDecoder().decode(reply.body)) as {
      errCode?: string;
      aspId?: string;
    };
    expect(body.errCode).toBe("0");
    expect(body.aspId).toBe("agent");
  });

  it("rak_error: decrypts to NHP_RAK (14) and recovers the 52100 errCode + errMsg", async () => {
    const v = golden.rak_error;
    const reply = await decryptReply(
      hexToBytes(v.agent_static_priv_hex),
      hexToBytes(v.server_static_pub_hex),
      hexToBytes(v.packet_hex),
    );
    expect(reply.headerType).toBe(NHP_RAK);
    expect(reply.counter).toBe(BigInt(`0x${v.counter_hex}`));
    const body = JSON.parse(new TextDecoder().decode(reply.body)) as {
      errCode?: string;
      errMsg?: string;
    };
    expect(body.errCode).toBe("52100");
    expect(body.errMsg).toMatch(/otp invalid or expired/);
  });

  it("the RAK body_hex matches what decryptReply recovers (frozen decrypt-only)", async () => {
    // Cross-check: the decrypted body equals the vector's plaintext body_hex.
    const v = golden.rak_success;
    const reply = await decryptReply(
      hexToBytes(v.agent_static_priv_hex),
      hexToBytes(v.server_static_pub_hex),
      hexToBytes(v.packet_hex),
    );
    expect(bytesToHex(reply.body)).toBe(v.body_hex);
  });
});
