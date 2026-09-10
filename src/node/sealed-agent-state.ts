import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  AgentStateError,
  decodeAgentState,
  encodeAgentState,
  encodeAgentJSON,
  exactObject,
  type AgentState,
} from "./agent-state.js";
import { FileAgentState, type AgentStateCodec } from "./file-agent-state.js";
import { parseStrictJson, type StrictJsonValue } from "./strict-json.js";

export interface AgentStateKeyBinding {
  purpose: string;
  envelopeVersion: number;
  providerID: string;
  agentID: string;
}
export interface WrappedAgentStateKey {
  version: number;
  ciphertext: Uint8Array;
  metadata?: StrictJsonValue;
}
export interface AgentStateKeyWrapper {
  wrapKey(
    key: Uint8Array,
    binding: AgentStateKeyBinding,
    signal?: AbortSignal,
  ): Promise<WrappedAgentStateKey>;
  unwrapKey(
    wrapped: WrappedAgentStateKey,
    binding: AgentStateKeyBinding,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

const PURPOSE = "qurl-go/agent-state";
function base64(value: StrictJsonValue | undefined, maximum: number): Buffer {
  if (typeof value !== "string") throw new AgentStateError("INVALID_ENVELOPE");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length === 0 || bytes.length > maximum)
    throw new AgentStateError("INVALID_ENVELOPE");
  return bytes;
}
// Go authenticates compact RawMessage bytes: keep key order and number lexemes.
function compactMetadata(raw: string): string {
  return raw.replace(/"(?:\\.|[^"\\])*"|\s+/g, (token) =>
    token.startsWith('"')
      ? token.replace(
          /[<>&\u2028\u2029]/g,
          (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
      : "",
  );
}
function wrappedWire(wrapped: WrappedAgentStateKey) {
  if (
    !Number.isSafeInteger(wrapped.version) ||
    wrapped.version < 1 ||
    !(wrapped.ciphertext instanceof Uint8Array) ||
    wrapped.ciphertext.length === 0 ||
    wrapped.ciphertext.length > 65536
  )
    throw new AgentStateError("INVALID_WRAPPED_KEY");
  const metadata =
    wrapped.metadata === undefined
      ? undefined
      : parseStrictJson(encodeAgentJSON(wrapped.metadata), 16384);
  return {
    version: wrapped.version,
    ciphertext: Buffer.from(wrapped.ciphertext).toString("base64"),
    ...(metadata === undefined ? {} : { metadata }),
  };
}
function aad(
  binding: AgentStateKeyBinding,
  wrapped: ReturnType<typeof wrappedWire>,
  metadataRaw?: string,
) {
  const raw = encodeAgentJSON({
    purpose: binding.purpose,
    envelope_version: binding.envelopeVersion,
    provider_id: binding.providerID,
    agent_id: binding.agentID,
    wrapped_key: { version: wrapped.version, ciphertext: wrapped.ciphertext },
  });
  const metadata =
    metadataRaw === undefined
      ? wrapped.metadata === undefined
        ? undefined
        : encodeAgentJSON(wrapped.metadata).toString()
      : compactMetadata(metadataRaw);
  // wrapped_key is the final field; raw ends with its closing brace and the envelope brace.
  return metadata === undefined
    ? raw
    : Buffer.concat([raw.subarray(0, -2), Buffer.from(',"metadata":' + metadata + "}}")]);
}
function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associated: Uint8Array,
): Buffer {
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < 16)
    throw new AgentStateError("INVALID_ENVELOPE");
  const cipher = createDecipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associated);
  cipher.setAuthTag(ciphertext.subarray(-16));
  let plain: Buffer | undefined;
  try {
    plain = cipher.update(ciphertext.subarray(0, -16));
    const final = cipher.final();
    const result = Buffer.concat([plain, final]);
    final.fill(0);
    return result;
  } catch (cause) {
    throw new AgentStateError("INVALID_ENVELOPE", { cause });
  } finally {
    plain?.fill(0);
  }
}

