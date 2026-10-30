import { afterEach, describe, expect, it, vi } from "vitest";
import { QURLClient } from "./client.js";
import { mockFetches } from "./__tests__/test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HTTP-date Retry-After", () => {
  it.each([429, 503])("honors a future date on HTTP %s", async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const fetch = mockFetches([
      {
        status,
        headers: { "Retry-After": "Tue, 01 Jan 2030 00:01:00 GMT" },
        body: { error: { code: "unavailable" } },
      },
      { status: 200, body: { data: { plan: "growth" } } },
    ]);
    const pending = new QURLClient({ apiKey: "synthetic-key", fetch, maxRetries: 1 }).getQuota();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).plan).toBe("growth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Mon, 31 Dec 2029 23:59:59 GMT", 0],
    ["Tue, 01 Jan 2030 00:00:00 GMT", 0],
    ["Tue, 01 Jan 2030 02:00:00 GMT", 3_600_000],
    ["not a date", 500],
    ["Tue, 99 Xxx 2030 00:00:00 GMT", 500],
  ])("uses a bounded delay for %s", async (header, expectedDelay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const started = Date.now();
    const fetch = mockFetches([
      {
        status: 429,
        headers: { "Retry-After": header },
        body: { error: { code: "rate_limited" } },
      },
      { status: 200, body: { data: { plan: "growth" } } },
    ]);
    const pending = new QURLClient({ apiKey: "synthetic-key", fetch, maxRetries: 1 }).getQuota();
    await vi.runAllTimersAsync();
    await pending;
    expect(Date.now() - started).toBe(expectedDelay);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
