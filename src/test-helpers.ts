import { vi } from "vitest";
import { QURLClient } from "./client.js";

// Shared test fixtures used by client.test.ts and contract.test.ts.
// Keep this file test-only — tsconfig excludes *.test.ts but NOT
// test-helpers.ts, so it would otherwise land in dist/. Filename +
// tsconfig exclude in lockstep: if you rename this, update the
// exclude pattern.

export function mockFetch(response: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.status === 200 ? "OK" : "Error",
    headers: new Headers(response.headers ?? {}),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  } satisfies Partial<Response> as Response);
}

export function createClient(fetchFn: typeof globalThis.fetch): QURLClient {
  return new QURLClient({
    apiKey: "lv_live_test",
    baseUrl: "https://api.test.layerv.ai",
    fetch: fetchFn,
    maxRetries: 0,
  });
}
