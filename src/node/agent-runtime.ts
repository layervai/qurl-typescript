import { loadDeploymentHub } from "./deployment.js";
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { QURLClient } from "../client.js";
import { parseCrid } from "../crid.js";
import { parseStrictJson, isStrictJsonObject, type StrictJsonValue } from "./strict-json.js";
import {
  AgentStateError,
  canonicalKey,
  canonicalTime,
  decodeAgentState,
  encodeAgentJSON,
  encodeAgentState,
  exactObject,
  RECOVERY_HORIZON_MS,
  validateAgentID,
  validateAssignment,
  validateEndpoint,
  type AgentAssignment,
  type AgentState,
  type AgentStateStore,
  type NHPUDPEndpoint,
} from "./agent-state.js";
import {
  nativeAgentTransport,
  AgentTransportError,
  type AgentTransport,
} from "./agent-transport.js";

export interface AgentOTPChallenge {
  agentID: string;
  cellID: string;
  assignmentTicketExpiresAt: string;
  pendingActivationRecovery: boolean;
}
export interface AgentRuntimeOptions {
  hub?: NHPUDPEndpoint;
  agentID?: string;
  enrollmentCredential?: string;
  enrollmentCredentialProvider?: (
    request: { agentID: string; pendingActivationRecovery: boolean },
    signal: AbortSignal,
  ) => Promise<string>;
  otpProvider?: (challenge: AgentOTPChallenge, signal: AbortSignal) => Promise<string>;
  headless?: boolean;
  offline?: boolean;
  hostname?: string;
  version?: string;
  signal?: AbortSignal;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
export class AgentLifecycleError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(`qURL agent lifecycle: ${code}`, options);
    this.name = "AgentLifecycleError";
  }
}
function validAgentAddress(value: string): boolean {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  return (
    !!match && !!isIP(match[1] ?? match[2]) && Number(match[3]) > 0 && Number(match[3]) <= 65535
  );
}
const UINT64_MAX = (1n << 64n) - 1n;
const KEY_ID = /^key_[A-Za-z0-9]{12}$/;
function copy(state: AgentState): AgentState {
  const raw = encodeAgentState(state);
  try {
    return decodeAgentState(raw);
  } finally {
    raw.fill(0);
  }
}
function fingerprint(
  kind: "activation-enrollment" | "credential-recovery",
  credential: string,
): string {
  return createHash("sha256")
    .update(`qurl-go/pending-${kind}-credential-v1\0`)
    .update(credential)
    .digest("base64url");
}
function credential(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(value))
    throw new AgentLifecycleError("INVALID_ENROLLMENT_CREDENTIAL");
}
function live(expires: string | undefined) {
  if (!expires || canonicalTime(expires) <= Date.now())
    throw new AgentLifecycleError("RECOVERY_EXPIRED");
}
function ready(state: AgentState) {
  if (state.pending_credential_recovery || state.pending_credential_recovery_issue)
    throw new AgentLifecycleError("CREDENTIAL_RECOVERY_REQUIRED");
  if (state.credential_recovery_refresh_required)
    throw new AgentLifecycleError("RECOVERED_ASSIGNMENT_REFRESH_REQUIRED");
  if (
    !state.registered_at ||
    !state.device_api_key ||
    !state.device_api_key_id ||
    !state.assignment
  )
    throw new AgentLifecycleError("NOT_REGISTERED");
}
function checkIdentity(state: AgentState, expected?: string) {
  if (expected !== undefined && state.agent_id !== expected)
    throw new AgentLifecycleError("IDENTITY_CHANGED");
}

/** One driver per producer operation. Persistence failures never enter the network retry loop. */
class Lifecycle {
  constructor(
    readonly store: AgentStateStore,
    readonly options: AgentRuntimeOptions,
    readonly transport: AgentTransport,
    readonly replacement?: { anchor: string; deadline: string },
  ) {}

  hub(): NHPUDPEndpoint {
    const hub = this.options.hub ?? loadDeploymentHub();
    return validateEndpoint(parseStrictJson(encodeAgentJSON(hub), 4096));
  }

