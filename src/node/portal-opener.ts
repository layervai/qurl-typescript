import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NHPMessage } from "./nhp-wire.js";
import { NHP_MAX_BODY_SIZE, NHP_TYPE_ACK, NHP_TYPE_COOKIE } from "./nhp-wire.js";
import {
  fingerprintKey,
  loadPortalDeployment,
  type PortalDeployment,
  type ValidatedCell,
  type ValidatedDeployment,
} from "./deployment.js";
import { nativeKnock, type NativeExchangeOptions } from "./native-udp.js";
import { isStrictJsonObject, parseStrictJson, type StrictJsonValue } from "./strict-json.js";
import { verifyQv2Link, type VerifiedQv2Link } from "./qv2.js";

const SESSION_COOKIE = "qurl_vsession";
const MAX_REDIRECT_REQUESTS = 10;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const MAX_OPEN_TIMEOUT_MS = 60_000;
const MIN_RENEWAL_GAP_MS = 5_000;
const MIN_RENEWAL_LEAD_MS = 5_000;
const MAX_RENEWAL_LEAD_MS = 60_000;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 2_000;
// Node changes a larger setTimeout delay to 1 ms. Clamp long grants so an
// authenticated but unexpected lifetime cannot create a hot renewal loop.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_ACK_BODY_BYTES = 4_096;
const UINT64_MAX = (1n << 64n) - 1n;

export interface CreatePortalOpenerOptions {
  /** Full qv2t1 qURL. The opener re-verifies it before each native open. */
  readonly qurl: string;
  /** Public deployment trust. Omit to load QURL_DEPLOYMENT on the first start. */
  readonly deployment?: PortalDeployment;
  /** Whole-operation deadline for each NHP open. The default is 15 seconds. */
  readonly openTimeoutMs?: number;
  /** Protected-content fetch implementation. Native NHP opening never uses it. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface PortalStartOptions {
  readonly signal?: AbortSignal;
}

export type PortalRequestBuilder = (authenticatedTarget: URL) => RequestInit;

export interface PortalFetchOptions {
  /** Use `error` for signed requests whose method, target, timestamp, and nonce must not be replayed. */
  readonly redirects?: "follow" | "error";
}

export type PortalOpenerState = "new" | "starting" | "ready" | "degraded" | "closed";

export type PortalOpenerFailureClass = "" | "open_failed" | "target_changed";

/** Secret-free, nonblocking lifecycle snapshot. */
export interface PortalOpenerHealth {
  readonly state: PortalOpenerState;
  readonly ready: boolean;
  readonly expiresAt?: Date;
  readonly renewAt?: Date;
  readonly lastOpenSucceededAt?: Date;
  readonly lastFailureClass: PortalOpenerFailureClass;
  readonly consecutiveFailures: number;
}

export interface PortalOpener {
  /** Open now and schedule renewal before the admission expires. */
  start(options?: PortalStartOptions): Promise<void>;
  /** Start a fetch at the exact ACK URL. Same-origin redirects follow only when allowed. */
  fetch(init?: RequestInit | PortalRequestBuilder, options?: PortalFetchOptions): Promise<Response>;
  /** Read local session state. This method does no I/O and exposes no capability. */
  health(): PortalOpenerHealth;
  /** Stop renewal and wipe mutable private-key, visitor-secret, and token buffers. */
  close(): Promise<void>;
}

export class PortalConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalConfigurationError";
  }
}

export class PortalVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalVerificationError";
  }
}

export class PortalDenyError extends Error {
  readonly errCode: string;

  constructor(errCode: string) {
    super(`qURL platform denied native access (errCode=${JSON.stringify(errCode)})`);
    this.name = "PortalDenyError";
    this.errCode = errCode;
  }
}

export class PortalStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalStateError";
  }
}

export class PortalOpenerNotStartedError extends PortalStateError {
  constructor() {
    super("portal opener has not started");
    this.name = "PortalOpenerNotStartedError";
  }
}

export class PortalOpenerNotReadyError extends PortalStateError {
  constructor(options?: ErrorOptions) {
    super("portal opener has no active session", options);
    this.name = "PortalOpenerNotReadyError";
  }
}

export class PortalOpenerClosedError extends PortalStateError {
  constructor(options?: ErrorOptions) {
    super("portal opener is closed", options);
    this.name = "PortalOpenerClosedError";
  }
}

export class PortalOpenTimeoutError extends PortalStateError {
  constructor() {
    super("native NHP open exceeded its overall deadline");
    this.name = "PortalOpenTimeoutError";
  }
}

