import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { buildNHPMessage, decryptNHPReply } from "./nhp-wire.js";
const require = createRequire(import.meta.url);
interface Vector {
  header_type: number;
  sender_key: string;
  receiver_key: string;
  ephemeral_priv_hex: string;
  timestamp_nanos: string;
  counter: string;
  preamble_hex: string;
  body_hex: string;
  packet_hex: string;
}
const vectors = JSON.parse(
  readFileSync(require.resolve("@layervai/qurl-conformance/agent_assignment_golden.json"), "utf8"),
) as {
  keys: Record<string, { static_priv_hex: string; static_pub_hex: string }>;
} & Record<string, { request: Vector; result?: Vector }>;
for (const phase of [
  "initial_assignment",
  "refresh_assignment",
  "assigned_cell_registration",
  "account_credential_otp",
  "registration_completion",
]) {
  it(`matches shared Go producer wire vectors: ${phase}`, () => {
    const { request, result } = vectors[phase];
    const hex = (value: string) => Buffer.from(value, "hex");
    const keys = vectors.keys;
    const built = buildNHPMessage({
      type: request.header_type,
      devicePrivateKey: hex(keys[request.sender_key].static_priv_hex),
      serverPublicKey: hex(keys[request.receiver_key].static_pub_hex),
      ephemeralPrivateKey: hex(request.ephemeral_priv_hex),
      timestampNanos: BigInt(request.timestamp_nanos),
      counter: BigInt(request.counter),
      preamble: Number.parseInt(request.preamble_hex, 16),
      body: hex(request.body_hex),
    });
    expect(Buffer.from(built.packet).toString("hex")).toBe(request.packet_hex);
    if (result) {
      const reply = decryptNHPReply(
        hex(keys[result.receiver_key].static_priv_hex),
        hex(keys[result.sender_key].static_pub_hex),
        hex(result.packet_hex),
      );
      expect(reply.type).toBe(result.header_type);
      expect(Buffer.from(reply.body).toString("hex")).toBe(result.body_hex);
    }
  });
}
