// Ported from nhp/endpoints/js-agent/src/crypto/handshake.ts + ack.ts —
// keep byte-identical.
//
// This module fuses the js-agent's `buildKnock` (handshake.ts) and
// `decryptReply` (ack.ts) into the header-type-generic pair the Go
// `relayknock/internal/nhpwire` codec exposes: `buildMessage(headerType, …)`
// and `decryptReply(…, packet)` gated to reply types. The Noise transcript is
// header-type-INDEPENDENT — only the obfuscated type field in HeaderCommon[4:8]
// differs — so KNK/OTP/REG all reuse buildKnock's exact seal ordering, and the
// NHP_RAK reply opens with ack.ts's exact transcript. Every byte-level step
// (big-endian framing, 4-zero-byte ‖ counter nonce, es→static / ss→timestamp
// seal order, ChainHash1/2/3 AADs, terminal body-key derivation) is preserved
// verbatim from the source; the only additions are the OTP/REG/RAK type gates
// and the responder-role helpers (openInitiatorMessage / buildReply) the SELF
// round-trip wire tests need — the mirrors of Go relayknocktest.
import { HashType, createChainHash, HASH_SIZE } from "./hash.js";
import { mixKey, keyGen2 } from "./kdf.js";
import { x25519PublicKey, x25519SharedSecret } from "./dh.js";
import { aeadSeal, aeadOpen } from "./aead.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import {
  HEADER_SIZE,
  PACKET_BUFFER_SIZE,
  NHP_KNK,
  NHP_OTP,
  NHP_REG,
  NHP_ACK,
  NHP_COK,
  NHP_RAK,
  NHP_RKN,
  OFF_EPHEMERAL,
  OFF_STATIC,
  OFF_TIMESTAMP,
  OFF_DIGEST,
  PUBLIC_KEY_SIZE,
  GCM_TAG_SIZE,
  TIMESTAMP_SIZE,
  MAX_SEALED_BODY_SIZE,
  PROTOCOL_VERSION_MAJOR,
  PROTOCOL_VERSION_MINOR,
  INITIAL_HASH,
  INITIAL_CHAIN_KEY,
  NHP_FLAG_COMPRESS,
  getTypeAndPayloadSize,
  getCounter,
  getFlag,
  nonceForCounter,
  setVersion,
  setCounter,
  setFlag,
  setTypeAndPayloadSize,
  headerDigest,
} from "./packet.js";

const STATIC_FIELD_SIZE = PUBLIC_KEY_SIZE + GCM_TAG_SIZE; // sealed device pubkey + tag
const TIMESTAMP_FIELD_SIZE = TIMESTAMP_SIZE + GCM_TAG_SIZE; // sealed timestamp + tag

/** Initiator header types an agent may originate (build). {@link buildMessage}
 * accepts these (plus NHP_RKN); every other type is server-originated. */
const INITIATOR_TYPES: ReadonlySet<number> = new Set([NHP_KNK, NHP_OTP, NHP_REG]);

/** Reply header types the server originates. {@link decryptReply} gates to
 * these — an authenticated packet carrying an initiator type is rejected. */
const REPLY_TYPES: ReadonlySet<number> = new Set([NHP_ACK, NHP_COK, NHP_RAK]);

/**
 * Inputs to a single NHP message. The caller owns every value the agent loop
 * would randomise/stamp at runtime — the ephemeral key, timestamp, counter, and
 * preamble — so the same inputs always produce the same bytes. That determinism
 * is what lets a cross-language fixture pin TS output and have Go decrypt it.
 */
export interface MessageInputs {
  /** Initiator (agent) static private key, 32 bytes. */
  deviceStaticPriv: Uint8Array;
  /** Responder (server) static public key, 32 bytes — the Noise `rs`. */
  serverStaticPub: Uint8Array;
  /** Per-message ephemeral private key, 32 bytes. Random in production. */
  ephemeralPriv: Uint8Array;
  /** Send time in nanoseconds (Go `time.Now().UnixNano()`), as a uint64. */
  timestampNanos: bigint;
  /** Transaction id / counter, a uint64. */
  counter: bigint;
  /** HeaderCommon obfuscation preamble, a uint32. Random in production. */
  preamble: number;
  /** Header type — KNK for a knock, OTP for a one-way OTP request, REG for a
   * registration. RKN is also accepted here for wire completeness (re-knock),
   * but the qURL registration flow never emits it. */
  headerType: number;
  /** Body payload, already serialized and **uncompressed** (the browser never
   * sets `NHP_FLAG_COMPRESS`, so the server reads the body as-is). */
  body: Uint8Array;
  /** Server-issued cookie, for the `NHP_RKN` re-knock digest only. */
  cookie?: Uint8Array;
}

