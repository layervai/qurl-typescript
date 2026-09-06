import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeUdpTesting } from "./native-udp.js";
import { NHP_PACKET_SIZE, NHP_TYPE_ACK, NHP_TYPE_COOKIE } from "./nhp-wire.js";

const servers: Array<ReturnType<typeof createSocket>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function replyServer(reply: Uint8Array): Promise<number> {
  const server = createSocket("udp4");
  servers.push(server);
  server.on("message", (_message, sender) => {
    server.send(reply, sender.port, sender.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("native UDP DNS fence", () => {
  it.each([
    ["8.8.8.8", 4, true],
    ["127.0.0.1", 4, false],
    ["10.0.0.1", 4, false],
    ["169.254.169.254", 4, false],
    ["203.0.113.1", 4, false],
    ["2606:4700:4700::1111", 6, true],
    ["2001:4c00::1", 6, true],
    ["2001:4e00::1", 6, false],
    ["::1", 6, false],
    ["fc00::1", 6, false],
    ["2001:db8::1", 6, false],
  ] as const)("classifies %s", (address, family, accepted) => {
    expect(nativeUdpTesting.isPublicAddress(address, family)).toBe(accepted);
  });
});

describe("native UDP exchange", () => {
  it("sends and receives one bounded UDP datagram", async () => {
    const port = await replyServer(Buffer.from([1, 2, 3]));
    await expect(
      nativeUdpTesting.exchangeDatagram("127.0.0.1", 4, port, Buffer.from([9]), 1_000),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("treats an oversized received datagram as a terminal reply attempt", async () => {
    const port = await replyServer(Buffer.alloc(NHP_PACKET_SIZE + 1));
    await expect(
      nativeUdpTesting.exchangeDatagram("127.0.0.1", 4, port, Buffer.from([9]), 1_000),
    ).rejects.toThrow("too large");
  });

  it("rejects an already aborted exchange before it creates a socket", async () => {
    const reason = new Error("stop");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      nativeUdpTesting.exchangeDatagram(
        "127.0.0.1",
        4,
        443,
        Buffer.from([9]),
        1_000,
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });
});

describe("native knock address policy", () => {
  function fixture() {
    const packet = Buffer.from([7, 8, 9]);
    const replyBody = Buffer.from("reply");
    const buildMessage = vi.fn(() => ({ packet, counter: 7n }));
    const resolveAddresses = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 as const },
      { address: "1.1.1.1", family: 4 as const },
    ]);
    const exchange = vi.fn(async () => new Uint8Array([1]));
    const decryptReply = vi.fn(() => ({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 7n,
      timestampNanos: 1n,
      body: replyBody,
    }));
    const cell = {
      host: "cell.example.test",
      port: 443 as const,
      serverPublicKey: Buffer.alloc(32, 2),
    };
    const open = () =>
      nativeUdpTesting.nativeKnockWithRuntime(
        cell,
        Buffer.alloc(32, 1),
        Buffer.from("knock"),
        {},
        { buildMessage, resolveAddresses, exchange, decryptReply },
      );
    return { packet, replyBody, buildMessage, resolveAddresses, exchange, decryptReply, open };
  }

  it("falls through only after a local socket failure and wipes the request packet", async () => {
    const item = fixture();
    item.exchange
      .mockRejectedValueOnce(nativeUdpTesting.socketExchangeError(new Error("local miss")))
      .mockResolvedValueOnce(new Uint8Array([2]));
    await expect(item.open()).resolves.toMatchObject({ type: NHP_TYPE_ACK, counter: 7n });
    expect(item.exchange).toHaveBeenCalledTimes(2);
    expect([...item.packet]).toEqual([0, 0, 0]);
  });

  it("does not send the knock to another address after a received reply fails", async () => {
    const item = fixture();
    item.decryptReply.mockImplementationOnce(() => {
      throw new Error("reply authentication failed");
    });
    await expect(item.open()).rejects.toThrow("reply authentication failed");
    expect(item.exchange).toHaveBeenCalledTimes(1);
    expect([...item.packet]).toEqual([0, 0, 0]);
  });

  it("rejects an ACK counter mismatch, wipes its body, and does not try another address", async () => {
    const item = fixture();
    item.decryptReply.mockReturnValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 8n,
      timestampNanos: 1n,
      body: item.replyBody,
    });
    await expect(item.open()).rejects.toThrow("counter");
    expect(item.exchange).toHaveBeenCalledTimes(1);
    expect([...item.replyBody]).toEqual(new Array(item.replyBody.byteLength).fill(0));
  });

  it("returns a COOKIE without applying the ACK counter rule", async () => {
    const item = fixture();
    item.decryptReply.mockReturnValueOnce({
      type: NHP_TYPE_COOKIE,
      flags: 0,
      counter: 8n,
      timestampNanos: 1n,
      body: item.replyBody,
    });
    await expect(item.open()).resolves.toMatchObject({ type: NHP_TYPE_COOKIE, counter: 8n });
    expect(item.exchange).toHaveBeenCalledTimes(1);
  });
});
