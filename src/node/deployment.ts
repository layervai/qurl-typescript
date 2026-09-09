import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isStrictJsonObject, parseStrictJson, type StrictJsonValue } from "./strict-json.js";
import { issuerKeyFromSpki } from "./qv2.js";

export interface PortalDeployment {
  readonly issuers: readonly PortalDeploymentIssuer[];
  readonly cells: readonly PortalDeploymentCell[];
  readonly relay_allowlist?: readonly string[];
}

export interface PortalDeploymentIssuer {
  readonly kid: string;
  readonly spki_der_b64: string;
}

export interface PortalDeploymentCell {
  readonly cell_id?: string;
  readonly host: string;
  readonly port: number;
  readonly server_public_key_b64: string;
}

export interface ValidatedDeployment {
  readonly issuers: ReadonlyMap<string, KeyObject>;
  readonly cells: ReadonlyMap<string, ValidatedCell>;
  readonly relayAllowlist: readonly string[];
}

export interface ValidatedCell {
  readonly host: string;
  readonly port: 443;
  readonly serverPublicKey: Uint8Array;
}

const DEPLOYMENT_KEYS = new Set(["issuers", "cells", "relay_allowlist", "hub"]);
const ISSUER_KEYS = new Set(["kid", "spki_der_b64"]);
const CELL_KEYS = new Set(["cell_id", "host", "port", "server_public_key_b64"]);
const MAX_DEPLOYMENT_BYTES = 1_048_576;

interface DeploymentFileRuntime {
  readonly open: (path: string, flags: number) => number;
  readonly stat: (descriptor: number) => { readonly size: number; isFile(): boolean };
  readonly read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly close: (descriptor: number) => void;
}

const defaultDeploymentFileRuntime: DeploymentFileRuntime = {
  open: openSync,
  stat: fstatSync,
  read: readSync,
  close: closeSync,
};

/** Load and validate deployment trust before an opener can do network I/O. */
export function loadPortalDeployment(explicit?: PortalDeployment): ValidatedDeployment {
  if (explicit !== undefined) return validateDeployment(explicit);
  const configured = process.env.QURL_DEPLOYMENT;
  if (!configured || configured.trim() === "") {
    throw new Error("native qURL opening requires deployment trust in QURL_DEPLOYMENT");
  }
  const trimmed = configured.trim();
  const raw = trimmed.startsWith("{")
    ? Buffer.from(trimmed, "utf8")
    : readBoundedDeploymentFile(trimmed);
  return validateDeploymentValue(parseStrictJson(raw, MAX_DEPLOYMENT_BYTES));
}

function readBoundedDeploymentFile(
  path: string,
  runtime: DeploymentFileRuntime = defaultDeploymentFileRuntime,
): Buffer {
  // O_NONBLOCK prevents a FIFO or device path from hanging startup before
  // fstat can enforce the regular-file contract. It has no effect on files.
  const descriptor = runtime.open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const metadata = runtime.stat(descriptor);
    if (!metadata.isFile()) throw new Error("native qURL deployment path must be a regular file");
    if (!Number.isSafeInteger(metadata.size) || metadata.size > MAX_DEPLOYMENT_BYTES) {
      throw new Error("native qURL deployment file exceeds its 1 MiB limit");
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = runtime.read(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) {
        throw new Error("native qURL deployment file changed while it was read");
      }
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (runtime.read(descriptor, extra, 0, 1, offset) !== 0) {
      throw new Error("native qURL deployment file changed while it was read");
    }
    return bytes.subarray(0, offset);
  } finally {
    runtime.close(descriptor);
  }
}

function validateDeployment(explicit: PortalDeployment): ValidatedDeployment {
  // Convert through JSON only to give the programmatic form the same strict,
  // immutable validation path as the environment/file form. Deployment data is
  // public trust material, not a secret.
  let encoded: string;
  try {
    encoded = JSON.stringify(explicit);
  } catch {
    throw new Error("native qURL deployment is not JSON serializable");
  }
  if (encoded === undefined) throw new Error("native qURL deployment is missing");
  return validateDeploymentValue(
    parseStrictJson(Buffer.from(encoded, "utf8"), MAX_DEPLOYMENT_BYTES),
  );
}