  async exchange(
    state: AgentState,
    endpoint: NHPUDPEndpoint,
    type: 1 | 5 | 12 | 13 | 16,
    value: unknown,
    phase:
      | "assignment"
      | "assignment-refresh"
      | "registration"
      | "completion"
      | "recovery-issue"
      | "recovery-completion"
      | "session",
    expires?: string,
    reknock?: unknown,
    detachedSignal?: AbortSignal,
  ): Promise<Record<string, StrictJsonValue>> {
    const body = encodeAgentJSON(value);
    const reknockBody = reknock === undefined ? undefined : encodeAgentJSON(reknock);
    const privateKey = canonicalKey(state.private_key_b64);
    const remaining = Math.min(
      30_000,
      expires ? canonicalTime(expires) - Date.now() : Infinity,
      this.replacement ? canonicalTime(this.replacement.deadline) - Date.now() : Infinity,
    );
    const controller = AbortSignal.timeout(Math.max(0, remaining));
    const caller = detachedSignal ?? this.options.signal;
    const signal = caller ? AbortSignal.any([controller, caller]) : controller;
    const beforeSend = () => {
      signal.throwIfAborted();
      this.store.checkContinuity?.();
      if (expires) live(expires);
      if (this.replacement) live(this.replacement.deadline);
    };
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        beforeSend();
        try {
          const reply = await this.transport({
            endpoint,
            privateKey,
            type,
            body,
            reknockBody,
            assignment:
              phase === "assignment" ||
              phase === "assignment-refresh" ||
              phase === "recovery-issue",
            signal,
            beforeSend,
          });
          if (type === 12) return {};
          if (!reply) throw new AgentLifecycleError("INVALID_REPLY");
          let parsed: Record<string, StrictJsonValue>;
          try {
            const value = parseStrictJson(reply.body, 4096);
            if (!isStrictJsonObject(value)) throw new AgentLifecycleError("INVALID_REPLY");
            parsed = value;
          } finally {
            reply.body.fill(0);
          }
          if (phase === "session") return parsed;
          const envelope = exactObject(
            parsed,
            phase === "registration"
              ? "errCode errMsg aspId"
              : "errCode errMsg retryAfterSeconds list",
          );
          if (typeof envelope.errCode !== "string" || !/^(?:0|[1-9]\d{4})$/.test(envelope.errCode))
            throw new AgentLifecycleError("INVALID_REPLY");
          if (envelope.errMsg !== undefined && typeof envelope.errMsg !== "string")
            throw new AgentLifecycleError("INVALID_REPLY");
          if (phase === "registration" && envelope.aspId !== "agent")
            throw new AgentLifecycleError("INVALID_REPLY");
          if (envelope.errCode === "0") {
            if (
              envelope.retryAfterSeconds !== undefined ||
              (phase !== "registration" && envelope.errMsg !== undefined)
            )
              throw new AgentLifecycleError("INVALID_REPLY");
            return envelope;
          }
          const allowed =
            phase === "assignment" || phase === "assignment-refresh"
              ? [
                  "52200",
                  "52201",
                  "52202",
                  "52203",
                  "52204",
                  "52205",
                  ...(phase === "assignment" ? ["52106", "52107", "52108", "52109"] : []),
                ]
              : phase === "registration"
                ? [
                    "52100",
                    "52101",
                    "52102",
                    "52103",
                    "52104",
                    "52105",
                    "52106",
                    "52107",
                    "52108",
                    "52109",
                    "52110",
                    "52111",
                    "52112",
                  ]
                : phase === "completion"
                  ? ["52300", "52301", "52302", "52303", "52304"]
                  : phase === "recovery-issue"
                    ? ["52400", "52401", "52402", "52403", "52404", "52405", "52406"]
                    : ["52410", "52411", "52412", "52413", "52414"];
          if (!allowed.includes(envelope.errCode) || envelope.list !== undefined)
            throw new AgentLifecycleError("INVALID_REPLY");
          const retry = envelope.retryAfterSeconds;
          const retryCodes = ["52200", "52204", "52300", "52400", "52404", "52410"];
          if (
            (retry !== undefined &&
              (!retryCodes.includes(envelope.errCode) ||
                typeof retry !== "bigint" ||
                retry <= 0n ||
                retry > 9223372036n)) ||
            (["52204", "52404"].includes(envelope.errCode) && retry === undefined)
          )
            throw new AgentLifecycleError("INVALID_REPLY");
          throw new AgentLifecycleError(
            envelope.errCode,
            retry === undefined ? undefined : Number(retry) * 1000,
          );
        } catch (error) {
          const retryable =
            error instanceof AgentTransportError ||
            (error instanceof AgentLifecycleError &&
              ["52200", "52202", "52204", "52300", "52400", "52404", "52410"].includes(
                error.code,
              ) &&
              (!error.code.startsWith("524") || !!error.retryAfterMs));
          if (!retryable || attempt === 3 || phase === "session" || type === 12) throw error;
          beforeSend();
          await delay(
            error instanceof AgentLifecycleError && error.retryAfterMs
              ? error.retryAfterMs
              : Math.min(8000, 500 * 2 ** attempt),
            undefined,
            { signal },
          );
        }
      }
      throw new AgentLifecycleError("RETRY_EXHAUSTED");
    } finally {
      privateKey.fill(0);
      body.fill(0);
      reknockBody?.fill(0);
    }
  }

  async assignment(state: AgentState, mode: "enroll" | "refresh", enrollment?: string) {
    const envelope = await this.exchange(
      state,
      this.hub(),
      5,
      {
        usrId: "",
        devId: state.agent_id,
        aspId: "agent",
        usrData: {
          query: "cell_assignment",
          version: 1,
          mode,
          request_nonce: randomBytes(32).toString("base64url"),
          ...(enrollment ? { credential: enrollment } : {}),
        },
      },
      mode === "enroll" ? "assignment" : "assignment-refresh",
    );
    const list = exactObject(
      envelope.list,
      `query version mode agent_id assignment${mode === "enroll" ? " registration assignment_ticket assignment_ticket_expires_at" : ""}`,
    );
    if (
      list.query !== "cell_assignment" ||
      list.version !== 1n ||
      list.mode !== mode ||
      list.agent_id !== state.agent_id
    )
      throw new AgentLifecycleError("INVALID_ASSIGNMENT_REPLY");
    const assignment = validateAssignment(list.assignment);
    if (canonicalTime(assignment.lease_expires_at) <= Date.now())
      throw new AgentLifecycleError("ASSIGNMENT_EXPIRED");
    return { list, assignment };
  }

  async refresh(state: AgentState, allowRecovered = false): Promise<AgentState> {
    if (
      state.pending_credential_recovery ||
      state.pending_credential_recovery_issue ||
      state.pending_activation ||
      state.pending_completion ||
      !state.registered_at
    )
      throw new AgentLifecycleError("INCOMPLETE_STATE");
    if (!allowRecovered && state.credential_recovery_refresh_required)
      throw new AgentLifecycleError("RECOVERED_ASSIGNMENT_REFRESH_REQUIRED");
    const { assignment } = await this.assignment(state, "refresh");
    const old = state.assignment;
    if (
      !old ||
      assignment.assignment_generation < old.assignment_generation ||
      (assignment.assignment_generation === old.assignment_generation &&
        (assignment.cell_id !== old.cell_id ||
          assignment.endpoint_revision < old.endpoint_revision)) ||
      (assignment.assignment_generation === old.assignment_generation &&
        assignment.endpoint_revision === old.endpoint_revision &&
        (assignment.nhp_udp_endpoint.host !== old.nhp_udp_endpoint.host ||
          assignment.nhp_udp_endpoint.server_public_key_b64 !==
            old.nhp_udp_endpoint.server_public_key_b64))
    )
      throw new AgentLifecycleError("ASSIGNMENT_DOWNGRADE");
    const next = copy(state);
    next.schema_version = 8;
    next.assignment = assignment;
    delete next.credential_recovery_refresh_required;
    await this.store.save(next, this.options.signal);
    return next;
  }

  async complete(state: AgentState): Promise<AgentState> {
    const pending = state.pending_completion!;
    live(pending.recovery_expires_at);
    const envelope = await this.exchange(
      state,
      state.assignment!.nhp_udp_endpoint,
      5,
      {
        usrId: "",
        devId: state.agent_id,
        aspId: "agent",
        usrData: {
          query: "agent_registration_completion",
          version: 1,
          device_api_key: pending.device_api_key,
        },
      },
      "completion",
      pending.recovery_expires_at,
    );
    const list = exactObject(envelope.list, "query version device_api_key_id");
    if (
      list.query !== "agent_registration_completion" ||
      list.version !== 1n ||
      typeof list.device_api_key_id !== "string" ||
      !KEY_ID.test(list.device_api_key_id)
    )
      throw new AgentLifecycleError("INVALID_COMPLETION_REPLY");
    const next = copy(state);
    next.device_api_key = pending.device_api_key;
    next.device_api_key_id = list.device_api_key_id;
    next.registered_at = new Date().toISOString();
    delete next.pending_completion;
    await this.store.save(next, AbortSignal.timeout(10_000));
    return next;
  }

  async enroll(state: AgentState): Promise<AgentState> {
    if (state.schema_version !== 8) {
      state = copy(state);
      state.schema_version = 8;
      // Persist any legacy activation horizon before replaying authority-bound work.
      await this.store.save(state, this.options.signal);
    }
    if (state.pending_completion) return this.complete(state);
    let enrollment = this.options.enrollmentCredential;
    if (this.options.enrollmentCredentialProvider) {
      enrollment = await this.options.enrollmentCredentialProvider(
        { agentID: state.agent_id!, pendingActivationRecovery: !!state.pending_activation },
        this.options.signal ?? AbortSignal.timeout(30_000),
      );
    }
    credential(enrollment);
    let code = enrollment;
    let pending = state.pending_activation;
    if (!pending) {
      const { assignment, list } = await this.assignment(state, "enroll", enrollment);
      const registration = exactObject(list.registration, "key_id key_kind");
      const kind = registration.key_kind;
      if (
        typeof registration.key_id !== "string" ||
        !KEY_ID.test(registration.key_id) ||
        !(this.options.headless ? ["bootstrap", "connector_bootstrap"] : ["account"]).includes(
          kind as string,
        )
      )
        throw new AgentLifecycleError("ENROLLMENT_KIND_REFUSED");
      if (
        typeof list.assignment_ticket !== "string" ||
        !/^[\x21-\x7e]{1,2304}$/.test(list.assignment_ticket) ||
        typeof list.assignment_ticket_expires_at !== "string"
      )
        throw new AgentLifecycleError("INVALID_ASSIGNMENT_TICKET");
      const ticketExpiry = canonicalTime(list.assignment_ticket_expires_at);
      if (ticketExpiry <= Date.now() || ticketExpiry >= canonicalTime(assignment.lease_expires_at))
        throw new AgentLifecycleError("INVALID_ASSIGNMENT_TICKET");
      if (kind === "account") {
        if (!this.options.otpProvider || ticketExpiry - Date.now() < 630_000)
          throw new AgentLifecycleError("OTP_NOT_AVAILABLE");
        await this.exchange(
          state,
          assignment.nhp_udp_endpoint,
          12,
          {
            usrId: registration.key_id,
            devId: state.agent_id,
            aspId: "agent",
            pass: enrollment,
            usrData: {
              query: "agent_registration_otp",
              version: 1,
              assignment_ticket: list.assignment_ticket,
            },
          },
          "registration",
        );
        code = await this.options.otpProvider(
          {
            agentID: state.agent_id!,
            cellID: assignment.cell_id,
            assignmentTicketExpiresAt: list.assignment_ticket_expires_at,
            pendingActivationRecovery: false,
          },
          this.options.signal ?? AbortSignal.timeout(30_000),
        );
        if (!/^\d{8}$/.test(code)) throw new AgentLifecycleError("INVALID_OTP");
      }
      pending = {
        agent_id: state.agent_id!,
        agent_public_key_b64: state.public_key_b64,
        assignment,
        registration: { key_id: registration.key_id, key_kind: kind as string },
        assignment_ticket: list.assignment_ticket,
        assignment_ticket_expires_at: list.assignment_ticket_expires_at,
        recovery_anchor_ticket_expires_at:
          this.replacement?.anchor ?? list.assignment_ticket_expires_at,
        recovery_expires_at:
          this.replacement?.deadline ??
          new Date(ticketExpiry + RECOVERY_HORIZON_MS).toISOString().replace(".000Z", "Z"),
        hostname: this.options.hostname,
        agent_version: this.options.version,
        enrollment_credential_fingerprint_b64: fingerprint("activation-enrollment", enrollment),
      };
      const next = copy(state);
      next.assignment = assignment;
      next.pending_activation = pending;
      await this.store.save(next, this.options.signal);
      state = next;
    } else {
      live(pending.recovery_expires_at);
      const expected = Buffer.from(pending.enrollment_credential_fingerprint_b64);
      const supplied = Buffer.from(fingerprint("activation-enrollment", enrollment));
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied) ||
        pending.hostname !== this.options.hostname ||
        pending.agent_version !== this.options.version
      )
        throw new AgentLifecycleError("ACTIVATION_INPUT_CHANGED");
      if (pending.registration.key_kind === "account") {
        if (!this.options.otpProvider) throw new AgentLifecycleError("OTP_NOT_AVAILABLE");
        code = await this.options.otpProvider(
          {
            agentID: state.agent_id!,
            cellID: pending.assignment.cell_id,
            assignmentTicketExpiresAt: pending.assignment_ticket_expires_at,
            pendingActivationRecovery: true,
          },
          this.options.signal ?? AbortSignal.timeout(30_000),
        );
        if (!/^\d{8}$/.test(code)) throw new AgentLifecycleError("INVALID_OTP");
      } else if (!this.options.headless) throw new AgentLifecycleError("ENROLLMENT_KIND_REFUSED");
    }
    try {
      await this.exchange(
        state,
        pending.assignment.nhp_udp_endpoint,
        13,
        {
          usrId: pending.registration.key_id,
          devId: state.agent_id,
          aspId: "agent",
          otp: code,
          usrData: {
            hostname: pending.hostname,
            version: pending.agent_version,
            assignment_ticket: pending.assignment_ticket,
          },
        },
        "registration",
        pending.recovery_expires_at,
      );
    } catch (error) {
      if (
        !this.replacement &&
        error instanceof AgentLifecycleError &&
        (error.code === "52111" ||
          (error.code === "52101" && pending.registration.key_kind === "account"))
      ) {
        // Keep the durable record. The replacement is committed only after a fresh Hub result.
        const anchor = pending.recovery_anchor_ticket_expires_at!;
        const deadline = pending.recovery_expires_at!;
        const next = copy(state);
        delete next.pending_activation;
        // Replacement follows the same registration path but must retain the original horizon.
        return new Lifecycle(
          this.store,
          {
            ...this.options,
            enrollmentCredential: enrollment,
            enrollmentCredentialProvider: undefined,
          },
          this.transport,
          { anchor, deadline },
        ).enroll(next);
      }
      throw error;
    }
    live(pending.recovery_expires_at);
    const next = copy(state);
    next.pending_completion = {
      device_api_key: `lv_live_${randomBytes(32).toString("base64url")}`,
      cell_id: pending.assignment.cell_id,
      assignment_generation: pending.assignment.assignment_generation,
      recovery_anchor_ticket_expires_at: pending.recovery_anchor_ticket_expires_at,
      recovery_expires_at: pending.recovery_expires_at,
    };
    next.enrollment_credential_kind = pending.registration.key_kind;
    delete next.pending_activation;
    await this.store.save(next, this.options.signal);
    return this.complete(next);
  }
}

