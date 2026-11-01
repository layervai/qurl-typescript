import { createECDH, createHash, createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { CRID_DOMAIN, cridKeyMatches } from "./crid.js";
import { connectorResourceData } from "./__tests__/client-fixtures.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";
import {
  ERROR_CODE_CLIENT_VALIDATION,
  ERROR_CODE_UNEXPECTED_RESPONSE,
  ValidationError,
} from "./errors.js";

const DEFAULT_LIMIT = 1 << 20;
const CEILING = 16 << 20;
function bodyOfSize(bytes: number): string {
  const prefix = '{"data":{"padding":"';
  const suffix = '"}}';
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const padding = bytes - prefix.length - suffix.length;
  return prefix + alphabet.repeat(Math.ceil(padding / alphabet.length)).slice(0, padding) + suffix;
}
function clientFor(
  body: string,
  limit?: number,
  headers?: NonNullable<ConstructorParameters<typeof Response>[1]>["headers"],
) {
  const fetch = vi.fn(async () => new Response(body, { status: 200, headers }));
  const client = new QURLClient({
    apiKey: "test-key",
    fetch: fetch as typeof globalThis.fetch,
    maxRetries: 0,
    maxResponseBodyBytes: limit,
  });
  return { client, fetch };
}

describe("bounded response-size configuration", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, CEILING + 1])(
    "rejects invalid cap %s before I/O",
    (limit) => {
      const fetch = vi.fn();
      expect(
        () => new QURLClient({ apiKey: "test-key", fetch, maxResponseBodyBytes: limit }),
      ).toThrow(ValidationError);
      try {
        new QURLClient({ apiKey: "test-key", fetch, maxResponseBodyBytes: limit });
      } catch (error) {
        expect(error).toMatchObject({ code: ERROR_CODE_CLIENT_VALIDATION });
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps the shared 1 MiB default", async () => {
    const { client } = clientFor(bodyOfSize(DEFAULT_LIMIT + 1));
    await expect(client.getQuota()).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
  });
  it("accepts an explicit larger bounded cap", async () => {
    const { client, fetch } = clientFor(bodyOfSize(DEFAULT_LIMIT + 1), 2 * DEFAULT_LIMIT);
    await expect(client.getQuota()).resolves.toHaveProperty("padding");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "1", "128"])("counts streamed bytes with Content-Length=%s", (length) => {
    const headers = length === undefined ? undefined : { "content-length": length };
    const exact = clientFor(bodyOfSize(128), 128, headers);
    const over = clientFor(bodyOfSize(129), 128, headers);
    return Promise.all([
      expect(exact.client.getQuota()).resolves.toHaveProperty("padding"),
      expect(over.client.getQuota()).rejects.toMatchObject({
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
      }),
    ]);
  });
  it("uses decoded bytes rather than compressed Content-Length", async () => {
    const { client } = clientFor(bodyOfSize(128), 128, {
      "content-encoding": "gzip",
      "content-length": "256",
    });
    await expect(client.getQuota()).resolves.toHaveProperty("padding");
  });
});

it("accepts the shared 16 MiB ceiling", () => {
  expect(() => new QURLClient({ apiKey: "test-key", maxResponseBodyBytes: CEILING })).not.toThrow();
});

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = 0,
    bits = 0,
    encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return encoded;
}

// Public OpenAPI maxima: 100 resources, 2048-byte URL, 500-byte description,
// ten 50-byte tags, and 256 allowed keys/passkeys with 64-byte passkey names.
async function maximumResourcePage() {
  const keys = [],
    passkeys = [];
  for (let i = 0; i < 256; i++) {
    const digest = createHash("sha256").update(`response-limit-device-${i}`).digest();
    keys.push(digest.toString("base64"));
    const id = base32(digest).slice(0, 16);
    passkeys.push({
      device_id: `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8, 12)}-${id.slice(12)}`,
      name: "<".repeat(64),
      approved_at: "2026-10-31T00:00:00Z",
    });
  }
  const prefix = "https://example.com/?q=";
  const resources = [];
  for (let i = 0; i < 100; i++) {
    const scalar = Buffer.alloc(32);
    scalar.writeUInt32BE(i + 1, 28);
    const key = createECDH("prime256v1");
    key.setPrivateKey(scalar);
    const point = key.getPublicKey();
    const der = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    }).export({ type: "spki", format: "der" });
    const digest = createHash("sha256").update(CRID_DOMAIN).update(der).digest();
    const payload = Buffer.concat([Buffer.from([1]), digest, Buffer.alloc(4)]);
    let crc = 0xffffffff;
    for (const byte of payload.subarray(0, 33)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
    payload.writeUInt32BE(~crc >>> 0, 33);
    const crid = base32(payload);
    expect(await cridKeyMatches(crid, der)).toBe(true);
    resources.push({
      resource_id: der.toString("base64url"),
      crid,
      type: "url",
      status: "active",
      target_url: prefix + "&".repeat(2048 - prefix.length),
      description: "<".repeat(500),
      tags: Array.from({ length: 10 }, (_, n) => `tag-${n}${"a".repeat(45)}`),
      private: true,
      allowed_device_keys: keys,
      allowed_passkeys: passkeys,
      consumer_access: { mode: "keys", version: 1 },
      created_at: "2026-10-31T00:00:00Z",
    });
  }
  expect(new Set(resources.map((x) => x.crid)).size).toBe(100);
  // Match normal Go JSON escaping on the service wire.
  const encode = (data: unknown, meta: unknown) =>
    JSON.stringify({ data, meta })
      .replace(/&/g, "\\u0026")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");
  const body = encode(resources, { page_size: 100, has_more: false });
  const decoded = JSON.parse(body) as { data: typeof resources };
  expect(decoded.data[0]).toEqual(resources[0]);
  expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_LIMIT);
  expect(Buffer.byteLength(body)).toBeLessThan(CEILING);
  expect(Buffer.byteLength(body)).toBe(14771352);
  return { body, resources, encode };
}

