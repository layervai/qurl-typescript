import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { QURLClient } from "./client.js";
import { mockFetch, createClient } from "./test-helpers.js";

// Contract test: every SDK public method must call the exact (verb,
// path) pair declared in contract/openapi.snapshot.yaml. Catches two
// failure modes:
//   1. SDK calls a path that isn't in the snapshot — either the SDK
//      is wrong, or the upstream contract changed and the snapshot
//      needs updating.
//   2. SDK calls a DIFFERENT but spec-valid path (e.g. create()
//      accidentally typo'd to POST /v1/resolve). Membership-only
//      checks would miss this; the per-test expected-template
//      assertion catches it.
//
// The snapshot is hand-curated to only the operations this SDK
// exercises — intentionally NOT vendoring the upstream spec.

type Verb = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type OpenApiSpec = {
  paths: Record<string, Partial<Record<Lowercase<Verb>, unknown>>>;
};

const snapshotPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contract",
  "openapi.snapshot.yaml",
);
const spec = parseYaml(readFileSync(snapshotPath, "utf8")) as OpenApiSpec;

// OpenAPI allows non-verb keys (`summary`, `description`, `parameters`,
// `servers`, `$ref`) at the path-item level. Filter against the verb
// allowlist so those never leak into pathTemplates as entries like
// `PARAMETERS /v1/…`. The SDK only uses these five verbs; HEAD/OPTIONS/
// TRACE are deliberately omitted — add them here if the SDK grows a
// method that uses them.
const HTTP_VERBS = new Set<Lowercase<Verb>>(["get", "post", "patch", "put", "delete"]);
const pathTemplates = new Set<string>();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const verb of Object.keys(methods ?? {})) {
    if (HTTP_VERBS.has(verb as Lowercase<Verb>)) {
      pathTemplates.add(`${verb.toUpperCase()} ${path}`);
    }
  }
}

