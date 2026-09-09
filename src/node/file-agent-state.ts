import { resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadNativeStateFS, type NativeStateFS } from "./native-loader.cjs";
import {
  AgentStateError,
  decodeAgentState,
  encodeAgentState,
  type AgentState,
  type AgentStateStore,
} from "./agent-state.js";

export interface AgentStateCodec {
  encode(state: AgentState, signal?: AbortSignal): Promise<Buffer>;
  decode(raw: Uint8Array, signal?: AbortSignal): Promise<AgentState>;
}

const plaintextCodec: AgentStateCodec = {
  async encode(state) {
    return encodeAgentState(state);
  },
  async decode(raw) {
    return decodeAgentState(raw);
  },
};

/** Own this handle until all clients and lifecycle operations finish. */
export class FileAgentState implements AgentStateStore {
  readonly #native: NativeStateFS;
  readonly #handle: object;
  readonly #codec: AgentStateCodec;
  #active = 0;
  #closed = false;
  #locked = false;

  constructor(path: string, codec: AgentStateCodec = plaintextCodec) {
    let absolute = resolve(path);
    if (process.platform === "darwin")
      absolute = absolute.replace(/^\/(var|tmp|etc)(?=\/|$)/, "/private/$1");
    this.#native = loadNativeStateFS();
    this.#handle = this.#native.open(dirname(absolute), basename(absolute));
    this.#codec = codec;
  }

  checkContinuity(): void {
    if (this.#closed) throw new AgentStateError("CLOSED");
    this.#native.check(this.#handle);
  }

  async load(signal?: AbortSignal): Promise<AgentState> {
    this.checkContinuity();
    signal?.throwIfAborted();
    this.#active++;
    let bytes: Buffer | null = null;
    try {
      bytes = this.#native.read(this.#handle);
      if (bytes === null) throw new AgentStateError("NOT_FOUND");
      const state = await this.#codec.decode(bytes, signal);
      this.checkContinuity();
      signal?.throwIfAborted();
      return state;
    } finally {
      bytes?.fill(0);
      this.#active--;
    }
  }

  async save(state: AgentState, signal?: AbortSignal): Promise<void> {
    // Snapshot before waiting for another writer or an external key wrapper.
    const bytes = encodeAgentState(state);
    try {
      await this.withLock((locked) => locked.save(decodeAgentState(bytes), signal), signal);
    } finally {
      bytes.fill(0);
    }
  }

  async withLock<T>(
    operation: (locked: AgentStateStore) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.checkContinuity();
    this.#active++;
    let acquired = false;
    const deadline = AbortSignal.timeout(30_000);
    const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (;;) {
        waiting.throwIfAborted();
        if (!this.#locked && this.#native.tryLock(this.#handle)) {
          this.#locked = acquired = true;
          break;
        }
        await delay(25, undefined, { signal: waiting });
      }
      let valid = true;
      const requireLease = () => {
        if (!valid) throw new AgentStateError("EXPIRED_LOCK_HANDLE");
        this.checkContinuity();
      };
      const locked: AgentStateStore = {
        load: async (nextSignal) => {
          requireLease();
          const value = await this.load(nextSignal ?? signal);
          requireLease();
          return value;
        },
        save: async (state, nextSignal) => {
          requireLease();
          const raw = encodeAgentState(state);
          let encoded: Buffer | undefined;
          try {
            encoded = await this.#codec.encode(decodeAgentState(raw), nextSignal ?? signal);
            requireLease();
            (nextSignal ?? signal)?.throwIfAborted();
            this.#native.write(this.#handle, encoded, `.qurl-${randomUUID()}`);
          } finally {
            encoded?.fill(0);
            raw.fill(0);
          }
        },
        withLock: async (fn) => {
          requireLease();
          return fn(locked);
        },
        checkContinuity: requireLease,
      };
      try {
        const result = await operation(locked);
        requireLease();
        return result;
      } finally {
        valid = false;
      }
    } finally {
      this.#active--;
      if (acquired) {
        this.#locked = false;
        this.#native.unlock(this.#handle);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#active) throw new AgentStateError("BUSY");
    this.#closed = true;
    this.#native.close(this.#handle);
  }
}
