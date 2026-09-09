import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AgentStateError,
  decodeAgentState,
  encodeAgentState,
  type AgentStateStore,
} from "@layervai/qurl/node";
import { lockedStore, errorNamed } from "./store.js";
import { randomUUID } from "node:crypto";

export function createSecretsManagerAgentStateStore(
  client: SecretsManagerClient,
  secretID: string,
  kmsKeyID?: string,
): AgentStateStore {
  secretID = secretID.trim();
  if (!client || !secretID) throw new AgentStateError("INVALID_SECRETS_MANAGER_CONFIGURATION");
  return lockedStore({
    async load(signal) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await client.send(new GetSecretValueCommand({ SecretId: secretID }), {
          abortSignal: signal,
        });
      } catch (error) {
        if (errorNamed(error, "ResourceNotFoundException")) throw new AgentStateError("NOT_FOUND");
        throw error;
      }
      if (typeof result.SecretString !== "string") throw new AgentStateError("INVALID_STATE");
      const raw = Buffer.from(result.SecretString);
      try {
        return decodeAgentState(raw);
      } finally {
        raw.fill(0);
      }
    },
    async save(state, signal) {
      signal?.throwIfAborted();
      const raw = encodeAgentState(state);
      const token = randomUUID();
      try {
        if (raw.length > 65536) throw new AgentStateError("SECRETS_MANAGER_SIZE_LIMIT");
        const SecretString = raw.toString();
        try {
          await client.send(
            new PutSecretValueCommand({
              SecretId: secretID,
              SecretString,
              ClientRequestToken: token,
            }),
            { abortSignal: signal },
          );
        } catch (error) {
          if (!errorNamed(error, "ResourceNotFoundException")) throw error;
          if (secretID.startsWith("arn:")) throw new AgentStateError("SECRET_MUST_EXIST");
          try {
            await client.send(
              new CreateSecretCommand({
                Name: secretID,
                SecretString,
                ClientRequestToken: token,
                KmsKeyId: kmsKeyID,
              }),
              { abortSignal: signal },
            );
          } catch (creation) {
            if (!errorNamed(creation, "ResourceExistsException")) throw creation;
            await client.send(
              new PutSecretValueCommand({
                SecretId: secretID,
                SecretString,
                ClientRequestToken: token,
              }),
              { abortSignal: signal },
            );
          }
        }
      } finally {
        raw.fill(0);
      }
    },
  });
}
