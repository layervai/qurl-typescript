// Vendored NHP wire crypto for the qURL TypeScript SDK.
//
// Ported from the private, unpublished nhp/endpoints/js-agent monorepo package
// (vendored, not depended on — see the per-file `// Ported from … — keep
// byte-identical` headers). Byte-compatible with the Go `qurl-go/relayknock`
// and `relayknock/internal/nhpwire` codecs by construction: X25519 (DH),
// AES-256-GCM (AEAD), BLAKE2s (hash/KDF), the fixed 240-byte NHP HeaderCurve,
// and the role-symmetric Noise IK handshake transcript.
//
// This is a low-level layer. Application code uses `registerAgent`; reach in
// here only to build/decrypt raw NHP messages outside that flow.

export { HashType, HASH_SIZE } from "./hash.js";
export {
  NHP_KNK,
  NHP_ACK,
  NHP_COK,
  NHP_RKN,
  NHP_OTP,
  NHP_REG,
  NHP_RAK,
  HEADER_SIZE,
  PACKET_BUFFER_SIZE,
} from "./packet.js";
export { pubKeyFingerprint, PUBKEY_FINGERPRINT_LEN } from "./fingerprint.js";
export {
  buildMessage,
  decryptReply,
  openInitiatorMessage,
  buildReply,
  type MessageInputs,
  type DecryptedReply,
} from "./message.js";
export { exchangeRegister, sendOTP, RelayError, type RelayOptions } from "./relay.js";
