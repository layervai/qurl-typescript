import { describe, expect, it } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { buildNHPMessage, decryptNHPReply, NHP_TYPE_ACK, NHP_TYPE_KNOCK } from "./nhp-wire.js";

type RelayVectors = {
  knock: Record<string, string>;
  ack: Record<string, string>;
};

const vectors = conformancePackage.relayKnockVectors() as RelayVectors;
const hex = (value: string): Buffer => Buffer.from(value, "hex");

describe("NHP 1.1 wire", () => {
  it("builds the shared byte-exact KNK vector", () => {
    const v = vectors.knock;
    const built = buildNHPMessage({
      type: NHP_TYPE_KNOCK,
      devicePrivateKey: hex(v.device_static_priv_hex),
      serverPublicKey: hex(v.server_static_pub_hex),
      ephemeralPrivateKey: hex(v.ephemeral_priv_hex),
      timestampNanos: BigInt(v.timestamp_nanos),
      counter: BigInt(v.counter),
      preamble: Number.parseInt(v.preamble_hex, 16),
      body: hex(v.body_hex),
    });
    expect(Buffer.from(built.packet).toString("hex")).toBe(v.packet_hex);
  });

  it("authenticates and decrypts the shared ACK vector", () => {
    const v = vectors.ack;
    const reply = decryptNHPReply(
      hex(v.agent_static_priv_hex),
      hex(v.server_static_pub_hex),
      hex(v.packet_hex),
    );
    expect(reply.type).toBe(NHP_TYPE_ACK);
    expect(reply.counter).toBe(BigInt(`0x${v.counter_hex}`));
    expect(reply.timestampNanos).toBe(BigInt(v.timestamp_nanos));
    expect(Buffer.from(reply.body).toString("hex")).toBe(v.body_hex);
  });

  it("fails closed when an authenticated packet byte is changed", () => {
    const v = vectors.ack;
    const packet = hex(v.packet_hex);
    packet[packet.length - 1] ^= 1;
    expect(() =>
      decryptNHPReply(hex(v.agent_static_priv_hex), hex(v.server_static_pub_hex), packet),
    ).toThrow();
  });
});
