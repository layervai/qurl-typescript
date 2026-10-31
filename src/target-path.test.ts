import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import conformance from "@layervai/qurl-conformance";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";

type PathCase = { name: string; present: boolean; value?: string; outcome: "accept" | "reject" };
const artifact = conformance.targetPathV1Vectors() as {
  contract: { max_bytes: number; wire_field: string };
  cases: PathCase[];
};
const CRID = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const DATA = {
  resource_id:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
  crid: CRID,
  qurl_link: "https://qurl.link/#at_path",
};

it("pins the same released target-path bytes used by qurl-go", () => {
  const require = createRequire(import.meta.url);
  const raw = readFileSync(
    require.resolve("@layervai/qurl-conformance/target_path_v1_vectors.json"),
  );
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "898e5bf24c825bbd57426fe799d71893951c5735b6cd15e9b95d436981b09a97",
  );
  expect(artifact.contract).toMatchObject({ max_bytes: 2048, wire_field: "target_path" });
  expect(artifact.cases).toHaveLength(119);
});

describe.each(["client", "handle", "rest"] as const)("target-path vectors through %s", (method) => {
  it.each(artifact.cases)("$name", async (tc) => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { ...DATA, ...(tc.present ? { target_path: tc.value } : {}) } },
    });
    const client = createClient(fetch);
    const opts = tc.present ? { targetPath: tc.value! } : {};
    const invoke = () =>
      method === "client"
        ? client.createPortal(CRID, opts)
        : method === "handle"
          ? client.resourceByCrid(CRID).createPortal(opts)
          : client.createQurlForResource(CRID, tc.present ? { target_path: tc.value! } : {});
    if (tc.outcome === "reject") {
      await expect(invoke()).rejects.toMatchObject({ code: "client_validation" });
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    const result = await invoke();
    expect(Reflect.get(result, method === "rest" ? "target_path" : "targetPath")).toBe(tc.value);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/v1/resources/${CRID}/qurls`);
    const body = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>;
    expect(Object.hasOwn(body, "target_path")).toBe(tc.present);
    expect(body.target_path).toBe(tc.value);
  });
});

it.each([
  ["missing", undefined],
  ["null", null],
  ["empty", ""],
  ["different", "/sibling"],
  ["noncanonical", "/view/../file"],
  ["wrong type", 1],
])(
  "rejects a %s recorded scope without replay and keeps correlation",
  async (_name, targetPath) => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { ...DATA, target_path: targetPath }, meta: { request_id: "req_scope" } },
    });
    await expect(
      createClient(fetch).createPortal(CRID, { targetPath: "/view/file" }),
    ).rejects.toMatchObject({
      code: "unexpected_response",
      requestId: "req_scope",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each(["existing", "url"])(
  "rejects an unexpected scope for an unscoped %s portal",
  async (kind) => {
    const fetch = mockFetch({
      status: 201,
      body: { data: { ...DATA, target_path: "/view/file" } },
    });
    const client = createClient(fetch);
    await expect(
      kind === "url" ? client.createPortalForUrl("https://example.com") : client.createPortal(CRID),
    ).rejects.toMatchObject({ code: "unexpected_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
