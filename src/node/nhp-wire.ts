import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { inflateSync } from "node:zlib";

export const NHP_TYPE_KNOCK = 1;
export const NHP_TYPE_ACK = 2;
export const NHP_TYPE_COOKIE = 7;
export const NHP_HEADER_SIZE = 240;
export const NHP_PACKET_SIZE = 4_096;
export const NHP_MAX_BODY_SIZE = NHP_PACKET_SIZE - NHP_HEADER_SIZE - 16;

const HEADER_COMMON_SIZE = 24;
const OFFSET_EPHEMERAL = 24;
const OFFSET_STATIC = 136;
const OFFSET_TIMESTAMP = 184;
const OFFSET_DIGEST = 208;
const FLAG_COMPRESS = 1 << 1;
const INITIAL_HASH = Buffer.from("NHP hashgen v.20230421@deepcloudsdp.com", "utf8");
const INITIAL_CHAIN_KEY = Buffer.from("NHP keygen v.20230421@clouddeep.cn", "utf8");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface NHPMessage {
  readonly type: number;
  readonly flags: number;
  readonly counter: bigint;
  readonly timestampNanos: bigint;
  readonly body: Uint8Array;
}

export interface BuildNHPMessageInput {
  readonly type: number;
  readonly devicePrivateKey: Uint8Array;
  readonly serverPublicKey: Uint8Array;
  readonly body: Uint8Array;
  readonly ephemeralPrivateKey?: Uint8Array;
  readonly timestampNanos?: bigint;
  readonly counter?: bigint;
  readonly preamble?: number;
}

export function buildNHPMessage(input: BuildNHPMessageInput): {
  packet: Uint8Array;
  counter: bigint;
} {
  validateKey(input.devicePrivateKey, "device private key");
  validateKey(input.serverPublicKey, "server public key");
  if (input.body.byteLength > NHP_MAX_BODY_SIZE)
    throw new Error("NHP application body is too large");
  if (input.type !== NHP_TYPE_KNOCK) throw new Error("unsupported NHP initiator message type");

  const ephemeralPrivateKey = input.ephemeralPrivateKey
    ? Buffer.from(input.ephemeralPrivateKey)
    : randomBytes(32);
  const secrets: Uint8Array[] = [ephemeralPrivateKey];
  try {
    validateKey(ephemeralPrivateKey, "ephemeral private key");
    const random =
      input.counter === undefined || input.preamble === undefined ? randomBytes(12) : undefined;
    const counter = input.counter ?? random!.readBigUInt64BE(0);
    const preamble = input.preamble ?? random!.readUInt32BE(8);
    const timestampNanos = input.timestampNanos ?? BigInt(Date.now()) * 1_000_000n;

    const devicePublicKey = rawPublicFromPrivate(input.devicePrivateKey);
    const ephemeralPublicKey = rawPublicFromPrivate(ephemeralPrivateKey);
    const nonce = nonceForCounter(counter);
    const header = Buffer.alloc(NHP_HEADER_SIZE);
    ephemeralPublicKey.copy(header, OFFSET_EPHEMERAL);

    let chainHashParts: Buffer[] = [INITIAL_HASH];
    let chainKey = trackSecret(secrets, mixKey(hashParts(chainHashParts), INITIAL_CHAIN_KEY));
    chainHashParts = [...chainHashParts, Buffer.from(input.serverPublicKey), ephemeralPublicKey];
    chainKey = trackSecret(secrets, mixKey(chainKey, ephemeralPublicKey));

    const ephemeralShared = trackSecret(
      secrets,
      sharedSecret(ephemeralPrivateKey, input.serverPublicKey),
    );
    let derived = keyGen2(chainKey, ephemeralShared);
    secrets.push(...derived);
    chainKey = derived[0];
    const sealedStatic = seal(derived[1], nonce, devicePublicKey, hashParts(chainHashParts));
    sealedStatic.copy(header, OFFSET_STATIC);
    chainHashParts = [...chainHashParts, sealedStatic];

    const staticShared = trackSecret(
      secrets,
      sharedSecret(input.devicePrivateKey, input.serverPublicKey),
    );
    derived = keyGen2(chainKey, staticShared);
    secrets.push(...derived);
    chainKey = derived[0];
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(timestampNanos);
    const sealedTimestamp = seal(derived[1], nonce, timestamp, hashParts(chainHashParts));
    sealedTimestamp.copy(header, OFFSET_TIMESTAMP);
    chainHashParts = [...chainHashParts, sealedTimestamp];
    derived = keyGen2(chainKey, sealedTimestamp);
    secrets.push(...derived);
    const bodyKey = derived[1];

    header.writeUInt8(1, 8);
    header.writeUInt8(1, 9);
    header.writeUInt16BE(0, 10);
    header.writeBigUInt64BE(counter, 16);
    const payloadSize = input.body.byteLength === 0 ? 0 : input.body.byteLength + 16;
    header.writeUInt32BE(preamble >>> 0, 0);
    header.writeUInt32BE((preamble ^ ((input.type << 16) | payloadSize)) >>> 0, 4);
    const bodyAad = hashParts([...chainHashParts, header.subarray(0, HEADER_COMMON_SIZE)]);
    const sealedBody =
      input.body.byteLength === 0 ? Buffer.alloc(0) : seal(bodyKey, nonce, input.body, bodyAad);
    headerDigest(input.serverPublicKey, header).copy(header, OFFSET_DIGEST);

    return { packet: Buffer.concat([header, sealedBody]), counter };
  } finally {
    wipeBuffers(secrets);
  }
}

