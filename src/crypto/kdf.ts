// Ported from nhp/endpoints/js-agent/src/crypto/kdf.ts — keep byte-identical.
import { hmac } from "@noble/hashes/hmac.js";
import { HashType, nobleHash } from "./hash.js";

// KDF domain-separation tags — single bytes appended in the HKDF-expand chain.
// Mirror Go `core` `kdfTag1/2/3` (`nhp/core/kdf.go`).
const TAG1 = Uint8Array.of(0x01);
const TAG2 = Uint8Array.of(0x02);
const TAG3 = Uint8Array.of(0x03);

// Key-material hygiene: Go's KDF wipes the intermediate PRK with SetZero after
// each derivation (defense-in-depth). The browser port deliberately does NOT —
// JS offers no control over the GC and no guaranteed in-place wipe (noble's own
// primitives don't either), so the wipe would be theatre. This is a conscious,
// unavoidable divergence from the Go side, not an omission; the derived
// handshake keys are ephemeral per knock regardless.

/**
 * `HMAC(key, in0 ‖ in1 ‖ …)` using the cipher-suite hash as the inner hash.
 * Mirrors Go `NoiseFactory.HMAC1`/`HMAC2` (`mac.Write` per input, then `Sum`).
 *
 * CRITICAL — this is HMAC *over the unkeyed hash* (`hmac(blake2s, key, msg)`),
 * NOT noble's keyed BLAKE2s (`blake2s(msg, { key })`). The two produce
 * different bytes; using the keyed form would silently break interop with the
 * Go server. The `kdf.test.ts` golden vectors are the guard against that.
 */
function mac(type: HashType, key: Uint8Array, ...inputs: Uint8Array[]): Uint8Array {
  const m = hmac.create(nobleHash(type), key);
  for (const input of inputs) m.update(input);
  return m.digest();
}

// keyGen1/2/3 below are standard HKDF (RFC 5869): extract = HMAC(salt=key,
// ikm=input), then expand chaining HMAC(prk, prev ‖ counter) with counter bytes
// 0x01/0x02/0x03 — and they are byte-identical to @noble/hashes/hkdf. They are
// hand-rolled rather than calling that helper so the TS stays a 1:1 mirror of Go
// NoiseFactory.KeyGenN (which hand-rolls it too); the golden vectors fence both,
// and the keyed-HMAC-over-unkeyed-hash subtlety above stays explicit at the call.

/**
 * One output: `dst0 = HMAC(HMAC(key, input), 0x01)`.
 * HKDF-Extract (`prk = HMAC(key, input)`) then HKDF-Expand with counter 1.
 * Mirrors Go `NoiseFactory.KeyGen1`.
 */
export function keyGen1(type: HashType, key: Uint8Array, input: Uint8Array): Uint8Array {
  const prk = mac(type, key, input);
  return mac(type, prk, TAG1);
}

/**
 * Two chained outputs from one extract:
 * `prk = HMAC(key, input)`, `dst0 = HMAC(prk, 0x01)`, `dst1 = HMAC(prk, dst0 ‖ 0x02)`.
 * Mirrors Go `NoiseFactory.KeyGen2` (used for the `es`/`ss` key derivations).
 */
export function keyGen2(
  type: HashType,
  key: Uint8Array,
  input: Uint8Array,
): [Uint8Array, Uint8Array] {
  const prk = mac(type, key, input);
  const dst0 = mac(type, prk, TAG1);
  const dst1 = mac(type, prk, dst0, TAG2);
  return [dst0, dst1];
}

/**
 * Three chained outputs from one extract — `KeyGen2` plus
 * `dst2 = HMAC(prk, dst1 ‖ 0x03)`. Mirrors Go `NoiseFactory.KeyGen3`.
 */
export function keyGen3(
  type: HashType,
  key: Uint8Array,
  input: Uint8Array,
): [Uint8Array, Uint8Array, Uint8Array] {
  const prk = mac(type, key, input);
  const dst0 = mac(type, prk, TAG1);
  const dst1 = mac(type, prk, dst0, TAG2);
  const dst2 = mac(type, prk, dst1, TAG3);
  return [dst0, dst1, dst2];
}

/** `MixKey` is `KeyGen1` (Go `NoiseFactory.MixKey`). */
export const mixKey = keyGen1;

// Note: Go also defines NoiseFactory.MixHash (H(key ‖ input)), but the handshake
// never calls it — it folds material into the chain hash with chainHash.Write(…)
// directly (initiator.go). This port uses createChainHash().update() the same
// way, so MixHash is intentionally not ported here (it would be unfenced, unused
// code).
