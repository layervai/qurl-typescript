// registerAgent — the NHP-native front door for enrolling an agent and getting a
// ready-to-use QURLClient. Mirrors the Go SDK `qurl.RegisterAgent` state machine
// (`qurl-go/qurl/register.go`, `register_wire.go`, `register_errors.go`).
//
// It is idempotent: the first call enrolls and persists a device credential into
// the store; later calls load that credential and return a client with no
// network I/O.
import { QURLClient } from "./client.js";
import type { AgentState, AgentStateStore } from "./agent-state.js";
import { AGENT_STATE_SCHEMA_VERSION } from "./agent-state.js";
import type { ClientOptions, NHPServerPeerInfo } from "./types.js";
import {
  QURLError,
  RegisterConfigError,
  BootstrapConfigError,
  RegistrationTransportError,
  OTPPendingError,
  OTPIncorrectError,
  OTPExpiredError,
  RegistrationRateLimitedError,
  RegisterKeyRejectedError,
  AgentIdentityConflictError,
  NoAccountEmailError,
  DeviceCredentialMissingError,
  RegistrationInvalidInputError,
  RegistrationDisabledError,
  RegistrationRetryLaterError,
  BootstrapSetupKeyConsumedError,
  InvalidAgentStateError,
  RegistrationDenyError,
  RegistrationError,
} from "./errors.js";
import { errText, stripTrailingSlashes } from "./internal.js";
// The vendored NHP wire crypto (src/crypto/) is loaded LAZILY via a memoized
// dynamic import (see loadCrypto), NOT statically. Rationale: @noble/curves,
// @noble/ciphers, and @noble/hashes are ESM-only ("type":"module", no CJS
// build). A static import pulls them into this module's load graph, which — in
// the package's CommonJS build — becomes `require("@noble/...")` and throws
// ERR_REQUIRE_ESM on Node < 20.19 (the package floor is Node 20.0.0). Deferring
// the load keeps `require("@layervai/qurl")` crypto-free, so a CJS consumer that
// never calls registerAgent/bootstrapAgent loads cleanly on any supported Node;
// the crypto is imported only when a registration run actually begins, and the
// loaded module is threaded through `cfg.crypto`. The ESM build is unaffected
// (noble is ESM). See tsconfig.cjs.json's TODO — a future `module:node16` CJS
// migration could statically import instead. Type-only imports below carry no
// runtime require.
import type * as CryptoWire from "./crypto/index.js";

/** The lazily-loaded vendored crypto module, resolved once per process. */
type CryptoModule = typeof CryptoWire;
let cryptoModulePromise: Promise<CryptoModule> | undefined;

/** The dynamic-import thunk `loadCrypto` memoizes. A module-internal seam (not a
 * public option): tests override it via {@link setCryptoImporterForTest} to
 * simulate the CJS + Node < 20.19 `ERR_REQUIRE_ESM` failure of the ESM-only
 * `@noble/*` deps and to assert the memo resets on failure. Defaults to the real
 * dynamic import of the vendored wire. */
let cryptoImporter: () => Promise<CryptoModule> = () => import("./crypto/index.js");

/** Loads the vendored NHP wire crypto via a memoized dynamic import. Kept out of
 * the static graph so the package's CJS entry does not `require` the ESM-only
 * noble deps at load time (see the import-block note above).
 *
 * On failure the memo is CLEARED before the rejection propagates, so a caller who
 * corrects the condition mid-process (e.g. re-enters through the ESM build, or on
 * a runtime that later satisfies the import) can retry instead of being wedged on
 * a permanently-rejected promise. A resolved module stays memoized for the process
 * lifetime. */
async function loadCrypto(): Promise<CryptoModule> {
  if (cryptoModulePromise === undefined) {
    // Assign the in-flight promise so concurrent callers share one import, but
    // drop it on rejection so the failure is not cached forever. Attaching the
    // reset via `.catch` (rethrowing) rather than a try/catch keeps the shared
    // in-flight promise identity for concurrent awaiters while still clearing the
    // slot once it settles as rejected.
    cryptoModulePromise = cryptoImporter().catch((err: unknown) => {
      cryptoModulePromise = undefined;
      throw err;
    });
  }
  return cryptoModulePromise;
}

/**
 * Test-only seam: override the crypto-import thunk and reset the memo. Returns a
 * restore function. NOT part of the public contract — it exists so a test can
 * simulate the CJS/Node-version dynamic-import failure and the memo-reset-on-retry
 * behavior without shipping a CJS build to an old Node. Passing `undefined`
 * restores the real dynamic import.
 */
export function setCryptoImporterForTest(
  importer: (() => Promise<CryptoModule>) | undefined,
): () => void {
  const previous = cryptoImporter;
  cryptoImporter = importer ?? (() => import("./crypto/index.js"));
  cryptoModulePromise = undefined;
  return () => {
    cryptoImporter = previous;
    cryptoModulePromise = undefined;
  };
}

/**
 * Recognizes the CommonJS + Node < 20.19 failure to dynamic-import the ESM-only
 * `@noble/*` wire deps (Node raises `ERR_REQUIRE_ESM` when `require()` — which a
 * CJS build's dynamic `import()` lowers to on older Node 20.x — hits an
 * ES-module-only package). Node < 20.19 predates `require()` of ES modules, so the
 * import cannot resolve. Returns true for that signature and its close variants so
 * the raw error can be re-thrown as an actionable {@link RegisterConfigError}.
 */
function isESMRequireError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_REQUIRE_ESM") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  // Fallback for runtimes/bundlers that surface the same condition without the
  // canonical `.code` (e.g. a transpiled `require()` of an ESM package, or the
  // "Cannot use import statement outside a module" phrasing).
  return (
    message.includes("ERR_REQUIRE_ESM") ||
    message.includes("require() of ES Module") ||
    message.includes("Cannot use import statement outside a module")
  );
}

/** Loads the vendored crypto for a run, mapping the CJS/Node-version ESM-import
 * failure to an actionable {@link RegisterConfigError} whose message names the two
 * fixes (call via the ESM entry, or upgrade to Node ≥ 20.19). Any other load
 * failure propagates unchanged. See {@link isESMRequireError} and the import-block
 * note above. */
async function loadCryptoForRun(): Promise<CryptoModule> {
  try {
    return await loadCrypto();
  } catch (err) {
    if (isESMRequireError(err)) {
      throw new RegisterConfigError(
        "the NHP registration wire depends on ESM-only packages (@noble/curves, @noble/ciphers, @noble/hashes) that could not be loaded under the CommonJS build: Node raised ERR_REQUIRE_ESM. Fix by calling registerAgent/bootstrapAgent via the ESM entry (import, not require), or upgrade to Node >= 20.19 (which added require() of ES modules). Importing the package and using the rest of the client is unaffected.",
        { cause: err },
      );
    }
    throw err;
  }
}

const DEFAULT_BASE_URL = "https://api.layerv.ai";
const DEFAULT_TIMEOUT_MS = 30_000;

/** The NHP authorization-service-provider id for the agent registration path. */
const AGENT_ASP_ID = "agent";

/** How long the account path waits before re-sending an email one-time code on a
 * rapid re-run, so repeated calls do not spam the account. Mirrors Go
 * `otpResendCooldown`. */
const OTP_RESEND_COOLDOWN_MS = 60_000;

/** Key-kind values returned by registration-info. */
const KEY_KIND_BOOTSTRAP = "bootstrap";
const KEY_KIND_ACCOUNT = "account";

/** The NHP_RAK success errCode. `""` and `"0"` both mean success. */
const RAK_SUCCESS = "0";

