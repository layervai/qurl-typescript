import { describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";

function listResponse(): Response {
  return Response.json({ data: [], meta: { has_more: false } });
}

describe("fetch receiver", () => {
  it.each(["default", "injected"])("preserves the global receiver for %s fetch", async (source) => {
    const fetch = vi.fn(function (this: unknown) {
      // Workers reject native fetch when an SDK instance becomes its receiver.
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(listResponse());
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const client = new QURLClient({
        apiKey: "test-key",
        maxRetries: 0,
        ...(source === "injected" ? { fetch } : {}),
      });
      expect((await client.list()).qurls).toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps an explicitly bound custom receiver", async () => {
    const receiver = {};
    const fetch = vi.fn(function (this: unknown) {
      expect(this).toBe(receiver);
      return Promise.resolve(listResponse());
    });
    const client = new QURLClient({ apiKey: "test-key", fetch: fetch.bind(receiver) });
    expect((await client.list()).qurls).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
