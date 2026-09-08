import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import conformancePackage from "@layervai/qurl-conformance";
import { getEventListeners } from "node:events";
import { Readable } from "node:stream";
import { createMatchedQv2Fixture } from "../__tests__/matched-qv2-fixture.js";
import { fingerprintKey, loadPortalDeployment } from "./deployment.js";
import {
  createPortalOpenerWithRuntime,
  portalOpenerTesting,
  PortalBusyError,
  PortalConfigurationError,
  PortalDenyError,
  PortalInvalidReplyError,
  PortalOpenerClosedError,
  PortalOpenerNotReadyError,
  PortalOpenerNotStartedError,
  PortalOpenTimeoutError,
  PortalRedirectError,
  PortalStateError,
  PortalTargetChangedError,
  PortalTooManyRedirectsError,
  PortalVerificationError,
  type CreatePortalOpenerOptions,
} from "./portal-opener.js";
import { NHP_TYPE_ACK, NHP_TYPE_COOKIE, type NHPMessage } from "./nhp-wire.js";
import { verifyQv2Link } from "./qv2.js";

const matched = createMatchedQv2Fixture();
const conformance = conformancePackage as typeof import("@layervai/qurl-conformance");

type Qv2TransportVector = {
  readonly name: string;
  readonly expect: "accept" | "reject";
  readonly transport_fragment?: string;
  readonly canonical_fragment?: string;
};

type Qv2ConformanceFile = {
  readonly classes: {
    readonly transport?: { readonly vectors: readonly Qv2TransportVector[] };
  };
};

type IssuerConformanceFile = {
  readonly issuer: {
    readonly kid: string;
    readonly spki_der_b64: string;
  };
};

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