export class PortalTargetChangedError extends PortalStateError {
  constructor() {
    super("portal renewal changed the authenticated target");
    this.name = "PortalTargetChangedError";
  }
}

export class PortalRedirectError extends PortalStateError {
  constructor(message = "protected request redirect refused", options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalRedirectError";
  }
}

export class PortalTooManyRedirectsError extends PortalStateError {
  constructor() {
    super(`portal fetch stopped at the ${MAX_REDIRECT_REQUESTS}-request redirect limit`);
    this.name = "PortalTooManyRedirectsError";
  }
}

export class PortalBusyError extends PortalStateError {
  constructor() {
    super("qURL platform is busy; retry start later");
    this.name = "PortalBusyError";
  }
}

export class PortalInvalidReplyError extends PortalStateError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalInvalidReplyError";
  }
}

interface PortalRuntime {
  readonly knock: (
    cell: ValidatedCell,
    key: Uint8Array,
    body: Uint8Array,
    options: NativeExchangeOptions,
  ) => Promise<NHPMessage>;
  readonly fetch: typeof globalThis.fetch;
  readonly nowNanos: () => bigint;
  readonly nowEpochMs: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
  readonly setDeadlineTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearDeadlineTimer: (timer: NodeJS.Timeout) => void;
}

const defaultContentFetch: typeof globalThis.fetch = (input, init) => {
  // Resolve lazily so importing the Node entry point does not require global
  // Fetch when a consumer supplies its own protected-content implementation.
  const implementation = globalThis.fetch as typeof globalThis.fetch | undefined;
  if (typeof implementation !== "function") {
    return Promise.reject(
      new PortalConfigurationError(
        "portal fetch requires global Fetch or CreatePortalOpenerOptions.fetch",
      ),
    );
  }
  return implementation.call(globalThis, input, init);
};

const defaultRuntime: PortalRuntime = {
  knock: nativeKnock,
  fetch: defaultContentFetch,
  nowNanos: () => process.hrtime.bigint(),
  nowEpochMs: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  setDeadlineTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearDeadlineTimer: (timer) => clearTimeout(timer),
};

export function createPortalOpener(options: CreatePortalOpenerOptions): PortalOpener {
  return createPortalOpenerWithRuntime(options, defaultRuntime);
}

export function createPortalOpenerWithRuntime(
  options: CreatePortalOpenerOptions,
  runtime: PortalRuntime,
): PortalOpener {
  if (!options || typeof options !== "object") {
    throw new PortalConfigurationError("native portal opener options are required");
  }
  if (typeof options.qurl !== "string" || options.qurl.trim() === "") {
    throw new PortalConfigurationError("native portal opener qurl must be a non-empty string");
  }
  if (
    options.openTimeoutMs !== undefined &&
    (!Number.isFinite(options.openTimeoutMs) ||
      options.openTimeoutMs < 1 ||
      options.openTimeoutMs > MAX_OPEN_TIMEOUT_MS)
  ) {
    throw new PortalConfigurationError(
      "native portal opener openTimeoutMs must be from 1 to 60000",
    );
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new PortalConfigurationError("native portal opener fetch must be a function");
  }
  return new NativePortalOpener(options, runtime);
}

type ActiveGrant = {
  readonly resourceUrl: string;
  readonly origin: string;
  readonly expiresAtNanos: bigint;
  readonly renewAtNanos: bigint;
  readonly expiresAtEpochMs: number;
  readonly renewAtEpochMs: number;
  readonly openedAtEpochMs: number;
  readonly token: Buffer;
};

type InternalState = "new" | "starting" | "running" | "degraded" | "closed";

class NativePortalOpener implements PortalOpener {
  readonly #runtime: PortalRuntime;
  readonly #fetch: typeof globalThis.fetch;
  readonly #explicitDeployment?: PortalDeployment;
  readonly #openTimeoutMs: number;
  #qurl: string;
  #resolvedDeployment?: ValidatedDeployment;
  #sessionSecret?: Buffer;
  #grant?: ActiveGrant;
  #boundResourceUrl?: string;
  #startPromise?: Promise<void>;
  #openPromise?: Promise<void>;
  #openController?: AbortController;
  #closePromise?: Promise<void>;
  #renewalTimer?: NodeJS.Timeout;
  #renewalCycle?: Promise<void>;
  readonly #lifecycleController = new AbortController();
  #state: InternalState = "new";
  #startingRecovery = false;
  #expiresAtEpochMs?: number;
  #renewAtEpochMs?: number;
  #lastOpenSucceededAt?: number;
  #lastFailureClass: PortalOpenerFailureClass = "";
  #consecutiveFailures = 0;

