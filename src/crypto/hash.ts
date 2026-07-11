// Ported from nhp/endpoints/js-agent/src/crypto/hash.ts — keep byte-identical.
import { blake2s } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";

/**
 * Hash algorithm selector — mirrors Go `core.HashTypeEnum`
 * (`nhp/core/crypto.go`). Numeric values match the Go `iota` so cross-language
 * test tables (e.g. the KDF golden vectors) line up by ordinal.
 *
 * BLAKE2s-256 is the default NHP cipher suite (`defaultCipherSuite`); SHA-256
 * is the alternate. Both produce a 32-byte digest.
 */
export enum HashType {
  BLAKE2S = 0,
  SHA256 = 1,
}

/** Digest size of every supported hash: 32 bytes (BLAKE2s-256 / SHA-256). */
export const HASH_SIZE = 32;

/**
 * The noble hash for a given type. noble exposes each hash as a callable
 * `CHash` that is also what `hmac()` and incremental hashing consume, so this
 * one mapping backs the KDF, the chain hash, and `MixHash`.
 */
export function nobleHash(type: HashType): CHash {
  switch (type) {
    case HashType.BLAKE2S:
      return blake2s;
    case HashType.SHA256:
      return sha256;
    default:
      throw new Error(`unsupported hash type: ${type as number}`);
  }
}

/**
 * One-shot hash of the concatenated inputs: `H(inputs[0] ‖ inputs[1] ‖ …)`.
 * This is the shape `MixHash` needs — `H(key ‖ input)` — and matches Go's
 * `h.Write(a); h.Write(b); h.Sum(nil)` (streaming a hash IS hashing the
 * concatenation).
 */
export function hash(type: HashType, ...inputs: Uint8Array[]): Uint8Array {
  const h = nobleHash(type).create();
  for (const input of inputs) h.update(input);
  return h.digest();
}

/**
 * An incremental hash whose digest can be read **without finalizing** — the
 * Noise chain-hash usage in the Go handshake (`nhp/core/initiator.go`), where
 * `chainHash.Write(…)` absorbs more material and `chainHash.Sum(nil)` peeks the
 * current digest repeatedly as the transcript evolves.
 *
 * noble's `digest()` finalizes (and throws if called twice), so {@link sum}
 * peeks by cloning the live state and digesting the copy — non-destructive.
 */
export interface ChainHash {
  update(data: Uint8Array): void;
  /** Current digest, without finalizing. Safe to call repeatedly. */
  sum(): Uint8Array;
}

/** Creates a {@link ChainHash} over the given hash type. */
export function createChainHash(type: HashType): ChainHash {
  const h = nobleHash(type).create();
  return {
    update(data: Uint8Array): void {
      h.update(data);
    },
    sum(): Uint8Array {
      return h.clone().digest();
    },
  };
}
