import { vi } from "vitest";
import { QURLClient } from "../client.js";

// Shared test fixtures. Lives under src/__tests__/ so the tsconfig
// exclude pattern (`src/__tests__/**`) keeps everything here out of
// the published build — any helper file added to this directory is
// automatically excluded without a tsconfig edit.

type MockResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function buildResponse(response: MockResponse): Response {
  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    status: response.status,
    // statusText mirrors `ok` (not just status === 200) so 201/204
    // successes don't render as "Error" to assertions that inspect it.
    statusText: ok ? "OK" : "Error",
    headers: new Headers(response.headers ?? {}),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  } satisfies Partial<Response> as Response;
}

export function mockFetch(response: MockResponse): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(buildResponse(response));
}

// Multi-call variant: returns the next response in the sequence on each
// fetch call. Used by the pagination contract case where a single
// response isn't enough to exercise the full loop.
export function mockFetches(responses: MockResponse[]): typeof globalThis.fetch {
  const fn = vi.fn();
  for (const response of responses) {
    fn.mockResolvedValueOnce(buildResponse(response));
  }
  return fn as unknown as typeof globalThis.fetch;
}

export function createClient(fetchFn: typeof globalThis.fetch): QURLClient {
  return new QURLClient({
    apiKey: "lv_live_test",
    baseUrl: "https://api.test.layerv.ai",
    fetch: fetchFn,
    maxRetries: 0,
  });
}