function ack(
  openSeconds = 900,
  errCode = "0",
  resourceUrl = RESOURCE_URL,
  token = TOKEN,
): NHPMessage {
  return {
    type: NHP_TYPE_ACK,
    flags: 0,
    counter: 1n,
    timestampNanos: 2n,
    body: Buffer.from(
      `{"errCode":"${errCode}","sessId":18446744073709551615,"opnTime":${openSeconds},` +
        `"redirectUrl":"${resourceUrl}","aspToken":"${token}"}`,
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

function trackedRequestBody() {
  let canceled = false;
  return {
    body: new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    wasCanceled: () => canceled,
  };
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

function fixture(
  fetchImpl: typeof globalThis.fetch = vi.fn(async () => new Response("ok")),
  optionOverrides: Partial<CreatePortalOpenerOptions> = {},
) {
  let now = 1_000_000_000n;
  let nowReader = () => now;
  const renewal = fakeTimerQueue();
  const deadline = fakeTimerQueue();
  const knock = vi.fn(async () => ack());
  const runtime = {
    knock,
    fetch: fetchImpl,
    nowNanos: () => nowReader(),
    nowEpochMs: () => Number(now / 1_000_000n),
    setTimer: renewal.set,
    clearTimer: renewal.clear,
    setDeadlineTimer: deadline.set,
    clearDeadlineTimer: deadline.clear,
  };
  const options: CreatePortalOpenerOptions = {
    qurl: matched.qurl,
    deployment: deployment(),
    ...optionOverrides,
  };
  const opener = createPortalOpenerWithRuntime(options, runtime);
  return {
    opener,
    knock,
    timers: renewal.callbacks,
    timerDelays: renewal.delays,
    deadlineTimers: deadline.callbacks,
    deadlineDelays: deadline.delays,
    setNow: (value: bigint) => {
      now = value;
      nowReader = () => now;
    },
    setNowReader: (reader: () => bigint) => (nowReader = reader),
  };
}

describe("native portal opener", () => {
  it("does no I/O at construction and resolves QURL_DEPLOYMENT during start", async () => {
    vi.stubEnv("QURL_DEPLOYMENT", "invalid before start");
    const knock = vi.fn(async () => ack());
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: matched.qurl,
      },
      {
        knock,
        fetch,
        nowNanos: () => 1_000_000_000n,
        nowEpochMs: () => 1_000,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: clearTimeout,
      },
    );
    try {
      expect(opener.health()).toMatchObject({ state: "new", ready: false });
      expect(knock).not.toHaveBeenCalled();
      await expect(opener.start()).rejects.toBeInstanceOf(PortalConfigurationError);
      expect(opener.health()).toMatchObject({
        state: "degraded",
        ready: false,
        lastFailureClass: "open_failed",
        consecutiveFailures: 1,
      });
      vi.stubEnv("QURL_DEPLOYMENT", JSON.stringify(deployment()));
      await opener.start();
      expect(knock).toHaveBeenCalledTimes(1);
    } finally {
      await opener.close();
      vi.unstubAllEnvs();
    }
  });

  it("pins resolved deployment trust after the first successful open", async () => {
    vi.stubEnv("QURL_DEPLOYMENT", JSON.stringify(deployment()));
    let now = 1_000_000_000n;
    const renewal = fakeTimerQueue();
    const deadline = fakeTimerQueue();
    const knock = vi.fn(async () => ack(10));
    const opener = createPortalOpenerWithRuntime(
      { qurl: matched.qurl },
      {
        knock,
        fetch,
        nowNanos: () => now,
        nowEpochMs: () => Number(now / 1_000_000n),
        setTimer: renewal.set,
        clearTimer: renewal.clear,
        setDeadlineTimer: deadline.set,
        clearDeadlineTimer: deadline.clear,
      },
    );
    try {
      await opener.start();
      vi.stubEnv("QURL_DEPLOYMENT", "invalid after first open");
      now = 6_000_000_000n;
      renewal.callbacks.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(knock).toHaveBeenCalledTimes(2);
      expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    } finally {
      await opener.close();
      vi.unstubAllEnvs();
    }
  });

  it("loads trust and refuses an unknown native cell before network I/O", async () => {
    const invalid = deployment();
    const wrong = Buffer.alloc(32, 7).toString("base64url");
    const knock = vi.fn();
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: matched.qurl,
        deployment: {
          ...invalid,
          cells: [{ ...invalid.cells[0], server_public_key_b64: wrong }],
        },
      },
      {
        knock,
        fetch,
        nowNanos: () => 0n,
        nowEpochMs: () => 0,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: clearTimeout,
      },
    );
    await expect(opener.start()).rejects.toBeInstanceOf(PortalConfigurationError);
    expect(knock).not.toHaveBeenCalled();
    await opener.close();
  });

  it("separates deployment configuration failures from qURL verification failures", async () => {
    const runtime = {
      knock: vi.fn(),
      fetch,
      nowNanos: () => 0n,
      nowEpochMs: () => 0,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      setDeadlineTimer: setTimeout,
      clearDeadlineTimer: clearTimeout,
    };
    const invalidDeployment = createPortalOpenerWithRuntime(
      {
        qurl: matched.qurl,
        deployment: { ...deployment(), issuers: [] },
      },
      runtime,
    );
    await expect(invalidDeployment.start()).rejects.toBeInstanceOf(PortalConfigurationError);
    await invalidDeployment.close();
    const invalidQurl = createPortalOpenerWithRuntime(
      { qurl: "https://qurl.link/#invalid", deployment: deployment() },
      runtime,
    );
    await expect(invalidQurl.start()).rejects.toBeInstanceOf(PortalVerificationError);
    await invalidQurl.close();
    expect(runtime.knock).not.toHaveBeenCalled();
  });

  it("rejects a fragment private key that does not match the signed public key before I/O", async () => {
    const knock = vi.fn();
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: matched.mismatchedPrivateKeyQurl,
        deployment: deployment(),
      },
      {
        knock,
        fetch,
        nowNanos: () => 0n,
        nowEpochMs: () => 0,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: clearTimeout,
      },
    );
    await expect(opener.start()).rejects.toBeInstanceOf(PortalVerificationError);
    expect(knock).not.toHaveBeenCalled();
    await opener.close();
  });

  it("rejects a fingerprint collision after exact cell-key comparison", () => {
    const validated = loadPortalDeployment(deployment());
    const link = verifyQv2Link(matched.qurl, validated.issuers);
    const signedFingerprint = fingerprintKey(link.claims.cellPublicKey);
    const selected = validated.cells.get(signedFingerprint);
    if (!selected) throw new Error("matched fixture cell is missing");
    const collision = {
      ...validated,
      cells: new Map([[signedFingerprint, { ...selected, serverPublicKey: Buffer.alloc(32, 12) }]]),
    };
    try {
      expect(() => portalOpenerTesting.validatedCellForLink(link, collision)).toThrow(
        "does not match the signed cell key",
      );
    } finally {
      link.devicePrivateKey.fill(0);
    }
  });

  it("rejects a verified qv2 credential that cannot fit one NHP knock", async () => {
    const oversized = createMatchedQv2Fixture({ jti: "x".repeat(3_000) });
    const rawOversizedDeployment = {
      issuers: [oversized.issuer],
      cells: [
        {
          cell_id: "oversized-vector-cell",
          host: "cell.example.test",
          port: 443,
          server_public_key_b64: oversized.cellPublicKeyB64,
        },
      ],
    };
    const knock = vi.fn();
    const opener = createPortalOpenerWithRuntime(
      { qurl: oversized.qurl, deployment: rawOversizedDeployment },
      {
        knock,
        fetch,
        nowNanos: () => 0n,
        nowEpochMs: () => 0,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: clearTimeout,
      },
    );
    await expect(opener.start()).rejects.toThrow("cannot fit the native NHP knock envelope");
    expect(knock).not.toHaveBeenCalled();
    await opener.close();
  });

  it("opens the released qv2t1 vector through the complete public contract", async () => {
    const qv2 = conformance.qv2Vectors() as Qv2ConformanceFile;
    const issuer = (conformance.issuerSignatureVectors() as IssuerConformanceFile).issuer;
    const vector = (qv2.classes.transport?.vectors ?? []).find(
      (candidate) => candidate.name === "accept_valid_qv2_round_trip",
    );
    if (
      vector?.expect !== "accept" ||
      typeof vector.transport_fragment !== "string" ||
      typeof vector.canonical_fragment !== "string"
    ) {
      throw new Error("released qv2 transport accept vector is missing");
    }
    const [, claimsB64, secretB64, signatureB64] = vector.canonical_fragment.split(".");
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8")) as {
      cell_public_key_b64: string;
      resource_public_key_b64: string;
    };
    const secret = JSON.parse(Buffer.from(secretB64, "base64url").toString("utf8")) as {
      qurl_user_private_key_b64: string;
    };
    let observed:
      | {
          cellKey: Buffer;
          deviceKey: Buffer;
          body: Record<string, unknown>;
        }
      | undefined;
    const knock = vi.fn(async (cell, deviceKey: Uint8Array, body: Uint8Array) => {
      observed = {
        cellKey: Buffer.from(cell.serverPublicKey),
        deviceKey: Buffer.from(deviceKey),
        body: JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>,
      };
      return ack();
    });
    const timer = fakeTimerQueue();
    const deadline = fakeTimerQueue();
    const opener = createPortalOpenerWithRuntime(
      {
        qurl: `https://qurl.link/#${vector.transport_fragment}`,
        deployment: {
          issuers: [{ kid: issuer.kid, spki_der_b64: issuer.spki_der_b64 }],
          cells: [
            {
              cell_id: "vector-cell",
              host: "cell.example.test",
              port: 443,
              server_public_key_b64: claims.cell_public_key_b64,
            },
          ],
        },
      },
      {
        knock,
        fetch,
        nowNanos: () => 1_000_000_000n,
        nowEpochMs: () => 1_000,
        setTimer: timer.set,
        clearTimer: timer.clear,
        setDeadlineTimer: deadline.set,
        clearDeadlineTimer: deadline.clear,
      },
    );

    try {
      await opener.start();
      expect(observed).toBeDefined();
      expect(observed!.cellKey).toEqual(Buffer.from(claims.cell_public_key_b64, "base64url"));
      expect(observed!.deviceKey).toEqual(
        Buffer.from(secret.qurl_user_private_key_b64, "base64url"),
      );
      expect(observed!.body).toMatchObject({
        headerType: 1,
        aspId: "qurl",
        resId: claims.resource_public_key_b64,
        usrData: {
          qurl_claims_b64: claimsB64,
          qurl_issuer_sig_b64: signatureB64,
        },
      });
      expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    } finally {
      await opener.close();
    }
  });

  it.each([
    ["zero open timeout", { openTimeoutMs: 0 }],
    ["sub-millisecond open timeout", { openTimeoutMs: 0.5 }],
    ["large open timeout", { openTimeoutMs: 60_001 }],
  ])("rejects %s before an NHP exchange", (_name, invalid) => {
    const knock = vi.fn();
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: matched.qurl,
          deployment: deployment(),
          ...invalid,
        },
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          nowEpochMs: () => 0,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalConfigurationError);
    expect(knock).not.toHaveBeenCalled();
  });

  it("rejects an invalid protected-content fetch before an NHP exchange", () => {
    const knock = vi.fn();
    expect(() =>
      createPortalOpenerWithRuntime(
        {
          qurl: matched.qurl,
          deployment: deployment(),
          fetch: "not a function" as never,
        },
        {
          knock,
          fetch,
          nowNanos: () => 0n,
          nowEpochMs: () => 0,
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          setDeadlineTimer: setTimeout,
          clearDeadlineTimer: clearTimeout,
        },
      ),
    ).toThrow(PortalConfigurationError);
    expect(knock).not.toHaveBeenCalled();
  });

  it("loads without global Fetch when the caller supplies protected-content Fetch", async () => {
    const savedFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    vi.resetModules();
    try {
      const isolated = await import("./portal-opener.js");
      const customFetch = vi.fn(async () => new Response("ok")) as typeof globalThis.fetch;
      const opener = isolated.createPortalOpener({
        qurl: matched.qurl,
        deployment: deployment(),
        fetch: customFetch,
      });
      expect(opener.health()).toMatchObject({ state: "new", ready: false });
      expect(customFetch).not.toHaveBeenCalled();
      await opener.close();
    } finally {
      vi.stubGlobal("fetch", savedFetch);
      vi.resetModules();
    }
  });

  it("shares one initial open and reports starting health", async () => {
    const pending = deferred<NHPMessage>();
    const { opener, knock } = fixture();
    knock.mockImplementationOnce(() => pending.promise);
    const first = opener.start();
    const second = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(1);
    expect(opener.health()).toMatchObject({ state: "starting", ready: false });
    pending.resolve(ack());
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    await opener.close();
  });

  it("lets the first Start signal cancel the shared initial open without a health failure", async () => {
    const { opener, knock } = fixture();
    knock.mockImplementationOnce((_cell, _key, _body, options) => {
      return new Promise<NHPMessage>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const reason = new Error("startup canceled");
    const first = opener.start({ signal: controller.signal });
    const second = opener.start();
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    expect(opener.health()).toEqual({
      state: "new",
      ready: false,
      expiresAt: undefined,
      renewAt: undefined,
      lastOpenSucceededAt: undefined,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    await opener.close();
  });

  it("preserves degraded health when the first caller cancels recovery", async () => {
    const initialFailure = new Error("initial open failed");
    const { opener, knock } = fixture();
    knock.mockRejectedValueOnce(initialFailure).mockImplementationOnce(
      (_cell, _key, _body, options) =>
        new Promise<NHPMessage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(opener.start()).rejects.toBe(initialFailure);
    const beforeRecovery = opener.health();
    expect(beforeRecovery).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });

    const controller = new AbortController();
    const reason = new Error("recovery canceled");
    const recovery = opener.start({ signal: controller.signal });
    controller.abort(reason);
    await expect(recovery).rejects.toBe(reason);
    expect(opener.health()).toEqual(beforeRecovery);
    expect(knock).toHaveBeenCalledTimes(2);
    await opener.close();
  });

  it("lets a joined Start signal cancel only that caller's wait", async () => {
    const pending = deferred<NHPMessage>();
    const { opener, knock } = fixture();
    knock.mockImplementationOnce(() => pending.promise);
    const first = opener.start();
    const controller = new AbortController();
    const reason = new Error("joined wait canceled");
    const joined = opener.start({ signal: controller.signal });
    controller.abort(reason);

    await expect(joined).rejects.toBe(reason);
    pending.resolve(ack());
    await expect(first).resolves.toBeUndefined();
    expect(knock).toHaveBeenCalledTimes(1);
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    await opener.close();
  });

  it("keeps a failed Start single-flight through open-promise cleanup", async () => {
    const failure = new Error("initial open failed");
    const knock = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(ack());
    const follower = deferred<void>();
    let scheduleFollower = true;
    let opener!: ReturnType<typeof createPortalOpenerWithRuntime>;
    opener = createPortalOpenerWithRuntime(
      { qurl: matched.qurl, deployment: deployment() },
      {
        knock,
        fetch,
        nowNanos: () => 1_000_000_000n,
        nowEpochMs: () => 1_000,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        setDeadlineTimer: setTimeout,
        clearDeadlineTimer: (timer) => {
          clearTimeout(timer);
          if (!scheduleFollower) return;
          scheduleFollower = false;
          globalThis.queueMicrotask(() => opener.start().then(follower.resolve, follower.reject));
        },
      },
    );

    const first = opener.start();
    await expect(first).rejects.toBe(failure);
    await expect(follower.promise).rejects.toBe(failure);
    expect(knock).toHaveBeenCalledTimes(1);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    await opener.close();
  });

  it("cancels and joins an initial open during close", async () => {
    let deviceKey: Uint8Array | undefined;
    let body: Uint8Array | undefined;
    const { opener, knock } = fixture();
    knock.mockImplementationOnce((_cell, key, knockBody, options) => {
      deviceKey = key;
      body = knockBody;
      return new Promise<NHPMessage>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const start = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    await opener.close();
    const closed = await start.catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(PortalOpenerClosedError);
    expect((closed as Error).cause).toBeInstanceOf(PortalOpenerClosedError);
    expect(deviceKey).toEqual(Buffer.alloc(32));
    expect(body).toEqual(Buffer.alloc(body?.byteLength ?? 0));
    expect(opener.health()).toMatchObject({
      state: "closed",
      ready: false,
      expiresAt: undefined,
      renewAt: undefined,
      lastOpenSucceededAt: undefined,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
  });

  it("applies the whole-open timeout to the initial Start", async () => {
    const { opener, knock, deadlineTimers, deadlineDelays } = fixture();
    knock.mockImplementationOnce((_cell, _key, _body, options) => {
      return new Promise<NHPMessage>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const start = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deadlineDelays).toEqual([15_000]);
    deadlineTimers.shift()!();
    await expect(start).rejects.toBeInstanceOf(PortalOpenTimeoutError);
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    await opener.close();
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
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    const renderedHealth = JSON.stringify(opener.health());
    expect(renderedHealth).not.toContain(matched.qurl);
    expect(renderedHealth).not.toContain(RESOURCE_URL);
    expect(renderedHealth).not.toContain(TOKEN);
    await opener.close();
    expect(opener.health()).toMatchObject({ state: "closed", ready: false });
  });

  it("fetches escaped descendants from the cached session and preserves base URL state", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock } = fixture(fetchImpl);
    knock.mockResolvedValueOnce(
      ack(900, "0", "https://private.example.test/api/detect/?tenant=example"),
    );
    await opener.start();

    const response = await opener.fetchDescendant(
      ["eib_example", "team alpha%beta", "%2e%2e"],
      (target) => {
        expect(target.href).toBe(
          "https://private.example.test/api/detect/eib_example/team%20alpha%25beta/%252e%252e?tenant=example",
        );
        // The builder can mutate only its disposable copy.
        target.hostname = "attacker-controlled.example.test";
        target.pathname = "/changed";
        return { method: "POST" };
      },
      { redirects: "error" },
    );

    expect(response.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(
      "https://private.example.test/api/detect/eib_example/team%20alpha%25beta/%252e%252e?tenant=example",
    );
    expect(new URL(sent[0].url).host).toBe("private.example.test");
    expect(knock).toHaveBeenCalledTimes(1);

    await expect(
      opener.fetchDescendant(["eib_example"], () => ({
        headers: { host: "attacker-controlled.example.test" },
      })),
    ).rejects.toBeInstanceOf(PortalConfigurationError);
    expect(sent).toHaveLength(1);
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("inserts one separator and escapes UTF-8 and control bytes", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const { opener, knock } = fixture(fetchImpl);
    knock.mockResolvedValueOnce(ack(900, "0", "https://private.example.test/api/detect"));
    await opener.start();

    await opener.fetchDescendant(["café", "line\r\nX: value"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(
      "https://private.example.test/api/detect/caf%C3%A9/line%0D%0AX:%20value",
    );
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it.each([
    ["missing list", undefined],
    ["null list", null],
    ["empty list", []],
    ["null segment", [null]],
    ["empty segment", [""]],
    ["dot segment", ["."]],
    ["dot-dot segment", [".."]],
    ["authority", ["//evil.example"]],
    ["URL", ["https://evil.example"]],
    ["query", ["binding?admin=true"]],
    ["fragment", ["binding#fragment"]],
    ["backslash", ["binding\\admin"]],
    ["path delimiter", ["binding/admin"]],
  ])("rejects unsafe descendant %s before the builder or transport", async (_name, segments) => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener, knock } = fixture(fetchImpl);
    await opener.start();
    const builder = vi.fn(() => ({ method: "POST" }));

    await expect(opener.fetchDescendant(segments as never, builder)).rejects.toBeInstanceOf(
      PortalConfigurationError,
    );
    expect(builder).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("releases a direct request body when descendant validation rejects", async () => {
    const request = trackedRequestBody();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();

    await expect(
      opener.fetchDescendant([], { method: "POST", body: request.body }),
    ).rejects.toBeInstanceOf(PortalConfigurationError);
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("uses the configured content fetch without putting HTTP on the NHP open path", async () => {
    const runtimeFetch = vi.fn(async () => new Response("runtime")) as unknown as typeof fetch;
    const contentFetch = vi.fn(async () => new Response("configured")) as unknown as typeof fetch;
    const { opener, knock } = fixture(runtimeFetch, { fetch: contentFetch });

    await opener.start();
    expect(knock).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(contentFetch).not.toHaveBeenCalled();

    const response = await opener.fetch();
    expect(await response.text()).toBe("configured");
    expect(contentFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    await opener.close();
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

  it("drops a lone-quote cookie value", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await opener.fetch({ headers: { cookie: 'odd="; theme=dark' } });
    const sent = new Headers(vi.mocked(fetchImpl).mock.calls[0][1]?.headers);
    expect(sent.get("cookie")).toBe(`theme=dark; qurl_vsession=${TOKEN}`);
    await opener.close();
  });

  it("rejects fetch before start without content I/O", async () => {
    const request = trackedRequestBody();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await expect(opener.fetch({ method: "POST", body: request.body })).rejects.toBeInstanceOf(
      PortalOpenerNotStartedError,
    );
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("rejects an invalid redirect option, cancels its stream, and performs no content I/O", async () => {
    const request = trackedRequestBody();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(
      opener.fetch({ method: "POST", body: request.body }, { redirects: "manual" as never }),
    ).rejects.toBeInstanceOf(PortalConfigurationError);
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("cancels a direct request body while the initial Start is pending", async () => {
    const request = trackedRequestBody();
    const pending = deferred<NHPMessage>();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener, knock } = fixture(fetchImpl);
    knock.mockImplementationOnce(() => pending.promise);
    const start = opener.start();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(opener.fetch({ method: "POST", body: request.body })).rejects.toBeInstanceOf(
      PortalOpenerNotStartedError,
    );
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    pending.resolve(ack());
    await start;
    await opener.close();
  });

  it("cancels a direct request body while the opener is degraded", async () => {
    const request = trackedRequestBody();
    const failure = new Error("initial open failed");
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener, knock } = fixture(fetchImpl);
    knock.mockRejectedValueOnce(failure);
    await expect(opener.start()).rejects.toBe(failure);

    await expect(opener.fetch({ method: "POST", body: request.body })).rejects.toBeInstanceOf(
      PortalOpenerNotReadyError,
    );
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("rejects an invalid request builder result as caller configuration", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(opener.fetch(() => undefined as never)).rejects.toBeInstanceOf(
      PortalConfigurationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it.each([
    ["redirect", { redirect: "follow" as const }],
    ["Host", { headers: { host: "attacker-controlled.example.test" } }],
  ])(
    "rejects a caller %s override, cancels its stream, and performs no content I/O",
    async (_name, invalid) => {
      const request = trackedRequestBody();
      const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
      const { opener } = fixture(fetchImpl);
      await opener.start();
      await expect(
        opener.fetch({ ...invalid, method: "POST", body: request.body }),
      ).rejects.toBeInstanceOf(PortalConfigurationError);
      expect(request.wasCanceled()).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      await opener.close();
    },
  );

  it.each([
    ["invalid method", { method: 123 as unknown as string }],
    ["invalid header", { headers: [["bad header name", "value"]] as RequestInit["headers"] }],
    ["invalid signal", { signal: {} as AbortSignal }],
  ])("cancels its stream when caller-controlled %s preparation throws", async (_name, invalid) => {
    const request = trackedRequestBody();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await expect(
      opener.fetch({ method: "POST", body: request.body, ...invalid }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(request.wasCanceled()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("destroys a Node Readable when request preparation throws", async () => {
    const body = Readable.from(["payload"]);
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();

    await expect(
      opener.fetch({
        method: "POST",
        body: body as unknown as RequestInit["body"],
        headers: [["bad header name", "value"]],
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(body.destroyed).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await opener.close();
  });

  it("makes close idempotent and rejects start and fetch after close", async () => {
    const request = trackedRequestBody();
    const { opener, knock } = fixture();
    const first = opener.close();
    expect(opener.close()).toBe(first);
    await first;
    await expect(opener.start()).rejects.toThrow("portal opener is closed");
    await expect(opener.fetch({ method: "POST", body: request.body })).rejects.toThrow(
      "portal opener is closed",
    );
    expect(request.wasCanceled()).toBe(true);
    expect(knock).not.toHaveBeenCalled();
  });

  it("accepts an explicit empty success errCode like Go", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce(ack(900, ""));
    await expect(opener.start()).resolves.toBeUndefined();
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
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
    await expect(opener.fetch({ redirect: "follow" })).rejects.toBeInstanceOf(
      PortalConfigurationError,
    );
    await expect(
      opener.fetch(() => ({ method: "PATCH", body: "signed" }), { redirects: "error" }),
    ).rejects.toBeInstanceOf(PortalRedirectError);
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

  it.each(["follow", "error"] as const)(
    "returns a redirect-shaped response with no Location in %s mode",
    async (redirects) => {
      const fetchImpl = vi.fn(
        async () => new Response("no target", { status: 302 }),
      ) as unknown as typeof globalThis.fetch;
      const { opener } = fixture(fetchImpl);
      await opener.start();
      const response = await opener.fetch({}, { redirects });
      expect(response.status).toBe(302);
      expect(await response.text()).toBe("no target");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await opener.close();
    },
  );

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

  it("removes a redirect fragment before the next request and URL check", async () => {
    const final = new Response("done", { status: 200 });
    Object.defineProperty(final, "url", {
      value: "https://private.example.test/done",
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/done#section" } }),
      )
      .mockResolvedValueOnce(final) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const response = await opener.fetch();
    expect(response).toBe(final);
    expect(vi.mocked(fetchImpl).mock.calls[1][0]).toBe("https://private.example.test/done");
    await opener.close();
  });

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
    await expect(opener.fetch()).rejects.toBeInstanceOf(PortalTooManyRedirectsError);
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
    const renewedToken = `${Buffer.from('{"renewed":true}').toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    let runRenewal: (() => void) | undefined;
    const sentCookies: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentCookies.push(new Headers(init?.headers).get("cookie"));
      if (vi.mocked(fetchImpl).mock.calls.length === 1) {
        runRenewal?.();
        await new Promise((resolve) => setImmediate(resolve));
        return new Response(null, { status: 302, headers: { location: "/done" } });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers, setNow } = fixture(fetchImpl);
    knock
      .mockResolvedValueOnce(ack(10))
      .mockResolvedValueOnce(ack(10, "0", RESOURCE_URL, renewedToken));
    await opener.start();
    setNow(6_000_000_000n);
    runRenewal = timers.shift();
    await expect(opener.fetch()).resolves.toBeInstanceOf(Response);
    expect(sentCookies).toEqual([`qurl_vsession=${TOKEN}`, `qurl_vsession=${TOKEN}`]);
    expect(knock).toHaveBeenCalledTimes(2);

    await opener.fetch();
    expect(sentCookies.at(-1)).toBe(`qurl_vsession=${renewedToken}`);
    await opener.close();
  });

  it("retries renewal through the full admission window with a 2 second cap", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers, timerDelays, setNow } = fixture(fetchImpl);
    knock.mockResolvedValueOnce(ack(10)).mockRejectedValue(new Error("temporary UDP miss"));
    await opener.start();
    expect(timerDelays).toEqual([5_000]);

    for (const [now, expectedDelay] of [
      [6_000_000_000n, 500],
      [6_500_000_000n, 1_000],
      [7_500_000_000n, 2_000],
      [9_500_000_000n, 1_500],
    ] as const) {
      setNow(now);
      timers.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(timerDelays.at(-1)).toBe(expectedDelay);
    }
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "open_failed",
      consecutiveFailures: 4,
    });
    await expect(opener.fetch()).resolves.toBeInstanceOf(Response);

    setNow(11_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    expect(knock).toHaveBeenCalledTimes(5);
    await opener.close();
  });

  it("bounds a stalled background open by both the open timeout and grant expiry", async () => {
    const { opener, knock, timers, deadlineTimers, deadlineDelays, setNow } = fixture();
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

    setNow(49_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deadlineDelays).toEqual([15_000, 12_000]);
    expect(deadlineTimers).toHaveLength(1);
    deadlineTimers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    expect(timers).toHaveLength(1);
    await opener.close();
  });

  it("keeps the first authenticated target and stops retrying target changes", async () => {
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      sent.push(String(target));
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers, timerDelays, setNow } = fixture(fetchImpl);
    knock
      .mockResolvedValueOnce(ack(10))
      .mockImplementation(async () => ack(10, "0", "https://private.example.test/changed"));
    await opener.start();
    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "target_changed",
      consecutiveFailures: 1,
    });
    expect(timerDelays).toEqual([5_000, 5_000]);
    await opener.fetch();
    expect(sent).toEqual([RESOURCE_URL]);
    expect(knock).toHaveBeenCalledTimes(2);

    setNow(11_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    expect(knock).toHaveBeenCalledTimes(2);
    await expect(opener.start()).rejects.toBeInstanceOf(PortalTargetChangedError);
    expect(knock).toHaveBeenCalledTimes(3);
    await opener.close();
  });

  it("closes promptly while a target-changed renewal waits for expiry", async () => {
    const { opener, knock, timers, setNow } = fixture();
    knock
      .mockResolvedValueOnce(ack(60))
      .mockResolvedValueOnce(ack(60, "0", "https://private.example.test/changed"));
    await opener.start();
    setNow(49_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      lastFailureClass: "target_changed",
      consecutiveFailures: 1,
    });
    expect(timers).toHaveLength(1);

    await opener.close();
    expect(timers).toHaveLength(0);
    expect(opener.health()).toMatchObject({ state: "closed", ready: false });
  });

  it("canonicalizes equivalent authenticated targets before binding renewal", async () => {
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      sent.push(String(target));
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const { opener, knock, timers, setNow } = fixture(fetchImpl);
    knock
      .mockResolvedValueOnce(ack(10, "0", "https://private.example.test/reports/Q3 summary"))
      .mockResolvedValueOnce(ack(10, "0", "https://private.example.test/reports/Q3%20summary"));
    await opener.start();
    await opener.fetch();
    expect(sent).toEqual(["https://private.example.test/reports/Q3%20summary"]);

    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({
      state: "ready",
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    await opener.close();
  });

  it("lets a late in-flight renewal restore foreground readiness", async () => {
    const pending = deferred<NHPMessage>();
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockImplementationOnce(() => pending.promise);
    await opener.start();
    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(2);

    setNow(11_000_000_000n);
    const foreground = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    pending.resolve(ack(60));
    await expect(foreground).resolves.toBeUndefined();
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    await opener.close();
  });

  it("keeps Go idempotency after a transient renewal failure", async () => {
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockRejectedValueOnce(new Error("renewal failed"));
    await opener.start();
    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    controller.abort(new Error("late lifecycle cancellation"));
    await expect(opener.start({ signal: controller.signal })).resolves.toBeUndefined();
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "ready", consecutiveFailures: 1 });
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

  it("expires a short grant at the Go-compatible 5 second renewal gap", async () => {
    const { opener, knock, timers, setNow, timerDelays } = fixture();
    knock.mockImplementationOnce(async () => {
      setNow(2_000_000_000n);
      return ack(2);
    });
    await opener.start();
    expect(opener.health()).toMatchObject({
      state: "ready",
      ready: true,
      expiresAt: new Date(3_000),
      renewAt: new Date(3_000),
      lastOpenSucceededAt: new Date(2_000),
    });
    expect(timerDelays).toEqual([1_000]);
    setNow(3_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(1);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    await opener.close();
  });

  it("classifies a renewal bound exhausted between readiness checks as a timeout", async () => {
    const { opener, knock, timers, setNowReader } = fixture();
    knock.mockResolvedValueOnce(ack(10));
    await opener.start();
    const readings = [
      6_000_000_000n,
      10_999_999_999n,
      11_000_000_000n,
      11_000_000_000n,
      11_000_000_000n,
    ];
    let read = 0;
    setNowReader(() => readings[Math.min(read++, readings.length - 1)]);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(1);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    await opener.close();
  });

  it("contains an unexpected background-cycle rejection and degrades fail closed", async () => {
    const { opener, timers, setNow, setNowReader } = fixture();
    await opener.start();
    const failure = new Error("unexpected local clock failure");
    let reads = 0;
    setNowReader(() => {
      if (reads++ === 0) return 850_000_000_000n;
      throw failure;
    });
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    setNow(850_000_000_000n);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    await opener.close();
  });

  it("never schedules a successful open less than 5 seconds after completion", async () => {
    const { opener, knock, setNow, timerDelays } = fixture();
    knock.mockImplementationOnce(async () => {
      setNow(15_000_000_000n);
      return ack(20);
    });
    await opener.start();
    expect(opener.health()).toMatchObject({
      state: "ready",
      expiresAt: new Date(21_000),
      renewAt: new Date(20_000),
      lastOpenSucceededAt: new Date(15_000),
    });
    expect(timerDelays).toEqual([5_000]);
    await opener.close();
  });

  it("rejects a grant that expires during the native exchange", async () => {
    const { opener, knock, setNow } = fixture();
    knock.mockImplementationOnce(async () => {
      setNow(2_000_000_000n);
      return ack(1);
    });
    await expect(opener.start()).rejects.toThrow("expired before it became usable");
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    await opener.close();
  });

  it("reports readiness from the exact nanosecond expiry boundary", async () => {
    const { opener, knock, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(1));
    await opener.start();
    setNow(1_999_999_999n);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    setNow(2_000_000_000n);
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    await opener.close();
  });

  it("uses one open when foreground recovery meets an expired renewal", async () => {
    const pending = deferred<NHPMessage>();
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(1)).mockImplementationOnce(() => pending.promise);
    await opener.start();
    setNow(2_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    const foreground = opener.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "degraded", ready: false });
    pending.resolve(ack(4));
    await foreground;
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    await opener.close();
  });

  it("aborts and awaits an active renewal before close completes", async () => {
    let activeSignal: AbortSignal | undefined;
    let active = 0;
    let maximumActive = 0;
    const { opener, knock, timers, setNow } = fixture();
    knock.mockResolvedValueOnce(ack(10)).mockImplementationOnce((_cell, _key, _body, options) => {
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
    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(1);
    const closing = opener.close();
    expect(activeSignal?.aborted).toBe(true);
    await closing;
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health()).toMatchObject({ state: "closed", ready: false });
  });

  it("aborts a protected request that is on the wire during close", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal;
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const response = opener.fetch();
    await new Promise((resolve) => setImmediate(resolve));
    const rejected = expect(response).rejects.toBeInstanceOf(PortalOpenerClosedError);
    await opener.close();
    expect(requestSignal?.aborted).toBe(true);
    await rejected;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves the request failure that races with close", async () => {
    const pending = deferred<Response>();
    const failure = new Error("protected transport failed during close");
    const fetchImpl = vi.fn(() => pending.promise) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const request = opener.fetch();
    await new Promise((resolve) => setImmediate(resolve));
    await opener.close();
    pending.reject(failure);
    const closed = await request.catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(PortalOpenerClosedError);
    expect((closed as Error).cause).toBe(failure);
  });

  it("keeps caller cancellation on the protected request without closing the opener", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const controller = new AbortController();
    const reason = new Error("content request canceled");
    const response = opener.fetch({ signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await expect(response).rejects.toBe(reason);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await opener.close();
  });

  it("calls a custom fetch with the standard global receiver", async () => {
    const receivers: unknown[] = [];
    const fetchImpl = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(new Response("ok"));
    } as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    await opener.fetch();
    expect(receivers).toEqual([globalThis]);
    await opener.close();
  });

  it("keeps caller cancellation active while the returned response body is read", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const controller = new AbortController();
    const reason = new Error("body read canceled");
    const response = await opener.fetch({ signal: controller.signal });
    const read = response.body!.getReader().read();
    controller.abort(reason);
    await expect(read).rejects.toBe(reason);
    expect(opener.health()).toMatchObject({ state: "ready", ready: true });
    await opener.close();
  });

  it("aborts a returned response body when the opener closes", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const response = await opener.fetch();
    const read = response.body!.getReader().read();
    await opener.close();
    await expect(read).rejects.toBeInstanceOf(PortalOpenerClosedError);
  });

  it("does not fan out listeners on shared signals for concurrent requests", async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    const fetchImpl = vi.fn(() => {
      const request = deferred<Response>();
      pending.push(request);
      return request.promise;
    }) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const controller = new AbortController();
    const requests = Array.from({ length: 20 }, () => opener.fetch({ signal: controller.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    for (const request of pending) request.resolve(new Response("ok"));
    await expect(Promise.all(requests)).resolves.toHaveLength(20);
    await opener.close();
  });

  it("does not create a composite signal without a caller signal", async () => {
    const any = vi.spyOn(AbortSignal, "any");
    const { opener } = fixture();
    try {
      await opener.start();
      const response = await opener.fetch();
      await response.body?.cancel();
      expect(any).not.toHaveBeenCalled();
    } finally {
      any.mockRestore();
      await opener.close();
    }
  });

  it("does not warn when concurrent requests share the lifecycle signal", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const response = await opener.fetch();
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      for (let index = 0; index < 20; index += 1) {
        requestSignal!.addEventListener("abort", () => undefined, { once: true });
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning")).toEqual(
        [],
      );
    } finally {
      process.off("warning", onWarning);
      await response.body?.cancel();
      await opener.close();
    }
  });

  it("does not start a redirect leg after close when custom fetch ignores abort", async () => {
    const first = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(new Response("done")) as unknown as typeof globalThis.fetch;
    const { opener } = fixture(fetchImpl);
    await opener.start();
    const response = opener.fetch();
    await new Promise((resolve) => setImmediate(resolve));
    const closing = opener.close();
    expect(opener.health()).toEqual({
      state: "closed",
      ready: false,
      expiresAt: undefined,
      renewAt: undefined,
      lastOpenSucceededAt: undefined,
      lastFailureClass: "",
      consecutiveFailures: 0,
    });
    await closing;
    first.resolve(new Response(null, { status: 302, headers: { location: "/done" } }));
    await expect(response).rejects.toBeInstanceOf(PortalOpenerClosedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("exposes a typed busy error and degraded cold-start health", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_COOKIE,
      flags: 0,
      counter: 99n,
      timestampNanos: 2n,
      body: Buffer.from("busy"),
    });
    await expect(opener.start()).rejects.toBeInstanceOf(PortalBusyError);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
    await opener.close();
  });

  it("exposes a typed invalid-reply error and degraded cold-start health", async () => {
    const { opener, knock } = fixture();
    knock.mockResolvedValueOnce({
      type: NHP_TYPE_ACK,
      flags: 0,
      counter: 1n,
      timestampNanos: 2n,
      body: Buffer.from("not-json"),
    });
    await expect(opener.start()).rejects.toBeInstanceOf(PortalInvalidReplyError);
    expect(opener.health()).toMatchObject({
      state: "degraded",
      ready: false,
      lastFailureClass: "open_failed",
      consecutiveFailures: 1,
    });
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
    await expect(opener.fetch(builder)).rejects.toBeInstanceOf(PortalOpenerNotReadyError);
    expect(builder).not.toHaveBeenCalled();
    expect(knock).toHaveBeenCalledTimes(1);
    await opener.close();
  });
});

it.each([undefined, "", "invalid"])(
  "rejects invalid expectedCRID at construction: %s",
  (expectedCRID) => {
    expect(() => fixture(undefined, { expectedCRID })).toThrow(PortalConfigurationError);
  },
);

it("rejects a valid foreign-resource qURL before native access", async () => {
  const { opener, knock } = fixture(undefined, {
    expectedCRID: "qe4jqpd7eaoslq7jinmjv4yikgzmcxgpjfsuobiniqnko32lpw742pueoujq",
  });
  await expect(opener.start()).rejects.toMatchObject({
    cause: { message: "qURL resource key does not match the expected CRID" },
  });
  expect(knock).not.toHaveBeenCalled();
  await opener.close();
});

it("opens and renews with an independently held matching CRID", async () => {
  const vectors = JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("@layervai/qurl-conformance/crid_v1_vectors.json"),
      "utf8",
    ),
  );
  const vector = vectors.producer_cases[0];
  const link = createMatchedQv2Fixture({
    resourceSpki: Buffer.from(vector.der_spki_b64url, "base64url"),
  });
  const { opener, knock, timers, setNow } = fixture(undefined, {
    qurl: link.qurl,
    expectedCRID: vector.expected_crid,
    deployment: { ...deployment(), issuers: [link.issuer] },
  });
  knock.mockResolvedValue(ack(10));
  try {
    await opener.start();
    expect(knock).toHaveBeenCalledTimes(1);
    setNow(6_000_000_000n);
    timers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(knock).toHaveBeenCalledTimes(2);
    expect(opener.health().ready).toBe(true);
  } finally {
    await opener.close();
  }
});
