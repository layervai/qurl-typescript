// Ported from nhp/endpoints/js-agent/src/crypto/packet.ts — keep byte-identical.
//
// Divergence from the js-agent source: this port ADDS the agent-registration
// message types NHP_OTP (12), NHP_REG (13), and NHP_RAK (14). They match the
// Go `nhpwire` iota (`relayknock/internal/nhpwire/packet.go`) exactly. Nothing
// else changes — the header framing, offsets, digest, and nonce derivation are
// header-type-independent, so the same layout carries every message type.
import { HashType, hash, HASH_SIZE } from "./hash.js";

// NHP knock packet wire format — mirrors Go `nhp/core/scheme/curve/header.go`
// (`HeaderCurve`), `nhp/core/packet.go`, and `nhp/core/constants.go`. The
// browser must lay these bytes out exactly as the Go server expects, so every
// constant and offset here is pinned to the Go source.

export const PUBLIC_KEY_SIZE = 32;
export const GCM_NONCE_SIZE = 12;
export const GCM_TAG_SIZE = 16;
export const TIMESTAMP_SIZE = 8;
/** Server-issued cookie size (`nhp/core/constants.go` `CookieSize`), folded into
 * the NHP_RKN re-knock header digest. */
export const COOKIE_SIZE = 32;

const HEADER_COMMON_SIZE = 24;
const MAX_IDENTITY_SIZE = 64;

// Field offsets within the 240-byte HeaderCurve. Each field after the common
// header is `plaintext + GCM tag` for the sealed ones.
export const OFF_HEADER_COMMON = 0;
export const OFF_EPHEMERAL = HEADER_COMMON_SIZE; // 24
export const OFF_IDENTITY = OFF_EPHEMERAL + PUBLIC_KEY_SIZE; // 56
export const OFF_STATIC = OFF_IDENTITY + MAX_IDENTITY_SIZE + GCM_TAG_SIZE; // 136
export const OFF_TIMESTAMP = OFF_STATIC + PUBLIC_KEY_SIZE + GCM_TAG_SIZE; // 184
export const OFF_DIGEST = OFF_TIMESTAMP + TIMESTAMP_SIZE + GCM_TAG_SIZE; // 208
export const HEADER_SIZE = OFF_DIGEST + HASH_SIZE; // 240

// The server decrypts into a fixed PacketBufferSize buffer (`nhp/core/constants.go`).
export const PACKET_BUFFER_SIZE = 4096;

// Maximum sealed-body payload: the body+tag must fit the server's packet buffer
// alongside the 240-byte header — the exact bound Go enforces in encryptBody
// (`BodySize > PacketBufferSize - header.Size()`). This (3856) is tighter than
// the 16-bit HeaderCommon size field (0xffff), which the browser also can't
// exceed since it never sets NHP_FLAG_EXTENDEDLENGTH.
//
// This bounds the SEALED size (plaintext + 16-byte tag), so the largest
// plaintext body a caller can pass is `MAX_SEALED_BODY_SIZE - GCM_TAG_SIZE`.
export const MAX_SEALED_BODY_SIZE = PACKET_BUFFER_SIZE - HEADER_SIZE;

// Header types (`nhp/core/packet.go` iota: KPL=0, KNK=1, ACK=2, …, COK=7, RKN=8).
export const NHP_KNK = 1;
export const NHP_ACK = 2; // server → agent: knock result
export const NHP_COK = 7; // server → agent: re-knock cookie
export const NHP_RKN = 8;

// Agent-registration message types (`relayknock/internal/nhpwire/packet.go`).
// These extend the base knock types above for the NHP-native RegisterAgent flow.
export const NHP_OTP = 12; // agent → server: one-way OTP request (no reply)
export const NHP_REG = 13; // agent → server: registration
export const NHP_RAK = 14; // server → agent: registration reply

// Header flags (`nhp/common/packet.go`): EXTENDEDLENGTH = 1<<0, COMPRESS = 1<<1.
// The browser sends bodies uncompressed, so it never sets COMPRESS — it's here
// for completeness / decoding.
export const NHP_FLAG_COMPRESS = 1 << 1;

export const PROTOCOL_VERSION_MAJOR = 1;
export const PROTOCOL_VERSION_MINOR = 0;

// Noise init constants (`nhp/core/constants.go`) — the literal UTF-8 bytes.
export const INITIAL_HASH = new TextEncoder().encode("NHP hashgen v.20230421@deepcloudsdp.com");
export const INITIAL_CHAIN_KEY = new TextEncoder().encode("NHP keygen v.20230421@clouddeep.cn");

