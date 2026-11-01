import { expect, vi } from "vitest";

export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TARGET_PATH_MAX_LENGTH = 2048;

export const PUBLIC_RESOURCE_ID =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";

export const RESOURCE_CRID = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";

export const SENSITIVE_ACCESS_TOKEN = "at_sensitive-token-value";

export const RESPONSE_BODY_LIMIT = 1 << 20;

export function sizedJSON(prefix: string, suffix: string, size: number): string {
  const paddingLength =
    size -
    new TextEncoder().encode(prefix).byteLength -
    new TextEncoder().encode(suffix).byteLength;
  if (paddingLength < 0) throw new Error("JSON framing exceeds requested test size");
  const body = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
  expect(new TextEncoder().encode(body).byteLength).toBe(size);
  return body;
}

export function sizedMultibyteJSON(prefix: string, suffix: string, size: number): string {
  const framingBytes =
    new TextEncoder().encode(prefix).byteLength + new TextEncoder().encode(suffix).byteLength;
  const paddingBytes = size - framingBytes;
  if (paddingBytes < 0) throw new Error("JSON framing exceeds requested test size");
  const body = `${prefix}${"€".repeat(Math.floor(paddingBytes / 3))}${"x".repeat(
    paddingBytes % 3,
  )}${suffix}`;
  expect(new TextEncoder().encode(body).byteLength).toBe(size);
  return body;
}

export const CONNECTOR_RESOURCE_ID =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";

export const NON_P256_CONNECTOR_RESOURCE_ID = btoa(String.fromCharCode(...new Uint8Array(91)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

export const OFF_CURVE_CONNECTOR_RESOURCE_ID =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7VDGkLaZfQLKvxScAKGCA1Y3p6jNG6d0f66a4Wib8NP8CRZJoEm1jRQej5f0aRzejaH5N7ChvQkiISohN2KVOQ";

export const CONNECTOR_ROUTING_ID = "c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function connectorResourceData(overrides: Record<string, unknown> = {}) {
  return {
    resource_id: CONNECTOR_RESOURCE_ID,
    crid: "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
    connector_routing_id: CONNECTOR_ROUTING_ID,
    knock_resource_id: "asp-resource-1",
    type: "tunnel",
    status: "active",
    slug: "prod-dashboard",
    alias: "dashboard-display-name",
    desired_state: "on",
    serving_epoch: 7,
    ...overrides,
  };
}

export function callHeaders(
  fetch: typeof globalThis.fetch | ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls[callIndex][1].headers as Record<
    string,
    string
  >;
}
