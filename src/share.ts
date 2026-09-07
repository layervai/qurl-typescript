import {
  ERROR_CODE_CRID_MISMATCH,
  ERROR_CODE_INVALID_CRID,
  ERROR_CODE_INVALID_CRID_KEY,
  ERROR_CODE_MISSING_CRID,
  QURLError,
  RuntimeError,
} from "./errors.js";

import { cridKeyMatches, parseCrid } from "./crid.js";

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
  /**
   * The one-time secret share link. This property is deliberately
   * non-enumerable: read it directly instead of spreading or cloning the object.
   */
  readonly link: string;
  /** Token ID when supplied by the service; older deployments may omit it. */
  readonly qurlId?: string;
  readonly crid?: string;
  readonly type?: string;
  readonly #expiresAtEpochMs?: number;
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
    this.#expiresAtEpochMs = init.expiresAt?.getTime();
    this.expiresInSeconds = init.expiresInSeconds;
    this.singleUse = init.singleUse;
    Object.freeze(this);
  }

  /** Effective expiry as a defensive copy; mutating it does not change this share. */
  get expiresAt(): Date | undefined {
    return this.#expiresAtEpochMs === undefined ? undefined : new Date(this.#expiresAtEpochMs);
  }

  /** Serialize safe metadata while redacting the one-time-returned credential. */
  toJSON(): ShareLinkJSON {
    const expiresAt = this.expiresAt;
    return {
      link: "[redacted]",
      qurlId: this.qurlId,
      crid: this.crid,
      type: this.type,
      expiresAt:
        expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : undefined,
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
    if (!parseCrid(this.crid)) throw invalidCrid();
    const key = copyBytes(derSpki);
    const crypto = globalThis.crypto;
    if (!crypto?.subtle) {
      throw new RuntimeError("globalThis.crypto.subtle is required to verify a CRID");
    }
    if (!(await cridKeyMatches(this.crid, key))) {
      throw new CRIDVerificationError(
        ERROR_CODE_CRID_MISMATCH,
        "Resource key does not derive the held CRID",
      );
    }
  }
}

function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  try {
    if (ArrayBuffer.isView(value)) {
      return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    // The intrinsic checks the real internal slot, including across realms.
    return new Uint8Array(ArrayBuffer.prototype.slice.call(value as ArrayBuffer, 0));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Non-binary values and detached buffers are invalid caller key material.
  }
  throw new CRIDVerificationError(
    ERROR_CODE_INVALID_CRID_KEY,
    "Resource key must be binary DER SPKI data",
  );
}

function invalidCrid(): CRIDVerificationError {
  return new CRIDVerificationError(
    ERROR_CODE_INVALID_CRID,
    "Share response carried an invalid CRID",
  );
}