// NHP_RAK error codes (the enrollment wire contract). Mirrors register_wire.go.
const RAK_CREDENTIAL_INVALID = "52100"; // OTP/credential wrong
const RAK_CREDENTIAL_EXPIRED = "52101"; // OTP expired
const RAK_ATTEMPTS_EXCEEDED = "52102"; // too many attempts (lockout)
const RAK_IDENTITY_CONFLICT = "52103"; // device identity already enrolled elsewhere
const RAK_RATE_LIMITED = "52104"; // rate limited
const RAK_EMAIL_UNAVAILABLE = "52105"; // no account email for the code
const RAK_INVALID_API_KEY = "52106"; // API key invalid
const RAK_REGISTRATION_OFF = "52107"; // registration disabled
const RAK_BOOTSTRAP_CONSUMED = "52108"; // pre-issued setup key already consumed
const RAK_INVALID_INPUT = "52109"; // malformed registration input (e.g. device id)

/** The two enrollment paths. 52100's meaning depends on the path: an account
 * path treats it as a wrong OTP; a bootstrap path treats it as a rejected key. */
type PathKind = "account" | "bootstrap";

/** An OTP-provider callback: returns the email one-time code, for callers that
 * fetch it programmatically rather than passing a literal. */
export type OTPProvider = () => Promise<string> | string;

/**
 * Options for {@link registerAgent}. Every field mirrors a Go `WithX` option
 * (`register.go`). All are optional; the defaults enroll against
 * `https://api.layerv.ai` with a generated, persisted device id.
 */
export interface RegisterOptions {
  /** The email one-time code to finish account-key registration. Set on the
   * resume call after LayerV emails the code. Ignored on the pre-issued
   * (bootstrap) key path. Mirrors `WithOTP`. */
  otp?: string;
  /** A callback returning the email one-time code, for callers that fetch it
   * programmatically (e.g. from a mailbox API). Called only on the account path
   * when a code is needed. Set at most one of {@link otp} or this. On a fresh
   * store the code is dispatched and then this is invoked in the same call, so it
   * must tolerate/await email delivery. Mirrors `WithOTPProvider`. */
  otpProvider?: OTPProvider;
  /** The stable device id (also the enrolled agent id and the NHP device id).
   * When omitted, a stable id is generated on first run and persisted. Mirrors
   * `WithDeviceID`. */
  deviceId?: string;
  /** Re-bind a device identity already enrolled to a different key or agent,
   * resolving an {@link AgentIdentityConflictError}. Replaces the prior binding —
   * use deliberately. Mirrors `WithTakeover`. */
  takeover?: boolean;
  /** Records the local hostname in registration audit metadata. Mirrors
   * `WithRegisterHostname`. */
  hostname?: string;
  /** Records the local build version in registration audit metadata. Mirrors
   * `WithRegisterVersion`. */
  version?: string;
  /** Points registration at a non-default LayerV API origin for the
   * registration-info and completion HTTPS endpoints. This origin also becomes
   * the base URL of the returned client. Mirrors `WithRegisterBaseURL`. */
  baseUrl?: string;
  /** Custom fetch implementation for the registration HTTPS endpoints and the
   * relay POSTs, and for the returned client. Mirrors `WithRegisterHTTPClient`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms for the registration HTTPS endpoints and relay
   * POSTs. Default 30000. */
  timeoutMs?: number;
  /** Overrides the NHP relay base URL that registration-info would otherwise
   * supply. Advanced; like {@link nhpPeer}, an overridden relay bypasses the
   * registration-info integrity check — route only through a relay you trust.
   * Mirrors `WithRelayURL`. */
  relayUrl?: string;
  /** Overrides the NHP server peer that registration-info would otherwise
   * supply. Advanced; NOT covered by the server_id ⇄ peer-key fingerprint check
   * (that validates only the peer the service reported) — pin only a peer you
   * trust. Mirrors `WithNHPPeer`. */
  nhpPeer?: NHPServerPeerInfo;
  /** Test seam: injected wall-clock, used everywhere the engine needs "now" (the
   * OTP resend cooldown, timestamps). Defaults to `Date.now`. Not part of the
   * public contract. */
  now?: () => number;
  /** Test seam: injected random-bytes source for the NHP handshake (ephemeral
   * key, counter, preamble) and device-id/keypair generation. Defaults to
   * `globalThis.crypto.getRandomValues`. Not part of the public contract. */
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * The result of a successful {@link registerAgent}: the ready-to-use client plus
 * the registered {@link AgentState} (the credential; see the AgentState doc).
 * The `client` is authorized with the persisted device API key.
 */
export interface RegisterAgentResult {
  /** A ready-to-use client authorized with the device API key minted at
   * registration completion. */
  client: QURLClient;
  /** The registered agent state. It is a CREDENTIAL — it holds `device_api_key`.
   * Keep it out of logs and support bundles. */
  state: AgentState;
}

/**
 * Enrolls an agent over NHP and returns a ready-to-use {@link QURLClient}. It is
 * idempotent: the first call enrolls and persists a device credential into
 * `store`; later calls load that credential and return a client with no network
 * I/O.
 *
 * `apiKey` is used only during first enrollment. Once `store` holds a completed
 * registration the fast path serves the client entirely from it and does not
 * re-validate the key.
 *
 * Two enrollment paths are selected by the key, transparently:
 *   - A pre-issued (bootstrap) key IS the enrollment credential: registration
 *     completes in one call.
 *   - An account key uses email one-time codes. The first call asks LayerV to
 *     email a code and throws {@link OTPPendingError}; re-run with the code in
 *     the `otp` option once it arrives to finish. See {@link
 *     RegisterOptions.otpProvider} for the single-call variant.
 *
 * `store` persists {@link AgentState}, which becomes a credential once enrollment
 * completes. Registration proves the agent's X25519 device key through the NHP
 * Noise handshake, so the same keypair is reused across resumes.
 *
 * Call from one setup path at a time for a given store. Each state write is
 * atomic, but the SDK does not lock across concurrent callers sharing a state
 * file — on the account path each concurrent fresh run dispatches its own code,
 * so concurrent setup multiplies OTP emails. Concurrent callers also race the
 * final completion write: each persists its own registered {@link AgentState}
 * (device credential included) last-writer-wins, so the credential left on disk is
 * whichever run finished last. Serialize enrollment per store.
 *
 * Runtime note: the NHP wire crypto depends on ESM-only packages (`@noble/*`)
 * and is imported lazily on the first call. Under the ESM build this works on
 * every supported Node. Under the CommonJS build (`require("@layervai/qurl")`),
 * that lazy import resolves via `require()`, which needs Node ≥ 20.19 (the
 * version that added `require()` of ES modules); a CJS consumer on an older
 * Node 20.x should use the ESM entry to call this. Importing the package and
 * using the rest of the client is unaffected on any supported Node.
 *
 * @example
 * ```ts
 * const { client } = await registerAgent(apiKey, new FileAgentStateStore("./agent.json"));
 * const resource = await client.createResource({
 *   type: "url",
 *   target_url: "https://dashboard.internal.example.com",
 * });
 * ```
 */
export async function registerAgent(
  apiKey: string,
  store: AgentStateStore,
  opts: RegisterOptions = {},
): Promise<RegisterAgentResult> {
  const cfg = newRegisterConfig(apiKey, store, opts);
  const state = await cfg.run(apiKey, store);
  const client = newStoreBackedClient(state, cfg);
  return { client, state };
}

/** Options for {@link bootstrapAgent}. A subset of {@link RegisterOptions} — the
 * bootstrap (pre-issued key) path takes no OTP options. */
export interface BootstrapAgentOptions {
  /** The stable device id (also the enrolled agent id and NHP device id).
   * Generated and persisted on first run when omitted. */
  deviceId?: string;
  /** Records the local hostname in registration audit metadata. */
  hostname?: string;
  /** Records the local build version in registration audit metadata. */
  version?: string;
  /** Points bootstrap at a non-default LayerV API origin. */
  baseUrl?: string;
  /** Custom fetch implementation for the registration HTTPS endpoints and relay POSTs. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Advanced: override the NHP relay base URL. */
  relayUrl?: string;
  /** Advanced: override the NHP server peer. */
  nhpPeer?: NHPServerPeerInfo;
  /** Test seam: injected wall-clock. Not part of the public contract. */
  now?: () => number;
  /** Test seam: injected random-bytes source. Not part of the public contract. */
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Consumes a pre-issued (bootstrap) LayerV setup key, enrolls a local X25519
 * identity over NHP, saves it in `store`, and returns the registered
 * {@link AgentState}. Mirrors the Go SDK `qurl.BootstrapAgent`: it runs the SAME
 * NHP registration engine as {@link registerAgent}'s bootstrap path (a
 * registration-info pre-flight, an NHP_REG carrying the setup key as the
 * enrollment credential, and a completion fetch), specialized to the pre-issued
 * path and returning the raw state rather than a client.
 *
 * @deprecated Prefer {@link registerAgent} for new code: it returns a
 * ready-to-use {@link QURLClient} and covers both the pre-issued-key and
 * email-OTP paths. `bootstrapAgent` is kept for callers that manage the client
 * separately.
 *
 * If `store` already contains a registered AgentState, it is returned without
 * sending the setup key again. Unlike {@link registerAgent}, the fast path does
 * NOT require a device credential, so a legacy bootstrap-era state (registered,
 * no device key) still returns.
 */
export async function bootstrapAgent(
  setupKey: string,
  store: AgentStateStore,
  opts: BootstrapAgentOptions = {},
): Promise<AgentState> {
  // Validate the bootstrap-specific inputs under the bootstrap front-door class
  // (mirrors Go BootstrapAgent's early ErrInvalidBootstrapConfig checks) before
  // delegating to the shared engine config, which then keeps that class via the
  // invalidConfig override below.
  if (typeof setupKey !== "string" || setupKey.trim() === "") {
    throw new BootstrapConfigError("setup key must not be empty");
  }
  if (store === null || store === undefined || typeof store.loadAgentState !== "function") {
    throw new BootstrapConfigError("state store must not be null");
  }
  const cfg = newRegisterConfig(setupKey, store, {
    deviceId: opts.deviceId,
    hostname: opts.hostname,
    version: opts.version,
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
    relayUrl: opts.relayUrl,
    nhpPeer: opts.nhpPeer,
    now: opts.now,
    randomBytes: opts.randomBytes,
  });
  // BootstrapAgent is PATH A specialized: leave requireDeviceKey false so a
  // legacy bootstrap-era state (registered, no device key) still returns from the
  // fast path, and keep the front-door config-error class as the bootstrap class.
  cfg.requireDeviceKey = false;
  cfg.invalidConfig = (detail, options) => new BootstrapConfigError(detail, options);
  return cfg.run(setupKey, store);
}

/** The resolved option set plus fixed dependencies a registration run needs.
 * Mirrors Go `registerConfig`. */
interface RegisterConfig {
  baseUrl: string;
  fetchFn: typeof globalThis.fetch;
  timeoutMs: number;
  deviceId: string;
  otp: string;
  otpProvider?: OTPProvider;
  takeover: boolean;
  hostname: string;
  version: string;
  relayUrlOverride: string;
  nhpPeerOverride?: NHPServerPeerInfo;
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  /** Makes the fast path fail closed when a registered state carries no device
   * credential. registerAgent sets it; bootstrapAgent leaves it false so a legacy
   * bootstrap-era state without a device key still returns. */
  requireDeviceKey: boolean;
  /** Builds a config-class error for this front door (registerAgent →
   * RegisterConfigError; bootstrapAgent → a bootstrap-config error), so each
   * front door keeps its documented class on device-id mismatch, key decode,
   * server_id mismatch, and loaded-state validation. Mirrors `invalidConfigErr`. */
  invalidConfig: (detail: string, options?: { cause?: unknown }) => RegistrationError;
  /** The lazily-loaded vendored NHP wire crypto, resolved once at the start of a
   * run (see loadCrypto) and read synchronously by the crypto-using helpers. It
   * is populated by {@link runEngine} before any crypto call. */
  crypto: CryptoModule;
  run(apiKey: string, store: AgentStateStore): Promise<AgentState>;
}

function newRegisterConfig(
  apiKey: string,
  store: AgentStateStore,
  opts: RegisterOptions,
): RegisterConfig {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new RegisterConfigError("API key must not be empty");
  }
  if (store === null || store === undefined || typeof store.loadAgentState !== "function") {
    throw new RegisterConfigError("state store must not be null");
  }
  if (opts.otp !== undefined && opts.otpProvider !== undefined) {
    throw new RegisterConfigError("set only one of the otp or otpProvider option");
  }
  if (opts.otp !== undefined && opts.otp.trim() === "") {
    throw new RegisterConfigError("one-time code must not be empty");
  }
  if (opts.deviceId !== undefined && opts.deviceId.trim() === "") {
    throw new RegisterConfigError("device id must not be empty");
  }
  if (opts.hostname !== undefined && opts.hostname.trim() === "") {
    throw new RegisterConfigError("hostname must not be empty");
  }
  if (opts.version !== undefined && opts.version.trim() === "") {
    throw new RegisterConfigError("version must not be empty");
  }
  const baseUrl =
    opts.baseUrl !== undefined
      ? validatedHttpsOrLoopback(opts.baseUrl, "register base URL")
      : DEFAULT_BASE_URL;
  const relayUrlOverride =
    opts.relayUrl !== undefined ? validatedHttpsOrLoopback(opts.relayUrl, "relay URL") : "";
  if (opts.nhpPeer !== undefined) {
    validateNHPServerPeerInfo(
      opts.nhpPeer,
      opts.now ? opts.now() : Date.now(),
      "nhpPeer option",
      (d) => new RegisterConfigError(d),
    );
  }

