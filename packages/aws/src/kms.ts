import { EncryptCommand, DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  AgentStateError,
  type AgentStateKeyBinding,
  type AgentStateKeyWrapper,
} from "@layervai/qurl/node";
import { errorNamed } from "./store.js";

const KEY_ARN =
  /^arn:aws(?:-[a-z]+)?:kms:[a-z0-9-]+:\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;
function context(binding: AgentStateKeyBinding) {
  if (
    binding.purpose !== "qurl-go/agent-state" ||
    binding.envelopeVersion !== 1 ||
    !binding.agentID ||
    !binding.providerID
  )
    throw new AgentStateError("INVALID_KEY_BINDING");
  return {
    qurl_purpose: binding.purpose,
    qurl_envelope_version: String(binding.envelopeVersion),
    qurl_provider_id: binding.providerID,
    qurl_agent_id: binding.agentID,
  };
}

export function createKMSAgentStateKeyWrapper(
  client: KMSClient,
  keyID: string,
): AgentStateKeyWrapper {
  if (!client || !keyID || keyID.trim() !== keyID || keyID.length > 2048)
    throw new AgentStateError("INVALID_KMS_CONFIGURATION");
  return {
    async wrapKey(key, binding, signal) {
      signal?.throwIfAborted();
      if (key.length !== 32) throw new AgentStateError("INVALID_DATA_KEY");
      const plaintext = Buffer.from(key);
      try {
        const result = await client.send(
          new EncryptCommand({
            KeyId: keyID,
            Plaintext: plaintext,
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
            EncryptionContext: context(binding),
          }),
          { abortSignal: signal },
        );
        if (!result.CiphertextBlob?.length || !result.KeyId || !KEY_ARN.test(result.KeyId))
          throw new AgentStateError("INVALID_KMS_RESPONSE");
        return {
          version: 1,
          ciphertext: Buffer.from(result.CiphertextBlob),
          metadata: { key_id: result.KeyId },
        };
      } finally {
        plaintext.fill(0);
      }
    },
    async unwrapKey(wrapped, binding, signal) {
      signal?.throwIfAborted();
      const metadata = wrapped.metadata;
      if (
        wrapped.version !== 1 ||
        !wrapped.ciphertext.length ||
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        Object.keys(metadata).length !== 1 ||
        typeof metadata.key_id !== "string" ||
        !KEY_ARN.test(metadata.key_id)
      )
        throw new AgentStateError("INVALID_WRAPPED_KEY");
      let result;
      try {
        result = await client.send(
          new DecryptCommand({
            KeyId: metadata.key_id,
            CiphertextBlob: wrapped.ciphertext,
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
            EncryptionContext: context(binding),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (
          errorNamed(error, "InvalidCiphertextException") ||
          errorNamed(error, "IncorrectKeyException")
        )
          throw new AgentStateError("INVALID_WRAPPED_KEY");
        throw error;
      }
      try {
        if (result.KeyId !== metadata.key_id || result.Plaintext?.length !== 32)
          throw new AgentStateError("INVALID_KMS_RESPONSE");
        return Buffer.from(result.Plaintext);
      } finally {
        result.Plaintext?.fill(0);
      }
    },
  };
}
