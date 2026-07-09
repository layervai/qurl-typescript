// Relay transport for the NHP registration flow — mirrors the Go
// `relayknock` Exchange/Send orchestrators (`qurl-go/relayknock/relay.go`).
//
// The relay HTTP contract (the reference NHP relay's handleRelay endpoint): POST
// the raw packet as application/octet-stream to `{relayBaseURL}/relay/{serverId}`,
// where `serverId = pubKeyFingerprint(serverStaticPub)`.
//   - Round-trip (NHP_REG): 200 → the server's reply packet bytes to decrypt.
//   - One-way (NHP_OTP): the server never replies; a conforming relay
//     acknowledges dispatch at the HTTP layer with 202 Accepted and an empty
//     body. Anything else is a transport fault.
//
// This is intentionally minimal relative to the qURL knock path (relayknock also
// carries NHP_KNK): the RegisterAgent engine only ever sends NHP_OTP (Send) and
// NHP_REG (Exchange), so only those two are exposed here.
import { buildMessage, decryptReply, type DecryptedReply, type MessageInputs } from "./message.js";
import { pubKeyFingerprint } from "./fingerprint.js";
import { NHP_OTP, NHP_REG, PUBLIC_KEY_SIZE, PACKET_BUFFER_SIZE } from "./packet.js";

/** A relay POST that failed the HTTP-layer contract — a transport fault distinct
 * from an authenticated server *deny* (which arrives inside a decryptable reply).
 * `status` is the HTTP status, or 0 for a transport-level failure with no HTTP
 * response. Mirrors Go `relayknock.RelayError`. */
export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/** Options for {@link exchange} / {@link send}. */
export interface RelayOptions {
  /** The agent static private key (the Noise initiator identity), 32 bytes. */
  deviceStaticPriv: Uint8Array;
  /** fetch implementation. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Undefined ⇒ no SDK-imposed timeout (the caller's
   * fetch/AbortSignal governs). */
  timeoutMs?: number;
  /** Cryptographically-strong random bytes source, injectable for deterministic
   * tests. Defaults to `globalThis.crypto.getRandomValues`. */
  randomBytes?: (n: number) => Uint8Array;
  /** Wall-clock nanoseconds source for the message timestamp, injectable for
   * tests. Defaults to `Date.now()*1e6`. */
  nowNanos?: () => bigint;
}

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  throw new Error("globalThis.crypto.getRandomValues is required to build an NHP message");
}

function defaultNowNanos(): bigint {
  // Date.now() is millisecond-granular; scale to nanoseconds to match Go's
  // time.Now().UnixNano() field width. The server does not gate the agent on
  // this timestamp's precision (it is sealed, not a freshness check the agent
  // must pass), so millisecond granularity is fine.
  return BigInt(Date.now()) * 1_000_000n;
}

function randUint64(rand: (n: number) => Uint8Array): bigint {
  const b = rand(8);
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, false);
}

function randUint32(rand: (n: number) => Uint8Array): number {
  const b = rand(4);
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
}

/** Builds a headerType packet for `body`, minting the per-message random values
 * (ephemeral key, counter, preamble). Returns the packet and the minted counter
 * (a round-trip caller requires the reply to echo it). Mirrors Go `buildOutbound`. */
function buildOutbound(
  headerType: number,
  serverStaticPub: Uint8Array,
  body: Uint8Array,
  opts: RelayOptions,
): { packet: Uint8Array; counter: bigint } {
  if (serverStaticPub.length !== PUBLIC_KEY_SIZE) {
    throw new RelayError(
      0,
      `server static pub must be ${PUBLIC_KEY_SIZE} bytes, got ${serverStaticPub.length}`,
    );
  }
  if (opts.deviceStaticPriv.length !== 32) {
    throw new RelayError(
      0,
      `device static priv must be 32 bytes, got ${opts.deviceStaticPriv.length}`,
    );
  }
  const rand = opts.randomBytes ?? defaultRandomBytes;
  const now = opts.nowNanos ?? defaultNowNanos;
  const counter = randUint64(rand);
  const inputs: MessageInputs = {
    deviceStaticPriv: opts.deviceStaticPriv,
    serverStaticPub,
    ephemeralPriv: rand(32),
    timestampNanos: now(),
    counter,
    preamble: randUint32(rand),
    headerType,
    body,
  };
  return { packet: buildMessage(inputs), counter };
}

/** Delivers one packet to `{relayBaseURL}/relay/{serverId}` and returns the HTTP
 * status and (bounded) response body, leaving status interpretation to the
 * caller. Mirrors Go `relayDo`. */
