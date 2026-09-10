import { buildNHPMessage, decryptNHPReply, type NHPMessage } from "./nhp-wire.js";
import { exchangeDatagram, resolvePublicAddresses, isSocketExchangeError } from "./native-udp.js";
import { canonicalKey, exactObject, AgentStateError, type NHPUDPEndpoint } from "./agent-state.js";
import { parseStrictJson } from "./strict-json.js";

export interface AgentExchange {
  endpoint: NHPUDPEndpoint;
  privateKey: Uint8Array;
  type: 1 | 5 | 12 | 13 | 16;
  body: Uint8Array;
  reknockBody?: Uint8Array;
  assignment?: boolean;
  signal: AbortSignal;
  beforeSend: () => void;
}
export type AgentTransport = (exchange: AgentExchange) => Promise<NHPMessage | undefined>;

export class AgentTransportError extends Error {
  constructor(options?: ErrorOptions) {
    super("native agent transport failed", options);
    this.name = "AgentTransportError";
  }
}

export const nativeAgentTransport: AgentTransport = async (input) => {
  const serverPublicKey = canonicalKey(input.endpoint.server_public_key_b64);
  const timestamp = BigInt(Date.now()) * 1_000_000n;
  const first = buildNHPMessage({
    type: input.type,
    devicePrivateKey: input.privateKey,
    serverPublicKey,
    body: input.body,
    timestampNanos: timestamp,
  });
  const send = async (packet: Uint8Array, counter: bigint, type: number, challenge = false) => {
    input.signal.throwIfAborted();
    let addresses;
    try {
      addresses = await resolvePublicAddresses(input.endpoint.host, 3, input.signal);
    } catch (cause) {
      throw new AgentTransportError({ cause });
    }
    let lastError: unknown;
    for (const address of addresses) {
      input.signal.throwIfAborted();
      input.beforeSend();
      let received: Uint8Array;
      try {
        received = await exchangeDatagram(
          address.address,
          address.family,
          input.endpoint.port,
          packet,
          3000,
          input.signal,
          type === 12,
        );
      } catch (cause) {
        if (!isSocketExchangeError(cause)) throw cause;
        lastError = cause;
        continue;
      }
      if (type === 12) return undefined;
      let reply: NHPMessage;
      try {
        reply = decryptNHPReply(input.privateKey, serverPublicKey, received);
      } finally {
        received.fill(0);
      }
      const cookieAllowed = reply.type === 7 && (type === 1 || challenge);
      const allowed = cookieAllowed || reply.type === (type === 5 ? 6 : type === 13 ? 14 : 2);
      if (
        !allowed ||
        (!cookieAllowed && reply.counter !== counter) ||
        (input.assignment && reply.flags !== 0)
      ) {
        reply.body.fill(0);
        throw new AgentStateError("INVALID_NATIVE_REPLY");
      }
      return reply;
    }
    throw new AgentTransportError({ cause: lastError });
  };
  try {
    const reply = await send(first.packet, first.counter, input.type, input.assignment);
    if (input.assignment && reply?.type !== 7) {
      reply?.body.fill(0);
      throw new AgentStateError("ASSIGNMENT_REQUIRES_SOURCE_PROOF");
    }
    if (reply?.type !== 7 || (!input.assignment && input.reknockBody === undefined)) return reply;
    let cookie: Buffer;
    try {
      const challenge = exactObject(parseStrictJson(reply.body, 4096), "trxId cookie");
      if (
        challenge.trxId !== first.counter ||
        /"cookie"\s*:\s*"[^"\n]*\\/.test(
          Buffer.from(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength).toString(),
        )
      )
        throw new AgentStateError("INVALID_COOKIE");
      cookie = canonicalKey(challenge.cookie);
    } finally {
      reply.body.fill(0);
    }
    try {
      input.signal.throwIfAborted();
      const current = BigInt(Date.now()) * 1_000_000n;
      const proof = buildNHPMessage({
        type: input.assignment ? 5 : 8,
        devicePrivateKey: input.privateKey,
        serverPublicKey,
        cookie,
        hubProof: input.assignment,
        body: input.assignment ? input.body : input.reknockBody!,
        timestampNanos: current > timestamp ? current : timestamp + 1n,
      });
      try {
        if (
          proof.counter === first.counter ||
          Buffer.from(proof.packet.subarray(24, 56)).equals(first.packet.subarray(24, 56))
        )
          throw new AgentStateError("REPEATED_PROOF_RANDOMNESS");
        return await send(proof.packet, proof.counter, input.assignment ? 5 : 8);
      } finally {
        proof.packet.fill(0);
      }
    } finally {
      cookie.fill(0);
    }
  } finally {
    first.packet.fill(0);
  }
};
