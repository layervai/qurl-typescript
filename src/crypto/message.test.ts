import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { buildMessage, decryptReply, openInitiatorMessage, buildReply } from "./message.js";
import {
  NHP_KNK,
  NHP_OTP,
  NHP_REG,
  NHP_ACK,
  NHP_RAK,
  HEADER_SIZE,
  GCM_TAG_SIZE,
} from "./packet.js";

// SELF round-trip wire tests. These exercise the vendored NHP wire NOW (the
// conformance-vector byte-fence against local C1 vectors is deferred —
// layervai/qurl-typescript#176). They build an OTP/REG/KNK packet and open it
// back with the responder-role open, then fabricate a reply (ACK/RAK) and open it
// with the agent-role decrypt, asserting the body/type/counter round-trip. The
// responder-role helpers are the TS mirrors of Go relayknocktest.

const enc = new TextEncoder();
const dec = new TextDecoder();

function fixedKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const devicePriv = fixedKey(7);
const devicePub = x25519.getPublicKey(devicePriv);
const serverPriv = fixedKey(9);
const serverPub = x25519.getPublicKey(serverPriv);

function baseInputs(headerType: number, body: Uint8Array, counter = 0xdeadbeefcafef00dn) {
  return {
    deviceStaticPriv: devicePriv,
    serverStaticPub: serverPub,
    ephemeralPriv: fixedKey(3),
    timestampNanos: 111222333444555n,
    counter,
    preamble: 0x1a2b3c4d,
    headerType,
    body,
  };
}

describe("NHP wire self round-trip", () => {
  it("REG packet: agent builds, responder opens, fields round-trip", async () => {
    const body = enc.encode(
      JSON.stringify({ usrId: "key_x", devId: "agent-1", aspId: "agent", otp: "123456" }),
    );
    const pkt = buildMessage(baseInputs(NHP_REG, body));
    // 240-byte header + sealed body (plaintext + 16-byte GCM tag).
    expect(pkt.length).toBe(HEADER_SIZE + body.length + GCM_TAG_SIZE);

    const opened = await openInitiatorMessage(serverPriv, devicePub, pkt);
    expect(opened.headerType).toBe(NHP_REG);
    expect(opened.counter).toBe(0xdeadbeefcafef00dn);
    expect(dec.decode(opened.body)).toBe(dec.decode(body));
    // The opened static key is the agent's (the responder recovers the initiator).
    expect(Array.from(opened.serverStaticPub)).toEqual(Array.from(devicePub));
  });

  it("OTP packet: agent builds, responder opens", async () => {
    const body = enc.encode(JSON.stringify({ usrId: "key_x", pass: "lv_key" }));
    const pkt = buildMessage(baseInputs(NHP_OTP, body, 42n));
    const opened = await openInitiatorMessage(serverPriv, devicePub, pkt);
    expect(opened.headerType).toBe(NHP_OTP);
    expect(opened.counter).toBe(42n);
    expect(dec.decode(opened.body)).toBe(dec.decode(body));
  });

  it("KNK packet still round-trips (the base knock type)", async () => {
    const body = enc.encode("knock");
    const pkt = buildMessage(baseInputs(NHP_KNK, body, 1n));
    const opened = await openInitiatorMessage(serverPriv, devicePub, pkt);
    expect(opened.headerType).toBe(NHP_KNK);
    expect(dec.decode(opened.body)).toBe("knock");
  });

  it("RAK reply: server builds (roles swapped), agent decrypts", async () => {
    // Agent sends a REG to learn the counter the reply must echo.
    const regBody = enc.encode(JSON.stringify({ otp: "123456" }));
    const regPkt = buildMessage(baseInputs(NHP_REG, regBody));
    const opened = await openInitiatorMessage(serverPriv, devicePub, regPkt);

    const rakBody = enc.encode(JSON.stringify({ errCode: "0", errMsg: "", aspId: "agent" }));
    const rakPkt = buildReply({
      deviceStaticPriv: serverPriv, // server is the initiator of the reply handshake
      serverStaticPub: devicePub,
      ephemeralPriv: fixedKey(5),
      timestampNanos: 999n,
      counter: opened.counter,
      preamble: 0x5a6b7c8d,
      headerType: NHP_RAK,
      body: rakBody,
    });
    const reply = await decryptReply(devicePriv, serverPub, rakPkt);
    expect(reply.headerType).toBe(NHP_RAK);
    expect(reply.counter).toBe(opened.counter);
    expect(dec.decode(reply.body)).toBe(dec.decode(rakBody));
  });

  it("empty-body message round-trips (no sealed body, size 0)", async () => {
    const pkt = buildMessage(baseInputs(NHP_REG, new Uint8Array(0), 5n));
    expect(pkt.length).toBe(HEADER_SIZE); // no body, no tag
    const opened = await openInitiatorMessage(serverPriv, devicePub, pkt);
    expect(opened.headerType).toBe(NHP_REG);
    expect(opened.body.length).toBe(0);
  });
});