  const cfg: RegisterConfig = {
    baseUrl,
    fetchFn: opts.fetch ?? globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deviceId: opts.deviceId?.trim() ?? "",
    otp: opts.otp?.trim() ?? "",
    otpProvider: opts.otpProvider,
    takeover: opts.takeover ?? false,
    hostname: opts.hostname ?? "",
    version: opts.version ?? "",
    relayUrlOverride,
    nhpPeerOverride: opts.nhpPeer,
    now: opts.now ?? Date.now,
    randomBytes: opts.randomBytes ?? defaultRandomBytes,
    requireDeviceKey: true,
    invalidConfig: (detail, options) => new RegisterConfigError(detail, options),
    // Populated by runEngine via loadCrypto before any crypto helper runs; the
    // lazy-load throwing guard makes a premature read fail loudly rather than
    // silently using an unloaded module.
    crypto: cryptoNotLoadedGuard(),
    run(apiKey: string, store: AgentStateStore) {
      return runEngine(this, apiKey, store);
    },
  };
  return cfg;
}

/** A stand-in {@link CryptoModule} for `cfg.crypto` before {@link runEngine}
 * loads the real one. Every property access throws, so a code path that uses
 * crypto without going through runEngine's load fails loudly instead of reading
 * `undefined`. runEngine overwrites `cfg.crypto` with the real module first. */
function cryptoNotLoadedGuard(): CryptoModule {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(
          "qurl: internal error — NHP crypto used before it was loaded (runEngine must call loadCrypto first)",
        );
      },
    },
  ) as CryptoModule;
}

/**
 * Drives the registration state machine to a registered {@link AgentState}. State
 * is derived from AgentState fields (no enum): absent → keypair-persisted →
 * otp_pending → registered. Mirrors Go `registerConfig.run`.
 */