// `/v1/qurls/{id}` → `^/v1/qurls/[^/]+$`. Regex-escape the literal,
// then un-escape and widen the `{param}` segments into single-segment
// wildcards. Anchored so `/v1/qurls` does not also match `/v1/qurls/{id}`.
// Single-segment widening (`[^/]+` not `.+`) is intentional —
// `/v1/qurls/{id}/mint_link` must match `/v1/qurls/abc/mint_link` but
// NOT `/v1/qurls/abc/def/mint_link`, which would be a different
// (and unintended) endpoint.
function templateRegex(pathTemplate: string): RegExp {
  const escaped = pathTemplate
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function assertSdkCallMatches(
  fetchFn: typeof globalThis.fetch,
  expectedVerb: Verb,
  expectedTemplate: string,
  callIndex: number = 0,
): void {
  const calls = vi.mocked(fetchFn).mock.calls;
  if (calls.length <= callIndex) {
    throw new Error(
      `SDK made ${calls.length} fetch call(s); expected at least ${callIndex + 1} ` +
        `(looking for ${expectedVerb} ${expectedTemplate})`,
    );
  }
  const [rawUrl, init] = calls[callIndex];
  if (!init) {
    throw new Error(
      `SDK called fetch without an init object; cannot verify method. ` +
        `Expected ${expectedVerb} ${expectedTemplate}.`,
    );
  }
  if (typeof rawUrl !== "string") {
    throw new Error(
      `SDK called fetch with a ${typeof rawUrl}; contract test expects a string URL. ` +
        `Expected ${expectedVerb} ${expectedTemplate}.`,
    );
  }
  const actualVerb = (init as RequestInit).method as Verb;
  const actualPath = new URL(rawUrl).pathname;

  // Layer 1: spec must declare the (verb, template) the test expects.
  const templateKey = `${expectedVerb} ${expectedTemplate}`;
  if (!pathTemplates.has(templateKey)) {
    throw new Error(
      `Expected (verb, path) "${templateKey}" is not in the snapshot. ` +
        `Either the SDK is wrong, or the upstream API changed — in which ` +
        `case update contract/openapi.snapshot.yaml to match.`,
    );
  }

  // Layer 2: SDK must have actually called that specific template.
  if (actualVerb !== expectedVerb || !templateRegex(expectedTemplate).test(actualPath)) {
    throw new Error(
      `SDK called ${actualVerb} ${actualPath}, expected ${expectedVerb} ${expectedTemplate}.`,
    );
  }
}

const mockOk = (body: unknown = { data: {}, meta: {} }): typeof globalThis.fetch =>
  mockFetch({ status: 200, body });

const client = createClient;

// Hardcoded expected public API surface. Kept in lockstep with the
// `it()` blocks below AND with QURLClient's prototype — two separate
// completeness tests enforce each direction. Adding a new public
// method without extending this set (and writing a contract case)
// fails CI.
const SDK_PUBLIC_METHODS: ReadonlySet<string> = new Set([
  "create",
  "get",
  "list",
  "listAll",
  "update",
  "extend",
  "delete",
  "mintLink",
  "resolve",
  "getQuota",
]);

// `toJSON` is a diagnostic helper (used by console.log/JSON.stringify),
// not an API call — intentionally outside the contract set.
const NON_API_PROTOTYPE_METHODS: ReadonlySet<string> = new Set(["constructor", "toJSON"]);

// Internal helpers on the prototype. TypeScript's `private`/`protected`
// keywords erase at runtime, so visibility isn't introspectable —
// this deny-list IS the classification. Anything added here must be
// genuinely internal.
const INTERNAL_HELPERS: ReadonlySet<string> = new Set([
  "request",
  "rawRequest",
  "maskKey",
  "log",
  "parseError",
  "parseRetryAfter",
  "retryDelay",
  "classifyFetchError",
]);

describe("API contract", () => {
  it("snapshot parses and has paths", () => {
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    expect(pathTemplates.size).toBeGreaterThan(0);
  });

  it("SDK public methods match the contract-covered set (completeness)", () => {
    const prototypeMethods = Object.getOwnPropertyNames(QURLClient.prototype).filter((name) => {
      if (NON_API_PROTOTYPE_METHODS.has(name) || INTERNAL_HELPERS.has(name)) return false;
      const desc = Object.getOwnPropertyDescriptor(QURLClient.prototype, name);
      return typeof desc?.value === "function";
    });
    const actual = new Set(prototypeMethods);
    const missingFromSet = [...actual].filter((m) => !SDK_PUBLIC_METHODS.has(m));
    const missingFromPrototype = [...SDK_PUBLIC_METHODS].filter((m) => !actual.has(m));
    if (missingFromSet.length || missingFromPrototype.length) {
      throw new Error(
        `Contract set drift:\n` +
          (missingFromSet.length
            ? `  New public method(s) on QURLClient.prototype: ${missingFromSet.join(", ")}\n` +
              `    → add to SDK_PUBLIC_METHODS and add an it("…") case, ` +
              `OR add to INTERNAL_HELPERS if not a user-facing API call.\n`
            : "") +
          (missingFromPrototype.length
            ? `  Listed in SDK_PUBLIC_METHODS but missing from prototype: ${missingFromPrototype.join(", ")}\n` +
              `    → either the method was removed/renamed in client.ts, or the name here is wrong.\n`
            : ""),
      );
    }
  });

  // Parse this test file's own source and assert every method in
  // SDK_PUBLIC_METHODS has at least one `it("<method>…"` declaration.
  // Lookahead for whitespace or `(` distinguishes `list` from `listAll`.
  // Brittle against `test(…)` or `it.only(…)` or wrapping the body in
  // another `describe`; the failure mode is loud (false negative,
  // forces a reviewer to rename or adjust the regex).
  it("every SDK_PUBLIC_METHOD has an it() case (test-file coverage)", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const missing: string[] = [];
    for (const method of SDK_PUBLIC_METHODS) {
      const escaped = method.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\bit\\("${escaped}(?=[\\s("])`);
      if (!re.test(src)) missing.push(method);
    }
    if (missing.length > 0) {
      throw new Error(
        `SDK_PUBLIC_METHODS listed but no matching it("<method>…") found: ` +
          `${missing.join(", ")}. Add a contract case for each.`,
      );
    }
  });

  // Each SDK public method → one call → captured (verb, url) must
  // match the exact (verb, template). Aliases (`listAll` wraps `list`,
  // `extend` wraps `update`) get their own cases — a future alias
  // rewire would otherwise silently slip past.

  it("create → POST /v1/qurls", async () => {
    const fetch = mockOk({
      data: { resource_id: "r_x", qurl_link: "https://qurl.link/#at_y" },
    });
    await client(fetch).create({ target_url: "https://example.com" });
    assertSdkCallMatches(fetch, "POST", "/v1/qurls");
  });

  it("get → GET /v1/qurls/{id}", async () => {
    const fetch = mockOk({ data: { resource_id: "r_x" } });
    await client(fetch).get("r_x");
    assertSdkCallMatches(fetch, "GET", "/v1/qurls/{id}");
  });

  it("list → GET /v1/qurls", async () => {
    const fetch = mockOk({ data: [], meta: { has_more: false } });
    await client(fetch).list();
    assertSdkCallMatches(fetch, "GET", "/v1/qurls");
  });

  it("list with query params → GET /v1/qurls (query stripped)", async () => {
    const fetch = mockOk({ data: [], meta: { has_more: false } });
    await client(fetch).list({ limit: 10, cursor: "c" });
    assertSdkCallMatches(fetch, "GET", "/v1/qurls");
  });

  it("listAll → GET /v1/qurls (via wrapped list)", async () => {
    const fetch = mockOk({ data: [], meta: { has_more: false } });
    // Drive the generator to completion so the underlying list() fires.
    const iter = client(fetch).listAll();
    while (!(await iter.next()).done) {
      /* no-op */
    }
    assertSdkCallMatches(fetch, "GET", "/v1/qurls");
  });

  it("listAll multi-page → every page hits GET /v1/qurls", async () => {
    // Two-page mock covers the pagination path — a single-page exit
    // would not exercise that every subsequent fetch also targets the
    // same endpoint.
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ data: [], meta: { has_more: true, next_cursor: "c2" } }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ data: [], meta: { has_more: false } }),
        text: async () => "",
      })) as unknown as typeof globalThis.fetch;
    const iter = client(fetch).listAll();
    while (!(await iter.next()).done) {
      /* no-op */
    }
    assertSdkCallMatches(fetch, "GET", "/v1/qurls", 0);
    assertSdkCallMatches(fetch, "GET", "/v1/qurls", 1);
  });

  it("update → PATCH /v1/qurls/{id}", async () => {
    const fetch = mockOk({ data: { resource_id: "r_x" } });
    await client(fetch).update("r_x", { expires_in: "24h" });
    assertSdkCallMatches(fetch, "PATCH", "/v1/qurls/{id}");
  });

  it("extend → PATCH /v1/qurls/{id} (alias of update)", async () => {
    const fetch = mockOk({ data: { resource_id: "r_x" } });
    await client(fetch).extend("r_x", { expires_in: "24h" });
    assertSdkCallMatches(fetch, "PATCH", "/v1/qurls/{id}");
  });

  it("delete → DELETE /v1/qurls/{id}", async () => {
    const fetch = mockOk();
    await client(fetch).delete("r_x");
    assertSdkCallMatches(fetch, "DELETE", "/v1/qurls/{id}");
  });

  it("mintLink → POST /v1/qurls/{id}/mint_link", async () => {
    const fetch = mockOk({ data: { qurl_link: "https://qurl.link/#at_y" } });
    await client(fetch).mintLink("r_x");
    assertSdkCallMatches(fetch, "POST", "/v1/qurls/{id}/mint_link");
  });

  it("resolve (string arg) → POST /v1/resolve", async () => {
    const fetch = mockOk({ data: { target_url: "https://example.com" } });
    await client(fetch).resolve("at_y");
    assertSdkCallMatches(fetch, "POST", "/v1/resolve");
  });

  it("resolve (object arg) → POST /v1/resolve", async () => {
    // resolve() overloads: string token OR ResolveInput object. Both
    // must hit the same endpoint; a regression where the object form
    // dispatched elsewhere would otherwise slip past the string case.
    const fetch = mockOk({ data: { target_url: "https://example.com" } });
    await client(fetch).resolve({ access_token: "at_y" });
    assertSdkCallMatches(fetch, "POST", "/v1/resolve");
  });

  it("getQuota → GET /v1/quota", async () => {
    const fetch = mockOk({ data: { plan: "free" } });
    await client(fetch).getQuota();
    assertSdkCallMatches(fetch, "GET", "/v1/quota");
  });

  // Anti-vacuous-pass guards. These validate the two failure modes
  // the helper is designed to catch — if either regresses, this trips.

  it("negative: expected template must exist in snapshot", async () => {
    const fetch = mockOk({ data: { plan: "free" } });
    await client(fetch).getQuota();
    expect(() => assertSdkCallMatches(fetch, "GET", "/v1/definitely-not-a-real-endpoint")).toThrow(
      /is not in the snapshot/,
    );
  });

  it("negative: SDK call to a different (but spec-valid) path fails", async () => {
    // If create() ever typo'd to POST /v1/resolve it would be a
    // spec-valid endpoint but the wrong contract. The helper must
    // catch this — membership-only checks silently would not.
    //
    // The error-string regex below is intentionally strict so that
    // a copy edit to assertSdkCallMatches's error message breaks
    // this test, forcing a reviewer to re-confirm the message is
    // still operator-actionable. If you edit that message, update
    // this regex too.
    const fetch = mockOk({ data: { target_url: "https://example.com" } });
    await client(fetch).resolve("at_y"); // actually calls POST /v1/resolve
    expect(() => assertSdkCallMatches(fetch, "POST", "/v1/qurls")).toThrow(
      /SDK called POST \/v1\/resolve, expected POST \/v1\/qurls/,
    );
  });
});
