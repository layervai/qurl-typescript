import { describe, expect, it, vi } from "vitest";
import { QURLClient, getResponseMetadata } from "./index.js";
import { createClient, mockFetch, mockFetches } from "./__tests__/test-helpers.js";
import { RESOURCE_CRID } from "./__tests__/client-fixtures.js";

describe("success response metadata", () => {
  it("does not collide with wire fields or change enumerable/JSON output", async () => {
    const data = { request_id: "business-id", responseMetadata: { requestId: "wire-spoof" } };
    const result = await createClient(
      mockFetch({
        status: 201,
        body: { data, meta: { request_id: "req_actual" } },
      }),
    ).create({ target_url: "https://example.com" });
    expect(getResponseMetadata(result)).toEqual({ requestId: "req_actual" });
    expect(Object.keys(result)).toEqual(Object.keys(data));
    expect(JSON.stringify(result)).toBe(JSON.stringify(data));
    expect(Object.isFrozen(getResponseMetadata(result))).toBe(true);
    expect(getResponseMetadata(JSON.parse(JSON.stringify(result)))).toBeUndefined();
    expect(getResponseMetadata({ request_id: "req_spoof" })).toBeUndefined();
  });

  it.each([undefined, "", "bad\nidentifier", "x".repeat(5000), 42])(
    "does not invent metadata for an absent or invalid id (%j)",
    async (requestId) => {
      const result = await createClient(
        mockFetch({
          status: 200,
          body: { data: { request_id: "wire-only" }, meta: { request_id: requestId } },
        }),
      ).getQuota();
      expect(getResponseMetadata(result)).toBeUndefined();
    },
  );

  it("keeps concurrent calls separate when responses arrive in reverse order", async () => {
    const waiting = new Map<string, (response: Response) => void>();
    const fetch = vi.fn(
      (input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          waiting.set(new URL(String(input)).pathname, resolve);
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createClient(fetch);
    const creating = client.create({ target_url: "https://example.com" });
    const quota = client.getQuota();
    await vi.waitFor(() => expect(waiting.size).toBe(2));
    waiting.get("/v1/quota")!(
      new Response(JSON.stringify({ data: { remaining: 10 }, meta: { request_id: "req_quota" } })),
    );
    await quota;
    waiting.get("/v1/qurls")!(
      new Response(
        JSON.stringify({ data: { resource_id: "owned" }, meta: { request_id: "req_create" } }),
        { status: 201 },
      ),
    );
    expect(getResponseMetadata(await creating)).toEqual({ requestId: "req_create" });
    expect(getResponseMetadata(await quota)).toEqual({ requestId: "req_quota" });
  });

  it("carries each page id onto iterator values", async () => {
    const client = createClient(
      mockFetches([
        {
          status: 200,
          body: {
            data: [{ resource_id: "first", qurls: [] }],
            meta: { request_id: "req_page_1", has_more: true, next_cursor: "next" },
          },
        },
        {
          status: 200,
          body: {
            data: [{ resource_id: "second", qurls: [] }],
            meta: { request_id: "req_page_2", has_more: false },
          },
        },
      ]),
    );
    const values = [];
    for await (const value of client.listAll()) values.push(value);
    expect(values.map((value) => getResponseMetadata(value)?.requestId)).toEqual([
      "req_page_1",
      "req_page_2",
    ]);
    expect(values[0]).toMatchObject({ resource_id: "first", access_tokens: [] });
  });

  it("returns undefined for local handles and no-content results", async () => {
    const client = createClient(mockFetch({ status: 204 }));
    expect(getResponseMetadata(client.resourceByCrid(RESOURCE_CRID))).toBeUndefined();
    expect(getResponseMetadata(await client.delete(RESOURCE_CRID))).toBeUndefined();
    for (const value of [undefined, null, 0, false, "text"])
      expect(getResponseMetadata(value)).toBeUndefined();
  });

  it("exposes the accessor through the browser-safe public entry point", () => {
    expect(QURLClient).toBeTypeOf("function");
    expect(getResponseMetadata).toBeTypeOf("function");
  });
});