async function runEngine(
  cfg: RegisterConfig,
  apiKey: string,
  store: AgentStateStore,
): Promise<AgentState> {
  // Load the vendored NHP wire crypto once, before any helper touches it
  // (loadOrCreateAgentState derives the device public key). Lazy so the package's
  // CJS entry does not eagerly `require` the ESM-only noble deps — see loadCrypto.
  // loadCryptoForRun maps the CJS + Node < 20.19 ERR_REQUIRE_ESM failure to an
  // actionable RegisterConfigError instead of letting the raw import error escape.
  cfg.crypto = await loadCryptoForRun();

  // 1. Fast path: a registered state short-circuits with no network.
  const state = await loadOrCreateAgentState(store, cfg);
  if (state.registered_at !== undefined && state.registered_at !== null) {
    // This validates the persisted NHP peer, including its expiry — so a
    // registered agent whose persisted peer has expired is rejected here rather
    // than served. That is inherited verbatim from the Go contract
    // (qurl-go validateRegisteredAgentState): LayerV peers are normally durable
    // (expire_time 0), the peer is re-fetched on a fresh registration, and an
    // expired persisted peer means the routing state is stale, so the agent must
    // re-register. Kept Go-aligned deliberately (do not diverge the two SDKs).
    validateRegisteredAgentState(state, cfg.now(), cfg.invalidConfig);
    if (cfg.requireDeviceKey && (state.device_api_key ?? "").trim() === "") {
      // The device credential is issued once and cannot be recovered from this
      // state. Re-running against the SAME store short-circuits here again. The
      // only recovery is to clear or replace the persisted AgentState (or point
      // at a fresh store) and register again from scratch.
      throw new DeviceCredentialMissingError(
        `agent ${JSON.stringify(state.agent_id ?? "")} is registered but its device credential is absent from this state; clear or replace the persisted AgentState (or use a fresh store) and register again`,
      );
    }
    reconcileDeviceID(cfg, state);
    return state;
  }

  // 2. Persist the device identity (keypair + stable device id) BEFORE any
  //    network call so an interrupted registration resumes with the same
  //    identity the server will bind.
  ensureDeviceID(cfg, state);
  if ((state.schema_version ?? 0) < AGENT_STATE_SCHEMA_VERSION) {
    state.schema_version = AGENT_STATE_SCHEMA_VERSION;
  }
  await store.saveAgentState(state);

  // 3. Pre-flight: registration-info tells us the path (key_kind), the key id,
  //    the NHP peer, and the relay coordinates. Side-effect-free.
  const info = await fetchRegistrationInfo(cfg, apiKey);
  // Assert the pre-flight's own server_id agrees with its own peer key — an
  // integrity check independent of any nhpPeer override.
  assertServerIDMatches(cfg, info.relay.server_id, info.nhp_server_peer);
  const peer = resolvePeer(cfg, info);
  const relayUrl = resolveRelayURL(cfg, info);
  state.nhp_server_peer = peer;
  state.relay_url = relayUrl;
  state.key_id = info.key_id;
  await store.saveAgentState(state);

  switch (info.key_kind.trim()) {
    case KEY_KIND_BOOTSTRAP:
      // PATH A: the pre-issued key is the enrollment credential. REG directly.
      return registerAndComplete(cfg, apiKey, store, state, peer, relayUrl, apiKey, "bootstrap");
    case KEY_KIND_ACCOUNT: {
      if ((info.masked_email ?? "").trim() === "") {
        // Fail fast before an OTP round trip: an account key with no email on
        // file can never receive the code.
        throw new NoAccountEmailError(
          "the account key has no email on file for the one-time code; add an email or use a pre-issued key",
        );
      }
      return runAccountPath(cfg, apiKey, store, state, peer, relayUrl, info.masked_email ?? "");
    }
    default:
      throw cfg.invalidConfig(
        `registration-info returned unknown key_kind ${JSON.stringify(info.key_kind)}`,
      );
  }
}

/**
 * PATH B: email one-time code. Re-entrant across process runs, driven by
 * `otp_requested_at`. Mirrors Go `runAccountPath`.
 */
async function runAccountPath(
  cfg: RegisterConfig,
  apiKey: string,
  store: AgentStateStore,
  state: AgentState,
  peer: NHPServerPeerInfo,
  relayUrl: string,
  maskedEmail: string,
): Promise<AgentState> {
  // Ensure the code has been requested before any code can be valid. On a fresh
  // store this emails the code; on a resume it does nothing unless a code source
  // is absent and the cooldown has elapsed (below).
  const freshRequest = state.otp_requested_at === undefined || state.otp_requested_at === null;
  if (freshRequest) {
    await requestOTP(cfg, store, state, peer, relayUrl, apiKey);
  }

  // On a resume, probe completion BEFORE resolving any code: a prior run may have
  // gotten the RAK but crashed before completion, so the device is already
  // enrolled server-side and completion finishes the run without a code. Doing
  // this first means a no-code resume still self-heals, and a real-work
  // otpProvider is not invoked when the probe can finish. A fresh request has
  // nothing enrolled yet, so the probe is skipped to keep the first call lean.
  if (!freshRequest) {
    const probe = await tryCompletionProbe(cfg, apiKey, store, state, "account");
    if (probe.done) {
      return probe.state as AgentState;
    }
  }

  // A static otp literal supplied on the SAME call that just emailed a code
  // cannot match that fresh email — pause and let the caller re-run with the
  // newly emailed code. An otpProvider is exempt: it reads the just-sent code.
  if (freshRequest && cfg.otp !== "") {
    throw new OTPPendingError({
      requestedAt: parseTimeOr(state.otp_requested_at, cfg.now()),
      maskedEmail,
    });
  }

  const code = await resolveOTP(cfg);
  if (code === "") {
    // No code source: re-send once the cooldown elapses (so a long-idle re-run
    // refreshes an expired code), then pause for the caller to supply the code.
    if (
      cfg.now() - parseTimeOr(state.otp_requested_at, cfg.now()).getTime() >=
      OTP_RESEND_COOLDOWN_MS
    ) {
      await requestOTP(cfg, store, state, peer, relayUrl, apiKey);
    }
    throw new OTPPendingError({
      requestedAt: parseTimeOr(state.otp_requested_at, cfg.now()),
      maskedEmail,
    });
  }

  return registerAndComplete(cfg, apiKey, store, state, peer, relayUrl, code, "account");
}

/**
 * The shared REG → success-check → completion tail both enrollment paths end
 * with. `credential` is the key secret (bootstrap) or the one-time code
 * (account); `path` selects the RAK error mapping. Mirrors Go
 * `registerAndComplete`.
 */
async function registerAndComplete(
  cfg: RegisterConfig,
  apiKey: string,
  store: AgentStateStore,
  state: AgentState,
  peer: NHPServerPeerInfo,
  relayUrl: string,
  credential: string,
  path: PathKind,
): Promise<AgentState> {
  const ack = await registerExchange(cfg, state, peer, relayUrl, credential);
  if (!isRAKSuccess(ack.errCode)) {
    throw mapRAKError(ack, path);
  }
  return completeAndPersist(cfg, apiKey, store, state, path);
}

/**
 * Records `otp_requested_at` (otp_pending) and THEN dispatches the OTP email.
 * The order is deliberate and anti-spam: persisting before sending means a
 * persist failure emits no email (the caller retries as a still-fresh request),
 * while a send failure after a successful persist leaves the state otp_pending —
 * so the retry resumes under the resend cooldown instead of re-emailing
 * immediately. On a persist failure the in-memory mutation is rolled back.
 * Mirrors Go `requestOTP`.
 */
async function requestOTP(
  cfg: RegisterConfig,
  store: AgentStateStore,
  state: AgentState,
  peer: NHPServerPeerInfo,
  relayUrl: string,
  apiKey: string,
): Promise<void> {
  const prev = state.otp_requested_at;
  state.otp_requested_at = new Date(cfg.now()).toISOString();
  try {
    await store.saveAgentState(state);
  } catch (err) {
    state.otp_requested_at = prev; // roll back the in-memory mutation
    throw err;
  }
  await dispatchOTP(cfg, state, peer, relayUrl, apiKey);
}

/**
 * Attempts a completion fetch to self-heal a crash that happened after the REG
 * but before completion. `done` is true when the probe resolved the run (success
 * → registered state, or a terminal completion error); `done` is false when the
 * device is not yet enrolled OR the probe hit a transient fault — in both cases
 * the caller proceeds to REG. Mirrors Go `tryCompletionProbe`.
 */
