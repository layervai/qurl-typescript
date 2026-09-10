import { afterEach, expect, it, vi } from "vitest";
import conformance from "@layervai/qurl-conformance";
import * as wire from "./nhp-wire.js";
import { fingerprintKey } from "./deployment.js";
import { relayKnock, RelayError } from "./relay.js";

const vector = (
  conformance.relayKnockVectors() as {
    ack: Record<string, string>;
  }
).ack;
const server = Buffer.from(vector.server_static_pub_hex, "hex");
const device = Buffer.from(vector.agent_static_priv_hex, "hex");
const counter = BigInt(`0x${vector.counter_hex}`);
const payload = Buffer.from('{"test":"relay"}');
const url = "https://relay.example.test/base/";
const allowed = ["relay.example.test"];
afterEach(() => vi.restoreAllMocks());

function fixedCounter(value = counter) {
  const build = wire.buildNHPMessage;
  vi.spyOn(wire, "buildNHPMessage").mockImplementation((options) =>
    build({ ...options, counter: value }),
  );
}
function ack() {
  return new Response(Buffer.from(vector.packet_hex, "hex"));
}

it("posts a native knock over HTTPS and authenticates the shared Go ACK", async () => {
  fixedCounter();
  let request: Uint8Array | undefined;
  const fetcher = vi.fn(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(input).toBe(`${url}relay/${fingerprintKey(server)}`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      request = init?.body as Uint8Array;
      expect(request.byteLength).toBeGreaterThan(payload.byteLength);
      return ack();
    },
  );
  const reply = await relayKnock(url, allowed, server, device, payload, { fetch: fetcher });
  expect(reply.type).toBe(wire.NHP_TYPE_ACK);
  expect(reply.counter).toBe(counter);
  expect(Buffer.from(reply.body).toString("hex")).toBe(vector.body_hex);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects a valid ACK for a different request counter", async () => {
  fixedCounter(counter + 1n);
  await expect(
    relayKnock(url, allowed, server, device, payload, { fetch: async () => ack() }),
  ).rejects.toMatchObject({
    name: "RelayError",
    status: 200,
    cause: { message: "NHP relay reply does not match the request" },
  });
});

it("returns a cookie reply without treating it as an ACK", async () => {
  const cookie = {
    type: wire.NHP_TYPE_COOKIE,
    flags: 0,
    counter: 0n,
    timestampNanos: 0n,
    body: Buffer.from("cookie"),
  };
  vi.spyOn(wire, "decryptNHPReply").mockReturnValueOnce(cookie);
  expect(
    await relayKnock(url, allowed, server, device, payload, {
      fetch: async () => ack(),
    }),
  ).toBe(cookie);
});

it("maps HTTP failure without trying to decrypt the error body", async () => {
  await expect(
    relayKnock(url, allowed, server, device, payload, {
      fetch: async () => new Response("unavailable", { status: 503 }),
    }),
  ).rejects.toMatchObject({ name: "RelayError", status: 503 });
});

it("preserves an error status and cancels an oversized proxy error page", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(wire.NHP_PACKET_SIZE + 1));
      },
      cancel,
    }),
    { status: 502 },
  );
  await expect(
    relayKnock(url, allowed, server, device, payload, {
      fetch: async () => response,
    }),
  ).rejects.toMatchObject({ name: "RelayError", status: 502 });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("refuses redirect/network failures without a second request", async () => {
  const fetcher = vi.fn(async () => {
    throw new TypeError("redirect refused");
  });
  await expect(
    relayKnock(url, allowed, server, device, payload, { fetch: fetcher }),
  ).rejects.toBeInstanceOf(RelayError);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects malformed relay URLs before sending", async () => {
  const fetcher = vi.fn();
  await expect(
    relayKnock("not a URL", allowed, server, device, payload, { fetch: fetcher }),
  ).rejects.toMatchObject({ name: "RelayError", status: 0 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([new Uint8Array(3), new Uint8Array(wire.NHP_PACKET_SIZE + 1)])(
  "classifies invalid HTTP 200 relay bodies",
  async (body) => {
    await expect(
      relayKnock(url, allowed, server, device, payload, { fetch: async () => new Response(body) }),
    ).rejects.toMatchObject({ name: "RelayError", status: 200, cause: expect.any(Error) });
  },
);

it.each(["fetch", "body"])("preserves caller cancellation during %s", async (phase) => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled by caller", "AbortError");
  const fetcher = async () => {
    if (phase === "fetch") {
      controller.abort(reason);
      throw reason;
    }
    return new Response(
      new ReadableStream({
        pull(stream) {
          controller.abort(reason);
          stream.error(reason);
        },
      }),
    );
  };
  await expect(
    relayKnock(url, allowed, server, device, payload, {
      signal: controller.signal,
      fetch: fetcher,
    }),
  ).rejects.toBe(reason);
});
