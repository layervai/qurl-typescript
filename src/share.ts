import {
  ERROR_CODE_CRID_MISMATCH,
  ERROR_CODE_INVALID_CRID,
  ERROR_CODE_INVALID_CRID_KEY,
  ERROR_CODE_MISSING_CRID,
  QURLError,
  RuntimeError,
} from "./errors.js";

const CRID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CRID_FULL_LENGTH = 60;
const CRID_TRUNCATED_LENGTH = 47;
const CRID_CHECKSUM_LENGTH = 4;
const CRID_DOMAIN = new TextEncoder().encode("NHP-QURL-CRID-V1\0");
const CRC32C_REVERSED_POLYNOMIAL = 0x82f63b78;

export type CRIDVerificationErrorCode =
  | typeof ERROR_CODE_MISSING_CRID
  | typeof ERROR_CODE_INVALID_CRID
  | typeof ERROR_CODE_INVALID_CRID_KEY
  | typeof ERROR_CODE_CRID_MISMATCH;

/** A local, fail-closed CRID verification failure. */
export class CRIDVerificationError extends QURLError {
  constructor(code: CRIDVerificationErrorCode, message: string) {
    super({ status: 0, code, title: "CRID Verification Error", detail: message });
    this.name = "CRIDVerificationError";
  }
}

export interface ShareLinkInit {
  link: string;
  qurlId?: string;
  crid?: string;
  type?: string;
  expiresAt?: Date;
  expiresInSeconds?: number;
  singleUse?: boolean;
}

/** A freshly minted, one-time-returned access link for an existing resource. */
export class ShareLink {
  readonly link: string;
  readonly qurlId?: string;
  readonly crid?: string;
  readonly type?: string;
  readonly expiresAt?: Date;
  readonly expiresInSeconds?: number;
  readonly singleUse?: boolean;

  constructor(init: ShareLinkInit) {
    this.link = init.link;
    this.qurlId = init.qurlId;
    this.crid = init.crid;
    this.type = init.type;
    this.expiresAt = init.expiresAt;
    this.expiresInSeconds = init.expiresInSeconds;
    this.singleUse = init.singleUse;
  }

  /**
   * Tie this response to a DER SubjectPublicKeyInfo already held by the caller.
   * Resolves only when the key re-derives the held CRID.
   */
  async verifyCrid(derSpki: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (!this.crid) {
      throw new CRIDVerificationError(
        ERROR_CODE_MISSING_CRID,
        "Share response carried no CRID; the resource key cannot be verified",
      );
    }
    const parsed = parseCrid(this.crid);
    const key = copyBytes(derSpki);
    const crypto = globalThis.crypto;
    if (!crypto?.subtle) {
      throw new RuntimeError("globalThis.crypto.subtle is required to verify a CRID");
    }
    const message = new Uint8Array(CRID_DOMAIN.length + key.length);
    message.set(CRID_DOMAIN);
    message.set(key, CRID_DOMAIN.length);
    const derived = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
    let difference = 0;
    for (let i = 0; i < parsed.digest.length; i++) {
      difference |= parsed.digest[i] ^ derived[i];
    }
    if (difference !== 0) {
      throw new CRIDVerificationError(
        ERROR_CODE_CRID_MISMATCH,
        "Resource key does not derive the held CRID",
      );
    }
  }
}

function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new CRIDVerificationError(
    ERROR_CODE_INVALID_CRID_KEY,
    "Resource key must be binary DER SPKI data",
  );
}

function parseCrid(value: string): { digest: Uint8Array } {
  if (value.length !== CRID_FULL_LENGTH && value.length !== CRID_TRUNCATED_LENGTH) {
    throw invalidCrid();
  }
  const decoded: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const index = CRID_ALPHABET.indexOf(character);
    if (index < 0) throw invalidCrid();
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0) throw invalidCrid();
  const bytes = Uint8Array.from(decoded);
  // Version zero is reserved. Other version/environment bytes are deliberately
  // accepted for forward compatibility, as required by the CRID conformance
  // vectors; verification still fails closed unless the key-derived digest
  // matches.
  if (bytes[0] === 0) throw invalidCrid();
  const payload = bytes.subarray(0, bytes.length - CRID_CHECKSUM_LENGTH);
  const checksum = bytes.subarray(bytes.length - CRID_CHECKSUM_LENGTH);
  const expected = crc32c(payload);
  const observed =
    ((checksum[0] << 24) | (checksum[1] << 16) | (checksum[2] << 8) | checksum[3]) >>> 0;
  if (observed !== expected) throw invalidCrid();
  return { digest: payload.subarray(1) };
}

function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? CRC32C_REVERSED_POLYNOMIAL : 0);
    }
  }
  return ~crc >>> 0;
}

function invalidCrid(): CRIDVerificationError {
  return new CRIDVerificationError(
    ERROR_CODE_INVALID_CRID,
    "Share response carried an invalid CRID",
  );
}