/** The decrypted result of a server reply (NHP_ACK / NHP_COK / NHP_RAK). */
export interface DecryptedReply {
  /** Header type — NHP_ACK (knock result), NHP_COK (re-knock cookie), or
   * NHP_RAK (registration reply). `decryptReply` decrypts and authenticates but
   * does not dispatch; the caller branches on this type. */
  headerType: number;
  /** Header counter / transaction id. Server replies echo the outstanding
   * request's counter here, so consumers can correlate without re-parsing the
   * packet header. */
  counter: bigint;
  /** The peer static public key recovered from the packet — verified to equal
   * the expected one. On a reply this is the server's static key; the `ss`-keyed
   * opens (below) complete the authentication. */
  serverStaticPub: Uint8Array;
  /** The sender's send time, nanoseconds. */
  timestampNanos: bigint;
  /** The decrypted (and, if flagged, inflated) body — a JSON message such as
   * the registration ack, for the caller to parse by type. */
  body: Uint8Array;
}

/**
 * Inflate a Go `compress/zlib` (RFC 1950) stream via the native
 * DecompressionStream — `"deflate"` is the zlib-wrapped format, matching Go's
 * `zlib.Writer`. No zlib dependency; async because the Web API streams.
 *
 * No explicit *output* cap (Go uses `MaxDecompressedBodySize`), but the input is
 * doubly contained: the `PACKET_BUFFER_SIZE` guard bounds these bytes (mirroring
 * Go's `PacketBufferSize` transport cap), and the body is inflated only *after*
 * its AEAD tag verifies under a key derived from the sender's proven static key
 * — so the input is both size-bounded and in-TCB (the exact peer this agent
 * messaged), not attacker-chosen. A bomb would require that peer to attack its
 * own counterpart, from ≤ one buffer of input.
 */