async function tryCompletionProbe(
  cfg: RegisterConfig,
  apiKey: string,
  store: AgentStateStore,
  state: AgentState,
  path: PathKind,
): Promise<{ done: boolean; state?: AgentState }> {
  let comp: CompletionResponse;
  try {
    comp = await postCompletion(cfg, apiKey, state, path);
  } catch (err) {
    if (isCompletionNotYetRegistered(err) || isTransientCompletionError(err)) {
      // Not yet registered, or a transient blip on the optimization probe: fall
      // through to REG rather than aborting the whole registration.
      return { done: false };
    }
    // Any other completion error is terminal (most notably a structured
    // device_key_already_issued 409). Surface it rather than treating the probe
    // as a no-op and proceeding to REG.
    throw err;
  }
  const persisted = await persistCompletion(cfg, store, state, comp);
  return { done: true, state: persisted };
}

/**
 * Builds and sends the NHP_REG round trip, returning the decrypted NHP_RAK body.
 * `credential` is the enrollment credential (key secret on bootstrap, one-time
 * code on account). Mirrors Go `registerExchange`.
 */
async function registerExchange(
  cfg: RegisterConfig,
  state: AgentState,
  peer: NHPServerPeerInfo,
  relayUrl: string,
  credential: string,
): Promise<RegisterAckBody> {
  const { devicePriv, serverPub } = decodeNHPKeys(cfg, state, peer);
  const body = new TextEncoder().encode(
    JSON.stringify({
      usrId: state.key_id ?? "",
      devId: state.agent_id ?? "",
      aspId: AGENT_ASP_ID,
      otp: credential,
      usrData: {
        hostname: cfg.hostname || undefined,
        version: cfg.version || undefined,
        takeover: cfg.takeover || undefined,
      },
    }),
  );
  let reply;
  try {
    reply = await cfg.crypto.exchangeRegister(relayUrl, serverPub, body, {
      deviceStaticPriv: devicePriv,
      fetchFn: cfg.fetchFn,
      timeoutMs: cfg.timeoutMs,
      randomBytes: cfg.randomBytes,
      nowNanos: () => BigInt(cfg.now()) * 1_000_000n,
    });
  } catch (err) {
    throw normalizeRelayError(cfg, err);
  }
  if (reply.headerType === cfg.crypto.NHP_COK) {
    // The relay is under load and returned an overload cookie-challenge instead
    // of a registration reply — a "retry later" signal, distinct from a protocol
    // violation.
    throw new RegistrationRetryLaterError(
      "the registration relay returned an overload cookie-challenge; back off briefly and re-run",
    );
  }
  if (reply.headerType !== cfg.crypto.NHP_RAK) {
    throw cfg.invalidConfig(`unexpected NHP reply type ${reply.headerType} to a registration`);
  }
  return parseRegisterAck(reply.body);
}

/**
 * Dispatches the one-way NHP_OTP that asks LayerV to email a one-time code. A
 * relay 202 (empty) means dispatched; there is no NHP reply. The API key secret
 * rides in the NHP `pass` field, sealed inside the AES-256-GCM body before it
 * leaves the process. Mirrors Go `sendOTP`.
 */
async function dispatchOTP(
  cfg: RegisterConfig,
  state: AgentState,
  peer: NHPServerPeerInfo,
  relayUrl: string,
  apiKey: string,
): Promise<void> {
  const { devicePriv, serverPub } = decodeNHPKeys(cfg, state, peer);
  const body = new TextEncoder().encode(
    JSON.stringify({
      usrId: state.key_id ?? "",
      devId: state.agent_id ?? "",
      aspId: AGENT_ASP_ID,
      pass: apiKey,
    }),
  );
  try {
    await cfg.crypto.sendOTP(relayUrl, serverPub, body, {
      deviceStaticPriv: devicePriv,
      fetchFn: cfg.fetchFn,
      timeoutMs: cfg.timeoutMs,
      randomBytes: cfg.randomBytes,
      nowNanos: () => BigInt(cfg.now()) * 1_000_000n,
    });
  } catch (err) {
    throw normalizeRelayError(cfg, err);
  }
}

/** Runs the completion fetch and persists the resulting registered state. */
async function completeAndPersist(
  cfg: RegisterConfig,
  apiKey: string,
  store: AgentStateStore,
  state: AgentState,
  path: PathKind,
): Promise<AgentState> {
  const comp = await postCompletion(cfg, apiKey, state, path);
  return persistCompletion(cfg, store, state, comp);
}

/** Writes the completed registration into the store and returns the registered
 * state. Mirrors Go `persistCompletion`. */
async function persistCompletion(
  cfg: RegisterConfig,
  store: AgentStateStore,
  state: AgentState,
  comp: CompletionResponse,
): Promise<AgentState> {
  reconcileCompletionDeviceID(cfg, state, comp);
  state.agent_id = comp.agent_id;
  state.registered_at = comp.registered_at;
  state.nhp_server_peer = comp.nhp_server_peer;
  state.device_api_key = comp.device_api_key;
  state.otp_requested_at = undefined;
  state.schema_version = AGENT_STATE_SCHEMA_VERSION;
  await store.saveAgentState(state);
  return state;
}

// --- qurl-service HTTPS endpoints (Bearer <apiKey>) ---

/** GET /v1/agent/registration-info — the side-effect-free pre-flight. Mirrors
 * Go `fetchRegistrationInfo`. */
async function fetchRegistrationInfo(
  cfg: RegisterConfig,
  apiKey: string,
): Promise<RegistrationInfoResponse> {
  let data: RegistrationInfoResponse;
  try {
    data = await doAuthorizedJSON<RegistrationInfoResponse>(
      cfg,
      apiKey,
      "GET",
      "/v1/agent/registration-info",
    );
  } catch (err) {
    throw mapRegistrationHTTPError(err);
  }
  validateRegistrationInfo(cfg, data);
  return data;
}

/** POST /v1/agent/registration/complete — mints (or returns) the device REST
 * credential. Mirrors Go `postCompletion`. */
async function postCompletion(
  cfg: RegisterConfig,
  apiKey: string,
  state: AgentState,
  path: PathKind,
): Promise<CompletionResponse> {
  let data: CompletionResponse;
  try {
    data = await doAuthorizedJSON<CompletionResponse>(
      cfg,
      apiKey,
      "POST",
      "/v1/agent/registration/complete",
      {
        device_id: state.agent_id ?? "",
        device_pubkey_b64: state.public_key_b64,
      },
    );
  } catch (err) {
    throw mapCompletionHTTPError(err, path);
  }
  validateCompletionResponse(cfg, data);
  return data;
}

/**
 * Issues an authorized JSON request to the qurl-service registration endpoints
 * and unwraps the `{data}` envelope. A non-2xx response is parsed into a
 * {@link QURLError} carrying `.code`/`.status` (the same envelope the main client
 * uses), which the register/completion HTTP mappers then inspect. Mirrors Go
 * `doAuthorizedJSON` + the client's error parsing.
 */
async function doAuthorizedJSON<T>(
  cfg: RegisterConfig,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${cfg.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await cfg.fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: cfg.timeoutMs > 0 ? AbortSignal.timeout(cfg.timeoutMs) : undefined,
    });
  } catch (err) {
    // Transport fault (DNS, connection refused, per-request timeout) — a
    // transient outage, distinct from a permanent misconfig. Surface it under
    // the retryable RegistrationTransportError code so a caller branching on
    // `.code` re-runs (registerAgent is idempotent) rather than treating a blip
    // as a config error. This intentionally does NOT use the front-door config
    // class (which stays for input/response-shape faults).
    throw new RegistrationTransportError(`${method} ${path} failed: ${errText(err)}`, {
      cause: err,
    });
  }
  if (response.ok) {
    let json: { data?: T };
    try {
      json = (await response.json()) as { data?: T };
    } catch (err) {
      throw cfg.invalidConfig(
        `${method} ${path}: expected a JSON response body but received non-JSON content`,
        { cause: err },
      );
    }
    if (json.data === undefined) {
      throw cfg.invalidConfig(`${method} ${path}: response is missing the data envelope`);
    }
    return json.data;
  }
  throw await parseAPIError(response);
}

