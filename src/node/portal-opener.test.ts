import { describe, expect, it, vi } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import {
  createPortalOpenerWithRuntime,
  PortalConfigurationError,
  PortalStateError,
  type CreatePortalOpenerOptions,
} from "./portal-opener.js";
import { NHP_TYPE_ACK, type NHPMessage } from "./nhp-wire.js";

type Qv2Vectors = {
  classes: {
    transport: {
      vectors: Array<{
        name: string;
        transport_fragment: string;
        canonical_fragment?: string;
      }>;
    };
  };
};
type IssuerVectors = { issuer: { kid: string; spki_der_b64: string } };

const qv2 = conformancePackage.qv2Vectors() as Qv2Vectors;
const issuer = (conformancePackage.issuerSignatureVectors() as IssuerVectors).issuer;
const complete = qv2.classes.transport.vectors.find(
  (vector) => vector.name === "accept_valid_qv2_round_trip",
);
if (!complete?.canonical_fragment) throw new Error("shared complete qv2 vector is missing");
const claims = JSON.parse(
  Buffer.from(complete.canonical_fragment.split(".")[1], "base64url").toString("utf8"),
) as { cell_public_key_b64: string };

const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.alloc(32).toString("base64url")}`;
const RESOURCE_URL = "https://private.example.test/internal/v1/uploads";

function deployment() {
  return {
    issuers: [{ kid: issuer.kid, spki_der_b64: issuer.spki_der_b64 }],
    cells: [
      {
        cell_id: "vector-cell",
        host: "cell.example.test",
        port: 443,
        server_public_key_b64: claims.cell_public_key_b64,
      },
    ],
  } as const;
}

function ack(openSeconds = 900): NHPMessage {
  return {
    type: NHP_TYPE_ACK,
    flags: 0,
    counter: 1n,
    timestampNanos: 2n,
    body: Buffer.from(
      `{"errCode":"0","sessId":18446744073709551615,"opnTime":${openSeconds},` +
        `"redirectUrl":"${RESOURCE_URL}","aspToken":"${TOKEN}"}`,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fixture(fetchImpl: typeof globalThis.fetch = vi.fn(async () => new Response("ok"))) {
  let now = 1_000_000_000n;
  const timers: Array<() => void> = [];
  const timerDelays: number[] = [];
  const knock = vi.fn(async () => ack());
  const runtime = {
    knock,
    fetch: fetchImpl,
    nowNanos: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      timers.push(callback);
      timerDelays.push(delayMs);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
  };
  const options: CreatePortalOpenerOptions = {
    qurl: `https://qurl.link/#${complete.transport_fragment}`,
    transport: "native-only",
    deployment: deployment(),
  };
  const opener = createPortalOpenerWithRuntime(options, runtime);
  return { opener, knock, timers, timerDelays, setNow: (value: bigint) => (now = value) };
}