async function inflateZlib(compressed: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view: the AEAD output may alias a
  // larger/shared buffer, which BlobPart's type rejects. The body is tiny.
  const stream = new Blob([new Uint8Array(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The role-symmetric NHP handshake BUILD, identical in seal ordering to the
 * js-agent `buildKnock`. The header type is a plain parameter — the digest is
 * computed AFTER the type is stamped, so it cannot be swapped post-build. Both
 * {@link buildMessage} (initiator types) and {@link buildReply} (reply types)
 * gate the type and then delegate here, so there is a single byte-exact
 * transcript. `deviceStaticPriv`/`serverStaticPub` are named from the initiator
 * perspective; the responder-role {@link buildReply} passes the server private
 * key and agent public key here with the roles swapped.
 *
 * The Identity field (offset 56–135) is left as 80 zero bytes — the knock path
 * never seals it, and the responder ignores it (it's only covered by the header
 * digest, computed over those same zeros here).
 */
function buildTranscript(inp: MessageInputs): Uint8Array {
  // Fixed cipher suite — the server's default CIPHER_SCHEME_CURVE: X25519 (DH),
  // AES-256-GCM (aeadSeal), BLAKE2s (T). The message carries no suite selector,
  // so this must match the server's default; a server configured for the
  // alternate ChaCha20-Poly1305 GcmType would fail to open these seals.
  const T = HashType.BLAKE2S;
  // One nonce per packet: 4 zero bytes ‖ counter. Each seal below uses it under
  // a *distinct* derived key, so there is no AES-GCM nonce reuse.
  const nonce = nonceForCounter(inp.counter);

  const ephemeralPub = x25519PublicKey(inp.ephemeralPriv);
  const ownStaticPub = x25519PublicKey(inp.deviceStaticPriv);

  const header = new Uint8Array(HEADER_SIZE);
  header.set(ephemeralPub, OFF_EPHEMERAL); // -> e

  // ChainHash0 / ChainKey0 from the two NHP init constants.
  const chainHash = createChainHash(T);
  chainHash.update(INITIAL_HASH);
  let chainKey = mixKey(T, chainHash.sum(), INITIAL_CHAIN_KEY);

  // Fold in rs and e: ChainHash0 -> ChainHash1, ChainKey0 -> ChainKey1.
  chainHash.update(inp.serverStaticPub);
  chainHash.update(ephemeralPub);
  chainKey = mixKey(T, chainKey, ephemeralPub);

  // es = DH(e, rs): derive the static-encryption key and seal the own static
  // pubkey. AAD is ChainHash1; the ciphertext then evolves ChainHash1 -> ChainHash2.
  const ess = x25519SharedSecret(inp.ephemeralPriv, inp.serverStaticPub);
  let aeadKey: Uint8Array;
  [chainKey, aeadKey] = keyGen2(T, chainKey, ess);
  const sealedStatic = aeadSeal(aeadKey, nonce, ownStaticPub, chainHash.sum());
  header.set(sealedStatic, OFF_STATIC);
  chainHash.update(sealedStatic);

  // ss = DH(s, rs): derive the timestamp key and seal the send time.
  // AAD is ChainHash2; the ciphertext then evolves ChainHash2 -> ChainHash3.
  const ss = x25519SharedSecret(inp.deviceStaticPriv, inp.serverStaticPub);
  [chainKey, aeadKey] = keyGen2(T, chainKey, ss);
  const tsBytes = new Uint8Array(TIMESTAMP_SIZE);
  new DataView(tsBytes.buffer).setBigUint64(0, inp.timestampNanos, false);
  const sealedTs = aeadSeal(aeadKey, nonce, tsBytes, chainHash.sum());
  header.set(sealedTs, OFF_TIMESTAMP);
  chainHash.update(sealedTs);

  // Body AAD is ChainHash3 (captured before the final key derivation, which does
  // not touch the chain hash). Then derive the body key from the ts ciphertext;
  // this is the terminal derivation, so the evolved chain key is discarded
  // (unlike the es/ss steps above, whose chain key feeds the next KeyGen2).
  const bodyAad = chainHash.sum();
  [, aeadKey] = keyGen2(T, chainKey, sealedTs);
  // Empty body: skip the seal entirely (payload size 0), matching Go encryptBody.
  const sealedBody =
    inp.body.length === 0 ? new Uint8Array(0) : aeadSeal(aeadKey, nonce, inp.body, bodyAad);
  if (sealedBody.length > MAX_SEALED_BODY_SIZE) {
    // Fail loud rather than emit a packet the server's fixed buffer rejects.
    throw new Error(
      `message body too large: sealed ${sealedBody.length} bytes exceeds the ${MAX_SEALED_BODY_SIZE}-byte limit`,
    );
  }

  // HeaderCommon — all of it must be set before the digest, which covers
  // header[0:208]. Flag is 0: uncompressed, no extended length.
  setVersion(header, PROTOCOL_VERSION_MAJOR, PROTOCOL_VERSION_MINOR);
  setCounter(header, inp.counter);
  setFlag(header, 0);
  setTypeAndPayloadSize(header, inp.headerType, sealedBody.length, inp.preamble);

  // Unkeyed header digest over header[0:208] (+ cookie for NHP_RKN).
  header.set(headerDigest(inp.serverStaticPub, header, inp.cookie), OFF_DIGEST);

  const packet = new Uint8Array(HEADER_SIZE + sealedBody.length);
  packet.set(header, 0);
  packet.set(sealedBody, HEADER_SIZE);
  return packet;
}

/**
 * The role-symmetric NHP handshake OPEN, identical to the js-agent `decryptReply`
 * transcript. Verifies the header digest, opens the static field (pinning the
 * peer), opens the timestamp (the `ss`-keyed tag AUTHENTICATES the sender — only
 * the real peer's static private key yields a valid tag), then opens the body.
 * Returns the decoded fields WITHOUT gating the header type; {@link decryptReply}
 * (reply-type gate) and {@link openInitiatorMessage} (initiator-type gate) layer
 * their type gate on top, so there is a single byte-exact open.
 *
 * `ownPriv` is this side's static private key; `expectedPeerStaticPub` is the
 * peer static key the caller expects.
 */
async function openTranscript(
  ownPriv: Uint8Array,
  expectedPeerStaticPub: Uint8Array,
  packet: Uint8Array,
): Promise<DecryptedReply> {
  if (packet.length < HEADER_SIZE) {
    throw new Error(`message too short: ${packet.length} bytes < ${HEADER_SIZE}-byte header`);
  }
  // Upper bound mirrors Go's structural cap — the server reads packets into a
  // fixed `[PacketBufferSize]byte` (device.go), so nothing valid exceeds it.
  // Bounding the input here (before any DH/AEAD work) also bounds the body the
  // AEAD opens and the bytes `inflateZlib` can be handed, closing a
  // CPU/memory-amplification path with a single comparison.
  if (packet.length > PACKET_BUFFER_SIZE) {
    throw new Error(`message too long: ${packet.length} bytes > ${PACKET_BUFFER_SIZE}-byte buffer`);
  }
  const header = packet.subarray(0, HEADER_SIZE);
  const sealedBody = packet.subarray(HEADER_SIZE);
  const T = HashType.BLAKE2S;

  // This side's own static pubkey is the responder static that the header digest
  // and ChainHash1 bind (the sender's RemotePubKey when it built the message).
  const ownPub = x25519PublicKey(ownPriv);
  if (
    !equalBytes(headerDigest(ownPub, header), header.subarray(OFF_DIGEST, OFF_DIGEST + HASH_SIZE))
  ) {
    throw new Error("message header digest mismatch (tampered, or wrong key)");
  }

  const counter = getCounter(header);
  const nonce = nonceForCounter(counter);
  const peerEph = header.subarray(OFF_EPHEMERAL, OFF_EPHEMERAL + PUBLIC_KEY_SIZE);
  const staticField = header.subarray(OFF_STATIC, OFF_STATIC + STATIC_FIELD_SIZE);
  const tsField = header.subarray(OFF_TIMESTAMP, OFF_TIMESTAMP + TIMESTAMP_FIELD_SIZE);

  // ChainHash0/ChainKey0, then fold ownPub + peerEph → ChainHash1/ChainKey1.
  const chainHash = createChainHash(T);
  chainHash.update(INITIAL_HASH);
  let chainKey = mixKey(T, chainHash.sum(), INITIAL_CHAIN_KEY);
  chainHash.update(ownPub);
  chainHash.update(peerEph);
  chainKey = mixKey(T, chainKey, peerEph);

  // es = DH(ownPriv, peerEph): open the peer's static key (AAD = ChainHash1).
  let aeadKey: Uint8Array;
  [chainKey, aeadKey] = keyGen2(T, chainKey, x25519SharedSecret(ownPriv, peerEph));
  const peerStaticPub = aeadOpen(aeadKey, nonce, staticField, chainHash.sum());
  // Pins the peer identity — necessary but not the authenticator (see doc): the
  // ss-keyed open below is what proves possession of the peer's static key.
  if (!equalBytes(peerStaticPub, expectedPeerStaticPub)) {
    throw new Error("message from an unexpected peer (static key mismatch)");
  }
  chainHash.update(staticField);

  // ss = DH(ownPriv, peerStatic): only the real peer can derive this, so a valid
  // open here authenticates the sender. Opens the timestamp (AAD = ChainHash2).
  [chainKey, aeadKey] = keyGen2(T, chainKey, x25519SharedSecret(ownPriv, peerStaticPub));
  const tsBytes = aeadOpen(aeadKey, nonce, tsField, chainHash.sum());
  const timestampNanos = new DataView(
    tsBytes.buffer,
    tsBytes.byteOffset,
    tsBytes.byteLength,
  ).getBigUint64(0, false);
  chainHash.update(tsField);

  // Body AAD = ChainHash3; the body key derives from the timestamp ciphertext.
  const bodyAad = chainHash.sum();
  const bodyKey = keyGen2(T, chainKey, tsField)[1];
  let body =
    sealedBody.length === 0 ? new Uint8Array(0) : aeadOpen(bodyKey, nonce, sealedBody, bodyAad);

  if (body.length > 0 && (getFlag(header) & NHP_FLAG_COMPRESS) !== 0) {
    body = await inflateZlib(body);
  }

  return {
    headerType: getTypeAndPayloadSize(header).type,
    counter,
    serverStaticPub: peerStaticPub,
    timestampNanos,
    body,
  };
}

/**
 * Builds a complete NHP packet (240-byte header ‖ sealed body) of the given
 * initiator header type — KNK/OTP/REG (or RKN for a re-knock) — that the Go
 * `nhp/core` responder decrypts. It is the generalization of the js-agent's
 * `buildKnock` over the header type: the Noise transcript is identical for every
 * type (only the obfuscated type field differs), so OTP/REG reuse the exact
 * knock transcript with a different header type + body. Mirrors Go
 * `relayknock.BuildMessage`.
 */
export function buildMessage(inp: MessageInputs): Uint8Array {
  // Only initiator header types are valid here — an agent never builds a reply
  // type. Fail loud on a miswire, mirroring relayknock.BuildMessage's gate.
  if (!INITIATOR_TYPES.has(inp.headerType) && inp.headerType !== NHP_RKN) {
    throw new Error(
      `unsupported initiator header type ${inp.headerType}: expected NHP_KNK, NHP_OTP, or NHP_REG`,
    );
  }
  // The server folds a cookie into the digest iff NHP_RKN (addHeaderDigest), so a
  // type/cookie mismatch here produces a digest it silently rejects. Catch it at
  // the source rather than as an opaque server-side rejection.
  if (inp.headerType === NHP_RKN && inp.cookie === undefined) {
    throw new Error("NHP_RKN re-knock requires a cookie");
  }
  if (inp.headerType !== NHP_RKN && inp.cookie !== undefined) {
    throw new Error("only NHP_RKN takes a cookie");
  }
  return buildTranscript(inp);
}

/**
 * Decrypts a server reply to an initiator message (the NHP_ACK / NHP_COK the
 * relay returns to a knock, or the NHP_RAK it returns to a registration) against
 * the static key of the server this agent messaged. It is the generalization of
 * the js-agent's `decryptReply` over the reply type: the transcript does not
 * depend on the header type, so NHP_RAK opens identically to NHP_ACK; only the
 * final type gate widens to admit it. Mirrors Go `relayknock.DecryptReply`.
 *
 * Throws if the header digest, either header AEAD tag, the server-key check, a
 * present body AEAD tag, or the reply-type gate fails. A zero-length body carries
 * no body tag to open; callers decide whether that is valid for the reply type.
 */
export async function decryptReply(
  devicePriv: Uint8Array,
  expectedServerStaticPub: Uint8Array,
  packet: Uint8Array,
): Promise<DecryptedReply> {
  const opened = await openTranscript(devicePriv, expectedServerStaticPub, packet);
  // The type field rides outside the AEAD, so a garbage/initiator type decrypts
  // fine — gate to reply types explicitly instead of returning a reply no caller
  // predicate matches (mirrors relayknock.DecryptReply's reply-only gate).
  if (!REPLY_TYPES.has(opened.headerType)) {
    throw new Error(`not a server reply: header type ${opened.headerType} is initiator-only`);
  }
  return opened;
}

// --- responder-role helpers (test support; mirrors Go relayknocktest) ---
//
// openInitiatorMessage / buildReply are the server/responder-role mirrors of the
// agent API above. An SDK never opens an initiator packet or builds a reply, so
// these are NOT a production path — they exist so the SELF round-trip wire tests
// can build an OTP/REG packet, open it back in the responder role, fabricate an
// NHP_RAK, and open THAT with decryptReply, exercising the wire now without the
// deferred conformance byte-fence (layervai/qurl-typescript#176). They are the
// counterparts of Go relayknocktest.OpenInitiatorMessage / BuildReply.

/**
 * Responder-role open of an initiator packet (NHP_KNK / NHP_OTP / NHP_REG). It
 * is the mirror of {@link decryptReply}, splitting the same role-symmetric
 * transcript by which header types each admits. `serverPriv` is the responder
 * (server) static private key; `expectedDevicePub` is the initiator (agent)
 * static public key the caller expects.
 */
export async function openInitiatorMessage(
  serverPriv: Uint8Array,
  expectedDevicePub: Uint8Array,
  packet: Uint8Array,
): Promise<DecryptedReply> {
  const opened = await openTranscript(serverPriv, expectedDevicePub, packet);
  if (!INITIATOR_TYPES.has(opened.headerType)) {
    throw new Error(`not an initiator message: header type ${opened.headerType} is reply-only`);
  }
  return opened;
}

/**
 * Responder-role BUILD of a server-originated reply (NHP_ACK / NHP_COK /
 * NHP_RAK). The transcript is role-symmetric, so this reuses {@link
 * buildTranscript} with the roles swapped: `deviceStaticPriv` must be the SERVER
 * static private key and `serverStaticPub` the AGENT (initiator) static public
 * key, and `counter` must echo the request being answered. Mirrors Go
 * `relayknocktest.BuildReply`.
 */
export function buildReply(inp: MessageInputs): Uint8Array {
  if (!REPLY_TYPES.has(inp.headerType)) {
    throw new Error(
      `unsupported reply header type ${inp.headerType}: expected NHP_ACK, NHP_COK, or NHP_RAK`,
    );
  }
  if (inp.cookie !== undefined) {
    throw new Error("a reply takes no cookie");
  }
  return buildTranscript(inp);
}
