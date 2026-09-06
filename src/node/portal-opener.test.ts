import { describe, expect, it, vi } from "vitest";
import { createMatchedQv2Fixture } from "../__tests__/matched-qv2-fixture.js";
import { fingerprintKey, loadPortalDeployment } from "./deployment.js";
import {
  createPortalOpenerWithRuntime,
  portalOpenerTesting,
  PortalConfigurationError,
  PortalDenyError,
  PortalStateError,
  PortalVerificationError,
  type CreatePortalOpenerOptions,
} from "./portal-opener.js";
import { NHP_TYPE_ACK, NHP_TYPE_COOKIE, type NHPMessage } from "./nhp-wire.js";
import { verifyQv2Link } from "./qv2.js";

const matched = createMatchedQv2Fixture();

const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.alloc(32).toString("base64url")}`;
const RESOURCE_URL = "https://private.example.test/internal/v1/uploads";

function deployment() {
  return {
    issuers: [matched.issuer],
    cells: [
      {
        cell_id: "vector-cell",
        host: "cell.example.test",
        port: 443,
        server_public_key_b64: matched.cellPublicKeyB64,
      },
    ],
  } as const;
}

function ack(openSeconds = 900, errCode = "0", resourceUrl = RESOURCE_URL): NHPMessage {
  return {
    type: NHP_TYPE_ACK,
    flags: 0,
    counter: 1n,
    timestampNanos: 2n,
    body: Buffer.from(
      `{"errCode":"${errCode}","sessId":18446744073709551615,"opnTime":${openSeconds},` +
        `"redirectUrl":"${resourceUrl}","aspToken":"${TOKEN}"}`,
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

function fakeTimerQueue() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const pending = new Map<NodeJS.Timeout, () => void>();
  return {
    callbacks,
    delays,
    set(callback: () => void, delayMs: number): NodeJS.Timeout {
      let handle!: NodeJS.Timeout;
      const wrapped = () => {
        pending.delete(handle);
        callback();
      };
      handle = { unref: () => undefined } as unknown as NodeJS.Timeout;
      pending.set(handle, wrapped);
      callbacks.push(wrapped);
      delays.push(delayMs);
      return handle;
    },
    clear(handle: NodeJS.Timeout): void {
      const callback = pending.get(handle);
      pending.delete(handle);
      if (!callback) return;
      const index = callbacks.indexOf(callback);
      if (index !== -1) callbacks.splice(index, 1);
    },
  };
}

function fixture(fetchImpl: typeof globalThis.fetch = vi.fn(async () => new Response("ok"))) {
  let now = 1_000_000_000n;
  const renewal = fakeTimerQueue();
  const deadline = fakeTimerQueue();
  const knock = vi.fn(async () => ack());
  const runtime = {
    knock,
    fetch: fetchImpl,
    nowNanos: () => now,
    randomFraction: () => 0.5,
    setTimer: renewal.set,
    clearTimer: renewal.clear,
    setDeadlineTimer: deadline.set,
    clearDeadlineTimer: deadline.clear,
  };
  const options: CreatePortalOpenerOptions = {
    qurl: matched.qurl,
    transport: "native-only",
    deployment: deployment(),
  };
  const opener = createPortalOpenerWithRuntime(options, runtime);
  return {
    opener,
    knock,
    timers: renewal.callbacks,
    timerDelays: renewal.delays,
    deadlineTimers: deadline.callbacks,
    deadlineDelays: deadline.delays,
    setNow: (value: bigint) => (now = value),
  };
}

describe("native portal opener", () => {
  it("loads QURL_DEPLOYMENT once when the opener is constructed", async () => {
    vi.stubEnv("QURL_DEPLOYMENT", JSON.stringify(deployment()));
    const knock = vi.fn(async () => ack());
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: matched.qurl,
        transport: "native-only",
      },
      {
        knock,
        fetch,
        nowNanos: () => 1_000_000_000n,
        randomFraction: () => 0.5,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: clearTimeout,
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
          qurl: matched.qurl,
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
          randomFraction: () => 0.5,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalConfigurationError);
  });

  it("separates deployment configuration failures from qURL verification failures", () => {
    const runtime = {
      knock: vi.fn(),
      fetch,
      nowNanos: () => 0n,
      randomFraction: () => 0.5,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      setDeadlineTimer: setTimeout,
      clearDeadlineTimer: clearTimeout,
    };
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: matched.qurl,
          transport: "native-only",
          deployment: { ...deployment(), issuers: [] },
        },
        runtime,
      ),
    ).toThrow(PortalConfigurationError);
    expect(() =>
      createPortalOpenerWithRuntime(
        { qurl: "https://qurl.link/#invalid", transport: "native-only", deployment: deployment() },
        runtime,
      ),
    ).toThrow(PortalVerificationError);
    expect(runtime.knock).not.toHaveBeenCalled();
  });

  it("rejects a fragment private key that does not match the signed public key before I/O", () => {
    const knock = vi.fn();
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: matched.mismatchedPrivateKeyQurl,
          transport: "native-only",
          deployment: deployment(),
        },
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          randomFraction: () => 0.5,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalVerificationError);
    expect(knock).not.toHaveBeenCalled();
  });

  it("rejects a fingerprint collision, wipes the device key, and performs no I/O", () => {
    const validated = loadPortalDeployment(deployment());
    const link = verifyQv2Link(matched.qurl, validated.issuers);
    const signedFingerprint = fingerprintKey(link.claims.cellPublicKey);
    const selected = validated.cells.get(signedFingerprint);
    if (!selected) throw new Error("matched fixture cell is missing");
    const collision = {
      ...validated,
      cells: new Map([[signedFingerprint, { ...selected, serverPublicKey: Buffer.alloc(32, 12) }]]),
    };
    const knock = vi.fn();
    expect(() =>
      portalOpenerTesting.constructVerifiedPortalOpener(
        { qurl: matched.qurl, transport: "native-only", deployment: deployment() },
        link,
        collision,
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          randomFraction: () => 0.5,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow("does not match the signed cell key");
    expect(link.devicePrivateKey).toEqual(Buffer.alloc(32));
    expect(knock).not.toHaveBeenCalled();
  });

  it("rejects and wipes a verified qv2 credential that cannot fit one NHP knock", () => {
    const oversized = createMatchedQv2Fixture({ jti: "x".repeat(3_000) });
    const oversizedDeployment = loadPortalDeployment({
      issuers: [oversized.issuer],
      cells: [
        {
          cell_id: "oversized-vector-cell",
          host: "cell.example.test",
          port: 443,
          server_public_key_b64: oversized.cellPublicKeyB64,
        },
      ],
    });
    const link = verifyQv2Link(oversized.qurl, oversizedDeployment.issuers);
    const knock = vi.fn();
    expect(() =>
      portalOpenerTesting.constructVerifiedPortalOpener(
        { qurl: oversized.qurl, transport: "native-only", deployment: deployment() },
        link,
        oversizedDeployment,
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          randomFraction: () => 0.5,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow("cannot fit the native NHP knock envelope");
    expect(link.devicePrivateKey).toEqual(Buffer.alloc(32));
    expect(knock).not.toHaveBeenCalled();
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
          qurl: matched.qurl,
          transport: "native-only",
          deployment: deployment(),
          ...invalid,
        },
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          randomFraction: () => 0.5,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
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

  it("preserves duplicate valid caller cookies after Node normalizes them", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await opener.fetch({
      headers: [
        ["cookie", "theme=dark"],
        ["cookie", "locale=en"],
        ["cookie", "qurl_vsession=stale"],
      ],
    });
    const sent = new Headers(vi.mocked(fetchImpl).mock.calls[0][1]?.headers);
    expect(sent.get("cookie")).toBe(`theme=dark; locale=en; qurl_vsession=${TOKEN}`);
    await opener.close();
  });

  it("rejects fetch before start without content I/O", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await expect(opener.fetch()).rejects.toThrow("must be started");
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("rejects an invalid redirect option without content I/O", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch({}, { redirects: "manual" as never })).rejects.toThrow(
      "must be follow or error",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("makes close idempotent and rejects start and fetch after close", async () => {
    const { opener, knock } = fixture();
    const first = opener.close();
    expect(opener.close()).toBe(first);
    await first;
    await expect(opener.start()).rejects.toThrow("portal opener is closed");
    await expect(opener.fetch()).rejects.toThrow("portal opener is closed");
    expect(knock).not.toHaveBeenCalled();
  });

  it("accepts an explicit empty success errCode like Go", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce(ack(900, ""));
    await expect(opener.start()).resolves.toBeUndefined();
    expect(opener.health()).toMatchObject({ state: "healthy" });
    await opener.close();
  });

  it("wipes mutable token validation bytes on success and rejection", () => {
    const decoded: Buffer[] = [];
    const decode = (part: string) => {
      const value = Buffer.from(part, "base64url");
      decoded.push(value);
      return value;
    };
    expect(() => portalOpenerTesting.validateSessionToken(TOKEN, decode)).not.toThrow();
    expect(decoded).toHaveLength(2);
    expect(decoded.every((value) => value.equals(Buffer.alloc(value.byteLength)))).toBe(true);

    decoded.length = 0;
    expect(() =>
      portalOpenerTesting.validateSessionToken(
        `A.${Buffer.alloc(32).toString("base64url")}`,
        decode,
      ),
    ).toThrow("not canonical base64url");
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(Buffer.alloc(decoded[0].byteLength));
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

  it.each([301, 302, 303])(
    "follows HTTP %i with Go method rewriting on the same origin",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status, headers: { location: "/done" } }))
        .mockResolvedValueOnce(
          new Response("done", { status: 200 }),
        ) as unknown as typeof globalThis.fetch;
      const { opener } = fixture(fetchImpl);
      await opener.start();
      await expect(opener.fetch({ method: "POST", body: "payload" })).resolves.toBeInstanceOf(
        Response,
      );
      expect(vi.mocked(fetchImpl).mock.calls[1][0]).toBe("https://private.example.test/done");
      expect(vi.mocked(fetchImpl).mock.calls[1][1]).toMatchObject({
        method: "GET",
        body: undefined,
      });
      await opener.close();
    },
  );

  it("blocks a redirect to another origin", async () => {
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

  it("uses the Go-compatible 10-request redirect limit", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch()).rejects.toThrow("10-request redirect limit");
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    await opener.close();
  });

  it.each([307, 308])(
    "returns HTTP %i when its request body cannot be replayed",
    async (status) => {
      const fetchImpl = vi.fn(
        async () => new Response(null, { status, headers: { location: "/again" } }),
      ) as unknown as typeof globalThis.fetch;
      const { opener } = fixture(fetchImpl);
      await opener.start();
      const body = new ReadableStream();
      await expect(opener.fetch({ method: "POST", body })).resolves.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await opener.close();
    },
  );

  it("keeps one token snapshot when renewal completes during a redirect chain", async () => {
    let runRenewal: (() => void) | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (vi.mocked(fetchImpl).mock.calls.length === 1) {
        runRenewal?.();
        await new Promise((resolve) => setImmediate(resolve));
        return new Response(null, { status: 302, headers: { location: "/done" } });
      }
      expect(new Headers(init?.headers).get("cookie")).toBe(`qurl_vsession=${TOKEN}`);
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers } = fixture(fetchImpl);
    knock.mockResolvedValueOnce(ack(4)).mockResolvedValueOnce(ack(4));
    await opener.start();
    runRenewal = timers.shift();
    await expect(opener.fetch()).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(knock).toHaveBeenCalledTimes(2);
    await opener.close();
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

  it("bounds a stalled background open and makes its transport failure observable", async () => {
    const { opener, knock, timers, deadlineTimers, deadlineDelays } = fixture();
    knock.mockResolvedValueOnce(ack(60)).mockImplementationOnce((_cell, _key, _body, options) => {
      return new Promise<NHPMessage>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    await opener.start();
    expect(deadlineDelays).toEqual([15_000]);
    expect(deadlineTimers).toHaveLength(0);

    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deadlineDelays).toEqual([15_000, 15_000]);
    expect(deadlineTimers).toHaveLength(1);
    deadlineTimers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 1,
      renewalFailure: { kind: "transport" },
    });
    expect(timers).toHaveLength(1);
    await opener.close();
  });

  it("keeps the first authenticated target when a renewal reply changes it", async () => {
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      sent.push(String(target));
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers } = fixture(fetchImpl);
    knock
      .mockResolvedValueOnce(ack(4))
      .mockResolvedValueOnce(ack(4, "0", "https://private.example.test/changed"));
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "degraded",
      renewalFailure: { kind: "invalid_reply" },
    });
    await opener.fetch();
    expect(sent).toEqual([RESOURCE_URL]);
    await opener.close();
  });

  it("spreads a long-grant retry across the remaining admission lifetime", async () => {
    const { opener, knock, timers, timerDelays, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(900)).mockRejectedValueOnce(new Error("temporary UDP miss"));
    await opener.start();
    expect(timerDelays).toEqual([675_000]);

    setNow(676_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(timerDelays).toEqual([675_000, 49_218]);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 1,
      renewalFailure: { kind: "transport" },
    });
    await opener.close();
  });

  it("preserves all bounded retries inside a short remaining grant window", async () => {
    const { opener, knock, timers, timerDelays, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(2)).mockRejectedValue(new Error("temporary UDP miss"));
    await opener.start();

    setNow(2_500_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timerDelays).toEqual([1_500, 109]);

    setNow(2_609_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timerDelays).toEqual([1_500, 109, 113]);

    setNow(2_722_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timerDelays).toEqual([1_500, 109, 113, 121]);

    setNow(2_843_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(0);
    expect(knock).toHaveBeenCalledTimes(5);
    expect(opener.health()).toMatchObject({ state: "degraded", backgroundAttempts: 4 });
    await opener.close();
  });

  it("classifies an authenticated COOKIE renewal as a busy session", async () => {
    const { opener, knock, timers } = fixture();
    knock.mockResolvedValueOnce(ack(4)).mockResolvedValueOnce({
      type: NHP_TYPE_COOKIE,
      flags: 0,
      counter: 99n,
      timestampNanos: 2n,
      body: Buffer.from("busy"),
    });
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "degraded",
      renewalFailure: { kind: "busy" },
    });
    await opener.close();
  });

  it("classifies a malformed authenticated renewal ACK as an invalid remote reply", async () => {
    const { opener, knock, timers } = fixture();
    knock.mockResolvedValueOnce(ack(4)).mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body: Buffer.from('{"errCode":"0","sessId":0,"opnTime":4}'),
    });
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "degraded",
      renewalFailure: { kind: "invalid_reply" },
    });
    await opener.close();
  });

  it("classifies a locally expired renewal result as a local state failure", async () => {
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockImplementationOnce(async () => {
      setNow(3_000_000_000n);
      return ack(1);
    });
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "degraded",
      renewalFailure: { kind: "local_state" },
    });
    await opener.close();
  });

  it("lets start recover a degraded grant after bounded background retries stop", async () => {
    const { opener, knock, timers } = fixture();
    knock
      .mockResolvedValueOnce(ack(10))
      .mockRejectedValueOnce(new Error("renewal 1"))
      .mockRejectedValueOnce(new Error("renewal 2"))
      .mockRejectedValueOnce(new Error("renewal 3"))
      .mockRejectedValueOnce(new Error("renewal 4"))
      .mockResolvedValueOnce(ack(10));
    await opener.start();
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(timers).toHaveLength(1);
      timers.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(timers).toHaveLength(0);
    expect(opener.health()).toMatchObject({ state: "degraded", backgroundAttempts: 4 });
    await opener.start();
    expect(knock).toHaveBeenCalledTimes(6);
    expect(opener.health()).toMatchObject({ state: "healthy", backgroundAttempts: 0 });
    await opener.close();
  });

  it("replaces stale health when an explicit recovery fails without scheduling a timer", async () => {
    const { opener, knock, timers, setNow } = fixture();
    knock
      .mockResolvedValueOnce(ack(10))
      .mockRejectedValueOnce(new Error("renewal 1"))
      .mockRejectedValueOnce(new Error("renewal 2"))
      .mockRejectedValueOnce(new Error("renewal 3"))
      .mockRejectedValueOnce(new Error("renewal 4"));
    await opener.start();
    for (let attempt = 0; attempt < 4; attempt++) {
      timers.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 4,
      renewalFailure: { kind: "transport" },
    });

    knock.mockResolvedValueOnce({
      type: NHP_TYPE_COOKIE,
      flags: 0,
      counter: 99n,
      timestampNanos: 2n,
      body: Buffer.from("busy"),
    });
    await expect(opener.start()).rejects.toThrow("platform is busy");
    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 0,
      renewalFailure: { kind: "busy" },
    });
    expect(timers).toHaveLength(0);

    setNow(12_000_000_000n);
    await expect(opener.fetch()).rejects.toMatchObject({
      cause: { name: "PortalBusyError" },
    });
    await opener.close();
  });

  it("cancels a pending background retry before explicit recovery resets its budget", async () => {
    const { opener, knock, timers } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockRejectedValueOnce(new Error("renewal failed"));
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(1);
    expect(opener.health()).toMatchObject({ state: "degraded", backgroundAttempts: 1 });

    knock.mockResolvedValueOnce({
      type: NHP_TYPE_COOKIE,
      flags: 0,
      counter: 99n,
      timestampNanos: 2n,
      body: Buffer.from("busy"),
    });
    await expect(opener.start()).rejects.toThrow("platform is busy");
    expect(timers).toHaveLength(0);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      backgroundAttempts: 0,
      renewalFailure: { kind: "busy" },
    });
    expect(knock).toHaveBeenCalledTimes(3);
    await opener.close();
  });

  it("keeps a pending retry when an explicit recovery signal is already aborted", async () => {
    const { opener, knock, timers } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockRejectedValueOnce(new Error("renewal failed"));
    await opener.start();
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(1);

    const reason = new Error("lifecycle stopped");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(opener.start({ signal: controller.signal })).rejects.toBe(reason);
    expect(timers).toHaveLength(1);
    expect(opener.health()).toMatchObject({ state: "degraded", backgroundAttempts: 1 });
    expect(knock).toHaveBeenCalledTimes(2);
    await opener.close();
  });

  it("keeps Go idempotency when start receives an aborted signal for a healthy grant", async () => {
    const { opener, knock } = fixture();
    await opener.start();
    const controller = new AbortController();
    controller.abort(new Error("late lifecycle cancellation"));
    await expect(opener.start({ signal: controller.signal })).resolves.toBeUndefined();
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("measures grant lifetime and renewal from before the native exchange", async () => {
    const { opener, knock, setNow, timerDelays } = fixture();
    knock.mockImplementationOnce(async () => {
      setNow(2_000_000_000n);
      return ack(2);
    });
    await opener.start();
    expect(opener.health()).toMatchObject({ state: "healthy", expiresInMs: 1_000 });
    expect(timerDelays).toEqual([750]);
    await opener.close();
  });

  it("rejects a grant that expires during the native exchange", async () => {
    const { opener, knock, setNow } = fixture();
    knock.mockImplementationOnce(async () => {
      setNow(2_000_000_000n);
      return ack(1);
    });
    await expect(opener.start()).rejects.toThrow("expired before it became usable");
    expect(opener.health()).toEqual({ state: "idle" });
    await opener.close();
  });

  it("reports expiry from the exact nanosecond boundary and rounds only display", async () => {
    const { opener, knock, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(1));
    await opener.start();
    setNow(1_999_999_999n);
    expect(opener.health()).toMatchObject({ state: "healthy", expiresInMs: 1 });
    setNow(2_000_000_000n);
    expect(opener.health()).toMatchObject({ state: "expired", expiresInMs: 0 });
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
    ["negative-zero deny", Buffer.from('{"errCode":"7","opnTime":-0}')],
  ])("wipes the authenticated %s ACK body after rejection", async (_name, body) => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body,
    });
    const start = opener.start();
    if (_name === "negative-zero deny") {
      await expect(start).rejects.toThrow("opnTime must be canonical zero");
    } else if (_name === "deny") {
      await expect(start).rejects.toMatchObject<PortalDenyError>({
        name: "PortalDenyError",
        errCode: "7",
      });
    } else {
      await expect(start).rejects.toBeInstanceOf(Error);
    }
    expect([...body]).toEqual(new Array(body.byteLength).fill(0));
    await opener.close();
  });

  it.each(["01", "-7", "busy", " 7"])(
    "rejects noncanonical decimal deny errCode %j without reflecting it",
    async (errCode) => {
      const body = Buffer.from(JSON.stringify({ errCode, opnTime: 0 }));
      const { opener, knock } = fixture();
      knock.mockResolvedValueOnce({
        type: NHP_TYPE_ACK,
        flags: 0,
        counter: 1n,
        timestampNanos: 2n,
        body,
      });
      await expect(opener.start()).rejects.toThrow("deny code is not canonical decimal");
      expect([...body]).toEqual(new Array(body.byteLength).fill(0));
      await opener.close();
    },
  );

  it.each([
    ["session id", '{"errCode":"7","sessId":1,"opnTime":0}'],
    ["application token", '{"errCode":"7","opnTime":0,"aspToken":"secret"}'],
  ])("reports a deny ACK %s as a forbidden success capability", async (_name, encoded) => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body: Buffer.from(encoded),
    });
    await expect(opener.start()).rejects.toThrow("contains success capability fields");
    await opener.close();
  });

  it("matches Go by treating a deny redirect URL as non-authoritative metadata", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body: Buffer.from('{"errCode":"7","opnTime":0,"redirectUrl":"https://ignored.example.test"}'),
    });
    await expect(opener.start()).rejects.toMatchObject({ name: "PortalDenyError", errCode: "7" });
    await opener.close();
  });

  it("matches Go by accepting an explicit empty deny application token", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body: Buffer.from('{"errCode":"7","opnTime":0,"aspToken":""}'),
    });
    await expect(opener.start()).rejects.toMatchObject({ name: "PortalDenyError", errCode: "7" });
    await opener.close();
  });

  it("accepts an unrecognized canonical decimal deny errCode like Go", async () => {
    const body = Buffer.from('{"errCode":"999999999999999999999999","opnTime":0}');
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body,
    });
    await expect(opener.start()).rejects.toMatchObject({
      name: "PortalDenyError",
      errCode: "999999999999999999999999",
    });
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
    const { opener, knock, timers, timerDelays, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(0xffff_ffff)).mockRejectedValueOnce(new Error("temporary"));
    await opener.start();
    expect(timerDelays).toEqual([2_147_483_647]);
    setNow(2_147_484_647_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timerDelays).toEqual([2_147_483_647, 2_147_483_647]);
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