describe("native portal opener", () => {
  it("loads QURL_DEPLOYMENT once when the opener is constructed", async () => {
    vi.stubEnv("QURL_DEPLOYMENT", JSON.stringify(deployment()));
    const knock = vi.fn(async () => ack());
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: `https://qurl.link/#${complete.transport_fragment}`,
        transport: "native-only",
      },
      {
        knock,
        fetch,
        nowNanos: () => 1_000_000_000n,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      },
    );
    vi.stubEnv("QURL_DEPLOYMENT", "invalid after construction");
    try {
      await opener.start();
      expect(knock).toHaveBeenCalledTimes(1);
    } finally {
      await opener.close();
      vi.unstubAllEnvs();
    }
  });

  it("loads trust and refuses an unknown native cell before network I/O", () => {
    const invalid = deployment();
    const wrong = Buffer.alloc(32, 7).toString("base64url");
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: `https://qurl.link/#${complete.transport_fragment}`,
          transport: "native-only",
          deployment: {
            ...invalid,
            cells: [{ ...invalid.cells[0], server_public_key_b64: wrong }],
          },
        },
        {
          knock: vi.fn(),
          fetch,
          nowNanos: () => 0n,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalConfigurationError);
  });

  it.each([
    ["zero timeout", { timeoutMs: 0 }],
    ["large timeout", { timeoutMs: 60_001 }],
    ["zero address limit", { maxAddresses: 0 }],
    ["fractional address limit", { maxAddresses: 1.5 }],
    ["large address limit", { maxAddresses: 17 }],
  ])("rejects %s before an NHP exchange", (_name, invalid) => {
    const knock = vi.fn();
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: `https://qurl.link/#${complete.transport_fragment}`,
          transport: "native-only",
          deployment: deployment(),
          ...invalid,
        },
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalConfigurationError);
    expect(knock).not.toHaveBeenCalled();
  });

  it("starts one session, binds signing to the exact ACK target, and replaces only qurl_vsession", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock } = fixture(fetchImpl);
    await opener.start();

    const response = await opener.fetch(
      (target) => {
        expect(target.href).toBe(RESOURCE_URL);
        target.pathname = "/attacker-controlled";
        return {
          method: "POST",
          headers: { cookie: `theme=dark; ${"qurl_vsession"}=stale; bad cookie` },
          body: "payload",
        };
      },
      { redirects: "error" },
    );
    expect(await response.text()).toBe("ok");
    expect(knock).toHaveBeenCalledTimes(1);
    expect(sent[0].url).toBe(RESOURCE_URL);
    const headers = sent[0].init.headers as Headers;
    expect(headers.get("cookie")).toBe(`theme=dark; qurl_vsession=${TOKEN}`);
    expect(opener.health()).toMatchObject({ state: "healthy", backgroundAttempts: 0 });
    await opener.close();
    expect(opener.health()).toEqual({ state: "closed" });
  });

  it("rejects caller redirect overrides and signed-request redirects without replay", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: "/other" } }),
    ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch({ redirect: "follow" })).rejects.toBeInstanceOf(PortalStateError);
    await expect(
      opener.fetch(() => ({ method: "PATCH", body: "signed" }), { redirects: "error" }),
    ).rejects.toThrow("fixed signed request");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("cancels a refused redirect body before it reports the fixed-target error", async () => {
    let canceled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { status: 307, headers: { location: "/other" } },
        ),
    ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch({}, { redirects: "error" })).rejects.toThrow("fixed signed request");
    expect(canceled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("rejects an injected fetch that bypasses manual redirect handling and cancels its body", async () => {
    let canceled = false;
    const followed = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { status: 200 },
    );
    Object.defineProperties(followed, {
      redirected: { value: true },
      url: { value: "https://private.example.test/other" },
    });
    const fetchImpl = vi.fn(async () => followed) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch()).rejects.toThrow("bypassed its manual redirect policy");
    expect(canceled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("follows same-origin redirects with Go method rewriting and blocks another origin", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/done" } }))
      .mockResolvedValueOnce(
        new Response("done", { status: 200 }),
      ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch({ method: "POST", body: "payload" })).resolves.toBeInstanceOf(
      Response,
    );
    expect(vi.mocked(fetchImpl).mock.calls[1][0]).toBe("https://private.example.test/done");
    expect(vi.mocked(fetchImpl).mock.calls[1][1]).toMatchObject({ method: "GET", body: undefined });
    await opener.close();

    const crossFetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    ) as unknown as typeof globalThis.fetch;
    const cross = fixture(crossFetch).opener;
    await cross.start();
    await expect(cross.fetch()).rejects.toThrow("outside the authenticated origin");
    expect(crossFetch).toHaveBeenCalledTimes(1);
    await cross.close();
  });

  it("retries renewal only in the background and keeps the valid prior grant", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers } = fixture(fetchImpl);
    knock.mockResolvedValueOnce(ack(4)).mockRejectedValueOnce(new Error("temporary UDP miss"));
    await opener.start();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 1,
      renewalFailure: { kind: "transport" },
    });
    expect(timers).toHaveLength(1);
    await expect(opener.fetch()).resolves.toBeInstanceOf(Response);
    expect(knock).toHaveBeenCalledTimes(2);

    knock.mockResolvedValueOnce(ack(4));
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({ state: "healthy", backgroundAttempts: 0 });
    expect(knock).toHaveBeenCalledTimes(3);
    await opener.close();
  });

  it("uses one open when an expired foreground start meets a background renewal", async () => {
    const pending = deferred<NHPMessage>();
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(1)).mockImplementationOnce(() => pending.promise);
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    setNow(3_000_000_000n);
    const foreground = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "expired", backgroundAttempts: 1 });
    pending.resolve(ack(4));
    await foreground;
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "healthy", backgroundAttempts: 0 });
    await opener.close();
  });

  it("aborts and awaits an active renewal before close completes", async () => {
    let activeSignal: AbortSignal | undefined;
    let active = 0;
    let maximumActive = 0;
    const { opener, knock, timers } = fixture();
    knock.mockResolvedValueOnce(ack(2)).mockImplementationOnce((_cell, _key, _body, options) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      activeSignal = options.signal;
      return new Promise<NHPMessage>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            active--;
            reject(options.signal?.reason);
          },
          { once: true },
        );
      });
    });
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(1);
    const closing = opener.close();
    expect(activeSignal?.aborted).toBe(true);
    await closing;
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toEqual({ state: "closed" });
  });

  it.each([
    ["malformed", Buffer.from("not-json")],
    ["deny", Buffer.from('{"errCode":"7","opnTime":0}')],
  ])("wipes the authenticated %s ACK body after rejection", async (_name, body) => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body,
    });
    await expect(opener.start()).rejects.toBeInstanceOf(Error);
    expect([...body]).toEqual(new Array(body.byteLength).fill(0));
    await opener.close();
  });

  it.each([
    ["fractional session id", "1.0", "900"],
    ["exponent session id", "1e0", "900"],
    ["fractional open time", "1", "900.0"],
    ["exponent open time", "1", "9e2"],
  ])("rejects a noncanonical %s and wipes the reply", async (_name, session, openTime) => {
    const body = Buffer.from(
      `{"errCode":"0","sessId":${session},"opnTime":${openTime},` +
        `"redirectUrl":"${RESOURCE_URL}","aspToken":"${TOKEN}"}`,
    );
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body,
    });
    await expect(opener.start()).rejects.toThrow("unsigned decimal integer");
    expect([...body]).toEqual(new Array(body.byteLength).fill(0));
    await opener.close();
  });

  it("classifies an invalid ACK resource URL as a malformed session reply", async () => {
    const body = Buffer.from(
      `{"errCode":"0","sessId":1,"opnTime":900,"redirectUrl":"://",` + `"aspToken":"${TOKEN}"}`,
    );
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body,
    });
    await expect(opener.start()).rejects.toBeInstanceOf(PortalStateError);
    await opener.close();
  });

  it("clamps a very long grant so Node cannot turn its renewal delay into a hot loop", async () => {
    const { opener, knock, timerDelays } = fixture();
    knock.mockResolvedValueOnce(ack(0xffff_ffff));
    await opener.start();
    expect(timerDelays).toEqual([2_147_483_647]);
    await opener.close();
  });

  it("does not open in fetch when the proactive grant has expired", async () => {
    const { opener, knock, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(1));
    await opener.start();
    setNow(3_000_000_000n);
    const builder = vi.fn(() => ({ method: "POST" }));
    await expect(opener.fetch(builder)).rejects.toThrow("expired");
    expect(builder).not.toHaveBeenCalled();
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });
});