function headerView(header: Uint8Array): DataView {
  return new DataView(header.buffer, header.byteOffset, header.byteLength);
}

/**
 * Write the obfuscated type + payload size into HeaderCommon[0:8]:
 * `[0:4] = preamble`, `[4:8] = (type<<16 | size) XOR preamble`, both big-endian.
 * Mirrors Go `HeaderCurve.SetTypeAndPayloadSize` — except the random preamble is
 * a parameter here so the caller owns it (random in production, fixed in tests).
 */
export function setTypeAndPayloadSize(
  header: Uint8Array,
  type: number,
  size: number,
  preamble: number,
): void {
  const dv = headerView(header);
  const tns = (preamble ^ (((type & 0xffff) << 16) | (size & 0xffff))) >>> 0;
  dv.setUint32(0, preamble >>> 0, false);
  dv.setUint32(4, tns, false);
}

/** Decode the type + payload size written by {@link setTypeAndPayloadSize}. */
export function getTypeAndPayloadSize(header: Uint8Array): {
  type: number;
  size: number;
} {
  const dv = headerView(header);
  const preamble = dv.getUint32(0, false);
  const tns = (preamble ^ dv.getUint32(4, false)) >>> 0;
  return { type: (tns >>> 16) & 0xffff, size: tns & 0xffff };
}

/** HeaderCommon[8] = major, [9] = minor. Mirrors `HeaderCurve.SetVersion`. */
export function setVersion(header: Uint8Array, major: number, minor: number): void {
  header[8] = major & 0xff;
  header[9] = minor & 0xff;
}

/**
 * HeaderCommon[10:12] = flag (big-endian), after stripping EXTENDEDLENGTH and
 * masking to 12 bits — mirrors `HeaderCurve.SetFlag`.
 */
export function setFlag(header: Uint8Array, flag: number): void {
  const masked = flag & ~(1 << 0) & 0x0fff;
  headerView(header).setUint16(10, masked, false);
}

/** Read the flag bits at HeaderCommon[10:12] — e.g. to test NHP_FLAG_COMPRESS on
 * a received packet. Returns the raw uint16, mirroring Go `HeaderCurve.Flag()`
 * (also unmasked); the value is ≤ 12 bits because `SetFlag` masks `0x0fff` on
 * write, and the upper nibble is unused (the cipher scheme is a separate hardcoded
 * constant — Go's `CipherScheme()` — not stored in these bits). */
export function getFlag(header: Uint8Array): number {
  return headerView(header).getUint16(10, false);
}

/** HeaderCommon[16:24] = counter (big-endian uint64). `HeaderCurve.SetCounter`. */
export function setCounter(header: Uint8Array, counter: bigint): void {
  headerView(header).setBigUint64(16, counter, false);
}

/** Read the counter written by {@link setCounter}. */
export function getCounter(header: Uint8Array): bigint {
  return headerView(header).getBigUint64(16, false);
}

/**
 * The 12-byte GCM nonce for a packet: 4 zero bytes followed by the 8-byte
 * big-endian counter. Mirrors `HeaderCurve.NonceBytes` (which copies
 * HeaderCommon[16:24] into nonce[4:12]). The same nonce is used for every seal
 * in one packet, each under a *distinct* derived key — safe per AES-GCM.
 */
export function nonceForCounter(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(GCM_NONCE_SIZE);
  new DataView(nonce.buffer).setBigUint64(4, counter, false);
  return nonce;
}

/**
 * The unkeyed header digest: `BLAKE2s(INITIAL_HASH ‖ serverPubKey ‖
 * header[0:OFF_DIGEST] [‖ cookie])`. Mirrors Go `addHeaderDigest` /
 * `checkHeaderDigest`.
 *
 * NOT an authenticator — all inputs are public (and the NHP_RKN cookie is
 * server-issued and on-path-observable), so a passing digest proves header
 * integrity, not peer identity. Real authentication is the AEAD-sealed static
 * key the responder opens and looks up. Same caveat as the Go side
 * (`scheme/curve/header.go`).
 */
export function headerDigest(
  serverPubKey: Uint8Array,
  header: Uint8Array,
  cookie?: Uint8Array,
): Uint8Array {
  const prefix = header.subarray(0, OFF_DIGEST);
  return cookie === undefined
    ? hash(HashType.BLAKE2S, INITIAL_HASH, serverPubKey, prefix)
    : hash(HashType.BLAKE2S, INITIAL_HASH, serverPubKey, prefix, cookie);
}