describe("large legal collection pages", () => {
  let page: Awaited<ReturnType<typeof maximumResourcePage>>;
  beforeAll(async () => {
    page = await maximumResourcePage();
  });
  it("accepts the maximum bounded-field page with the explicit ceiling", async () => {
    const make = (limit?: number) =>
      new QURLClient({
        apiKey: "test-key",
        maxRetries: 0,
        maxResponseBodyBytes: limit,
        fetch: vi.fn(async () => new Response(page.body)) as typeof globalThis.fetch,
      });
    await expect(make().listResources({ limit: 100 })).rejects.toMatchObject({
      code: ERROR_CODE_UNEXPECTED_RESPONSE,
    });
    await expect(make(CEILING).listResources({ limit: 100 })).resolves.toHaveProperty(
      "resources.length",
      100,
    );
  });
  it("retries a smaller page from the last successful cursor with the same filters", async () => {
    const calls: Array<{ cursor: string | null; limit: string | null }> = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("status")).toBe("active");
      expect(url.searchParams.get("type")).toBe("url");
      calls.push({ cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") });
      if (!url.searchParams.has("cursor"))
        return new Response(
          page.encode([connectorResourceData()], {
            has_more: true,
            next_cursor: "saved",
            page_size: 1,
          }),
        );
      expect(url.searchParams.get("cursor")).toBe("saved");
      if (url.searchParams.get("limit") === "100") return new Response(page.body);
      expect(url.searchParams.get("limit")).toBe("5");
      return new Response(
        page.encode(page.resources.slice(0, 5), {
          has_more: true,
          next_cursor: "after-five",
          page_size: 5,
        }),
      );
    });
    const client = new QURLClient({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: fetch as typeof globalThis.fetch,
    });
    const filters = { status: "active" as const, type: "url" as const };
    const first = await client.listResources({ ...filters, limit: 100 });
    await expect(
      client.listResources({ ...filters, cursor: first.next_cursor, limit: 100 }),
    ).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
    const retry = await client.listResources({ ...filters, cursor: first.next_cursor, limit: 5 });
    expect(retry.resources).toHaveLength(5);
    expect(retry.resources[0]?.resource_id).toBe(page.resources[0]?.resource_id);
    expect(retry.next_cursor).toBe("after-five");
    expect(calls).toEqual([
      { cursor: null, limit: "100" },
      { cursor: "saved", limit: "100" },
      { cursor: "saved", limit: "5" },
    ]);
  });
});

it.each([64, 65])("counts real gzip-decoded bytes at size %i", async (size) => {
  const compressed = gzipSync(bodyOfSize(size));
  expect(compressed.length).toBeGreaterThan(64);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
    response.end(compressed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const client = new QURLClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      maxResponseBodyBytes: 64,
    });
    if (size === 64) await expect(client.getQuota()).resolves.toHaveProperty("padding");
    else
      await expect(client.getQuota()).rejects.toMatchObject({
        code: ERROR_CODE_UNEXPECTED_RESPONSE,
      });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each(["text", "json"])(
  "enforces an explicit cap for materialized %s fetch shims",
  async (mode) => {
    const body = bodyOfSize(129);
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      redirected: false,
      url: "",
      ...(mode === "text"
        ? { text: async () => body }
        : { json: async () => JSON.parse(body) as unknown }),
    } as Response;
    const fetch = vi.fn(async () => response);
    const client = new QURLClient({
      apiKey: "test-key",
      maxResponseBodyBytes: 128,
      maxRetries: 2,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getQuota()).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("rejects a valid oversized unencoded length hint", async () => {
  const { client } = clientFor(bodyOfSize(64), 128, { "content-length": "1024" });
  await expect(client.getQuota()).rejects.toMatchObject({ code: ERROR_CODE_UNEXPECTED_RESPONSE });
});

it.each([429, 503])(
  "retains HTTP status %i when an explicit cap rejects the error body",
  async (status) => {
    const client = new QURLClient({
      apiKey: "test-key",
      maxResponseBodyBytes: 128,
      maxRetries: 0,
      fetch: vi.fn(
        async () => new Response(bodyOfSize(129), { status }),
      ) as typeof globalThis.fetch,
    });
    await expect(client.getQuota()).rejects.toMatchObject({ status });
  },
);