describe("NHP wire authentication and gating", () => {
  it("rejects a tampered body (AEAD tag fails)", async () => {
    const pkt = buildMessage(baseInputs(NHP_REG, enc.encode("body-to-tamper")));
    const tampered = pkt.slice();
    tampered[HEADER_SIZE + 2] ^= 0xff;
    await expect(openInitiatorMessage(serverPriv, devicePub, tampered)).rejects.toThrow();
  });

  it("rejects a tampered header (digest fails)", async () => {
    const pkt = buildMessage(baseInputs(NHP_REG, enc.encode("x")));
    const tampered = pkt.slice();
    tampered[10] ^= 0xff; // flip a HeaderCommon byte covered by the digest
    await expect(openInitiatorMessage(serverPriv, devicePub, tampered)).rejects.toThrow(
      /digest mismatch/,
    );
  });

  it("pins the server: decryptReply with the wrong expected key throws", async () => {
    const rakPkt = buildReply({
      deviceStaticPriv: serverPriv,
      serverStaticPub: devicePub,
      ephemeralPriv: fixedKey(5),
      timestampNanos: 1n,
      counter: 7n,
      preamble: 1,
      headerType: NHP_RAK,
      body: enc.encode("{}"),
    });
    await expect(
      decryptReply(devicePriv, fixedKey(1) /* wrong server key */, rakPkt),
    ).rejects.toThrow(/unexpected/);
  });

  it("decryptReply rejects an initiator-type packet (reply-only gate)", async () => {
    const regPkt = buildMessage(baseInputs(NHP_REG, enc.encode("x")));
    // Open in the responder role would succeed; decryptReply must reject the type.
    await expect(decryptReply(serverPriv, devicePub, regPkt)).rejects.toThrow(/initiator-only/);
  });

  it("openInitiatorMessage rejects a reply-type packet (initiator-only gate)", async () => {
    const rakPkt = buildReply({
      deviceStaticPriv: serverPriv,
      serverStaticPub: devicePub,
      ephemeralPriv: fixedKey(5),
      timestampNanos: 1n,
      counter: 7n,
      preamble: 1,
      headerType: NHP_RAK,
      body: enc.encode("{}"),
    });
    await expect(openInitiatorMessage(devicePriv, serverPub, rakPkt)).rejects.toThrow(/reply-only/);
  });

  it("buildMessage rejects a reply header type", () => {
    expect(() => buildMessage(baseInputs(NHP_ACK, enc.encode("x")))).toThrow(/unsupported/);
  });

  it("buildReply rejects an initiator header type", () => {
    expect(() =>
      buildReply({
        deviceStaticPriv: serverPriv,
        serverStaticPub: devicePub,
        ephemeralPriv: fixedKey(5),
        timestampNanos: 1n,
        counter: 7n,
        preamble: 1,
        headerType: NHP_REG,
        body: enc.encode("{}"),
      }),
    ).toThrow(/unsupported reply/);
  });

  it("a different counter in the reply is observable to the caller", async () => {
    // The transcript does not bind the counter; decryptReply surfaces it so the
    // relay layer (exchangeRegister) can enforce the echo. Here we prove the
    // decoded counter reflects what the builder stamped.
    const rakPkt = buildReply({
      deviceStaticPriv: serverPriv,
      serverStaticPub: devicePub,
      ephemeralPriv: fixedKey(6),
      timestampNanos: 1n,
      counter: 0x0102030405060708n,
      preamble: 9,
      headerType: NHP_RAK,
      body: new Uint8Array(0),
    });
    const reply = await decryptReply(devicePriv, serverPub, rakPkt);
    expect(reply.counter).toBe(0x0102030405060708n);
  });
});