  constructor(options: CreatePortalOpenerOptions, runtime: PortalRuntime) {
    this.#qurl = options.qurl;
    this.#explicitDeployment = options.deployment;
    this.#runtime = runtime;
    this.#fetch = options.fetch ?? runtime.fetch;
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  async start(options: PortalStartOptions = {}): Promise<void> {
    this.#requireOpen();
    if (this.#state === "running" && this.#grant && this.#isGrantReady(this.#grant)) return;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    if (this.#state === "running" && !this.#isGrantReady(this.#grant) && this.#renewalCycle) {
      await waitForPromise(this.#renewalCycle, options.signal);
      return this.start(options);
    }

    const sharedStart = this.#startPromise;
    if (sharedStart) return waitForPromise(sharedStart, options.signal);

    let attempt!: Promise<void>;
    attempt = this.#runStart(options.signal).finally(() => {
      if (this.#startPromise === attempt) this.#startPromise = undefined;
    });
    this.#startPromise = attempt;
    return attempt;
  }

  async #runStart(signal?: AbortSignal): Promise<void> {
    // A pending renewal wait always has a ready grant, so public start() returns
    // before reaching this explicit-open path. Keep that invariant if start()
    // admission rules change: clearing its timer would strand #renewalCycle.
    if (this.#renewalTimer) this.#runtime.clearTimer(this.#renewalTimer);
    this.#renewalTimer = undefined;
    const recovery = this.#state === "degraded" || this.#state === "running";
    this.#startingRecovery = recovery;
    this.#state = "starting";
    try {
      await this.#openSingleFlight(signal);
    } catch (error) {
      if (this.#isClosed()) throw new PortalOpenerClosedError({ cause: error });
      this.#clearGrant();
      if (signal?.aborted && error === signal.reason) {
        this.#state = recovery ? "degraded" : "new";
      } else {
        this.#state = "degraded";
        this.#recordFailure(error);
      }
      throw error;
    } finally {
      this.#startingRecovery = false;
    }
  }

  async fetch(
    input: RequestInit | PortalRequestBuilder = {},
    options: PortalFetchOptions = {},
  ): Promise<Response> {
    if (this.#state === "closed") throw new PortalOpenerClosedError();
    if (
      options.redirects !== undefined &&
      options.redirects !== "follow" &&
      options.redirects !== "error"
    ) {
      throw new PortalConfigurationError("portal fetch redirects must be follow or error");
    }
    if (this.#state === "new" || (this.#state === "starting" && !this.#startingRecovery)) {
      throw new PortalOpenerNotStartedError();
    }
    const grant = this.#grant;
    if (this.#state !== "running" || !this.#isGrantReady(grant)) {
      throw new PortalOpenerNotReadyError();
    }
    // A successful renewal or close wipes the mutable grant token. Keep the
    // unavoidable request string local to this fetch so every redirect leg has
    // one stable credential snapshot.
    const sessionToken = grant.token.toString("ascii");
    const init = typeof input === "function" ? input(new URL(grant.resourceUrl)) : input;
    if (!init || typeof init !== "object") {
      throw new PortalConfigurationError("portal request builder must return RequestInit");
    }
    if (Object.prototype.hasOwnProperty.call(init, "redirect") && init.redirect !== undefined) {
      await discardRequestBody(init.body);
      throw new PortalConfigurationError(
        "portal fetch owns redirect handling; redirect overrides are not allowed",
      );
    }
    let currentUrl = grant.resourceUrl;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = new Headers(init.headers);
    if (headers.has("host")) {
      await discardRequestBody(body);
      throw new PortalConfigurationError(
        "portal fetch owns the Host derived from the authenticated target",
      );
    }
    // A native composite signal avoids one listener per request on the shared
    // lifecycle signal. It also remains active after headers arrive, so caller
    // cancellation and close retain standard Fetch response-body semantics.
    const requestSignal = AbortSignal.any(
      init.signal
        ? [init.signal, this.#lifecycleController.signal]
        : [this.#lifecycleController.signal],
    );
    try {
      for (let requestCount = 1; ; requestCount++) {
        this.#requireOpen();
        throwIfAborted(requestSignal);
        const requestHeaders = authorizeHeaders(headers, sessionToken);
        const response = await this.#fetch(currentUrl, {
          ...init,
          method,
          body,
          headers: requestHeaders,
          redirect: "manual",
          signal: requestSignal,
        });
        if (requestSignal.aborted) {
          await discardResponseBody(response);
          throwIfAborted(requestSignal);
        }
        if (response.redirected === true || !responseMatchesRequestUrl(response.url, currentUrl)) {
          await discardResponseBody(response);
          throw new PortalRedirectError(
            "portal fetch refused a response that bypassed its manual redirect policy",
          );
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) return response;
        if (options.redirects === "error") {
          await discardResponseBody(response);
          throw new PortalRedirectError(
            "portal fetch refused a redirect for a fixed signed request",
          );
        }
        if (requestCount >= MAX_REDIRECT_REQUESTS) {
          await discardResponseBody(response);
          throw new PortalTooManyRedirectsError();
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          await discardResponseBody(response);
          throw new PortalRedirectError("portal fetch refused an invalid redirect target");
        }
        // Fragments are never part of an HTTP request target, and Fetch omits
        // them from Response.url. Normalize before the next request and its
        // manual-redirect bypass check.
        next.hash = "";
        let nextOrigin: string;
        try {
          nextOrigin = normalizedHttpsOrigin(next);
        } catch {
          await discardResponseBody(response);
          throw new PortalRedirectError("portal fetch refused an invalid redirect target");
        }
        if (nextOrigin !== grant.origin) {
          await discardResponseBody(response);
          throw new PortalRedirectError(
            "portal fetch refused a redirect outside the authenticated origin",
          );
        }

        if ([301, 302, 303].includes(response.status) && method !== "GET" && method !== "HEAD") {
          method = "GET";
          body = undefined;
          headers = new Headers(headers);
          headers.delete("content-length");
          headers.delete("content-type");
        } else if ((response.status === 307 || response.status === 308) && body !== undefined) {
          if (!isReplayableBody(body)) return response;
        }
        await discardResponseBody(response);
        currentUrl = next.href;
      }
    } catch (error) {
      await discardRequestBody(body);
      if (this.#isClosed()) throw new PortalOpenerClosedError({ cause: error });
      throw error;
    }
  }

  health(): PortalOpenerHealth {
    const ready = this.#state === "running" && this.#isGrantReady(this.#grant);
    let state: PortalOpenerState;
    if (this.#state === "closed") state = "closed";
    else if (this.#state === "new") state = "new";
    else if (this.#state === "starting" && !this.#startingRecovery) state = "starting";
    else if (ready) state = "ready";
    else state = "degraded";
    return {
      state,
      ready,
      expiresAt: dateFromEpoch(this.#expiresAtEpochMs),
      renewAt: dateFromEpoch(this.#renewAtEpochMs),
      lastOpenSucceededAt: dateFromEpoch(this.#lastOpenSucceededAt),
      lastFailureClass: this.#lastFailureClass,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closed";
    if (this.#renewalTimer) this.#runtime.clearTimer(this.#renewalTimer);
    this.#renewalTimer = undefined;
    this.#expiresAtEpochMs = undefined;
    this.#renewAtEpochMs = undefined;
    this.#lastOpenSucceededAt = undefined;
    this.#lastFailureClass = "";
    this.#consecutiveFailures = 0;
    this.#startingRecovery = false;
    this.#lifecycleController.abort(new PortalOpenerClosedError());
    this.#openController?.abort(new PortalOpenerClosedError());
    const active = this.#openPromise;
    const renewal = this.#renewalCycle;
    const closing = (async () => {
      await Promise.allSettled([active, renewal].filter((item) => item !== undefined));
      this.#clearGrant();
      this.#boundResourceUrl = undefined;
      this.#qurl = "";
      this.#sessionSecret?.fill(0);
      this.#sessionSecret = undefined;
      this.#resolvedDeployment = undefined;
    })();
    this.#closePromise = closing;
    return closing;
  }

  #openSingleFlight(signal?: AbortSignal, expiresAtNanos?: bigint): Promise<void> {
    this.#requireOpen();
    const active = this.#openPromise;
    if (active) return waitForPromise(active, signal);

    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(signal, controller);
    const remainingMs =
      expiresAtNanos === undefined
        ? this.#openTimeoutMs
        : nanosToCeilingMilliseconds(expiresAtNanos - this.#runtime.nowNanos());
    const deadlineMs = Math.min(this.#openTimeoutMs, remainingMs);
    if (deadlineMs <= 0) {
      removeAbortListener();
      return Promise.reject(new PortalOpenTimeoutError());
    }
    const deadline = this.#runtime.setDeadlineTimer(() => {
      controller.abort(new PortalOpenTimeoutError());
    }, deadlineMs);
    deadline.unref?.();
    const current = this.#performOpen(controller.signal).finally(() => {
      this.#runtime.clearDeadlineTimer(deadline);
      removeAbortListener();
      if (this.#openPromise === current) {
        this.#openPromise = undefined;
        this.#openController = undefined;
      }
    });
    this.#openController = controller;
    this.#openPromise = current;
    return current;
  }

  async #performOpen(signal: AbortSignal): Promise<void> {
    this.#requireOpen();
    const deployment = this.#loadDeployment();
    const link = this.#verifyLink(deployment);
    try {
      const cell = validatedCellForLink(link, deployment);
      this.#sessionSecret ??= randomBytes(32);
      const body = this.#knockBody(link);
      // Start the local validity bound before DNS and UDP I/O. The cell starts
      // its grant no earlier than this, so this client never assumes extra RTT.
      const startedAtNanos = this.#runtime.nowNanos();
      const startedAtEpochMs = this.#runtime.nowEpochMs();
      try {
        const reply = await this.#runtime.knock(cell, link.devicePrivateKey, body, {
          signal,
        });
        try {
          this.#requireOpen();
          if (reply.type === NHP_TYPE_COOKIE) throw new PortalBusyError();
          if (reply.type !== NHP_TYPE_ACK) {
            throw new PortalInvalidReplyError("native NHP returned an unexpected reply type");
          }
          const openedAtNanos = this.#runtime.nowNanos();
          const openedAtEpochMs = this.#runtime.nowEpochMs();
          const grant = parseGrant(
            reply.body,
            startedAtNanos,
            startedAtEpochMs,
            openedAtNanos,
            openedAtEpochMs,
          );
          if (
            this.#boundResourceUrl !== undefined &&
            grant.resourceUrl !== this.#boundResourceUrl
          ) {
            grant.token.fill(0);
            throw new PortalTargetChangedError();
          }
          if (this.#runtime.nowNanos() >= grant.expiresAtNanos) {
            grant.token.fill(0);
            throw new PortalInvalidReplyError(
              "native NHP admission expired before it became usable",
            );
          }
          this.#resolvedDeployment ??= deployment;
          this.#installGrant(grant);
        } finally {
          // ACK and deny bodies can contain a bearer. Wipe them on every parse path.
          reply.body.fill(0);
        }
      } finally {
        body.fill(0);
      }
    } finally {
      link.devicePrivateKey.fill(0);
    }
  }

  #scheduleRenewal(grant: ActiveGrant): void {
    if (this.#renewalTimer) this.#runtime.clearTimer(this.#renewalTimer);
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, nanosToCeilingMilliseconds(grant.renewAtNanos - this.#runtime.nowNanos())),
    );
    const timer = this.#runtime.setTimer(() => {
      if (this.#renewalTimer === timer) this.#renewalTimer = undefined;
      if (this.#state !== "running" || this.#grant !== grant) return;
      if (this.#runtime.nowNanos() < grant.renewAtNanos) {
        this.#scheduleRenewal(grant);
        return;
      }
      const cycle = this.#runRenewalCycle(grant)
        .catch((error: unknown) => {
          // A background task must never create an unhandled rejection. An
          // unexpected internal failure loses readiness instead of risking the
          // host process or leaving an unsupervised running state.
          if (this.#isClosed() || this.#grant !== grant) return;
          this.#recordFailure(error);
          this.#expireGrant(grant);
        })
        .finally(() => {
          if (this.#renewalCycle === cycle) this.#renewalCycle = undefined;
        });
      this.#renewalCycle = cycle;
    }, delayMs);
    this.#renewalTimer = timer;
    timer.unref?.();
  }

  async #runRenewalCycle(grant: ActiveGrant): Promise<void> {
    let delayMs = INITIAL_RETRY_MS;
    while (this.#state === "running" && this.#grant === grant) {
      if (!this.#isGrantReady(grant)) {
        this.#expireGrant(grant);
        return;
      }
      try {
        await this.#openSingleFlight(this.#lifecycleController.signal, grant.expiresAtNanos);
        return;
      } catch (error) {
        if (this.#isClosed()) return;
        if (this.#grant !== grant) return;
        this.#recordFailure(error);
        if (error instanceof PortalTargetChangedError) {
          if (!(await this.#waitUntil(grant.expiresAtNanos))) return;
          this.#expireGrant(grant);
          return;
        }
        const remaining = nanosToCeilingMilliseconds(
          grant.expiresAtNanos - this.#runtime.nowNanos(),
        );
        if (remaining <= 0) continue;
        if (!(await this.#waitForRenewal(Math.min(delayMs, remaining)))) return;
        delayMs = Math.min(delayMs * 2, MAX_RETRY_MS);
      }
    }
  }

  #waitForRenewal(delayMs: number): Promise<boolean> {
    const signal = this.#lifecycleController.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (timer && this.#renewalTimer === timer) this.#renewalTimer = undefined;
        resolve(result);
      };
      const abort = () => {
        if (timer) this.#runtime.clearTimer(timer);
        finish(false);
      };
      timer = this.#runtime.setTimer(() => finish(true), delayMs);
      if (settled) {
        this.#runtime.clearTimer(timer);
        return;
      }
      this.#renewalTimer = timer;
      timer.unref?.();
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  async #waitUntil(deadlineNanos: bigint): Promise<boolean> {
    while (this.#runtime.nowNanos() < deadlineNanos) {
      const remaining = nanosToCeilingMilliseconds(deadlineNanos - this.#runtime.nowNanos());
      if (!(await this.#waitForRenewal(Math.min(MAX_TIMER_DELAY_MS, remaining)))) return false;
    }
    return true;
  }

  #installGrant(grant: ActiveGrant): void {
    this.#clearGrant();
    this.#grant = grant;
    this.#boundResourceUrl ??= grant.resourceUrl;
    this.#expiresAtEpochMs = grant.expiresAtEpochMs;
    this.#renewAtEpochMs = grant.renewAtEpochMs;
    this.#lastOpenSucceededAt = grant.openedAtEpochMs;
    this.#lastFailureClass = "";
    this.#consecutiveFailures = 0;
    this.#state = "running";
    this.#scheduleRenewal(grant);
  }

  #recordFailure(error: unknown): void {
    this.#lastFailureClass =
      error instanceof PortalTargetChangedError ? "target_changed" : "open_failed";
    this.#consecutiveFailures++;
  }

  #expireGrant(grant: ActiveGrant): void {
    if (this.#grant !== grant || this.#state !== "running") return;
    this.#clearGrant();
    this.#state = "degraded";
  }

  #clearGrant(): void {
    this.#grant?.token.fill(0);
    this.#grant = undefined;
  }

  #isGrantReady(grant: ActiveGrant | undefined): grant is ActiveGrant {
    return grant !== undefined && this.#runtime.nowNanos() < grant.expiresAtNanos;
  }

  #loadDeployment(): ValidatedDeployment {
    if (this.#resolvedDeployment) return this.#resolvedDeployment;
    try {
      return loadPortalDeployment(this.#explicitDeployment);
    } catch (error) {
      throw new PortalConfigurationError("native qURL deployment trust is invalid", {
        cause: error,
      });
    }
  }

  #verifyLink(deployment: ValidatedDeployment): VerifiedQv2Link {
    try {
      return verifyQv2Link(this.#qurl, deployment.issuers);
    } catch (error) {
      throw new PortalVerificationError("native qURL credential validation failed", {
        cause: error,
      });
    }
  }

  #knockBody(link: VerifiedQv2Link): Uint8Array {
    const sessionSecret = this.#sessionSecret;
    if (!sessionSecret) throw new PortalStateError("portal opener session is not initialized");
    // Immutable JS strings cannot be zeroized. Keep their lifetime to this one
    // serialization and retain private capability material only in mutable
    // buffers between opens.
    const encoded = JSON.stringify({
      headerType: 1,
      aspId: "qurl",
      resId: link.claims.resourcePublicKeyB64,
      usrData: {
        qurl_claims_b64: link.claimsB64,
        qurl_issuer_sig_b64: link.signatureB64,
        qurl_session_secret: sessionSecret.toString("base64url"),
      },
    });
    const body = Buffer.from(encoded, "utf8");
    if (body.byteLength > NHP_MAX_BODY_SIZE) {
      body.fill(0);
      throw new PortalVerificationError("verified qURL cannot fit the native NHP knock envelope");
    }
    return body;
  }

  #requireOpen(): void {
    if (this.#state === "closed") throw new PortalOpenerClosedError();
  }

  #isClosed(): boolean {
    return this.#state === "closed";
  }
}

function parseGrant(
  body: Uint8Array,
  startedAtNanos: bigint,
  startedAtEpochMs: number,
  openedAtNanos: bigint,
  openedAtEpochMs: number,
): ActiveGrant {
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(body, MAX_ACK_BODY_BYTES);
  } catch (error) {
    throw new PortalInvalidReplyError("native NHP ACK body is malformed", { cause: error });
  }
  if (!isStrictJsonObject(value))
    throw new PortalInvalidReplyError("native NHP ACK must be an object");
  const errCode =
    value.errCode === undefined ? "" : requirePossiblyEmptyString(value.errCode, "ACK errCode");
  if (errCode !== "" && errCode !== "0") {
    // Match qurl-go's canonical knock-deny grammar: decimal digits, no leading
    // zero, and no allowlist that could hide a new authenticated server code.
    if (!/^[1-9][0-9]*$/.test(errCode))
      throw new PortalInvalidReplyError("native NHP deny code is not canonical decimal");
    // The native opener's deny profile deliberately requires an explicit
    // canonical opnTime:0 and forbids the Go-defined success capabilities.
    if ("sessId" in value) {
      throw new PortalInvalidReplyError("native NHP deny ACK contains success capability fields");
    }
    if (value.opnTime !== 0n) {
      throw new PortalInvalidReplyError("native NHP deny ACK opnTime must be canonical zero");
    }
    if (value.aspToken !== undefined && value.aspToken !== "") {
      throw new PortalInvalidReplyError("native NHP deny ACK contains success capability fields");
    }
    throw new PortalDenyError(errCode);
  }
  const sessionId = requireUnsignedInteger(value.sessId, "ACK session id", UINT64_MAX);
  if (sessionId === 0n)
    throw new PortalInvalidReplyError("native NHP ACK session id must be positive");
  const openSecondsBig = requireUnsignedInteger(value.opnTime, "ACK open time", 0xffff_ffffn);
  if (openSecondsBig === 0n)
    throw new PortalInvalidReplyError("native NHP ACK open time must be positive");
  const openSeconds = Number(openSecondsBig);
  const resourceUrl = requireString(value.redirectUrl, "ACK resource URL");
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    throw new PortalInvalidReplyError("ACK resource URL is invalid");
  }
  if (parsed.hash !== "")
    throw new PortalInvalidReplyError("ACK resource URL must not contain a fragment");
  let origin: string;
  try {
    origin = normalizedHttpsOrigin(parsed);
  } catch (error) {
    throw new PortalInvalidReplyError(
      error instanceof Error ? error.message : "ACK resource URL has an invalid HTTPS origin",
      { cause: error },
    );
  }
  const tokenString = requireString(value.aspToken, "ACK application token");
  validateSessionToken(tokenString);
  const token = Buffer.from(tokenString, "ascii");
  const lifetimeNanos = BigInt(openSeconds) * 1_000_000_000n;
  const expiresAtNanos = startedAtNanos + lifetimeNanos;
  let renewAtNanos = expiresAtNanos - renewalLeadNanos(lifetimeNanos);
  const minimumRenewAt = openedAtNanos + BigInt(MIN_RENEWAL_GAP_MS) * 1_000_000n;
  if (renewAtNanos < minimumRenewAt) renewAtNanos = minimumRenewAt;
  if (renewAtNanos > expiresAtNanos) renewAtNanos = expiresAtNanos;
  return {
    resourceUrl: parsed.href,
    origin,
    expiresAtNanos,
    renewAtNanos,
    expiresAtEpochMs: startedAtEpochMs + openSeconds * 1_000,
    renewAtEpochMs: openedAtEpochMs + Number(renewAtNanos - openedAtNanos) / 1_000_000,
    openedAtEpochMs,
    token,
  };
}

function renewalLeadNanos(lifetimeNanos: bigint): bigint {
  let lead = lifetimeNanos / 5n;
  const minimum = BigInt(MIN_RENEWAL_LEAD_MS) * 1_000_000n;
  const maximum = BigInt(MAX_RENEWAL_LEAD_MS) * 1_000_000n;
  if (lead < minimum) lead = minimum;
  if (lead > maximum) lead = maximum;
  if (lead >= lifetimeNanos) lead = lifetimeNanos / 2n;
  return lead;
}

function validatedCellForLink(
  link: VerifiedQv2Link,
  deployment: ValidatedDeployment,
): ValidatedCell {
  const cell = deployment.cells.get(fingerprintKey(link.claims.cellPublicKey));
  if (!cell) {
    throw new PortalConfigurationError("verified qURL names a cell outside the native catalog");
  }
  // The 64-bit fingerprint is only an efficient map index. The signed cell
  // identity must still match the exact deployment key used by Noise.
  if (!timingSafeEqual(cell.serverPublicKey, link.claims.cellPublicKey)) {
    throw new PortalConfigurationError("deployment cell key does not match the signed cell key");
  }
  return cell;
}

function nanosToCeilingMilliseconds(value: bigint): number {
  if (value <= 0n) return 0;
  return Number((value + 999_999n) / 1_000_000n);
}

function dateFromEpoch(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function requireString(value: StrictJsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value === "")
    throw new PortalInvalidReplyError(`${name} is missing or invalid`);
  return value;
}

function requirePossiblyEmptyString(value: StrictJsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new PortalInvalidReplyError(`${name} is missing or invalid`);
  return value;
}

function requireUnsignedInteger(
  value: StrictJsonValue | undefined,
  name: string,
  maximum: bigint,
): bigint {
  if (typeof value !== "bigint") {
    throw new PortalInvalidReplyError(`${name} must be an unsigned decimal integer`);
  }
  if (value < 0n || value > maximum)
    throw new PortalInvalidReplyError(`${name} is outside its range`);
  return value;
}

function normalizedHttpsOrigin(url: URL): string {
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PortalStateError("ACK resource URL must have a valid HTTPS origin");
  }
  const port = url.port === "" ? "443" : url.port;
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new PortalStateError("ACK resource URL has an invalid port");
  }
  return `https://${url.hostname.toLowerCase()}:${Number(port)}`;
}

function validateSessionToken(
  value: string,
  decode: (part: string) => Buffer = (part) => Buffer.from(part, "base64url"),
): void {
  // This is a defense-in-depth capability bound. The ACK envelope limit above
  // currently makes it unreachable, but this validator also has direct tests.
  if (value.length > 4_096 || value.trim() !== value || hasUnsafeTokenByte(value)) {
    throw new PortalInvalidReplyError("ACK application token has an invalid shape");
  }
  const parts = value.split(".");
  if (parts.length !== 2 || parts.some((part) => part === "" || !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new PortalInvalidReplyError("ACK application token has an invalid shape");
  }
  let signatureLength = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const decoded = decode(part);
    try {
      if (decoded.toString("base64url") !== part) {
        throw new PortalInvalidReplyError("ACK application token is not canonical base64url");
      }
      if (index === 1) signatureLength = decoded.byteLength;
    } finally {
      // The token is a bearer capability. Wipe mutable validation copies even
      // though its unavoidable parsed string cannot be zeroized in JavaScript.
      decoded.fill(0);
    }
  }
  if (signatureLength !== 32) {
    throw new PortalInvalidReplyError("ACK application token signature has an invalid length");
  }
}

function hasUnsafeTokenByte(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code > 0x7f) return true;
  }
  return false;
}

function authorizeHeaders(input: Headers, token: string): Headers {
  const headers = new Headers(input);
  const preserved: string[] = [];
  for (const raw of (headers.get("cookie") ?? "").split(";")) {
    const item = raw.trim();
    if (item === "") continue;
    const equals = item.indexOf("=");
    if (equals <= 0) continue;
    const name = item.slice(0, equals).trim();
    const value = item.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (name === SESSION_COOKIE) continue;
    if (!isValidCookieValue(value)) continue;
    preserved.push(`${name}=${value}`);
  }
  preserved.push(`${SESSION_COOKIE}=${token}`);
  headers.set("cookie", preserved.join("; "));
  return headers;
}

function isValidCookieValue(value: string): boolean {
  const unquoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  for (let index = 0; index < unquoted.length; index++) {
    const code = unquoted.charCodeAt(index);
    if (
      code < 0x21 ||
      code > 0x7e ||
      code === 0x22 ||
      code === 0x2c ||
      code === 0x3b ||
      code === 0x5c
    ) {
      return false;
    }
  }
  return true;
}

function isReplayableBody(body: RequestInit["body"]): boolean {
  return (
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData
  );
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect refusal must keep its stable error even for a broken body shim.
  }
}

async function discardRequestBody(body: RequestInit["body"]): Promise<void> {
  if (!(body instanceof ReadableStream)) return;
  try {
    await body.cancel();
  } catch {
    // Invalid request handling must keep its stable error for a broken stream.
  }
}

function responseMatchesRequestUrl(responseUrl: string, requestUrl: string): boolean {
  if (responseUrl === "" || responseUrl === requestUrl) return true;
  try {
    return new URL(responseUrl).href === new URL(requestUrl).href;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForPromise(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export const portalOpenerTesting = {
  validatedCellForLink,
  validateSessionToken,
};
