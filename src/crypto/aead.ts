// Ported from nhp/endpoints/js-agent/src/crypto/aead.ts — keep byte-identical.
import { gcm } from "@noble/ciphers/aes.js";

/** AES-256 key size. */
export const AEAD_KEY_SIZE = 32;
/** GCM nonce size (Go `GCMNonceSize`). */
export const AEAD_NONCE_SIZE = 12;
/** GCM authentication tag size (Go `GCMTagSize`). */
export const AEAD_TAG_SIZE = 16;

// Why pure-JS AES (@noble/ciphers) rather than WebCrypto's hardware AES-GCM:
//
//   - Interop is unaffected: AES-256-GCM is deterministic, so @noble/ciphers
//     and WebCrypto emit byte-identical output for the same inputs. Either
//     decrypts what the Go server (crypto/aes + cipher.NewGCM) produces.
//   - @noble/ciphers is synchronous; WebCrypto's SubtleCrypto is Promise-based.
//     Keeping the primitive sync keeps the Noise handshake (a tight sequence of
//     ~3 seals interleaved with DH/hash) a plain synchronous function.
//   - The side-channel trade is acceptable here: noble's AES is table-based
//     (not constant-time), but every handshake key is ephemeral (derived from a
//     per-knock DH), so there is no repeated-use key to mount a cache-timing
//     oracle against.
//
// If a constant-time hardware AES is ever required, WebCrypto AES-GCM is the
// drop-in swap (it appends the tag and takes AAD the same way) — at the cost of
// making this module, and the handshake that calls it, async.

// Enforce the NHP suite's exact key and nonce sizes. noble's `gcm` does NOT
// guard these for us: it silently accepts a 16- or 24-byte key (downgrading to
// AES-128/192) and a variable-length GCM nonce. So this check is the only thing
// pinning AES-256 and the 12-byte nonce — a wrong-size key would otherwise
// change the wire crypto without erroring.
function assertKeyAndNonce(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== AEAD_KEY_SIZE) {
    throw new Error(`AES-256-GCM key must be ${AEAD_KEY_SIZE} bytes, got ${key.length}`);
  }
  if (nonce.length !== AEAD_NONCE_SIZE) {
    throw new Error(`AES-256-GCM nonce must be ${AEAD_NONCE_SIZE} bytes, got ${nonce.length}`);
  }
}

/**
 * AES-256-GCM seal: returns `ciphertext ‖ tag` (the 16-byte tag appended),
 * matching Go `cipher.AEAD.Seal` with the NHP default suite (`GCM_AES256`).
 * `aad` is the additional authenticated data (the chain hash, in the handshake).
 */
export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKeyAndNonce(key, nonce);
  return gcm(key, nonce, aad).encrypt(plaintext);
}

/**
 * AES-256-GCM open: verifies the tag over `ciphertext ‖ tag` and returns the
 * plaintext, or throws if authentication fails. Mirrors Go `cipher.AEAD.Open`.
 */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKeyAndNonce(key, nonce);
  if (ciphertext.length < AEAD_TAG_SIZE) {
    throw new Error(
      `AES-256-GCM ciphertext must be at least the ${AEAD_TAG_SIZE}-byte tag, got ${ciphertext.length}`,
    );
  }
  return gcm(key, nonce, aad).decrypt(ciphertext);
}