export function decryptNHPReply(
  devicePrivateKey: Uint8Array,
  expectedServerPublicKey: Uint8Array,
  packetValue: Uint8Array,
): NHPMessage {
  validateKey(devicePrivateKey, "device private key");
  validateKey(expectedServerPublicKey, "server public key");
  const packet = Buffer.from(packetValue);
  if (packet.byteLength < NHP_HEADER_SIZE || packet.byteLength > NHP_PACKET_SIZE) {
    throw new Error("NHP reply size is outside the protocol bounds");
  }
  if (packet[8] !== 1 || packet[9] < 1) throw new Error("unsupported NHP protocol version");
  const header = packet.subarray(0, NHP_HEADER_SIZE);
  const sealedBody = packet.subarray(NHP_HEADER_SIZE);
  const secrets: Uint8Array[] = [];
  let body: Buffer | undefined;
  try {
    const devicePublicKey = rawPublicFromPrivate(devicePrivateKey);
    const expectedDigest = headerDigest(devicePublicKey, header);
    if (!timingSafeEqual(expectedDigest, header.subarray(OFFSET_DIGEST))) {
      throw new Error("NHP reply header authentication failed");
    }

    const counter = header.readBigUInt64BE(16);
    const nonce = nonceForCounter(counter);
    const serverEphemeral = header.subarray(OFFSET_EPHEMERAL, OFFSET_EPHEMERAL + 32);
    const sealedStatic = header.subarray(OFFSET_STATIC, OFFSET_STATIC + 48);
    const sealedTimestamp = header.subarray(OFFSET_TIMESTAMP, OFFSET_TIMESTAMP + 24);

    let chainHashParts: Buffer[] = [INITIAL_HASH];
    let chainKey = trackSecret(secrets, mixKey(hashParts(chainHashParts), INITIAL_CHAIN_KEY));
    chainHashParts = [...chainHashParts, devicePublicKey, serverEphemeral];
    chainKey = trackSecret(secrets, mixKey(chainKey, serverEphemeral));

    const ephemeralShared = trackSecret(secrets, sharedSecret(devicePrivateKey, serverEphemeral));
    let derived = keyGen2(chainKey, ephemeralShared);
    secrets.push(...derived);
    chainKey = derived[0];
    const serverStatic = open(derived[1], nonce, sealedStatic, hashParts(chainHashParts));
    if (!timingSafeEqual(serverStatic, Buffer.from(expectedServerPublicKey))) {
      throw new Error("NHP reply came from an unexpected server key");
    }
    chainHashParts = [...chainHashParts, sealedStatic];

    const staticShared = trackSecret(secrets, sharedSecret(devicePrivateKey, serverStatic));
    derived = keyGen2(chainKey, staticShared);
    secrets.push(...derived);
    chainKey = derived[0];
    const timestamp = open(derived[1], nonce, sealedTimestamp, hashParts(chainHashParts));
    chainHashParts = [...chainHashParts, sealedTimestamp];
    derived = keyGen2(chainKey, sealedTimestamp);
    secrets.push(...derived);
    const bodyKey = derived[1];
    const bodyAad = hashParts([...chainHashParts, header.subarray(0, HEADER_COMMON_SIZE)]);
    body =
      sealedBody.byteLength === 0 ? Buffer.alloc(0) : open(bodyKey, nonce, sealedBody, bodyAad);

    const preamble = header.readUInt32BE(0);
    const encodedTypeSize = (preamble ^ header.readUInt32BE(4)) >>> 0;
    const type = (encodedTypeSize >>> 16) & 0xffff;
    const flags = header.readUInt16BE(10);
    if (
      ![NHP_TYPE_ACK, NHP_TYPE_COOKIE].includes(type) ||
      (flags !== 0 && flags !== FLAG_COMPRESS)
    ) {
      throw new Error("NHP reply type or flags are outside the reply profile");
    }
    if (body.byteLength > 0 && (flags & FLAG_COMPRESS) !== 0) {
      const compressed = body;
      try {
        body = inflateSync(compressed, { maxOutputLength: NHP_PACKET_SIZE });
      } finally {
        compressed.fill(0);
      }
    }
    if (body.byteLength > NHP_PACKET_SIZE) {
      throw new Error("NHP reply body exceeds the post-inflate limit");
    }

    const returnedBody = body;
    body = undefined;
    return {
      type,
      flags,
      counter,
      timestampNanos: timestamp.readBigUInt64BE(0),
      body: returnedBody,
    };
  } finally {
    body?.fill(0);
    wipeBuffers(secrets);
  }
}

