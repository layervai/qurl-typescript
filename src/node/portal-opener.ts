import { randomBytes } from "node:crypto";
import type { NHPMessage } from "./nhp-wire.js";
import { NHP_TYPE_ACK, NHP_TYPE_COOKIE } from "./nhp-wire.js";
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
const RENEWAL_NUMERATOR = 3;
const RENEWAL_DENOMINATOR = 4;
const MAX_BACKGROUND_RENEWAL_ATTEMPTS = 4;
const MIN_BACKGROUND_RETRY_MS = 100;
// Node changes a larger setTimeout delay to 1 ms. Clamp long grants so an
// authenticated but unexpected lifetime cannot create a hot renewal loop.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_ACK_BODY_BYTES = 4_096;
const UINT64_MAX = (1n << 64n) - 1n;

export interface CreatePortalOpenerOptions {
  /** Full qv2t1 qURL. The opener verifies and then drops this immutable string. */
  readonly qurl: string;
  /** Native-only is deliberate. There is no relay or HTTP-resolve fallback. */
  readonly transport: "native-only";
  /** Public deployment trust. Omit to load QURL_DEPLOYMENT once at construction. */
  readonly deployment?: PortalDeployment;
  readonly timeoutMs?: number;
  readonly maxAddresses?: number;
}

export interface PortalStartOptions {
  readonly signal?: AbortSignal;
}

export type PortalRequestBuilder = (authenticatedTarget: URL) => RequestInit;

export interface PortalFetchOptions {
  /** Use `error` for signed requests whose method, target, timestamp, and nonce must not be replayed. */
  readonly redirects?: "follow" | "error";
}

export type PortalRenewalFailure = {
  readonly kind: "transport" | "busy" | "denied" | "invalid_reply";
};

export type PortalSessionHealth =
  | { readonly state: "idle" | "starting" | "closed" }
  | {
      readonly state: "healthy" | "renewing" | "degraded" | "expired";
      readonly expiresInMs: number;
      readonly backgroundAttempts: number;
      readonly renewalFailure?: PortalRenewalFailure;
    };

export interface PortalOpener {
  /** Open now and schedule renewal before the admission expires. */
  start(options?: PortalStartOptions): Promise<void>;
  /** Start a fetch at the exact ACK URL. Same-origin redirects follow only when allowed. */
  fetch(init?: RequestInit | PortalRequestBuilder, options?: PortalFetchOptions): Promise<Response>;
  /** Read local session state. This method does no I/O and exposes no capability. */
  health(): PortalSessionHealth;
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

interface PortalRuntime {
  readonly knock: (
    cell: ValidatedCell,
    key: Uint8Array,
    body: Uint8Array,
    options: NativeExchangeOptions,
  ) => Promise<NHPMessage>;
  readonly fetch: typeof globalThis.fetch;
  readonly nowNanos: () => bigint;
  readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
}

const defaultRuntime: PortalRuntime = {
  knock: nativeKnock,
  fetch: globalThis.fetch.bind(globalThis),
  nowNanos: () => process.hrtime.bigint(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
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
  if (options.transport !== "native-only") {
    throw new PortalConfigurationError("native portal opener transport must be native-only");
  }
  if (typeof options.qurl !== "string" || options.qurl === "") {
    throw new PortalConfigurationError("native portal opener qurl must be a non-empty string");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60_000)
  ) {
    throw new PortalConfigurationError("native portal opener timeoutMs must be from 1 to 60000");
  }
  if (
    options.maxAddresses !== undefined &&
    (!Number.isInteger(options.maxAddresses) ||
      options.maxAddresses < 1 ||
      options.maxAddresses > 16)
  ) {
    throw new PortalConfigurationError("native portal opener maxAddresses must be from 1 to 16");
  }

  let deployment: ValidatedDeployment;
  try {
    deployment = loadPortalDeployment(options.deployment);
  } catch (error) {
    throw new PortalConfigurationError("native qURL deployment trust is invalid", {
      cause: error,
    });
  }
  let link: VerifiedQv2Link;
  try {
    link = verifyQv2Link(options.qurl, deployment.issuers);
  } catch (error) {
    throw new PortalVerificationError("native qURL credential validation failed", {
      cause: error,
    });
  }
  const cell = deployment.cells.get(fingerprintKey(link.claims.cellPublicKey));
  if (!cell) {
    link.devicePrivateKey.fill(0);
    throw new PortalConfigurationError("verified qURL names a cell outside the native catalog");
  }
  return new NativePortalOpener(options, link, cell, runtime);
}

type ActiveGrant = {
  readonly resourceUrl: string;
  readonly origin: string;
  readonly openSeconds: number;
  readonly sessionId: bigint;
  readonly expiresAtNanos: bigint;
  readonly token: Buffer;
};

class NativePortalOpener implements PortalOpener {
  readonly #link: VerifiedQv2Link;
  readonly #cell: ValidatedCell;
  readonly #runtime: PortalRuntime;
  readonly #exchangeOptions: Omit<NativeExchangeOptions, "signal">;
  readonly #sessionSecret = randomBytes(32);
  #grant?: ActiveGrant;
  #openPromise?: Promise<void>;
  #openController?: AbortController;
  #closePromise?: Promise<void>;
  #renewalTimer?: NodeJS.Timeout;
  #renewalError?: unknown;
  #renewalFailure?: PortalRenewalFailure;
  #backgroundAttempts = 0;
  #renewing = false;
  #closed = false;