export function createSealedAgentStateCodec(
  providerID: string,
  wrapper: AgentStateKeyWrapper,
  expectedAgentID?: string,
): AgentStateCodec {
  if (
    !/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/.test(providerID) ||
    providerID.length > 64 ||
    !wrapper ||
    typeof wrapper.wrapKey !== "function" ||
    typeof wrapper.unwrapKey !== "function"
  )
    throw new AgentStateError("INVALID_WRAPPER_CONFIG");
  const bindingFor = (agentID: unknown): AgentStateKeyBinding => {
    if (
      typeof agentID !== "string" ||
      !agentID ||
      agentID.trim() !== agentID ||
      Buffer.byteLength(agentID) > 256 ||
      [...agentID].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ||
      (expectedAgentID !== undefined && expectedAgentID !== agentID)
    )
      throw new AgentStateError("ENVELOPE_IDENTITY_MISMATCH");
    return { purpose: PURPOSE, envelopeVersion: 1, providerID, agentID };
  };
  if (expectedAgentID !== undefined) bindingFor(expectedAgentID);
  return {
    async encode(state: AgentState, signal) {
      signal?.throwIfAborted();
      const raw = encodeAgentState(state);
      const key = randomBytes(32);
      const copy = Buffer.from(key);
      try {
        const binding = bindingFor(state.agent_id);
        const wrapped = wrappedWire(await wrapper.wrapKey(copy, { ...binding }, signal));
        signal?.throwIfAborted();
        const nonce = randomBytes(12);
        const associated = aad(binding, wrapped);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(associated);
        const ciphertext = Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
        const recovered = await wrapper.unwrapKey(
          {
            version: wrapped.version,
            ciphertext: Buffer.from(wrapped.ciphertext, "base64"),
            ...(wrapped.metadata === undefined ? {} : { metadata: wrapped.metadata }),
          },
          { ...binding },
          signal,
        );
        let check: Buffer | undefined;
        try {
          signal?.throwIfAborted();
          check = decrypt(recovered, nonce, ciphertext, associated);
          if (!check.equals(raw)) throw new AgentStateError("ENVELOPE_ROUNDTRIP");
        } finally {
          check?.fill(0);
          recovered.fill(0);
        }
        const envelope = encodeAgentJSON({
          version: 1,
          purpose: PURPOSE,
          agent_id: binding.agentID,
          provider_id: providerID,
          wrapped_key: wrapped,
          nonce: nonce.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        });
        parseStrictJson(envelope, 2 << 20);
        return envelope;
      } finally {
        raw.fill(0);
        key.fill(0);
        copy.fill(0);
      }
    },
    async decode(raw, signal) {
      signal?.throwIfAborted();
      const metadataMembers = new Map<object, string>();
      const envelope = exactObject(
        parseStrictJson(raw, 2 << 20, (object, key, value) => {
          if (key === "metadata") metadataMembers.set(object, value);
        }),
        "version purpose agent_id provider_id wrapped_key nonce ciphertext",
      );
      if (
        envelope.version !== 1n ||
        envelope.purpose !== PURPOSE ||
        envelope.provider_id !== providerID
      )
        throw new AgentStateError("INVALID_ENVELOPE");
      const binding = bindingFor(envelope.agent_id);
      const record = exactObject(envelope.wrapped_key, "version ciphertext metadata");
      if (
        typeof record.version !== "bigint" ||
        record.version < 1n ||
        record.version > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new AgentStateError("INVALID_WRAPPED_KEY");
      const wrapped: WrappedAgentStateKey = {
        version: Number(record.version),
        ciphertext: base64(record.ciphertext, 65536),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      };
      const wire = wrappedWire(wrapped);
      const nonce = base64(envelope.nonce, 12);
      const ciphertext = base64(envelope.ciphertext, (1 << 20) + 16);
      if (nonce.length !== 12 || ciphertext.length < 16)
        throw new AgentStateError("INVALID_ENVELOPE");
      const key = await wrapper.unwrapKey(wrapped, { ...binding }, signal);
      let plaintext: Buffer | undefined;
      try {
        signal?.throwIfAborted();
        plaintext = decrypt(
          key,
          nonce,
          ciphertext,
          aad(binding, wire, metadataMembers.get(record)),
        );
        const state = decodeAgentState(plaintext);
        if (state.agent_id !== binding.agentID)
          throw new AgentStateError("ENVELOPE_IDENTITY_MISMATCH");
        return state;
      } finally {
        key.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}

export function openSealedFileAgentState(
  path: string,
  providerID: string,
  wrapper: AgentStateKeyWrapper,
  expectedAgentID?: string,
): FileAgentState {
  return new FileAgentState(
    path,
    createSealedAgentStateCodec(providerID, wrapper, expectedAgentID),
  );
}