function validateKey(key: Uint8Array, name: string): void {
  if (key.byteLength !== 32) throw new Error(`${name} must be 32 bytes`);
}

function rawPrivateKey(raw: Uint8Array) {
  const der = Buffer.alloc(X25519_PKCS8_PREFIX.byteLength + raw.byteLength);
  X25519_PKCS8_PREFIX.copy(der);
  der.set(raw, X25519_PKCS8_PREFIX.byteLength);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

function rawPublicKey(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function rawPublicFromPrivate(raw: Uint8Array): Buffer {
  const spki = createPublicKey(rawPrivateKey(raw)).export({ format: "der", type: "spki" });
  return spki.subarray(spki.byteLength - 32);
}

function sharedSecret(privateValue: Uint8Array, publicValue: Uint8Array): Buffer {
  return diffieHellman({
    privateKey: rawPrivateKey(privateValue),
    publicKey: rawPublicKey(publicValue),
  });
}

function hashParts(parts: readonly Uint8Array[]): Buffer {
  const hash = createHash("blake2s256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmac(key: Uint8Array, ...parts: readonly Uint8Array[]): Buffer {
  const mac = createHmac("blake2s256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

function mixKey(key: Uint8Array, input: Uint8Array): Buffer {
  const prk = hmac(key, input);
  const mixed = hmac(prk, Uint8Array.of(1));
  prk.fill(0);
  return mixed;
}

function keyGen2(key: Uint8Array, input: Uint8Array): [Buffer, Buffer] {
  const prk = hmac(key, input);
  const first = hmac(prk, Uint8Array.of(1));
  const second = hmac(prk, first, Uint8Array.of(2));
  prk.fill(0);
  return [first, second];
}

function nonceForCounter(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.byteLength < 16) throw new Error("NHP sealed field is shorter than its tag");
  const ciphertext = sealed.subarray(0, sealed.byteLength - 16);
  const tag = sealed.subarray(sealed.byteLength - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function headerDigest(peerStaticPublicKey: Uint8Array, header: Uint8Array): Buffer {
  return hashParts([INITIAL_HASH, peerStaticPublicKey, header.subarray(0, OFFSET_DIGEST)]);
}

function trackSecret<T extends Uint8Array>(secrets: Uint8Array[], value: T): T {
  secrets.push(value);
  return value;
}

function wipeBuffers(values: readonly Uint8Array[]): void {
  for (const value of values) value.fill(0);
}
