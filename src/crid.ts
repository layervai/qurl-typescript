// CRID v1 local gate and delivered-key binding, matching qurl-go/crid.
// The byte selects a version/environment/digest width, not a new hash scheme.
// All key matches use the v1 domain separator, as in qurl-go/crid.KeyMatches.
// Unknown nonzero versions remain forwardable; the service owns activation.
// Access binding requires a locally known version and its registered width.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const CRID_DOMAIN = "NHP-QURL-CRID-V1\0";

export function parseCrid(value: unknown, knownVersionOnly = false): Uint8Array | undefined {
  if (typeof value !== "string" || ![47, 60].includes(value.length)) return undefined;
  const bytes = new Uint8Array(Math.floor((value.length * 5) / 8));
  let buffer = 0,
    bits = 0,
    offset = 0;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = buffer >>> bits;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0 || bytes[0] === 0) return undefined;
  const payload = bytes.subarray(0, -4);
  if (knownVersionOnly) {
    const version = bytes[0];
    const width =
      version === 1 || version === 0x81 ? 32 : version === 2 || version === 0x82 ? 24 : 0;
    if (payload.length !== width + 1 || width === 0) return undefined;
  }
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  if (~crc >>> 0 !== new DataView(bytes.buffer).getUint32(bytes.length - 4)) return undefined;
  return payload.subarray(1);
}

export async function cridKeyMatches(value: unknown, der: Uint8Array): Promise<boolean> {
  const expected = parseCrid(value);
  if (!expected) return false;
  const prefix = new TextEncoder().encode(CRID_DOMAIN);
  const message = new Uint8Array(prefix.length + der.length);
  message.set(prefix);
  message.set(der, prefix.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", message));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ digest[i];
  return difference === 0;
}
