import { fingerprintKey } from "./deployment.js";
import {
  buildNHPMessage,
  decryptNHPReply,
  NHP_PACKET_SIZE,
  NHP_TYPE_KNOCK,
  NHP_TYPE_ACK,
  NHP_TYPE_COOKIE,
  type NHPMessage,
} from "./nhp-wire.js";

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelayError";
  }
}

/** Call only after verifying the issuer signature over the relay URL. */
export function validateRelayURL(value: string, allowlist: readonly string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname ||
    !allowlist.some((entry) => {
      const host = entry.trim().toLowerCase();
      return (
        host === url.host.toLowerCase() ||
        host === url.hostname.toLowerCase() ||
        (url.port === "" && host === `${url.hostname.toLowerCase()}:443`)
      );
    })
  )
    throw new Error("qURL relay URL is not permitted by deployment trust");
  if (url.search || url.hash)
    throw new Error("qURL relay base URL must not contain a query or fragment");
  return url;
}

export async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) throw new Error("qURL HTTP response exceeds its size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function relayKnock(
  relayURL: string,
  allowlist: readonly string[],
  serverPublicKey: Uint8Array,
  devicePrivateKey: Uint8Array,
  body: Uint8Array,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<NHPMessage> {
  const base = validateRelayURL(relayURL, allowlist);
  options.signal?.throwIfAborted();
  const built = buildNHPMessage({ type: NHP_TYPE_KNOCK, serverPublicKey, devicePrivateKey, body });
  let packet: Uint8Array | undefined;
  try {
    const url = `${base.href.replace(/\/+$/, "")}/relay/${fingerprintKey(serverPublicKey)}`;
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(built.packet),
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new RelayError(0, "qURL relay transport failed", { cause });
    }
    packet = await readBoundedBody(response, NHP_PACKET_SIZE);
    if (response.status !== 200)
      throw new RelayError(response.status, "qURL relay returned an unexpected HTTP status");
    const reply = decryptNHPReply(devicePrivateKey, serverPublicKey, packet);
    if (reply.type === NHP_TYPE_COOKIE) return reply;
    if (reply.type !== NHP_TYPE_ACK || reply.counter !== built.counter) {
      reply.body.fill(0);
      throw new Error("NHP relay reply does not match the request");
    }
    return reply;
  } finally {
    built.packet.fill(0);
    packet?.fill(0);
  }
}
