import { expect, it } from "vitest";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { QURLError } from "./errors.js";

it("exposes retained tombstone metadata on a Gone error", async () => {
  const tombstone = { tombstoned_at: "2026-01-01T00:00:00Z", final_access_count: 42 };
  const error = await createClient(
    mockFetch({
      status: 410,
      body: {
        error: { title: "Gone", code: "resource_tombstoned" },
        meta: { request_id: "req_gone", tombstone },
      },
    }),
  )
    .getQuota()
    .catch((error: unknown) => error as QURLError);
  expect(error).toBeInstanceOf(QURLError);
  expect(error).toMatchObject({ status: 410, requestId: "req_gone", tombstone });
});

it("preserves list page size and request ID", async () => {
  const result = await createClient(
    mockFetch({
      status: 200,
      body: { data: [], meta: { page_size: 17, request_id: "req_list", has_more: false } },
    }),
  ).list();
  expect(result).toMatchObject({
    qurls: [],
    page_size: 17,
    request_id: "req_list",
    has_more: false,
  });
});

it.each([
  null,
  [],
  {},
  { tombstoned_at: 12 },
  { tombstoned_at: "invalid" },
  { tombstoned_at: "x".repeat(1000) },
])("drops malformed tombstone metadata: %j", async (tombstone) => {
  const error = await createClient(
    mockFetch({
      status: 410,
      body: { error: { title: "Gone", code: "gone" }, meta: { tombstone } },
    }),
  )
    .getQuota()
    .catch((error: unknown) => error as QURLError);
  expect(error).toBeInstanceOf(QURLError);
  expect(error).toHaveProperty("tombstone", undefined);
});

it.each([undefined, -1, 0, 1.5, "42", Number.MAX_SAFE_INTEGER + 1])(
  "does not invent or coerce an access count: %j",
  async (count) => {
    const error = await createClient(
      mockFetch({
        status: 410,
        body: {
          error: { title: "Gone", code: "gone" },
          meta: {
            tombstone: {
              tombstoned_at: "2026-01-01T00:00:00Z",
              final_access_count: count,
              secret: "must-not-copy",
            },
          },
        },
      }),
    )
      .getQuota()
      .catch((error: unknown) => error as QURLError);
    expect(error).toHaveProperty("tombstone", { tombstoned_at: "2026-01-01T00:00:00Z" });
  },
);

it("ignores tombstone metadata on non-410 errors", async () => {
  const error = await createClient(
    mockFetch({
      status: 403,
      body: {
        error: { title: "Forbidden", code: "forbidden" },
        meta: { tombstone: { tombstoned_at: "2026-01-01T00:00:00Z", final_access_count: 42 } },
      },
    }),
  )
    .getQuota()
    .catch((error: unknown) => error as QURLError);
  expect(error).toHaveProperty("tombstone", undefined);
});
