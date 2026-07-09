// Ported from nhp/endpoints/js-agent/src/crypto/dh.ts — keep byte-identical.
import { x25519 } from "@noble/curves/ed25519.js";

/** X25519 private and public keys are both 32 bytes. */
export const X25519_KEY_SIZE = 32;

function assertKeySize(label: string, key: Uint8Array): void {
  if (key.length !== X25519_KEY_SIZE) {
    throw new Error(`x25519 ${label} must be ${X25519_KEY_SIZE} bytes, got ${key.length}`);
  }
}

/**
 * Public key for an X25519 private key: `X25519(priv, basepoint)`.
 *
 * Mirrors Go `curve.Curve25519ECDH.SetPrivateKey` deriving `PubKey` via
 * `curve25519.X25519(priv, Basepoint)`. X25519 clamps the scalar internally per
 * RFC 7748, so an unclamped stored private key yields the same public key — the
 * Go side only clamps freshly-generated keys (`NewECDH`), not stored ones.
 */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  assertKeySize("private key", privateKey);
  return x25519.getPublicKey(privateKey);
}

/**
 * X25519 ECDH shared secret: `X25519(priv, peerPub)`, 32 bytes.
 *
 * Mirrors Go `curve.Curve25519ECDH.SharedSecret`. Go returns `nil` on a
 * wrong-length key or a low-order point (all-zero output); here those throw, so
 * a malformed key fails the knock loudly instead of silently proceeding with a
 * zero key.
 */
export function x25519SharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  assertKeySize("private key", privateKey);
  assertKeySize("peer public key", peerPublicKey);
  return x25519.getSharedSecret(privateKey, peerPublicKey);
}