/** Parses a non-2xx registration response into a {@link QURLError} with the
 * server's `.code`/`.status`, mirroring the main client's `parseError`. The
 * register/completion mappers inspect these fields. */
async function parseAPIError(response: Response): Promise<QURLError> {
  let code = "";
  let detail = "";
  try {
    const json = (await response.json()) as {
      error?: { code?: string; detail?: string; message?: string; title?: string; status?: number };
    };
    if (json.error) {
      code = json.error.code ?? "";
      detail = json.error.detail ?? json.error.message ?? json.error.title ?? "";
    }
  } catch {
    // Non-JSON error body — fall through to a status-only error.
  }
  return new QURLError({
    status: response.status,
    code: code !== "" ? code : "unknown",
    title: response.statusText || `HTTP ${response.status}`,
    detail: detail !== "" ? detail : response.statusText || `HTTP ${response.status}`,
  });
}

/**
 * Maps a registration-info HTTP failure to a typed error where the code is known
 * (invalid key, disabled), else returns it unchanged (still a QURLError the
 * caller can inspect). Mirrors Go `mapRegistrationHTTPError`.
 */
function mapRegistrationHTTPError(err: unknown): unknown {
  if (!(err instanceof QURLError)) {
    return err;
  }
  switch (err.code.trim().toLowerCase()) {
    case "invalid_api_key":
    case "key_rejected":
    case "unauthorized":
      return new RegisterKeyRejectedError("the API key was rejected by the registration service", {
        cause: err,
      });
    case "registration_disabled":
      return new RegistrationDisabledError(err.detail, { cause: err });
  }
  if (err.status === 401 || err.status === 403) {
    return new RegisterKeyRejectedError("the API key was rejected by the registration service", {
      cause: err,
    });
  }
  return err;
}

/**
 * Maps a completion HTTP failure. A 409 device_key_already_issued means the
 * device was registered but its key was already issued and this local state
 * cannot reproduce it. The consumed-setup-key code is a bootstrap-path concept,
 * so it is gated on `path === "bootstrap"`. Mirrors Go `mapCompletionHTTPError`.
 */
function mapCompletionHTTPError(err: unknown, path: PathKind): unknown {
  if (!(err instanceof QURLError)) {
    return err;
  }
  const code = err.code.trim().toLowerCase();
  if (
    path === "bootstrap" &&
    (code === "setup_key_consumed" || code === "bootstrap_setup_key_consumed")
  ) {
    return new BootstrapSetupKeyConsumedError(
      "rerun LayerV setup for a fresh key or restore the completed agent state",
      { cause: err },
    );
  }
  if (code === "device_key_already_issued") {
    return new DeviceCredentialMissingError(
      "the device was registered but its API key was already issued and cannot be re-fetched; re-register under a new device id (deviceId option) or re-bind with the takeover option",
      { cause: err },
    );
  }
  return err;
}

/** Reports whether a completion error means the device is not yet enrolled (the
 * expected outcome of the crash-recovery probe before REG). Mirrors Go
 * `isCompletionNotYetRegistered`. */
function isCompletionNotYetRegistered(err: unknown): boolean {
  if (!(err instanceof QURLError)) {
    return false;
  }
  switch (err.code.trim().toLowerCase()) {
    case "device_not_registered":
    case "registration_incomplete":
    case "not_registered":
      return true;
  }
  return err.status === 404;
}

/** Reports whether a completion error is a retryable server-side fault (5xx). On
 * the probe this means "proceed to REG". Mirrors Go `isTransientCompletionError`. */
function isTransientCompletionError(err: unknown): boolean {
  return err instanceof QURLError && err.status >= 500 && err.status <= 599;
}

// --- device identity ---

/** Sets `agent_id` to the configured device id, or generates a stable one when
 * none is configured and none is persisted. Mirrors Go `ensureDeviceID`. */
function ensureDeviceID(cfg: RegisterConfig, state: AgentState): void {
  if (cfg.deviceId !== "") {
    if ((state.agent_id ?? "") !== "" && state.agent_id !== cfg.deviceId) {
      throw errDeviceIDMismatch(cfg, state.agent_id ?? "", cfg.deviceId);
    }
    state.agent_id = cfg.deviceId;
    return;
  }
  if ((state.agent_id ?? "") === "") {
    state.agent_id = generateDeviceID(cfg);
  }
}

/** Checks a configured device id against an already-registered state on the fast
 * path. Mirrors Go `reconcileDeviceID`. */
function reconcileDeviceID(cfg: RegisterConfig, state: AgentState): void {
  if (cfg.deviceId !== "" && (state.agent_id ?? "") !== "" && cfg.deviceId !== state.agent_id) {
    throw errDeviceIDMismatch(cfg, state.agent_id ?? "", cfg.deviceId);
  }
}

function errDeviceIDMismatch(
  cfg: RegisterConfig,
  saved: string,
  requested: string,
): RegistrationError {
  return cfg.invalidConfig(
    `saved device id ${JSON.stringify(saved)} does not match requested device id ${JSON.stringify(requested)}`,
  );
}

/** Guards against a completion response reporting a different agent id than the
 * one the SDK registered (the id is SDK-owned and frozen). Mirrors Go
 * `reconcileCompletionDeviceID`. */
function reconcileCompletionDeviceID(
  cfg: RegisterConfig,
  state: AgentState,
  comp: CompletionResponse,
): void {
  if ((state.agent_id ?? "") !== "" && comp.agent_id !== "" && state.agent_id !== comp.agent_id) {
    throw cfg.invalidConfig(
      `completion response agent id ${JSON.stringify(comp.agent_id)} does not match registered device id ${JSON.stringify(state.agent_id ?? "")}`,
    );
  }
}

/** Mints a stable random device id. agent_id == NHP devId, so it must be a plain
 * identifier; a hex token is safe on every wire it crosses. Mirrors Go
 * `generateDeviceID`. */
function generateDeviceID(cfg: RegisterConfig): string {
  return `agent-${toHex(cfg.randomBytes(16))}`;
}

/** Returns the one-time code to use: the otp value, or the result of an
 * otpProvider call, or "" when neither is set. Mirrors Go `resolveOTP`. */
async function resolveOTP(cfg: RegisterConfig): Promise<string> {
  if (cfg.otp !== "") {
    return cfg.otp;
  }
  if (cfg.otpProvider !== undefined) {
    let code: string;
    try {
      code = (await cfg.otpProvider()).trim();
    } catch (err) {
      throw new RegisterConfigError(`one-time code provider failed: ${errText(err)}`, {
        cause: err,
      });
    }
    if (code === "") {
      throw new RegisterConfigError(
        "one-time code provider returned an empty code — on a fresh store the provider is called right after the code is dispatched, so it must await email delivery",
      );
    }
    return code;
  }
  return "";
}

// --- peer / relay / server-id resolution ---

function resolvePeer(cfg: RegisterConfig, info: RegistrationInfoResponse): NHPServerPeerInfo {
  return cfg.nhpPeerOverride !== undefined
    ? { ...cfg.nhpPeerOverride }
    : { ...info.nhp_server_peer };
}

function resolveRelayURL(cfg: RegisterConfig, info: RegistrationInfoResponse): string {
  if (cfg.relayUrlOverride !== "") {
    return cfg.relayUrlOverride;
  }
  return stripTrailingSlashes(info.relay.base_url);
}

/**
 * Checks the relay server_id returned by registration-info equals the
 * fingerprint independently computed from the NHP peer public key. They MUST
 * agree (both are base64url(sha256(pubkey)[:8])); a mismatch means the
 * pre-flight's routing id and peer key disagree, so fail closed. Mirrors Go
 * `assertServerIDMatches`.
 */