function validateDeploymentValue(value: StrictJsonValue): ValidatedDeployment {
  const root = requireObject(value, "deployment");
  rejectUnknown(root, DEPLOYMENT_KEYS, "deployment");
  const issuerRows = requireArray(root.issuers, "deployment issuers");
  const cellRows = requireArray(root.cells, "deployment cells");
  if (issuerRows.length === 0) throw new Error("deployment must contain at least one issuer");
  const relayAllowlist =
    root.relay_allowlist === undefined
      ? []
      : requireArray(root.relay_allowlist, "relay allowlist")
          .map((value) => requireString(value, "relay host").trim().toLowerCase())
          .filter(Boolean);
  if (cellRows.length === 0 && relayAllowlist.length === 0)
    throw new Error("deployment must contain at least one cell or relay host");

  const issuers = new Map<string, KeyObject>();
  for (const row of issuerRows) {
    const item = requireObject(row, "deployment issuer");
    rejectUnknown(item, ISSUER_KEYS, "deployment issuer");
    const kid = requireTrimmed(item.kid, "deployment issuer kid");
    if (issuers.has(kid)) throw new Error("deployment contains a duplicate issuer kid");
    issuers.set(kid, issuerKeyFromSpki(decodeFlexibleBase64(item.spki_der_b64, "issuer key")));
  }

  const cells = new Map<string, ValidatedCell>();
  for (const row of cellRows) {
    const item = requireObject(row, "deployment cell");
    rejectUnknown(item, CELL_KEYS, "deployment cell");
    const host = requireTrimmed(item.host, "deployment cell host");
    if (item.port !== 443n) throw new Error("deployment cell must use NHP UDP port 443");
    const serverPublicKey = decodeFlexibleBase64(item.server_public_key_b64, "cell public key");
    if (serverPublicKey.byteLength !== 32) throw new Error("cell public key must be 32 bytes");
    const fingerprint = fingerprintKey(serverPublicKey);
    if (cells.has(fingerprint)) throw new Error("deployment contains a duplicate cell public key");
    // Validate cell_id for schema parity, but do not use it as identity. The
    // full X25519 public key is the cryptographic cell binding.
    if (item.cell_id !== undefined) requireString(item.cell_id, "cell id");
    cells.set(fingerprint, { host, port: 443, serverPublicKey });
  }
  return { issuers, cells, relayAllowlist };
}

export function fingerprintKey(key: Uint8Array): string {
  return createHash("sha256").update(key).digest().subarray(0, 8).toString("base64url");
}

function decodeFlexibleBase64(value: StrictJsonValue | undefined, name: string): Uint8Array {
  const encoded = requireTrimmed(value, name);
  const hasStandard = /[+/]/.test(encoded);
  const hasUrl = /[-_]/.test(encoded);
  if (hasStandard && hasUrl) throw new Error(`${name} mixes base64 alphabets`);
  if (!/^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}==|[A-Za-z0-9+/_-]{3}=)?$/.test(encoded)) {
    // Also permit the unpadded two/three-character tail used by Raw encodings.
    if (!/^[A-Za-z0-9+/_-]+$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error(`${name} is not valid base64`);
    }
  }
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized) throw new Error(`${name} is not canonical base64`);
  return new Uint8Array(decoded);
}

function requireObject(
  value: StrictJsonValue | undefined,
  name: string,
): { [key: string]: StrictJsonValue } {
  if (!isStrictJsonObject(value)) throw new Error(`${name} must be one JSON object`);
  return value;
}

function requireArray(value: StrictJsonValue | undefined, name: string): StrictJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requireString(value: StrictJsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireTrimmed(value: StrictJsonValue | undefined, name: string): string {
  const string = requireString(value, name);
  if (string === "" || string.trim() !== string)
    throw new Error(`${name} must be non-empty and trimmed`);
  return string;
}

function rejectUnknown(
  value: { [key: string]: StrictJsonValue },
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains an unknown field`);
  }
}

export const deploymentTesting = { readBoundedDeploymentFile, decodeFlexibleBase64 };

/** Producer-only deployments need a pinned Hub, but need no portal issuer keys. */
export function loadDeploymentHub(): unknown {
  const configured = process.env.QURL_DEPLOYMENT?.trim();
  if (!configured) throw new Error("QURL_DEPLOYMENT has no producer Hub");
  const raw = configured.startsWith("{")
    ? Buffer.from(configured)
    : readBoundedDeploymentFile(configured);
  const value = parseStrictJson(raw, MAX_DEPLOYMENT_BYTES);
  if (
    !isStrictJsonObject(value) ||
    Object.keys(value).some((key) => !DEPLOYMENT_KEYS.has(key)) ||
    !isStrictJsonObject(value.hub)
  )
    throw new Error("QURL_DEPLOYMENT has no producer Hub");
  return value.hub;
}
