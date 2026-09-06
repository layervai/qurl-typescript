import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createSocket } from "node:dgram";
import { BlockList, isIP } from "node:net";
import {
  buildNHPMessage,
  decryptNHPReply,
  NHP_PACKET_SIZE,
  NHP_TYPE_COOKIE,
  NHP_TYPE_KNOCK,
  type NHPMessage,
} from "./nhp-wire.js";
import type { ValidatedCell } from "./deployment.js";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_ADDRESSES = 3;

const ipv4Denied = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  ipv4Denied.addSubnet(network, prefix, "ipv4");
}

const ipv6Allowed = new BlockList();
for (const [network, prefix] of [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
] as const) {
  ipv6Allowed.addSubnet(network, prefix, "ipv6");
}

const ipv6Denied = new BlockList();
for (const [network, prefix] of [
  ["100::", 64],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  ipv6Denied.addSubnet(network, prefix, "ipv6");
}

export interface NativeExchangeOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxAddresses?: number;
}

interface NativeKnockRuntime {
  readonly buildMessage: typeof buildNHPMessage;
  readonly resolveAddresses: typeof resolvePublicAddresses;
  readonly exchange: typeof exchangeDatagram;
  readonly decryptReply: typeof decryptNHPReply;
}

const defaultNativeKnockRuntime: NativeKnockRuntime = {
  buildMessage: buildNHPMessage,
  resolveAddresses: resolvePublicAddresses,
  exchange: exchangeDatagram,
  decryptReply: decryptNHPReply,
};

export async function nativeKnock(
  cell: ValidatedCell,
  devicePrivateKey: Uint8Array,
  body: Uint8Array,
  options: NativeExchangeOptions = {},
): Promise<NHPMessage> {
  return nativeKnockWithRuntime(cell, devicePrivateKey, body, options, defaultNativeKnockRuntime);
}

async function nativeKnockWithRuntime(
  cell: ValidatedCell,
  devicePrivateKey: Uint8Array,
  body: Uint8Array,
  options: NativeExchangeOptions,
  runtime: NativeKnockRuntime,
): Promise<NHPMessage> {
  if (options.signal?.aborted) throw options.signal.reason;
  const built = runtime.buildMessage({
    type: NHP_TYPE_KNOCK,
    devicePrivateKey,
    serverPublicKey: cell.serverPublicKey,
    body,
  });
  try {
    const addresses = await runtime.resolveAddresses(
      cell.host,
      options.maxAddresses ?? DEFAULT_MAX_ADDRESSES,
      options.signal,
    );
    let lastError: unknown;
    for (const address of addresses) {
      try {
        const packet = await runtime.exchange(
          address.address,
          address.family,
          cell.port,
          built.packet,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          options.signal,
        );
        const reply = runtime.decryptReply(devicePrivateKey, cell.serverPublicKey, packet);
        // NHP 1.1 COOKIE is a stateless busy response. Go intentionally does
        // not bind its counter to the request; only an ACK must match it.
        if (reply.type === NHP_TYPE_COOKIE) return reply;
        if (reply.counter !== built.counter) {
          reply.body.fill(0);
          throw new Error("NHP reply counter does not match the request");
        }
        return reply;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        // Authentication and reply-policy failures happen after a datagram was
        // received. They are terminal and must not fall through to another DNS
        // address. Only local socket failures carry this private marker.
        if (!isSocketExchangeError(error)) throw error;
        lastError = error.cause;
      }
    }
    throw new Error("native NHP exchange failed", { cause: lastError });
  } finally {
    built.packet.fill(0);
  }
}

async function resolvePublicAddresses(
  host: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
    throw new Error("native NHP maxAddresses must be an integer from 1 to 16");
  }
  if (signal?.aborted) throw signal.reason;
  let rows: LookupAddress[];
  try {
    rows = await waitForAbort(lookup(host, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error("native NHP endpoint DNS resolution failed", { cause: error });
  }
  if (signal?.aborted) throw signal.reason;
  const accepted: Array<{ address: string; family: 4 | 6 }> = [];
  for (const row of rows) {
    if (row.family !== 4 && row.family !== 6) continue;
    if (!isPublicAddress(row.address, row.family)) continue;
    accepted.push({ address: row.address, family: row.family });
    if (accepted.length === maximum) break;
  }
  if (accepted.length === 0) throw new Error("native NHP endpoint resolved to no public address");
  return accepted;
}

function isPublicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) return !ipv4Denied.check(address, "ipv4");
  return ipv6Allowed.check(address, "ipv6") && !ipv6Denied.check(address, "ipv6");
}

class SocketExchangeError extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("native NHP socket exchange failed", { cause });
    this.name = "SocketExchangeError";
  }
}

// A received datagram is an authority-bearing response attempt. Its malformed
// shape must stop address fallback instead of being treated as a local socket
// miss that can send the same knock to another address.
class ReceivedDatagramError extends Error {}

function isSocketExchangeError(error: unknown): error is SocketExchangeError {
  return error instanceof SocketExchangeError;
}

function exchangeDatagram(
  address: string,
  family: 4 | 6,
  port: number,
  packet: Uint8Array,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    return Promise.reject(new Error("native NHP timeout must be from 1 to 60000 milliseconds"));
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const socket = createSocket(family === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (error?: unknown, reply?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // An error that arrives while close settles must not become an unhandled
      // EventEmitter error after the one-shot operational listener ran.
      socket.on("error", () => undefined);
      try {
        socket.close();
      } catch {
        // The socket can already be closed by a synchronous setup failure.
      }
      if (error instanceof ReceivedDatagramError) reject(error);
      else if (error !== undefined) reject(new SocketExchangeError(error));
      else resolve(new Uint8Array(reply!));
    };
    const abort = (): void => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error("native NHP reply timed out")), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.once("message", (reply) => {
      if (reply.byteLength > NHP_PACKET_SIZE) {
        finish(new ReceivedDatagramError("native NHP reply is too large"));
      } else finish(undefined, reply);
    });
    socket.connect(port, address, () => {
      socket.send(packet, (error) => {
        if (error) finish(error);
      });
    });
  });
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export const nativeUdpTesting = {
  isPublicAddress,
  nativeKnockWithRuntime,
  exchangeDatagram,
  socketExchangeError: (cause: unknown): Error => new SocketExchangeError(cause),
};