export interface NativeAgentKnockOptions {
  runID: string;
  runAttempt: bigint;
  protectedResourceID: string;
  signal?: AbortSignal;
}
export interface NativeSessionReceipt {
  readonly cellID: string;
  readonly sessionID: bigint;
  readonly sessionIssuedAtMillis: bigint;
  readonly runID: string;
  readonly runAttempt: bigint;
}
export interface NativeAgentGrant {
  token: string;
  resourceHost: string;
  openTime: number;
  agentAddress: string;
  receipt: NativeSessionReceipt;
}
const receiptAuthority = new WeakMap<
  NativeSessionReceipt,
  { agentID: string; endpoint: NHPUDPEndpoint }
>();

export class AgentRuntime {
  readonly client: QURLClient;
  #state: AgentState | undefined;
  readonly #options: AgentRuntimeOptions;
  #renewal?: Promise<void>;
  #nextRefreshAt = 0;
  readonly #closed = new AbortController();
  constructor(
    state: AgentState,
    readonly store: AgentStateStore,
    options: AgentRuntimeOptions,
    readonly transport: AgentTransport,
  ) {
    this.#state = copy(state);
    this.#options = {
      hub: options.hub,
      offline: options.offline,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    };
    let cached = state.device_api_key!;
    let expiresAt = Date.now() + 60_000;
    let reload: Promise<void> | undefined;
    const agentID = state.agent_id;
    const publicKey = state.public_key_b64;
    const fetch = options.fetch ?? globalThis.fetch;
    this.client = new QURLClient({
      apiKey: cached,
      baseUrl: options.baseUrl,
      fetch: async (url, init) => {
        this.#closed.signal.throwIfAborted();
        if (Date.now() >= expiresAt) {
          reload ??= (async () => {
            const current = await store.load(this.#closed.signal);
            ready(current);
            checkIdentity(current, agentID);
            if (current.public_key_b64 !== publicKey)
              throw new AgentLifecycleError("IDENTITY_CHANGED");
            cached = current.device_api_key!;
            expiresAt = Date.now() + 60_000;
          })().finally(() => {
            reload = undefined;
          });
          await reload;
        }
        this.#closed.signal.throwIfAborted();
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${cached}`);
        return fetch(url, {
          ...init,
          headers,
          signal: init?.signal
            ? AbortSignal.any([init.signal, this.#closed.signal])
            : this.#closed.signal,
        });
      },
    });
  }
  get agentID(): string {
    return this.#requireState().agent_id!;
  }
  assignment(): AgentAssignment {
    return structuredClone(this.#requireState().assignment!);
  }
  #requireState(): AgentState {
    this.#closed.signal.throwIfAborted();
    if (!this.#state) throw new AgentLifecycleError("CLOSED");
    return this.#state;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.#options.offline) throw new AgentLifecycleError("OFFLINE");
    this.#requireState();
    signal = signal ? AbortSignal.any([signal, this.#closed.signal]) : this.#closed.signal;
    this.#renewal ??= this.store
      .withLock(async (locked) => {
        const state = await locked.load(signal);
        checkIdentity(state, this.agentID);
        if (state.public_key_b64 !== this.#requireState().public_key_b64)
          throw new AgentLifecycleError("IDENTITY_CHANGED");
        const next = await new Lifecycle(
          locked,
          {
            ...this.#options,
            signal,
          },
          this.transport,
        ).refresh(state, true);
        this.#closed.signal.throwIfAborted();
        this.#state = next;
      }, signal)
      .finally(() => {
        this.#renewal = undefined;
        this.#nextRefreshAt = Date.now() + 30_000;
      });
    await this.#renewal;
  }

  async knock(
    knockResourceID: string,
    options: NativeAgentKnockOptions,
  ): Promise<NativeAgentGrant> {
    if (
      !/^[0-9a-f]{16}$/.test(options.runID) ||
      typeof options.runAttempt !== "bigint" ||
      options.runAttempt <= 0n ||
      options.runAttempt > UINT64_MAX ||
      !parseCrid(options.protectedResourceID, true) ||
      options.protectedResourceID === knockResourceID ||
      !knockResourceID ||
      knockResourceID.trim() !== knockResourceID
    )
      throw new AgentLifecycleError("INVALID_KNOCK_INPUT");
    let state = this.#requireState();
    const lease = canonicalTime(state.assignment!.lease_expires_at);
    if (
      lease - Date.now() <= 300_000 &&
      Date.now() >= this.#nextRefreshAt &&
      !this.#options.offline
    ) {
      try {
        await this.refresh(options.signal);
      } catch (error) {
        if (lease <= Date.now()) throw error;
      }
      state = this.#requireState();
    }
    if (canonicalTime(state.assignment!.lease_expires_at) <= Date.now())
      throw new AgentLifecycleError("ASSIGNMENT_EXPIRED");
    const assignment = structuredClone(state.assignment!);
    const body = {
      headerType: 1,
      usrId: state.agent_id,
      devId: state.agent_id,
      aspId: "agent",
      resId: knockResourceID,
      runId: options.runID,
      runAttempt: options.runAttempt,
      protected_resource_id: options.protectedResourceID,
    };
    const ack = await new Lifecycle(
      this.store,
      {
        ...this.#options,
        signal: options.signal
          ? AbortSignal.any([options.signal, this.#closed.signal])
          : this.#closed.signal,
      },
      this.transport,
    ).exchange(state, assignment.nhp_udp_endpoint, 1, body, "session", undefined, {
      ...body,
      headerType: 8,
    });
    const parsed = exactObject(
      ack,
      "errCode errMsg sessId cellId sessIssuedAtMillis runId runAttempt resHost opnTime aspToken agentAddr acTokens preActions redirectUrl",
    );
    if (typeof parsed.errCode !== "string" || !/^(?:0|[1-9]\d*)$/.test(parsed.errCode))
      throw new AgentLifecycleError("INVALID_KNOCK_REPLY");
    if (parsed.errCode !== "0") {
      if (
        typeof parsed.errMsg !== "string" ||
        !parsed.errMsg.trim() ||
        parsed.errMsg.trim() !== parsed.errMsg ||
        (parsed.opnTime !== undefined && parsed.opnTime !== 0n) ||
        Object.keys(parsed).some((key) => !["errCode", "errMsg", "opnTime"].includes(key))
      )
        throw new AgentLifecycleError("INVALID_KNOCK_REPLY");
      throw new AgentLifecycleError(parsed.errCode);
    }
    if (
      parsed.errMsg !== undefined ||
      typeof parsed.sessId !== "bigint" ||
      parsed.sessId <= 0n ||
      parsed.sessId > UINT64_MAX ||
      parsed.cellId !== assignment.cell_id ||
      parsed.runId !== options.runID ||
      parsed.runAttempt !== options.runAttempt ||
      typeof parsed.sessIssuedAtMillis !== "bigint" ||
      parsed.sessIssuedAtMillis <= 0n ||
      parsed.sessIssuedAtMillis > (1n << 63n) - 1n ||
      typeof parsed.opnTime !== "bigint" ||
      parsed.opnTime <= 0n ||
      parsed.opnTime > 0xffffffffn ||
      typeof parsed.agentAddr !== "string" ||
      !validAgentAddress(parsed.agentAddr) ||
      !isStrictJsonObject(parsed.acTokens) ||
      !isStrictJsonObject(parsed.resHost)
    )
      throw new AgentLifecycleError("INVALID_KNOCK_REPLY");
    if (
      parsed.preActions !== undefined &&
      (!isStrictJsonObject(parsed.preActions) ||
        Object.values(parsed.preActions).some((value) => value !== null))
    )
      throw new AgentLifecycleError("UNSUPPORTED_PREACCESS_ACTION");
    const token = parsed.acTokens[knockResourceID];
    const resourceHost = parsed.resHost[knockResourceID];
    if (
      typeof token !== "string" ||
      !token ||
      token.trim() !== token ||
      typeof resourceHost !== "string" ||
      !resourceHost ||
      resourceHost.trim() !== resourceHost
    )
      throw new AgentLifecycleError("INVALID_KNOCK_REPLY");
    const receipt = Object.freeze({
      cellID: parsed.cellId as string,
      sessionID: parsed.sessId,
      sessionIssuedAtMillis: parsed.sessIssuedAtMillis,
      runID: options.runID,
      runAttempt: options.runAttempt,
    });
    receiptAuthority.set(receipt, {
      agentID: state.agent_id!,
      endpoint: assignment.nhp_udp_endpoint,
    });
    return {
      token,
      resourceHost,
      openTime: Number(parsed.opnTime),
      agentAddress: parsed.agentAddr,
      receipt,
    };
  }

  async retire(
    receipt: NativeSessionReceipt,
    signal?: AbortSignal,
  ): Promise<{ closeEventID: string; state: "closing" | "closed" }> {
    const state = this.#requireState();
    const authority = receiptAuthority.get(receipt);
    if (!authority || authority.agentID !== state.agent_id)
      throw new AgentLifecycleError("INVALID_SESSION_RECEIPT");
    const body = {
      headerType: 16,
      aspId: "agent",
      cellId: receipt.cellID,
      sessId: receipt.sessionID,
      sessIssuedAtMillis: receipt.sessionIssuedAtMillis,
      runId: receipt.runID,
      runAttempt: receipt.runAttempt,
    };
    const ack = await new Lifecycle(
      this.store,
      {
        ...this.#options,
        signal: signal ? AbortSignal.any([signal, this.#closed.signal]) : this.#closed.signal,
      },
      this.transport,
    ).exchange(state, authority.endpoint, 16, body, "session");
    exactObject(
      ack,
      "errCode errMsg cellId sessId sessIssuedAtMillis runId runAttempt closeEventId state",
    );
    if (typeof ack.errCode !== "string" || !/^(?:0|[1-9]\d*)$/.test(ack.errCode))
      throw new AgentLifecycleError("INVALID_RETIREMENT_REPLY");
    if (ack.errCode !== "0") {
      if (
        typeof ack.errMsg !== "string" ||
        !ack.errMsg.trim() ||
        ack.errMsg.trim() !== ack.errMsg ||
        Object.keys(ack).some((key) => !["errCode", "errMsg"].includes(key))
      )
        throw new AgentLifecycleError("INVALID_RETIREMENT_REPLY");
      throw new AgentLifecycleError(ack.errCode);
    }
    if (
      ack.errMsg !== undefined ||
      ack.cellId !== receipt.cellID ||
      ack.sessId !== receipt.sessionID ||
      ack.sessIssuedAtMillis !== receipt.sessionIssuedAtMillis ||
      ack.runId !== receipt.runID ||
      ack.runAttempt !== receipt.runAttempt ||
      typeof ack.closeEventId !== "string" ||
      !/^[0-9a-f]{32}$/.test(ack.closeEventId) ||
      !["closing", "closed"].includes(ack.state as string)
    )
      throw new AgentLifecycleError("INVALID_RETIREMENT_REPLY");
    return { closeEventID: ack.closeEventId, state: ack.state as "closing" | "closed" };
  }
  close(): void {
    this.#closed.abort(new AgentLifecycleError("CLOSED"));
    this.#state = undefined;
  }
  toJSON() {
    return { agentID: this.#state?.agent_id, closed: this.#closed.signal.aborted };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toJSON();
  }
}

export async function connectAgentRuntime(
  store: AgentStateStore,
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  return connectWithTransport(store, options, nativeAgentTransport);
}

export type AgentRecoveryOptions = Pick<
  AgentRuntimeOptions,
  "hub" | "agentID" | "signal" | "baseUrl" | "fetch"
>;

export async function recoverAgentRuntime(
  store: AgentStateStore,
  recoveryCredential: string | ((signal: AbortSignal) => Promise<string>),
  options: AgentRecoveryOptions = {},
): Promise<AgentRuntime> {
  return recoverWithTransport(store, recoveryCredential, options, nativeAgentTransport);
}

async function recoverWithTransport(
  store: AgentStateStore,
  provider: string | ((signal: AbortSignal) => Promise<string>),
  options: AgentRecoveryOptions,
  transport: AgentTransport,
): Promise<AgentRuntime> {
  const supplied = { ...options, hub: options.hub ? structuredClone(options.hub) : undefined };
  const state = await store.withLock(async (locked) => {
    let state = copy(await locked.load(options.signal));
    checkIdentity(state, options.agentID);
    if (
      !state.registered_at ||
      !state.assignment ||
      state.pending_activation ||
      state.pending_completion
    )
      throw new AgentLifecycleError("NOT_REGISTERED");
    const lifecycle = new Lifecycle(locked, supplied, transport);
    state.schema_version = 8;
    if (state.credential_recovery_refresh_required) return lifecycle.refresh(state, true);
    const hub = lifecycle.hub();
    let recoveryCredential: string | undefined;
    for (
      let issueAttempt = 0;
      issueAttempt < 2 &&
      (!state.pending_credential_recovery || state.pending_credential_recovery.needs_fresh_grant);
      issueAttempt++
    ) {
      const pending = state.pending_credential_recovery;
      if (pending) live(pending.recovery_expires_at);
      if (state.pending_credential_recovery_issue)
        live(state.pending_credential_recovery_issue.replay_not_after);
      recoveryCredential ??=
        typeof provider === "string"
          ? provider
          : await provider(options.signal ?? AbortSignal.timeout(30_000));
      if (!/^lv_(?:live|test)_/.test(recoveryCredential))
        throw new AgentLifecycleError("INVALID_RECOVERY_CREDENTIAL");
      canonicalKey(recoveryCredential.slice(8), "base64url").fill(0);
      const identity = fingerprint("credential-recovery", recoveryCredential);
      if (!state.pending_credential_recovery_issue) {
        const next = copy(state);
        next.pending_credential_recovery_issue = {
          agent_id: state.agent_id!,
          agent_public_key_b64: state.public_key_b64,
          request_nonce: randomBytes(32).toString("base64url"),
          recovery_credential_fingerprint_b64: identity,
          replay_not_after: new Date(
            Math.min(
              Math.floor(Date.now() / 1000) * 1000 + RECOVERY_HORIZON_MS,
              pending ? canonicalTime(pending.recovery_expires_at) : Infinity,
            ),
          )
            .toISOString()
            .replace(".000Z", "Z"),
          hub_host: hub.host,
          hub_port: hub.port,
          hub_server_public_key_b64: hub.server_public_key_b64,
        };
        await locked.save(next, options.signal);
        state = next;
      }
      const intent = state.pending_credential_recovery_issue!;
      if (
        intent.recovery_credential_fingerprint_b64 !== identity ||
        intent.hub_host !== hub.host ||
        intent.hub_port !== hub.port ||
        intent.hub_server_public_key_b64 !== hub.server_public_key_b64
      )
        throw new AgentLifecycleError("RECOVERY_INPUT_CHANGED");
      let envelope: Record<string, StrictJsonValue>;
      try {
        envelope = await lifecycle.exchange(
          state,
          hub,
          5,
          {
            usrId: "",
            devId: state.agent_id,
            aspId: "agent",
            usrData: {
              query: "cell_assignment",
              version: 1,
              mode: "recover",
              request_nonce: intent.request_nonce,
              credential: recoveryCredential,
            },
          },
          "recovery-issue",
          intent.replay_not_after,
        );
      } catch (error) {
        if (
          error instanceof AgentLifecycleError &&
          ["52401", "52402", "52403", "52405", "52406"].includes(error.code)
        ) {
          const next = copy(state);
          delete next.pending_credential_recovery_issue;
          await locked.save(next, AbortSignal.timeout(10_000));
        }
        throw error;
      }
      const list = exactObject(
        envelope.list,
        "query version mode agent_id assignment recovery_grant recovery_grant_issued_at recovery_grant_expires_at",
      );
      if (
        list.query !== "cell_assignment" ||
        list.version !== 1n ||
        list.mode !== "recover" ||
        list.agent_id !== state.agent_id ||
        typeof list.recovery_grant !== "string" ||
        !/^qrg1\.[A-Za-z0-9_-]{1,2299}$/.test(list.recovery_grant) ||
        typeof list.recovery_grant_issued_at !== "string" ||
        typeof list.recovery_grant_expires_at !== "string"
      )
        throw new AgentLifecycleError("INVALID_RECOVERY_REPLY");
      const assignment = validateAssignment(list.assignment);
      const issued = canonicalTime(list.recovery_grant_issued_at);
      const expires = canonicalTime(list.recovery_grant_expires_at);
      if (expires - issued !== 900_000 || expires >= canonicalTime(assignment.lease_expires_at))
        throw new AgentLifecycleError("INVALID_RECOVERY_REPLY");
      const anchor = pending?.recovery_anchor_grant_expires_at ?? list.recovery_grant_expires_at;
      const deadline =
        pending?.recovery_expires_at ??
        new Date(expires + RECOVERY_HORIZON_MS).toISOString().replace(".000Z", "Z");
      live(deadline);
      const next = copy(state);
      next.assignment = assignment;
      delete next.pending_credential_recovery_issue;
      delete next.device_api_key;
      delete next.device_api_key_id;
      next.pending_credential_recovery = {
        recovery_grant: list.recovery_grant,
        recovery_grant_issued_at: list.recovery_grant_issued_at,
        recovery_grant_expires_at: list.recovery_grant_expires_at,
        recovery_anchor_grant_expires_at: anchor,
        recovery_expires_at: deadline,
        device_api_key:
          pending?.device_api_key ?? `lv_live_${randomBytes(32).toString("base64url")}`,
        assignment,
        ...(expires <= Date.now() || canonicalTime(assignment.lease_expires_at) <= Date.now()
          ? { needs_fresh_grant: true }
          : {}),
      };
      await locked.save(next, options.signal);
      state = next;
    }
    const pending = state.pending_credential_recovery!;
    if (!pending || pending.needs_fresh_grant)
      throw new AgentLifecycleError("FRESH_RECOVERY_GRANT_REQUIRED");
    live(pending.recovery_expires_at);
    let envelope: Record<string, StrictJsonValue>;
    try {
      envelope = await lifecycle.exchange(
        state,
        pending.assignment.nhp_udp_endpoint,
        5,
        {
          usrId: "",
          devId: state.agent_id,
          aspId: "agent",
          usrData: {
            query: "agent_credential_recovery",
            version: 1,
            recovery_grant: pending.recovery_grant,
            device_api_key: pending.device_api_key,
          },
        },
        "recovery-completion",
        pending.recovery_expires_at,
      );
    } catch (error) {
      if (error instanceof AgentLifecycleError && error.code === "52411") {
        const next = copy(state);
        next.pending_credential_recovery!.needs_fresh_grant = true;
        await locked.save(next, AbortSignal.timeout(10_000));
      }
      throw error;
    }
    const list = exactObject(envelope.list, "query version device_api_key_id");
    if (
      list.query !== "agent_credential_recovery" ||
      list.version !== 1n ||
      typeof list.device_api_key_id !== "string" ||
      !KEY_ID.test(list.device_api_key_id)
    )
      throw new AgentLifecycleError("INVALID_RECOVERY_REPLY");
    const next = copy(state);
    next.device_api_key = pending.device_api_key;
    next.device_api_key_id = list.device_api_key_id;
    delete next.pending_credential_recovery;
    delete next.pending_credential_recovery_issue;
    next.credential_recovery_refresh_required = true;
    await locked.save(next, AbortSignal.timeout(10_000));
    return lifecycle.refresh(next, true);
  }, options.signal);
  return new AgentRuntime(state, store, supplied, transport);
}

async function connectWithTransport(
  store: AgentStateStore,
  options: AgentRuntimeOptions,
  transport: AgentTransport,
): Promise<AgentRuntime> {
  if (
    !store ||
    typeof store.withLock !== "function" ||
    (options.headless && options.otpProvider) ||
    (options.enrollmentCredentialProvider &&
      (options.enrollmentCredential !== undefined || options.otpProvider || options.offline)) ||
    (options.offline && (options.enrollmentCredential !== undefined || options.otpProvider))
  )
    throw new AgentLifecycleError("INVALID_CONFIGURATION");
  if (options.agentID !== undefined) validateAgentID(options.agentID);
  const supplied = { ...options, hub: options.hub ? structuredClone(options.hub) : undefined };
  const driver = new Lifecycle(store, supplied, transport);
  if (supplied.hub) driver.hub();
  const load = async (source: AgentStateStore) => {
    try {
      const state = copy(await source.load(options.signal));
      checkIdentity(state, options.agentID);
      return state;
    } catch (error) {
      if (error instanceof AgentStateError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  };
  let state = await load(store);
  if (state?.registered_at) {
    ready(state);
    if (canonicalTime(state.assignment!.lease_expires_at) > Date.now())
      return new AgentRuntime(state, store, supplied, transport);
  }
  if (options.offline)
    throw new AgentLifecycleError(state ? "ASSIGNMENT_EXPIRED" : "NOT_REGISTERED");
  state = await store.withLock(async (locked) => {
    let current = await load(locked);
    const lifecycle = new Lifecycle(locked, supplied, transport);
    if (current?.registered_at) {
      ready(current);
      return canonicalTime(current.assignment!.lease_expires_at) > Date.now()
        ? current
        : lifecycle.refresh(current);
    }
    if (
      !current?.pending_completion &&
      !options.enrollmentCredential &&
      !options.enrollmentCredentialProvider
    )
      throw new AgentLifecycleError("ENROLLMENT_NOT_CONFIGURED");
    if (!current) {
      lifecycle.hub();
      if (!options.headless && !options.otpProvider)
        throw new AgentLifecycleError("OTP_NOT_AVAILABLE");
      if (options.enrollmentCredential !== undefined) credential(options.enrollmentCredential);
      const { privateKey, publicKey } = generateKeyPairSync("x25519");
      const privateDER = privateKey.export({ type: "pkcs8", format: "der" });
      try {
        current = {
          schema_version: 8,
          agent_id: options.agentID ?? `agent-${randomBytes(16).toString("hex")}`,
          private_key_b64: privateDER.subarray(-32).toString("base64"),
          public_key_b64: publicKey
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64"),
        };
      } finally {
        privateDER.fill(0);
      }
      await locked.save(current, options.signal);
    }
    const completed = await lifecycle.enroll(current);
    return canonicalTime(completed.assignment!.lease_expires_at) <= Date.now()
      ? lifecycle.refresh(completed)
      : completed;
  }, options.signal);
  return new AgentRuntime(state, store, supplied, transport);
}

export const agentRuntimeTesting = {
  connectWithTransport,
  recoverWithTransport,
  Lifecycle,
  fingerprint,
};