function assertServerIDMatches(
  cfg: RegisterConfig,
  serverID: string,
  peer: NHPServerPeerInfo,
): void {
  let peerKey: Uint8Array;
  try {
    peerKey = decodeBase64Std(peer.public_key_b64);
  } catch (err) {
    throw cfg.invalidConfig(`NHP peer public key is not standard base64: ${errText(err)}`);
  }
  const computed = cfg.crypto.pubKeyFingerprint(peerKey);
  if (serverID !== computed) {
    throw cfg.invalidConfig(
      `registration-info relay server_id ${JSON.stringify(serverID)} does not match the NHP peer key fingerprint ${JSON.stringify(computed)}`,
    );
  }
}

/** Returns the agent device private key and the server static public key as raw
 * bytes for a relay call. Mirrors Go `decodeNHPKeys`. */
function decodeNHPKeys(
  cfg: RegisterConfig,
  state: AgentState,
  peer: NHPServerPeerInfo,
): { devicePriv: Uint8Array; serverPub: Uint8Array } {
  let devicePriv: Uint8Array;
  try {
    devicePriv = decodeBase64Std(state.private_key_b64);
  } catch (err) {
    throw cfg.invalidConfig(`decode device private key: ${errText(err)}`);
  }
  let serverPub: Uint8Array;
  try {
    serverPub = decodeBase64Std(peer.public_key_b64);
  } catch (err) {
    throw cfg.invalidConfig(`decode NHP peer public key: ${errText(err)}`);
  }
  return { devicePriv, serverPub };
}

/** Adapts a relay/transport error to the registration error taxonomy. A
 * `RelayError` (from the vendored crypto) is already actionable; other errors are
 * wrapped in the front-door config class. Mirrors Go `normalizeRelayError`. */
function normalizeRelayError(cfg: RegisterConfig, err: unknown): unknown {
  if (err instanceof cfg.crypto.RelayError) {
    return err;
  }
  if (err instanceof RegistrationError) {
    return err;
  }
  return cfg.invalidConfig(`NHP relay exchange failed: ${errText(err)}`, { cause: err });
}

// --- state load / validation ---

/** Loads the persisted state (creating a fresh keypair when none exists),
 * validating a loaded keypair. Mirrors Go `loadOrCreateAgentState`. */
async function loadOrCreateAgentState(
  store: AgentStateStore,
  cfg: RegisterConfig,
): Promise<AgentState> {
  let loaded: AgentState | null;
  try {
    loaded = await store.loadAgentState();
  } catch (err) {
    // A present-but-corrupt state. Re-wrap in the front-door config class while
    // keeping the store-neutral invalid-state cause matchable through the chain.
    throw cfg.invalidConfig(`load agent state: ${errText(err)}`, {
      cause: err instanceof Error ? err : new InvalidAgentStateError(errText(err)),
    });
  }
  if (loaded === null) {
    return newAgentState(cfg);
  }
  ensureKeypair(cfg, loaded);
  return loaded;
}

/** Generates a fresh X25519 keypair-backed AgentState. Mirrors Go `newAgentState`. */
function newAgentState(cfg: RegisterConfig): AgentState {
  const priv = cfg.randomBytes(32);
  const pub = cfg.crypto.x25519PublicKey(priv);
  return {
    private_key_b64: encodeBase64Std(priv),
    public_key_b64: encodeBase64Std(pub),
  };
}

/** Validates the loaded keypair, deriving the public key when absent. Mirrors Go
 * `ensureKeypair`. */
function ensureKeypair(cfg: RegisterConfig, state: AgentState): void {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Std(state.private_key_b64);
  } catch (err) {
    throw cfg.invalidConfig(`decode agent private key: ${errText(err)}`);
  }
  if (raw.length !== 32) {
    throw cfg.invalidConfig("agent private key must be X25519 (32 bytes)");
  }
  let pub: Uint8Array;
  try {
    pub = cfg.crypto.x25519PublicKey(raw);
  } catch (err) {
    throw cfg.invalidConfig(`agent private key must be X25519: ${errText(err)}`);
  }
  const publicKey = encodeBase64Std(pub);
  if ((state.public_key_b64 ?? "") === "") {
    state.public_key_b64 = publicKey;
  }
  if (state.public_key_b64 !== publicKey) {
    throw cfg.invalidConfig("agent public key does not match private key");
  }
}

/** Checks a loaded, already-registered state. Mirrors Go
 * `validateRegisteredAgentState`. */
function validateRegisteredAgentState(
  state: AgentState,
  nowMs: number,
  invalidConfig: (detail: string) => RegistrationError,
): void {
  if ((state.agent_id ?? "").trim() === "") {
    throw invalidConfig("registered agent state missing agent id");
  }
  if (state.registered_at === undefined || state.registered_at === null) {
    throw invalidConfig("registered agent state missing registration time");
  }
  if (state.nhp_server_peer === undefined || state.nhp_server_peer === null) {
    throw invalidConfig("registered agent state missing NHP peer");
  }
  validateNHPServerPeerInfo(state.nhp_server_peer, nowMs, "registered agent state", invalidConfig);
}

/** Checks an NHP peer record. Mirrors Go `validateNHPServerPeerInfo`. */
function validateNHPServerPeerInfo(
  peer: NHPServerPeerInfo,
  nowMs: number,
  label: string,
  invalidConfig: (detail: string) => RegistrationError,
): void {
  if ((peer.public_key_b64 ?? "").trim() === "") {
    throw invalidConfig(`${label} missing NHP peer public key`);
  }
  let key: Uint8Array;
  try {
    key = decodeBase64Std(peer.public_key_b64);
  } catch (err) {
    throw invalidConfig(`${label} NHP peer public key is not standard base64: ${errText(err)}`);
  }
  if (key.length !== 32) {
    throw invalidConfig(`${label} NHP peer public key is not X25519 (32 bytes)`);
  }
  if ((peer.host ?? "").trim() === "") {
    throw invalidConfig(`${label} missing NHP peer host`);
  }
  if (!(peer.port > 0)) {
    throw invalidConfig(`${label} missing NHP peer port`);
  }
  if (peer.port > 65535) {
    throw invalidConfig(`${label} NHP peer port out of range`);
  }
  if (peer.expire_time !== 0 && peer.expire_time <= Math.floor(nowMs / 1000)) {
    throw invalidConfig(`${label} NHP peer is expired`);
  }
}

/** Validates the registration-info pre-flight response. Mirrors
 * registrationInfoResponse.validate. */
function validateRegistrationInfo(cfg: RegisterConfig, r: RegistrationInfoResponse): void {
  switch ((r.key_kind ?? "").trim()) {
    case KEY_KIND_BOOTSTRAP:
    case KEY_KIND_ACCOUNT:
      break;
    default:
      throw cfg.invalidConfig(
        `registration-info returned unknown key_kind ${JSON.stringify(r.key_kind)}`,
      );
  }
  if ((r.key_id ?? "").trim() === "") {
    throw cfg.invalidConfig("registration-info missing key_id");
  }
  if (r.relay === undefined || (r.relay.base_url ?? "").trim() === "") {
    throw cfg.invalidConfig("registration-info missing relay base_url");
  }
  validatedHttpsOrLoopback(r.relay.base_url, "relay base_url", cfg.invalidConfig);
  if ((r.relay.server_id ?? "").trim() === "") {
    throw cfg.invalidConfig("registration-info missing relay server_id");
  }
  if (r.nhp_server_peer === undefined) {
    throw cfg.invalidConfig("registration-info missing nhp_server_peer");
  }
  validateNHPServerPeerInfo(r.nhp_server_peer, cfg.now(), "registration-info", cfg.invalidConfig);
}

