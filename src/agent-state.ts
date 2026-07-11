// Agent identity persistence for NHP-native registration — mirrors the Go
// qurl-go `AgentState` / `AgentStateStore` / `FileAgentState`
// (`qurl-go/qurl/bootstrap.go`).
//
// SECURITY: once registration completes, an AgentState is a CREDENTIAL — it
// holds `device_api_key`, the bearer token the returned client authorizes with.
// See the {@link AgentState} doc.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NHPServerPeerInfo } from "./types.js";
import { errText } from "./internal.js";

/** Current AgentState schema version, stamped into {@link AgentState.schema_version}
 * when registration writes state. Informational only — readiness is derived from
 * the fields (`registered_at` + `device_api_key`), never from this number. */
export const AGENT_STATE_SCHEMA_VERSION = 2;

/**
 * The protected local agent identity created during NHP-native registration.
 *
 * SECURITY: once registration completes, AgentState is a CREDENTIAL. It holds
 * {@link device_api_key}, the bearer token the client returned by `registerAgent`
 * authorizes with. Treat it as secret: keep it out of logs, crash dumps, and
 * support bundles, and keep the {@link FileAgentStateStore} 0600 / 0700-dir
 * posture. On a shared host, back it with a secret manager (via a custom
 * {@link AgentStateStore}) rather than a world-readable path.
 *
 * Field naming mirrors the Go JSON tags (snake_case) so a state file written by
 * one SDK is readable by the other — the persisted shape is a cross-language
 * contract. The presence of {@link device_api_key} alongside {@link registered_at}
 * marks a state ready to back a client with zero network.
 */
export interface AgentState {
  /** AgentState schema version. Absent/0 in legacy files; registration writes
   * {@link AGENT_STATE_SCHEMA_VERSION}. Informational only. */
  schema_version?: number;
  /** The enrolled agent id, also the NHP device id. SDK-owned and stable across
   * resumes; generated on first run when not configured. */
  agent_id?: string;
  /** The agent's X25519 device private key, standard base64. The Noise initiator
   * identity registration proves and the server binds. SENSITIVE. */
  private_key_b64: string;
  /** The agent's X25519 device public key, standard base64. Derived from the
   * private key; persisted for the completion request body. */
  public_key_b64: string;
  /** ISO-8601 registration completion time. Its presence (with
   * {@link device_api_key}) marks a ready credential. */
  registered_at?: string;
  /** The NHP server peer (public key, host, port) bound at registration. */
  nhp_server_peer?: NHPServerPeerInfo;
  /** The device REST bearer credential minted at registration completion. Its
   * presence alongside {@link registered_at} marks a state ready to back a client
   * with zero network. SENSITIVE — see the type doc. */
  device_api_key?: string;
  /** The NHP relay base URL from the most recent registration-info pre-flight. A
   * record of the last-known relay; a resume re-fetches registration-info (the
   * authoritative source) rather than reading this back. */
  relay_url?: string;
  /** The enrollment key id (`key_...`) from registration-info, carried as the NHP
   * `usrId`; refreshed from a fresh pre-flight on resume. */
  key_id?: string;
  /** Marks the account-key otp_pending state: an email one-time code has been
   * requested and registration is waiting for the code. Cleared once
   * {@link registered_at} is set. ISO-8601. */
  otp_requested_at?: string;
}

/**
 * Loads and saves the registered local identity. The file-backed store writes
 * plaintext JSON protected by filesystem permissions; implement this with KMS or
 * a secret manager when that is not appropriate.
 *
 * `loadAgentState` returns `null` when no state has been persisted (the "not
 * registered yet" signal — registration then starts a fresh enrollment). This
 * models the Go `ErrAgentStateNotFound` contract as a null return. A store that
 * has persisted state which cannot be read back (a corrupt blob) should throw,
 * not return null — that is distinct from "not yet persisted".
 */
export interface AgentStateStore {
  loadAgentState(): Promise<AgentState | null>;
  saveAgentState(state: AgentState): Promise<void>;
}

