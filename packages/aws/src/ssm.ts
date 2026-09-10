import { GetParameterCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import {
  AgentStateError,
  decodeAgentState,
  encodeAgentState,
  type AgentStateStore,
} from "@layervai/qurl/node";
import { lockedStore, errorNamed } from "./store.js";

export function createSSMAgentStateStore(
  client: SSMClient,
  name: string,
  options: { kmsKeyID?: string; tier?: "Standard" | "Advanced" | "Intelligent-Tiering" } = {},
): AgentStateStore {
  name = name.trim();
  if (!client || !name) throw new AgentStateError("INVALID_SSM_CONFIGURATION");
  const { kmsKeyID, tier } = options;
  return lockedStore({
    async load(signal) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
          abortSignal: signal,
        });
      } catch (error) {
        if (errorNamed(error, "ParameterNotFound")) throw new AgentStateError("NOT_FOUND");
        throw error;
      }
      if (typeof result.Parameter?.Value !== "string") throw new AgentStateError("INVALID_STATE");
      const raw = Buffer.from(result.Parameter.Value);
      try {
        return decodeAgentState(raw);
      } finally {
        raw.fill(0);
      }
    },
    async save(state, signal) {
      signal?.throwIfAborted();
      const raw = encodeAgentState(state);
      try {
        if (raw.length > (tier === "Advanced" || tier === "Intelligent-Tiering" ? 8192 : 4096))
          throw new AgentStateError("SSM_SIZE_LIMIT");
        await client.send(
          new PutParameterCommand({
            Name: name,
            Value: raw.toString(),
            Type: "SecureString",
            Overwrite: true,
            KeyId: kmsKeyID,
            Tier: tier,
          }),
          { abortSignal: signal },
        );
      } finally {
        raw.fill(0);
      }
    },
  });
}
