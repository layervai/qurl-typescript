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
// ASCII bytes for "NHP-QURL-CRID-V1\0". Keep the verification domain fixed
// and independent of runtime text encoding.
const CRID_DOMAIN = Uint8Array.of(
  0x4e,
  0x48,
  0x50,
  0x2d,
  0x51,
  0x55,
  0x52,
  0x4c,
  0x2d,
  0x43,
  0x52,
  0x49,
  0x44,
  0x2d,
  0x56,
  0x31,
  0x00,
);
const CRC32C_REVERSED_POLYNOMIAL = 0x82f63b78;

export type CRIDVerificationErrorCode =
  | typeof ERROR_CODE_MISSING_CRID
  | typeof ERROR_CODE_INVALID_CRID
  | typeof ERROR_CODE_INVALID_CRID_KEY
  | typeof ERROR_CODE_CRID_MISMATCH;

/** A local, fail-closed CRID verification failure. */
export class CRIDVerificationError extends QURLError {
  declare readonly code: CRIDVerificationErrorCode;

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

/** Credential-redacted, JSON-safe representation returned by {@link ShareLink.toJSON}. */
export interface ShareLinkJSON {
  link: "[redacted]";
  qurlId?: string;
  crid?: string;
  type?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  singleUse?: boolean;
}

/**
 * A freshly minted, one-time-returned access link for an existing resource.
 * Instances are frozen during construction and are not designed for subclassing.
 */
export class ShareLink {
  readonly link: string;
  /** Token ID when supplied by the service; older deployments may omit it. */
  readonly qurlId?: string;
  readonly crid?: string;
  readonly type?: string;
  readonly expiresAt?: Date;
  readonly expiresInSeconds?: number;
  /** Whether the link is single-use; undefined when an older service omits the field. */
  readonly singleUse?: boolean;

  constructor(init: ShareLinkInit) {
    this.link = init.link;
    // Keep accidental object spread/structured logging from copying the
    // one-time-returned credential. Callers can still read `.link` explicitly.
    Object.defineProperty(this, "link", {
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.qurlId = init.qurlId;
    this.crid = init.crid;
    this.type = init.type;
    this.expiresAt = init.expiresAt && new Date(init.expiresAt.getTime());
    this.expiresInSeconds = init.expiresInSeconds;
    this.singleUse = init.singleUse;
    Object.freeze(this);
  }

  /** Serialize safe metadata while redacting the one-time-returned credential. */
  toJSON(): ShareLinkJSON {
    return {
      link: "[redacted]",
      qurlId: this.qurlId,
      crid: this.crid,
      type: this.type,
      expiresAt: this.expiresAt?.toISOString(),
      expiresInSeconds: this.expiresInSeconds,
      singleUse: this.singleUse,
    };
  }

  /** Prevent Node's default object inspector from printing the credential. */
  [Symbol.for("nodejs.util.inspect.custom")](): ShareLinkJSON {
    return this.toJSON();
  }

  /**
   * Verify that this response's CRID was derived from a DER SubjectPublicKeyInfo
   * already trusted by the caller. This binds the response CRID to that key; it
   * does not independently prove that the secret link fragment belongs to it.
   */
  async verifyCrid(derSpki: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.crid === undefined) {
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
    // Compare every framed digest byte: 32 for full CRIDs and 24 for the
    // protocol's explicitly truncated form. Never clamp full CRIDs to 24.
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
  // Calling the intrinsic requires the real [[ArrayBufferData]] internal slot,
  // so it is cross-realm safe without trusting a spoofable toStringTag.
  try {
    const copied = ArrayBuffer.prototype.slice.call(value as ArrayBuffer, 0);
    return new Uint8Array(copied);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // A non-ArrayBuffer or detached buffer falls through to the typed-view
    // branch/error below.
  }
  if (ArrayBuffer.isView(value)) {
    try {
      return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // Detached views are invalid caller key material, not raw TypeErrors.
    }
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
  // Version zero is reserved. Like qurl-go, accept every other structurally
  // valid version for forward compatibility. The version registry classifies
  // environments for display/routing; KeyMatches/verifyCrid is deliberately
  // environment-agnostic and proves only key-to-digest equality.
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
