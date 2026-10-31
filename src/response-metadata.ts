/** Correlation metadata from one successful API response. */
export interface ResponseMetadata {
  readonly requestId: string;
}

// A constant global symbol survives mixed ESM/CJS loads without a mutable registry.
const RESPONSE_METADATA = Symbol.for("@layervai/qurl.responseMetadata.v1");

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Read this result's server correlation ID. Metadata is non-enumerable and is
 * not part of its JSON payload. Local handles and responses without an ID return undefined.
 */
export function getResponseMetadata(value: unknown): Readonly<ResponseMetadata> | undefined {
  if (!isObject(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, RESPONSE_METADATA)?.value as
    Readonly<ResponseMetadata> | undefined;
}

/** @internal Attach only an identifier already validated at the HTTP boundary. */
export function withResponseMetadata<T>(value: T, requestId: string | undefined): T {
  if (!isObject(value) || !requestId) return value;
  if (getResponseMetadata(value)?.requestId === requestId) return value;
  Object.defineProperty(value, RESPONSE_METADATA, {
    value: Object.freeze({ requestId }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

/** @internal Preserve correlation when a response becomes a new SDK value. */
export function copyResponseMetadata<T>(source: unknown, value: T): T {
  return withResponseMetadata(value, getResponseMetadata(source)?.requestId);
}