  constructor(
    options: CreatePortalOpenerOptions,
    link: VerifiedQv2Link,
    cell: ValidatedCell,
    runtime: PortalRuntime,
  ) {
    this.#link = link;
    this.#cell = cell;
    this.#runtime = runtime;
    this.#exchangeOptions = { timeoutMs: options.timeoutMs, maxAddresses: options.maxAddresses };
  }

  async start(options: PortalStartOptions = {}): Promise<void> {
    this.#requireOpen();
    if (
      this.#grant &&
      this.#runtime.nowNanos() < this.#grant.expiresAtNanos &&
      !this.#renewalFailure
    ) {
      return;
    }
    return this.#openSingleFlight(options.signal);
  }

  async fetch(
    input: RequestInit | PortalRequestBuilder = {},
    options: PortalFetchOptions = {},
  ): Promise<Response> {
    this.#requireOpen();
    if (
      options.redirects !== undefined &&
      options.redirects !== "follow" &&
      options.redirects !== "error"
    ) {
      throw new PortalStateError("portal fetch redirects must be follow or error");
    }
    const grant = this.#grant;
    if (!grant) throw new PortalStateError("portal opener must be started before fetch");
    if (this.#runtime.nowNanos() >= grant.expiresAtNanos) {
      throw new PortalStateError("portal admission expired; call start to open it again", {
        cause: this.#renewalError,
      });
    }
    // A successful renewal or close wipes the mutable grant token. Keep the
    // unavoidable request string local to this fetch so every redirect leg has
    // one stable credential snapshot.
    const sessionToken = grant.token.toString("ascii");
    const init = typeof input === "function" ? input(new URL(grant.resourceUrl)) : input;
    if (!init || typeof init !== "object") {
      throw new PortalStateError("portal request builder must return RequestInit");
    }
    if (Object.prototype.hasOwnProperty.call(init, "redirect") && init.redirect !== undefined) {
      throw new PortalStateError(
        "portal fetch owns redirect handling; redirect overrides are not allowed",
      );
    }
    let currentUrl = grant.resourceUrl;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = new Headers(init.headers);
    for (let requestCount = 1; ; requestCount++) {
      this.#requireOpen();
      const requestHeaders = authorizeHeaders(headers, sessionToken);
      const response = await this.#runtime.fetch(currentUrl, {
        ...init,
        method,
        body,
        headers: requestHeaders,
        redirect: "manual",
      });
      if (response.redirected === true || !responseMatchesRequestUrl(response.url, currentUrl)) {
        await discardResponseBody(response);
        throw new PortalStateError(
          "portal fetch refused a response that bypassed its manual redirect policy",
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (options.redirects === "error") {
        await discardResponseBody(response);
        throw new PortalStateError("portal fetch refused a redirect for a fixed signed request");
      }
      const location = response.headers.get("location");
      if (!location) return response;
      if (requestCount >= MAX_REDIRECT_REQUESTS) {
        await discardResponseBody(response);
        throw new PortalStateError("portal fetch stopped at the 10-request redirect limit");
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        await discardResponseBody(response);
        throw new PortalStateError("portal fetch refused an invalid redirect target");
      }
      let nextOrigin: string;
      try {
        nextOrigin = normalizedHttpsOrigin(next);
      } catch {
        await discardResponseBody(response);
        throw new PortalStateError("portal fetch refused an invalid redirect target");
      }
      if (nextOrigin !== grant.origin) {
        await discardResponseBody(response);
        throw new PortalStateError(
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
  }

  health(): PortalSessionHealth {
    if (this.#closed) return { state: "closed" };
    if (this.#openPromise && !this.#grant) return { state: "starting" };
    const grant = this.#grant;
    if (!grant) return { state: "idle" };
    const expiresInMs = Number((grant.expiresAtNanos - this.#runtime.nowNanos()) / 1_000_000n);
    if (expiresInMs <= 0) {
      return {
        state: "expired",
        expiresInMs: 0,
        backgroundAttempts: this.#backgroundAttempts,
        renewalFailure: this.#renewalFailure,
      };
    }
    return {
      state: this.#renewing ? "renewing" : this.#renewalFailure ? "degraded" : "healthy",
      expiresInMs,
      backgroundAttempts: this.#backgroundAttempts,
      renewalFailure: this.#renewalFailure,
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    if (this.#renewalTimer) this.#runtime.clearTimer(this.#renewalTimer);
    this.#renewalTimer = undefined;
    const active = this.#openPromise;
    this.#openController?.abort(
      new PortalStateError("portal opener closed while a native open was in progress"),
    );
    const closing = (async () => {
      try {
        await active;
      } catch {
        // The initiating caller receives this error. close is idempotent cleanup.
      } finally {
        this.#grant?.token.fill(0);
        this.#grant = undefined;
        this.#link.devicePrivateKey.fill(0);
        this.#sessionSecret.fill(0);
        this.#renewalError = undefined;
        this.#renewalFailure = undefined;
        this.#backgroundAttempts = 0;
        this.#renewing = false;
      }
    })();
    this.#closePromise = closing;
    return closing;
  }

  #openSingleFlight(signal?: AbortSignal): Promise<void> {
    this.#requireOpen();
    const active = this.#openPromise;
    if (active) return waitForPromise(active, signal);

    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(signal, controller);
    const current = this.#performOpen(controller.signal).finally(() => {
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
    const body = this.#knockBody();
    try {
      // Start the local validity bound before DNS and UDP I/O. The cell starts
      // its grant no earlier than this, so this client never assumes extra RTT.
      const openedAtNanos = this.#runtime.nowNanos();
      const reply = await this.#runtime.knock(this.#cell, this.#link.devicePrivateKey, body, {
        ...this.#exchangeOptions,
        signal,
      });
      try {
        if (this.#closed) {
          throw new PortalStateError("portal opener was closed while start was in progress");
        }
        if (reply.type === NHP_TYPE_COOKIE) {
          throw new PortalStateError("qURL platform is busy; retry start later");
        }
        if (reply.type !== NHP_TYPE_ACK) {
          throw new PortalStateError("native NHP returned an unexpected reply type");
        }
        const grant = parseGrant(reply.body, openedAtNanos);
        const old = this.#grant;
        this.#grant = grant;
        old?.token.fill(0);
        this.#renewalError = undefined;
        this.#renewalFailure = undefined;
        this.#backgroundAttempts = 0;
        this.#renewing = false;
        this.#scheduleRenewal(grant.openSeconds);
      } finally {
        // ACK and deny bodies can contain a bearer. Wipe them on every parse path.
        reply.body.fill(0);
      }
    } finally {
      body.fill(0);
    }
  }

  #scheduleRenewal(openSeconds: number): void {
    if (this.#renewalTimer) this.#runtime.clearTimer(this.#renewalTimer);
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, Math.floor((openSeconds * 1_000 * RENEWAL_NUMERATOR) / RENEWAL_DENOMINATOR)),
    );
    this.#renewalTimer = this.#runtime.setTimer(() => {
      this.#renewalTimer = undefined;
      if (this.#closed) return;
      this.#renewing = true;
      this.#backgroundAttempts++;
      void this.#openSingleFlight().catch((error: unknown) => this.#handleRenewalFailure(error));
    }, delayMs);
    this.#renewalTimer.unref?.();
  }

  #handleRenewalFailure(error: unknown): void {
    if (this.#closed) return;
    this.#renewing = false;
    this.#renewalError = error;
    this.#renewalFailure = classifyRenewalFailure(error);
    if (this.#backgroundAttempts >= MAX_BACKGROUND_RENEWAL_ATTEMPTS) return;
    const grant = this.#grant;
    if (!grant) return;
    const remainingMs = Number((grant.expiresAtNanos - this.#runtime.nowNanos()) / 1_000_000n);
    if (remainingMs <= MIN_BACKGROUND_RETRY_MS * 2) return;
    const exponent = Math.max(0, this.#backgroundAttempts - 1);
    const base = MIN_BACKGROUND_RETRY_MS * 2 ** exponent;
    const random = randomBytes(2).readUInt16BE(0) / 0xffff;
    const jittered = Math.max(MIN_BACKGROUND_RETRY_MS, Math.floor(base * (0.75 + random * 0.5)));
    const delayMs = Math.min(jittered, Math.floor(remainingMs / 2));
    this.#renewalTimer = this.#runtime.setTimer(() => {
      this.#renewalTimer = undefined;
      if (this.#closed) return;
      this.#renewing = true;
      this.#backgroundAttempts++;
      void this.#openSingleFlight().catch((next: unknown) => this.#handleRenewalFailure(next));
    }, delayMs);
    this.#renewalTimer.unref?.();
  }

  #knockBody(): Uint8Array {
    // Immutable JS strings cannot be zeroized. Keep their lifetime to this one
    // serialization and retain private capability material only in mutable
    // buffers between opens.
    const encoded = JSON.stringify({
      headerType: 1,
      aspId: "qurl",
      resId: this.#link.claims.resourcePublicKeyB64,
      usrData: {
        qurl_claims_b64: this.#link.claimsB64,
        qurl_issuer_sig_b64: this.#link.signatureB64,
        qurl_session_secret: this.#sessionSecret.toString("base64url"),
      },
    });
    const body = Buffer.from(encoded, "utf8");
    if (body.byteLength > 3_840) throw new PortalStateError("native qURL knock body is too large");
    return body;
  }

  #requireOpen(): void {
    if (this.#closed) throw new PortalStateError("portal opener is closed");
  }
}

function parseGrant(body: Uint8Array, nowNanos: bigint): ActiveGrant {
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(body, MAX_ACK_BODY_BYTES);
  } catch (error) {
    throw new PortalStateError("native NHP ACK body is malformed", { cause: error });
  }
  if (!isStrictJsonObject(value)) throw new PortalStateError("native NHP ACK must be an object");
  const errCode = value.errCode === undefined ? "" : requireString(value.errCode, "ACK errCode");
  if (errCode !== "" && errCode !== "0") {
    if (!/^[1-9][0-9]*$/.test(errCode))
      throw new PortalStateError("native NHP deny code is not canonical");
    if ("sessId" in value || value.opnTime !== 0n || value.aspToken !== undefined) {
      throw new PortalStateError("native NHP deny ACK contains success capability fields");
    }
    throw new PortalDenyError(errCode);
  }
  const sessionId = requireUnsignedInteger(value.sessId, "ACK session id", UINT64_MAX);
  if (sessionId === 0n) throw new PortalStateError("native NHP ACK session id must be positive");
  const openSecondsBig = requireUnsignedInteger(value.opnTime, "ACK open time", 0xffff_ffffn);
  if (openSecondsBig === 0n)
    throw new PortalStateError("native NHP ACK open time must be positive");
  const openSeconds = Number(openSecondsBig);
  const resourceUrl = requireString(value.redirectUrl, "ACK resource URL");
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    throw new PortalStateError("ACK resource URL is invalid");
  }
  if (parsed.hash !== "")
    throw new PortalStateError("ACK resource URL must not contain a fragment");
  const origin = normalizedHttpsOrigin(parsed);
  const tokenString = requireString(value.aspToken, "ACK application token");
  validateSessionToken(tokenString);
  const token = Buffer.from(tokenString, "ascii");
  return {
    resourceUrl,
    origin,
    openSeconds,
    sessionId,
    expiresAtNanos: nowNanos + BigInt(openSeconds) * 1_000_000_000n,
    token,
  };
}

function requireString(value: StrictJsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value === "")
    throw new PortalStateError(`${name} is missing or invalid`);
  return value;
}

function requireUnsignedInteger(
  value: StrictJsonValue | undefined,
  name: string,
  maximum: bigint,
): bigint {
  if (typeof value !== "bigint") {
    throw new PortalStateError(`${name} must be an unsigned decimal integer`);
  }
  if (value < 0n || value > maximum) throw new PortalStateError(`${name} is outside its range`);
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

function validateSessionToken(value: string): void {
  if (value.length > 4_096 || value.trim() !== value || hasUnsafeTokenByte(value)) {
    throw new PortalStateError("ACK application token has an invalid shape");
  }
  const parts = value.split(".");
  if (parts.length !== 2 || parts.some((part) => part === "" || !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new PortalStateError("ACK application token has an invalid shape");
  }
  for (const part of parts) {
    const decoded = Buffer.from(part, "base64url");
    if (decoded.toString("base64url") !== part) {
      throw new PortalStateError("ACK application token is not canonical base64url");
    }
  }
  if (Buffer.from(parts[1], "base64url").byteLength !== 32) {
    throw new PortalStateError("ACK application token signature has an invalid length");
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
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
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
    (typeof FormData !== "undefined" && body instanceof FormData)
  );
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect refusal must keep its stable error even for a broken body shim.
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

function classifyRenewalFailure(error: unknown): PortalRenewalFailure {
  if (error instanceof PortalDenyError) return { kind: "denied" };
  if (error instanceof PortalStateError) {
    if (error.message === "qURL platform is busy; retry start later") return { kind: "busy" };
    return { kind: "invalid_reply" };
  }
  return { kind: "transport" };
}
