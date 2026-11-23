import { canonicalKey, exactObject } from "./agent-state.js";
import { parseStrictJson } from "./strict-json.js";

// COK's outer counter is not correlated; its authenticated body.trxId is.
export function consumeCookieChallenge(body: Uint8Array, requestCounter: bigint): Buffer {
  try {
    const challenge = exactObject(
      parseStrictJson(body, 4096, (_object, key, raw) => {
        if (key === "cookie" && raw.includes("\\")) throw new Error("invalid NHP cookie encoding");
      }),
      "trxId cookie",
    );
    const transaction =
      typeof challenge.trxId === "number" && Number.isSafeInteger(challenge.trxId)
        ? BigInt(challenge.trxId)
        : challenge.trxId;
    if (transaction !== requestCounter)
      throw new Error("NHP cookie transaction does not match the request");
    return canonicalKey(challenge.cookie);
  } finally {
    body.fill(0);
  }
}