/**
 * A file-backed {@link AgentStateStore} for Node. Writes a plaintext JSON file
 * with 0600 permissions via an atomic temp-file-and-rename, in a directory
 * created 0700. Mirrors the Go `FileAgentState`.
 *
 * SECURITY: the file becomes a credential once registration completes (it holds
 * `device_api_key`). The 0600/0700 posture keeps it owner-only; do not relax it,
 * and prefer a secret manager on a shared host.
 */
export class FileAgentStateStore implements AgentStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("FileAgentStateStore: path must be a non-empty string");
    }
    this.filePath = filePath;
  }

  async loadAgentState(): Promise<AgentState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (isNotFound(err)) {
        // Not yet persisted — the "not registered" signal (Go ErrAgentStateNotFound).
        return null;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Present but unreadable — distinct from not-found. Mirrors Go
      // ErrInvalidAgentState (a corrupt/undecodable blob).
      throw new Error(
        `agent state at ${this.filePath} is present but unreadable or corrupt: ${errText(err)}`,
        { cause: err },
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`agent state at ${this.filePath} is present but not a JSON object`);
    }
    return parsed as AgentState;
  }

  async saveAgentState(state: AgentState): Promise<void> {
    if (state === null || typeof state !== "object") {
      throw new Error("FileAgentStateStore: state must be an object");
    }
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    // Atomic write: a unique temp file in the same dir, chmod 0600, then rename
    // over the target. A crash mid-write leaves either the old file or nothing,
    // never a truncated credential. The temp name is randomized to avoid
    // colliding with a concurrent writer's temp file.
    const tmpPath = path.join(
      dir,
      `.qurl-agent-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await fs.writeFile(tmpPath, serialized, { mode: 0o600 });
      // writeFile respects umask on create; force 0600 explicitly so a permissive
      // umask cannot widen the credential file.
      await fs.chmod(tmpPath, 0o600);
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * Convenience constructor mirroring the Go `qurl.FileAgentState(path)` free
 * function: returns a {@link FileAgentStateStore} for `filePath`, or — when
 * called with no path — a default under the user's home directory
 * (`~/.qurl/agent-state.json`).
 */
export function fileAgentStateStore(filePath?: string): AgentStateStore {
  return new FileAgentStateStore(filePath ?? path.join(os.homedir(), ".qurl", "agent-state.json"));
}

/**
 * An in-memory {@link AgentStateStore}. Holds the state in a field, returning
 * `null` until something is saved. Intended for tests and ephemeral processes —
 * it persists nothing across restarts, so a registered credential is lost when
 * the process exits.
 */
export class MemoryAgentStateStore implements AgentStateStore {
  private state: AgentState | null;

  constructor(initial: AgentState | null = null) {
    this.state = initial;
  }

  async loadAgentState(): Promise<AgentState | null> {
    // Deep-clone on the way out too: the registration engine mutates the loaded
    // state in place, and returning the stored object by reference would let
    // those mutations reach persisted state before any save. FileAgentStateStore
    // returns a fresh object per load (it re-parses the file), so cloning here
    // keeps the two stores' isolation semantics aligned.
    return this.state === null ? null : deepCloneState(this.state);
  }

  async saveAgentState(state: AgentState): Promise<void> {
    // Deep-clone so a later in-place mutation by the caller (including of the
    // nested nhp_server_peer) does not retroactively change persisted state. The
    // file store serializes, so this keeps the two stores' semantics aligned.
    this.state = deepCloneState(state);
  }
}

/** Deep-clones an AgentState. Uses structuredClone (Node >= 17) with a JSON
 * round-trip fallback for older/limited runtimes; AgentState is plain JSON, so
 * both are faithful. */
function deepCloneState(state: AgentState): AgentState {
  if (typeof structuredClone === "function") {
    return structuredClone(state);
  }
  return JSON.parse(JSON.stringify(state)) as AgentState;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