/** Validates the completion response. Mirrors completionResponse.validate. */
function validateCompletionResponse(cfg: RegisterConfig, r: CompletionResponse): void {
  if ((r.agent_id ?? "").trim() === "") {
    throw cfg.invalidConfig("completion response missing agent_id");
  }
  if (
    r.registered_at === undefined ||
    r.registered_at === null ||
    `${r.registered_at}`.trim() === ""
  ) {
    throw cfg.invalidConfig("completion response missing registered_at");
  }
  if ((r.device_api_key ?? "").trim() === "") {
    throw cfg.invalidConfig("completion response missing device_api_key");
  }
  if (r.nhp_server_peer === undefined) {
    throw cfg.invalidConfig("completion response missing nhp_server_peer");
  }
  validateNHPServerPeerInfo(r.nhp_server_peer, cfg.now(), "completion response", cfg.invalidConfig);
}

// --- RAK reply body + error mapping ---

interface RegisterAckBody {
  errCode: string;
  errMsg: string;
  aspId?: string;
}

function isRAKSuccess(errCode: string): boolean {
  return errCode === "" || errCode === RAK_SUCCESS;
}

/**
 * Decodes the decrypted NHP_RAK body. An empty body decodes to a zero-value ack
 * whose empty errCode reads as success, so the run proceeds to completion. That
 * is safe because the RAK was already authenticated by the Noise handshake and
 * the completion endpoint re-verifies enrollment. A non-empty body that is not
 * valid JSON is a hard error. Mirrors Go `parseRegisterAck`.
 */
function parseRegisterAck(body: Uint8Array): RegisterAckBody {
  if (body.length === 0) {
    return { errCode: "", errMsg: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (err) {
    throw new RegisterConfigError(`parse registration reply body: ${errText(err)}`, { cause: err });
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return {
    errCode: typeof obj.errCode === "string" ? obj.errCode : "",
    errMsg: typeof obj.errMsg === "string" ? obj.errMsg : "",
    aspId: typeof obj.aspId === "string" ? obj.aspId : undefined,
  };
}

/**
 * Turns a non-success NHP_RAK body into a typed error. Known codes become the
 * actionable typed errors; 52100 is resolved by path; anything else becomes a
 * {@link RegistrationDenyError} carrying the raw code. Mirrors Go `mapRAKError`.
 */
function mapRAKError(ack: RegisterAckBody, path: PathKind): RegistrationError {
  const code = ack.errCode.trim();
  const msg = ack.errMsg.trim();
  const suffix = msg !== "" ? ` (service said: ${msg})` : "";
  switch (code) {
    case RAK_CREDENTIAL_INVALID:
      if (path === "bootstrap") {
        return new RegisterKeyRejectedError(
          `pre-issued key was rejected by the enrollment service${suffix}`,
        );
      }
      return new OTPIncorrectError(
        `the one-time code was rejected; re-run registerAgent with the correct otp code${suffix}`,
      );
    case RAK_CREDENTIAL_EXPIRED:
      return new OTPExpiredError(
        `request a fresh code by re-running registerAgent with no otp, then supply the new code${suffix}`,
      );
    case RAK_ATTEMPTS_EXCEEDED:
      return new RegistrationRateLimitedError(
        `too many attempts; wait before retrying registration${suffix}`,
      );
    case RAK_RATE_LIMITED:
      return new RegistrationRateLimitedError(`back off and retry registration later${suffix}`);
    case RAK_IDENTITY_CONFLICT:
      return new AgentIdentityConflictError(
        `this device id is already enrolled; re-run with the takeover option to re-bind it, or pick a different deviceId${suffix}`,
      );
    case RAK_EMAIL_UNAVAILABLE:
      return new NoAccountEmailError(
        `add an email to the account or register with a pre-issued key${suffix}`,
      );
    case RAK_INVALID_API_KEY:
      return new RegisterKeyRejectedError(`check the API key and re-run registration${suffix}`);
    case RAK_REGISTRATION_OFF:
      return new RegistrationDisabledError(
        `agent registration is disabled for this account${suffix}`,
      );
    case RAK_BOOTSTRAP_CONSUMED:
      return new BootstrapSetupKeyConsumedError(
        `rerun LayerV setup for a fresh key or restore the completed agent state${suffix}`,
      );
    case RAK_INVALID_INPUT:
      return new RegistrationInvalidInputError(
        `the device id or registration input was malformed; use a valid identifier for deviceId${suffix}`,
      );
    default:
      return new RegistrationDenyError(ack.errCode, ack.errMsg);
  }
}

// --- store-backed client ---

/**
 * Builds a client authorized with the device API key persisted in state. Unlike
 * the Go SDK (whose Client reads the device key from the store on demand behind a
 * short cache), the TS QURLClient takes a fixed bearer at construction, so the
 * device API key minted at completion is baked in here. Callers who rotate the
 * device credential re-run registerAgent to obtain a fresh client.
 */
function newStoreBackedClient(state: AgentState, cfg: RegisterConfig): QURLClient {
  const options: ClientOptions = {
    apiKey: (state.device_api_key ?? "").trim(),
    baseUrl: cfg.baseUrl,
  };
  if (cfg.fetchFn !== globalThis.fetch) {
    options.fetch = cfg.fetchFn;
  }
  return new QURLClient(options);
}

// --- small helpers ---

/** Validates an https:// (or http://localhost loopback) URL, mirroring the Go
 * `validateHTTPSOrLoopbackURL`. Returns the URL with any trailing slashes
 * stripped (it does not trim surrounding whitespace). */
function validatedHttpsOrLoopback(
  rawUrl: string,
  label: string,
  invalidConfig: (detail: string) => RegistrationError = (d) => new RegisterConfigError(d),
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw invalidConfig(`${label} must be a valid URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidConfig(`${label} must not contain userinfo`);
  }
  if (parsed.protocol === "https:") {
    return stripTrailingSlashes(rawUrl);
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (isLoopback) {
      return stripTrailingSlashes(rawUrl);
    }
  }
  throw invalidConfig(`${label} must use https:// scheme`);
}

function parseTimeOr(iso: string | undefined | null, fallbackMs: number): Date {
  if (iso === undefined || iso === null || iso === "") {
    return new Date(fallbackMs);
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? new Date(fallbackMs) : new Date(t);
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  throw new RegisterConfigError(
    "globalThis.crypto.getRandomValues is required to generate agent registration keys",
  );
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += b.toString(16).padStart(2, "0");
  }
  return s;
}

function encodeBase64Std(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function decodeBase64Std(b64: string): Uint8Array {
  // An empty string decodes to zero bytes, but every field this decodes (a device
  // key, a peer public key) is a fixed-width credential — an empty value is
  // malformed input, so reject it explicitly rather than returning an empty array
  // a downstream length check would trip on with a vaguer error.
  if (b64 === "") {
    throw new Error("empty base64 (a key/packet field must not be empty)");
  }
  // Reject non-standard-base64 input the way Go's base64.StdEncoding.Strict does.
  // First validate the alphabet + padding length (atob is lenient about both):
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("not standard base64");
  }
  const bin = atob(b64);
  // atob also silently drops the "overflow" bits a short final quantum can't
  // represent (the bits before the "=" padding), which Strict rejects. Re-encoding
  // the decoded bytes must reproduce the input exactly; if it doesn't, those bits
  // were non-zero — a non-canonical encoding.
  if (btoa(bin) !== b64) {
    throw new Error("not standard base64 (non-canonical padding bits)");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

// --- HTTPS response envelope shapes ---

/** GET /v1/agent/registration-info data payload. Mirrors Go
 * `registrationInfoResponse`. */
interface RegistrationInfoResponse {
  key_kind: string; // "bootstrap" | "account"
  key_id: string;
  nhp_server_peer: NHPServerPeerInfo;
  relay: { base_url: string; server_id: string };
  masked_email?: string;
}

/** POST /v1/agent/registration/complete data payload. Mirrors Go
 * `completionResponse`. */
interface CompletionResponse {
  agent_id: string;
  registered_at: string;
  nhp_server_peer: NHPServerPeerInfo;
  device_api_key: string;
}