async function relayDo(
  relayBaseURL: string,
  serverID: string,
  packet: Uint8Array,
  opts: RelayOptions,
): Promise<{ status: number; body: Uint8Array; url: string }> {
  const base = relayBaseURL.replace(/\/+$/, "");
  const url = `${base}/relay/${serverID}`;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      // Copy into a fresh ArrayBuffer-backed view so BodyInit accepts it even if
      // `packet` aliases a larger/shared buffer.
      body: new Uint8Array(packet),
      signal:
        opts.timeoutMs !== undefined && opts.timeoutMs > 0
          ? AbortSignal.timeout(opts.timeoutMs)
          : undefined,
    });
  } catch (err) {
    throw new RelayError(0, `relay POST ${url} failed: ${errText(err)}`, { cause: err });
  }

  let raw: ArrayBuffer;
  try {
    raw = await response.arrayBuffer();
  } catch (err) {
    throw new RelayError(response.status, `relay POST ${url}: read reply: ${errText(err)}`, {
      cause: err,
    });
  }
  let body = new Uint8Array(raw);
  // Bound the body like Go's io.LimitReader(PacketBufferSize): nothing valid the
  // relay returns exceeds one packet buffer, and this caps what decryptReply /
  // inflate must handle.
  if (body.length > PACKET_BUFFER_SIZE) {
    body = body.subarray(0, PACKET_BUFFER_SIZE);
  }
  return { status: response.status, body, url };
}

/**
 * Performs one NHP request/reply round trip for a registration: builds an
 * NHP_REG packet for `body`, POSTs it to the relay, then decrypts and
 * authenticates the reply against `serverStaticPub`. 200 → the decrypted reply;
 * any other status → a {@link RelayError}. The reply's cleartext counter must
 * echo this request's counter (the relay's correlation contract); a mismatch is
 * a plain Error, not a RelayError, since it is a correlation failure of an
 * already-authenticated reply. Mirrors Go `relayknock.Exchange` fixed to
 * TypeRegister.
 */
export async function exchangeRegister(
  relayBaseURL: string,
  serverStaticPub: Uint8Array,
  body: Uint8Array,
  opts: RelayOptions,
): Promise<DecryptedReply> {
  const { packet, counter } = buildOutbound(NHP_REG, serverStaticPub, body, opts);
  const serverID = pubKeyFingerprint(serverStaticPub);
  const { status, body: replyBytes, url } = await relayDo(relayBaseURL, serverID, packet, opts);
  if (status !== HTTP_OK) {
    throw new RelayError(status, relayStatusMessage(url, status, replyBytes));
  }
  const reply = await decryptReply(opts.deviceStaticPriv, serverStaticPub, replyBytes);
  if (reply.counter !== counter) {
    throw new Error(`reply counter ${reply.counter} does not echo request counter ${counter}`);
  }
  return reply;
}

/**
 * Performs one one-way NHP dispatch: builds an NHP_OTP packet for `body`, POSTs
 * it to the relay. The server does not reply, so there are no reply bytes to
 * decrypt; a conforming relay acknowledges the dispatch with 202 Accepted and an
 * empty body, and that acknowledgement is exactly what this verifies. Anything
 * else — a non-202 status, or a 202 carrying a body — throws a {@link
 * RelayError}. Mirrors Go `relayknock.Send`. Every send mints fresh randomness,
 * so a retried send is a new, independent dispatch (at-least-once delivery).
 */
export async function sendOTP(
  relayBaseURL: string,
  serverStaticPub: Uint8Array,
  body: Uint8Array,
  opts: RelayOptions,
): Promise<void> {
  const { packet } = buildOutbound(NHP_OTP, serverStaticPub, body, opts);
  const serverID = pubKeyFingerprint(serverStaticPub);
  const { status, body: respBody, url } = await relayDo(relayBaseURL, serverID, packet, opts);
  if (status !== HTTP_ACCEPTED) {
    if (status === HTTP_OK && respBody.length > 0) {
      throw new RelayError(
        status,
        `relay POST ${url} -> 200 with a ${respBody.length}-byte reply to a one-way NHP_OTP (a conforming relay acknowledges dispatch with 202 Accepted); the server likely processed the dispatch; a retry may deliver a duplicate — one-way NHP_OTP delivery is at-least-once`,
      );
    }
    let m = `relay POST ${url} -> ${status}, want 202 Accepted for a one-way NHP_OTP dispatch`;
    const detail = textBody(respBody).trim();
    if (detail !== "") {
      m += `: ${detail}`;
    }
    throw new RelayError(status, `${m}; dispatch unconfirmed — safe to retry the send`);
  }
  if (respBody.length > 0) {
    throw new RelayError(
      status,
      `relay POST ${url} -> 202 Accepted with an unexpected ${respBody.length}-byte body (a conforming relay acknowledges a one-way dispatch with an empty body); a retry may deliver a duplicate — one-way NHP_OTP delivery is at-least-once`,
    );
  }
}

/** Builds the RelayError message for a non-200 round-trip status, quoting the
 * relay-authored plaintext body when present (Go RelayPost quotes it likewise —
 * a non-200 body is relay error detail, never packet bytes). */
function relayStatusMessage(url: string, status: number, body: Uint8Array): string {
  let m = `relay POST ${url} -> ${status}`;
  const detail = textBody(body).trim();
  if (detail !== "") {
    m += `: ${detail}`;
  }
  return m;
}

function textBody(body: Uint8Array): string {
  try {
    return new TextDecoder().decode(body);
  } catch {
    return "";
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
