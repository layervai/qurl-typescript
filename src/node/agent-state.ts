import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { isStrictJsonObject, parseStrictJson, type StrictJsonValue } from "./strict-json.js";

export interface NHPUDPEndpoint {
  host: string;
  port: number;
  server_public_key_b64: string;
}

export interface AgentAssignment {
  cell_id: string;
  assignment_generation: bigint;
  endpoint_revision: bigint;
  lease_expires_at: string;
  nhp_udp_endpoint: NHPUDPEndpoint;
}

export interface AssignmentRegistration {
  key_id: string;
  key_kind: string;
}

export interface PendingAgentActivation {
  assignment_ticket: string;
  assignment_ticket_expires_at: string;
  recovery_anchor_ticket_expires_at?: string;
  recovery_expires_at?: string;
  agent_id: string;
  agent_public_key_b64: string;
  assignment: AgentAssignment;
  registration: AssignmentRegistration;
  hostname?: string;
  agent_version?: string;
  enrollment_credential_fingerprint_b64: string;
}

export interface PendingAgentCompletion {
  device_api_key: string;
  cell_id: string;
  assignment_generation: bigint;
  recovery_anchor_ticket_expires_at?: string;
  recovery_expires_at?: string;
}

export interface PendingAgentCredentialRecovery {
  recovery_grant: string;
  recovery_grant_issued_at: string;
  recovery_grant_expires_at: string;
  recovery_anchor_grant_expires_at: string;
  recovery_expires_at: string;
  device_api_key: string;
  assignment: AgentAssignment;
  needs_fresh_grant?: boolean;
}

export interface PendingAgentCredentialRecoveryIssue {
  request_nonce: string;
  replay_not_after: string;
  recovery_credential_fingerprint_b64: string;
  agent_id: string;
  agent_public_key_b64: string;
  hub_host: string;
  hub_port: number;
  hub_server_public_key_b64: string;
}

export interface AgentState {
  agent_id?: string;
  private_key_b64: string;
  public_key_b64: string;
  registered_at?: string;
  schema_version?: number;
  device_api_key?: string;
  assignment?: AgentAssignment;
  device_api_key_id?: string;
  enrollment_credential_kind?: string;
  pending_activation?: PendingAgentActivation;
  pending_completion?: PendingAgentCompletion;
  pending_credential_recovery?: PendingAgentCredentialRecovery;
  pending_credential_recovery_issue?: PendingAgentCredentialRecoveryIssue;
  credential_recovery_refresh_required?: boolean;
}

export class AgentStateError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(`qURL agent state: ${code}`, options);
    this.name = "AgentStateError";
  }
}

export interface AgentStateStore {
  load(signal?: AbortSignal): Promise<AgentState>;
  save(state: AgentState, signal?: AbortSignal): Promise<void>;
  /**
   * Hold one store's setup lock across the complete lifecycle transition.
   * Nested calls reuse the outer lock and its signal; pass a signal directly
   * to load/save when an individual operation needs a different deadline.
   */
  withLock<T>(operation: (locked: AgentStateStore) => Promise<T>, signal?: AbortSignal): Promise<T>;
  checkContinuity?(): void;
}

export const RECOVERY_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_INT64 = (1n << 63n) - 1n;
const KEYS = {
  state:
    "agent_id private_key_b64 public_key_b64 registered_at schema_version device_api_key assignment device_api_key_id enrollment_credential_kind pending_activation pending_completion pending_credential_recovery pending_credential_recovery_issue credential_recovery_refresh_required",
  assignment: "cell_id assignment_generation endpoint_revision lease_expires_at nhp_udp_endpoint",
  endpoint: "host port server_public_key_b64",
  activation:
    "assignment_ticket assignment_ticket_expires_at recovery_anchor_ticket_expires_at recovery_expires_at agent_id agent_public_key_b64 assignment registration hostname agent_version enrollment_credential_fingerprint_b64",
  completion:
    "device_api_key cell_id assignment_generation recovery_anchor_ticket_expires_at recovery_expires_at",
  recovery:
    "recovery_grant recovery_grant_issued_at recovery_grant_expires_at recovery_anchor_grant_expires_at recovery_expires_at device_api_key assignment needs_fresh_grant",
  issue:
    "request_nonce replay_not_after recovery_credential_fingerprint_b64 agent_id agent_public_key_b64 hub_host hub_port hub_server_public_key_b64",
};

