import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { KMSClient } from "@aws-sdk/client-kms";
import { createSSMAgentStateStore } from "./ssm.js";
import { createSecretsManagerAgentStateStore } from "./secrets-manager.js";
import { lockedStore } from "./store.js";
import { createKMSAgentStateKeyWrapper } from "./kms.js";
const pair = generateKeyPairSync("x25519");
const state = {
  schema_version: 8,
  agent_id: "aws-test-agent",
  private_key_b64: pair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .subarray(-32)
    .toString("base64"),
  public_key_b64: pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64"),
};
it("SSM only maps absence to NOT_FOUND and writes SecureString", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      calls.push(command.input);
      if ("WithDecryption" in command.input)
        throw Object.assign(new Error("missing"), { name: "ParameterNotFound" });
      return {};
    },
  } as unknown as SSMClient;
  const store = createSSMAgentStateStore(client, "/agent/state", { kmsKeyID: "key" });
  await expect(store.load()).rejects.toMatchObject({ code: "NOT_FOUND" });
  await store.withLock((locked) => locked.save(state));
  expect(calls[1]).toMatchObject({ Type: "SecureString", Overwrite: true, KeyId: "key" });
  expect(JSON.parse(calls[1].Value as string)).toEqual(state);
});
it("Secrets Manager reuses one write token when creation races", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      calls.push(command.input);
      if (calls.length === 1)
        throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
      if (calls.length === 2) throw Object.assign(new Error(), { name: "ResourceExistsException" });
      return {};
    },
  } as unknown as SecretsManagerClient;
  await createSecretsManagerAgentStateStore(client, "state").save(state);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((call) => call.ClientRequestToken)).size).toBe(1);
});
it("KMS binds all four fields and decrypts with the immutable returned ARN", async () => {
  const arn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
  const calls: Record<string, unknown>[] = [];
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      calls.push(command.input);
      return "Plaintext" in command.input
        ? { KeyId: arn, CiphertextBlob: Buffer.alloc(64, 3) }
        : { KeyId: arn, Plaintext: Buffer.alloc(32, 9) };
    },
  } as unknown as KMSClient;
  const wrapper = createKMSAgentStateKeyWrapper(client, "alias/current");
  const binding = {
    purpose: "qurl-go/agent-state",
    envelopeVersion: 1,
    providerID: "aws-kms",
    agentID: "aws-test-agent",
  };
  const wrapped = await wrapper.wrapKey(Buffer.alloc(32, 9), binding);
  expect(await wrapper.unwrapKey(wrapped, binding)).toEqual(Buffer.alloc(32, 9));
  expect(calls[1].KeyId).toBe(arn);
  expect(calls[1].EncryptionContext).toEqual({
    qurl_purpose: binding.purpose,
    qurl_envelope_version: "1",
    qurl_provider_id: "aws-kms",
    qurl_agent_id: binding.agentID,
  });
  await expect(
    wrapper.unwrapKey({ ...wrapped, metadata: { key_id: "alias/current" } }, binding),
  ).rejects.toThrow("INVALID_WRAPPED_KEY");
});

it("serializes direct AWS saves with lifecycle transitions and carries the lock signal", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const store = lockedStore({
    async load() {
      return state;
    },
    async save(_state, signal) {
      expect(signal).toBe(controller.signal);
      events.push("save");
    },
  });
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = store.withLock(async (locked) => {
    events.push("locked");
    started();
    await entered;
    controller.abort(new Error("cancelled"));
    await expect(locked.save(state)).rejects.toThrow("cancelled");
  }, controller.signal);
  await ready;
  const queued = store.save(state, controller.signal);
  expect(events).toEqual(["locked"]);
  release();
  await held;
  await expect(queued).rejects.toThrow("cancelled");
  expect(events).toEqual(["locked"]);
});