/** Exact integer JSON, also used for NHP uint64 fields. */
export function encodeAgentJSON(value: unknown): Buffer {
  const encode = (v: unknown): string => {
    if (typeof v === "bigint") return v.toString();
    if (v === null || typeof v !== "object") {
      const out = JSON.stringify(v);
      if (out === undefined || (typeof v === "number" && !Number.isFinite(v)))
        throw new AgentStateError("INVALID_JSON");
      return out.replace(
        /[<>&\u2028\u2029]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
    }
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    return `{${Object.entries(v)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${encode(key)}:${encode(child)}`)
      .join(",")}}`;
  };
  return Buffer.from(encode(value));
}

export function exactObject(
  value: StrictJsonValue | undefined,
  keys: string,
): Record<string, StrictJsonValue> {
  const allowed = new Set(keys.split(" "));
  if (!isStrictJsonObject(value) || Object.keys(value).some((key) => !allowed.has(key)))
    throw new AgentStateError("INVALID_SCHEMA");
  return value;
}

export function canonicalTime(value: unknown, allowFraction = false): number {
  if (
    typeof value !== "string" ||
    (!allowFraction && value.includes(".")) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    throw new AgentStateError("INVALID_TIME");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new AgentStateError("INVALID_TIME");
  return ms;
}

export function canonicalKey(value: unknown, encoding: "base64" | "base64url" = "base64"): Buffer {
  if (typeof value !== "string") throw new AgentStateError("INVALID_KEY");
  const key = Buffer.from(value, encoding);
  if (key.length !== 32 || key.toString(encoding) !== value)
    throw new AgentStateError("INVALID_KEY");
  return key;
}

export function validateAgentID(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value))
    throw new AgentStateError("INVALID_ID");
}

export function validateDeviceCredential(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("lv_live_"))
    throw new AgentStateError("INVALID_CREDENTIAL");
  canonicalKey(value.slice(8), "base64url").fill(0);
}

export function validateEndpoint(value: StrictJsonValue | undefined): NHPUDPEndpoint {
  const item = exactObject(value, KEYS.endpoint);
  if (
    typeof item.host !== "string" ||
    item.host.length > 253 ||
    !/\.(?:layerv\.ai|layerv\.xyz)$/.test(item.host) ||
    item.host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    item.port !== 443n
  )
    throw new AgentStateError("INVALID_ENDPOINT");
  canonicalKey(item.server_public_key_b64);
  return {
    host: item.host,
    port: 443,
    server_public_key_b64: item.server_public_key_b64 as string,
  };
}

export function validateAssignment(value: StrictJsonValue | undefined): AgentAssignment {
  const item = exactObject(value, KEYS.assignment);
  if (typeof item.cell_id !== "string" || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(item.cell_id))
    throw new AgentStateError("INVALID_ASSIGNMENT");
  for (const key of ["assignment_generation", "endpoint_revision"]) {
    const n = item[key];
    if (typeof n !== "bigint" || n <= 0n || n > MAX_INT64)
      throw new AgentStateError("INVALID_ASSIGNMENT");
  }
  canonicalTime(item.lease_expires_at);
  return {
    ...item,
    nhp_udp_endpoint: validateEndpoint(item.nhp_udp_endpoint),
  } as unknown as AgentAssignment;
}

function recoveryWindow(anchor: unknown, expires: unknown) {
  if (canonicalTime(expires) - canonicalTime(anchor) !== RECOVERY_HORIZON_MS)
    throw new AgentStateError("INVALID_RECOVERY_WINDOW");
}

export function decodeAgentState(raw: Uint8Array): AgentState {
  try {
    const value = exactObject(parseStrictJson(raw, 1_048_576), KEYS.state);
    const schema = value.schema_version ?? 0n;
    if (typeof schema !== "bigint" || schema < 0n || schema > 8n)
      throw new AgentStateError("UNSUPPORTED_SCHEMA");
    if (
      (schema < 7n &&
        (value.pending_credential_recovery || value.pending_credential_recovery_issue)) ||
      (schema < 8n && value.credential_recovery_refresh_required)
    )
      throw new AgentStateError("UNSUPPORTED_SCHEMA");
    validateAgentID(value.agent_id);
    const privateKey = canonicalKey(value.private_key_b64);
    try {
      const key = createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privateKey]),
        type: "pkcs8",
        format: "der",
      });
      const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
      if (!timingSafeEqual(publicKey, canonicalKey(value.public_key_b64)))
        throw new AgentStateError("INVALID_KEYPAIR");
    } finally {
      privateKey.fill(0);
    }
    const state = { ...value, schema_version: Number(schema) } as unknown as AgentState;
    if (value.assignment !== undefined) state.assignment = validateAssignment(value.assignment);
    const assignmentEqual = (a: AgentAssignment) => {
      const b = state.assignment;
      return (
        b !== undefined &&
        a.cell_id === b.cell_id &&
        a.assignment_generation === b.assignment_generation &&
        a.endpoint_revision === b.endpoint_revision &&
        a.lease_expires_at === b.lease_expires_at &&
        a.nhp_udp_endpoint.host === b.nhp_udp_endpoint.host &&
        a.nhp_udp_endpoint.port === b.nhp_udp_endpoint.port &&
        a.nhp_udp_endpoint.server_public_key_b64 === b.nhp_udp_endpoint.server_public_key_b64
      );
    };
    if (value.registered_at !== undefined) canonicalTime(value.registered_at, true);
    if (value.device_api_key !== undefined) validateDeviceCredential(value.device_api_key);
    if (
      value.device_api_key_id !== undefined &&
      (typeof value.device_api_key_id !== "string" ||
        !/^key_[A-Za-z0-9]{12}$/.test(value.device_api_key_id))
    )
      throw new AgentStateError("INVALID_CREDENTIAL_ID");
    if (
      value.enrollment_credential_kind !== undefined &&
      !["account", "bootstrap", "connector_bootstrap", "agent"].includes(
        value.enrollment_credential_kind as string,
      )
    )
      throw new AgentStateError("INVALID_KIND");
    if (value.pending_activation !== undefined) {
      const p = exactObject(value.pending_activation, KEYS.activation);
      const registration = exactObject(p.registration, "key_id key_kind");
      const assignment = validateAssignment(p.assignment);
      if (
        p.agent_id !== state.agent_id ||
        p.agent_public_key_b64 !== state.public_key_b64 ||
        !assignmentEqual(assignment) ||
        typeof p.assignment_ticket !== "string" ||
        !/^[\x21-\x7e]{1,2304}$/.test(p.assignment_ticket) ||
        typeof registration.key_id !== "string" ||
        !/^key_[A-Za-z0-9]{12}$/.test(registration.key_id) ||
        !["account", "bootstrap", "connector_bootstrap", "agent"].includes(
          registration.key_kind as string,
        )
      )
        throw new AgentStateError("INVALID_ACTIVATION");
      canonicalTime(p.assignment_ticket_expires_at);
      if (
        schema < 6n &&
        p.recovery_anchor_ticket_expires_at === undefined &&
        p.recovery_expires_at === undefined
      ) {
        p.recovery_anchor_ticket_expires_at = p.assignment_ticket_expires_at;
        p.recovery_expires_at = new Date(
          canonicalTime(p.assignment_ticket_expires_at) + RECOVERY_HORIZON_MS,
        )
          .toISOString()
          .replace(".000Z", "Z");
      }
      recoveryWindow(p.recovery_anchor_ticket_expires_at, p.recovery_expires_at);
      canonicalKey(p.enrollment_credential_fingerprint_b64, "base64url");
      for (const field of ["hostname", "agent_version"])
        if (p[field] !== undefined && typeof p[field] !== "string")
          throw new AgentStateError("INVALID_ACTIVATION");
      if (
        state.registered_at ||
        state.device_api_key ||
        state.device_api_key_id ||
        value.pending_completion
      )
        throw new AgentStateError("CONFLICTING_PHASES");
      state.pending_activation = { ...p, assignment } as unknown as PendingAgentActivation;
    }
    if (value.pending_completion !== undefined) {
      const p = exactObject(value.pending_completion, KEYS.completion);
      validateDeviceCredential(p.device_api_key);
      recoveryWindow(p.recovery_anchor_ticket_expires_at, p.recovery_expires_at);
      if (
        !state.assignment ||
        p.cell_id !== state.assignment.cell_id ||
        p.assignment_generation !== state.assignment.assignment_generation ||
        state.registered_at ||
        state.device_api_key ||
        state.device_api_key_id
      )
        throw new AgentStateError("INVALID_COMPLETION");
    }
    if (value.pending_credential_recovery !== undefined) {
      const p = exactObject(value.pending_credential_recovery, KEYS.recovery);
      const assignment = validateAssignment(p.assignment);
      if (
        !assignmentEqual(assignment) ||
        !state.registered_at ||
        state.device_api_key ||
        state.device_api_key_id ||
        state.pending_activation ||
        state.pending_completion ||
        typeof p.recovery_grant !== "string" ||
        !/^qrg1\.[A-Za-z0-9_-]{1,2299}$/.test(p.recovery_grant) ||
        (p.needs_fresh_grant !== undefined && typeof p.needs_fresh_grant !== "boolean")
      )
        throw new AgentStateError("INVALID_RECOVERY");
      validateDeviceCredential(p.device_api_key);
      recoveryWindow(p.recovery_anchor_grant_expires_at, p.recovery_expires_at);
      if (
        canonicalTime(p.recovery_grant_expires_at) - canonicalTime(p.recovery_grant_issued_at) !==
        900_000
      )
        throw new AgentStateError("INVALID_GRANT_WINDOW");
      state.pending_credential_recovery = {
        ...p,
        assignment,
      } as unknown as PendingAgentCredentialRecovery;
    }
    if (value.pending_credential_recovery_issue !== undefined) {
      const p = exactObject(value.pending_credential_recovery_issue, KEYS.issue);
      if (
        !state.registered_at ||
        !state.assignment ||
        state.pending_activation ||
        state.pending_completion ||
        p.agent_id !== state.agent_id ||
        p.agent_public_key_b64 !== state.public_key_b64 ||
        (state.pending_credential_recovery && !state.pending_credential_recovery.needs_fresh_grant)
      )
        throw new AgentStateError("INVALID_RECOVERY_ISSUE");
      canonicalKey(p.request_nonce, "base64url");
      canonicalKey(p.recovery_credential_fingerprint_b64, "base64url");
      canonicalTime(p.replay_not_after);
      if (
        state.pending_credential_recovery &&
        canonicalTime(p.replay_not_after) >
          canonicalTime(state.pending_credential_recovery.recovery_expires_at)
      )
        throw new AgentStateError("INVALID_RECOVERY_WINDOW");
      const endpoint = validateEndpoint({
        host: p.hub_host,
        port: p.hub_port,
        server_public_key_b64: p.hub_server_public_key_b64,
      });
      state.pending_credential_recovery_issue = {
        ...p,
        hub_port: endpoint.port,
      } as unknown as PendingAgentCredentialRecoveryIssue;
    }
    if (
      value.credential_recovery_refresh_required !== undefined &&
      typeof value.credential_recovery_refresh_required !== "boolean"
    )
      throw new AgentStateError("INVALID_RECOVERY");
    if (
      state.credential_recovery_refresh_required &&
      (!state.registered_at ||
        !state.assignment ||
        !state.device_api_key ||
        !state.device_api_key_id ||
        state.pending_activation ||
        state.pending_completion ||
        state.pending_credential_recovery ||
        state.pending_credential_recovery_issue)
    )
      throw new AgentStateError("CONFLICTING_PHASES");
    return state;
  } catch (cause) {
    if (cause instanceof AgentStateError) throw cause;
    throw new AgentStateError("INVALID_STATE", { cause });
  }
}

export function encodeAgentState(state: AgentState): Buffer {
  const raw = encodeAgentJSON(state);
  try {
    decodeAgentState(raw);
    return raw;
  } catch (error) {
    raw.fill(0);
    throw error;
  }
}
