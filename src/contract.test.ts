import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { QURLClient } from "./client.js";
import { mockFetch, mockFetches, createClient } from "./__tests__/test-helpers.js";

// API-contract test: every SDK public method must call the exact
// (verb, path) pair declared in contract/openapi.snapshot.yaml.
// Scope and contribution rules live in CONTRIBUTING.md.

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

// HTTP verbs that the SDK uses today. Filters out OpenAPI path-item
// keys that aren't verbs (e.g. `parameters`, `summary`). When the SDK
// grows a method that uses a verb not listed here, add it.
const HTTP_VERBS = new Set<Lowercase<Verb>>(["get", "post", "patch", "delete"]);
const pathTemplates = new Set<string>();
// `spec.paths ?? {}` defends against a malformed snapshot surfacing as
// an unrelated TypeError at module load — without this, the intended
// "snapshot parses and has paths" test below never gets to run.
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const verb of Object.keys(methods ?? {})) {
    if (HTTP_VERBS.has(verb as Lowercase<Verb>)) {
      pathTemplates.add(`${verb.toUpperCase()} ${path}`);
    }
  }
}

// Escape regex metacharacters in a literal string so it can be embedded
// in a larger regex safely. Covers the full metacharacter set including
// `*` (quantifier) and `-` (significant inside char classes).
function regexEscape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// `/v1/qurls/{id}` → `^/v1/qurls/[^/]+$`. Regex-escape the literal,
// then un-escape and widen `{param}` segments into single-segment
// wildcards. Anchored so `/v1/qurls` does not also match `/v1/qurls/{id}`.
// Single-segment widening (`[^/]+` not `.+`) is intentional —
// `/v1/qurls/{id}/mint_link` must match `/v1/qurls/abc/mint_link` but
// NOT `/v1/qurls/abc/def/mint_link`, which would be a different
// (and unintended) endpoint.
function templateRegex(pathTemplate: string): RegExp {
  const escaped = regexEscape(pathTemplate).replace(/\\\{[^}]+\\\}/g, "[^/]+");
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
  const actualVerb = (init as RequestInit).method as Verb | undefined;
  if (!actualVerb) {
    throw new Error(
      `SDK called fetch without a method in init; cannot verify. ` +
        `Expected ${expectedVerb} ${expectedTemplate}.`,
    );
  }
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

// Single source of truth for the contract-covered methods. Each entry
// is one SDK public method → the (verb, template) it must call + a
// minimal invocation. `it.each` drives the standard per-method check
// off this array, and the two coverage tests below do pure set-diffs
// against it — no test-file source parsing, no module-level mutable
// state, no test-order coupling.
//
// Aliases (`listAll` wraps `list`, `extend` wraps `update`) get their
// own entries so an alias rewire can't silently slip past.
type MethodCase = {
  method: string;
  verb: Verb;
  template: string;
  mockBody?: unknown;
  invoke: (c: QURLClient) => Promise<unknown>;
};

const METHOD_CASES: MethodCase[] = [
  {
    method: "create",
    verb: "POST",
    template: "/v1/qurls",
    mockBody: { data: { resource_id: "r_x", qurl_link: "https://qurl.link/#at_y" } },
    invoke: (c) => c.create({ target_url: "https://example.com" }),
  },
  {
    method: "get",
    verb: "GET",
    template: "/v1/qurls/{id}",
    mockBody: { data: { resource_id: "r_x" } },
    invoke: (c) => c.get("r_x"),
  },
  {
    method: "list",
    verb: "GET",
    template: "/v1/qurls",
    mockBody: { data: [], meta: { has_more: false } },
    invoke: (c) => c.list(),
  },
  {
    method: "listAll",
    verb: "GET",
    template: "/v1/qurls",
    mockBody: { data: [], meta: { has_more: false } },
    invoke: async (c) => {
      const iter = c.listAll();
      while (!(await iter.next()).done) {
        /* no-op */
      }
    },
  },
  {
    method: "update",
    verb: "PATCH",
    template: "/v1/qurls/{id}",
    mockBody: { data: { resource_id: "r_x" } },
    invoke: (c) => c.update("r_x", { expires_in: "24h" }),
  },
  {
    method: "extend",
    verb: "PATCH",
    template: "/v1/qurls/{id}",
    mockBody: { data: { resource_id: "r_x" } },
    invoke: (c) => c.extend("r_x", { expires_in: "24h" }),
  },
  {
    method: "delete",
    verb: "DELETE",
    template: "/v1/qurls/{id}",
    mockBody: undefined,
    invoke: (c) => c.delete("r_x"),
  },
  {
    method: "mintLink",
    verb: "POST",
    template: "/v1/qurls/{id}/mint_link",
    mockBody: { data: { qurl_link: "https://qurl.link/#at_y" } },
    invoke: (c) => c.mintLink("r_x"),
  },
  {
    method: "resolve",
    verb: "POST",
    template: "/v1/resolve",
    mockBody: { data: { target_url: "https://example.com" } },
    invoke: (c) => c.resolve("at_y"),
  },
  {
    method: "getQuota",
    verb: "GET",
    template: "/v1/quota",
    mockBody: { data: { plan: "free" } },
    invoke: (c) => c.getQuota(),
  },
];

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

  it("METHOD_CASES covers every QURLClient public method (completeness)", () => {
    // Walks QURLClient.prototype — catches every instance method
    // defined with the `method() {}` form. Does NOT catch static
    // methods, arrow-function class properties, or symbol-keyed
    // methods (`Object.getOwnPropertyNames` ignores symbols). None
    // of those patterns exist in client.ts today.
    const prototypeMethods = Object.getOwnPropertyNames(QURLClient.prototype).filter((name) => {
      if (NON_API_PROTOTYPE_METHODS.has(name) || INTERNAL_HELPERS.has(name)) return false;
      const desc = Object.getOwnPropertyDescriptor(QURLClient.prototype, name);
      return typeof desc?.value === "function";
    });
    const publicMethods = new Set(prototypeMethods);
    const testedMethods = new Set(METHOD_CASES.map((c) => c.method));

    const missingFromCases = [...publicMethods].filter((m) => !testedMethods.has(m));
    const missingFromPrototype = [...testedMethods].filter((m) => !publicMethods.has(m));
    if (missingFromCases.length || missingFromPrototype.length) {
      throw new Error(
        `Contract drift:\n` +
          (missingFromCases.length
            ? `  New public method(s) on QURLClient.prototype: ${missingFromCases.join(", ")}\n` +
              `    → add a METHOD_CASES entry (and the snapshot entry if it's a new endpoint), ` +
              `OR add to INTERNAL_HELPERS if not a user-facing API call.\n`
            : "") +
          (missingFromPrototype.length
            ? `  Listed in METHOD_CASES but missing from prototype: ${missingFromPrototype.join(", ")}\n` +
              `    → either the method was removed/renamed in client.ts, or the name here is wrong.\n`
            : ""),
      );
    }
  });

  it("METHOD_CASES covers every snapshot template (coverage)", () => {
    // Catches the reverse drift direction: an orphaned snapshot entry
    // that no test exercises (e.g., a method was removed from
    // client.ts without trimming the yaml).
    const testedTemplates = new Set(METHOD_CASES.map((c) => `${c.verb} ${c.template}`));
    const uncovered = [...pathTemplates].filter((t) => !testedTemplates.has(t));
    if (uncovered.length > 0) {
      throw new Error(
        `Snapshot entries not exercised by METHOD_CASES: ${uncovered.join(", ")}. ` +
          `Either add a METHOD_CASES entry that asserts each, or remove the entry ` +
          `from contract/openapi.snapshot.yaml if the SDK no longer uses it.`,
      );
    }
  });

  // Table-driven case for each method in METHOD_CASES. vitest's `%s`
  // placeholders fill in from the table entry's string/verb/template
  // fields so the test title still reads as
  // `create → POST /v1/qurls`.
  it.each(METHOD_CASES)(
    "$method → $verb $template",
    async ({ mockBody, verb, template, invoke }) => {
      const fetch = mockOk(mockBody);
      await invoke(createClient(fetch));
      assertSdkCallMatches(fetch, verb, template);
    },
  );

  // Bespoke cases — variations that don't fit the one-call shape of
  // METHOD_CASES, or assert behavior beyond a single (verb, path).

  it("list with query params → GET /v1/qurls (query stripped)", async () => {
    const fetch = mockOk({ data: [], meta: { has_more: false } });
    await createClient(fetch).list({ limit: 10, cursor: "c" });
    assertSdkCallMatches(fetch, "GET", "/v1/qurls");
  });

  it("listAll multi-page → every page hits GET /v1/qurls", async () => {
    // Two-page mock covers the pagination path — a single-page exit
    // would not exercise that every subsequent fetch also targets the
    // same endpoint.
    const fetch = mockFetches([
      { status: 200, body: { data: [], meta: { has_more: true, next_cursor: "c2" } } },
      { status: 200, body: { data: [], meta: { has_more: false } } },
    ]);
    const iter = createClient(fetch).listAll();
    while (!(await iter.next()).done) {
      /* no-op */
    }
    assertSdkCallMatches(fetch, "GET", "/v1/qurls", 0);
    assertSdkCallMatches(fetch, "GET", "/v1/qurls", 1);
    // Pin exact call count — a listAll regression that looped forever
    // would trip mockFetches's exhaustion throw; this catches the
    // other direction (under-call: generator exits early).
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });

  it("resolve (object arg) → POST /v1/resolve", async () => {
    // resolve() overloads: string token OR ResolveInput object. The
    // METHOD_CASES entry covers the string form; this locks the
    // object form to the same endpoint so a dispatch regression
    // can't slip past.
    const fetch = mockOk({ data: { target_url: "https://example.com" } });
    await createClient(fetch).resolve({ access_token: "at_y" });
    assertSdkCallMatches(fetch, "POST", "/v1/resolve");
  });

  // Anti-vacuous-pass guards — validate the helper itself so a
  // regression can't leave it silently passing on bad inputs.

  it("negative: expected template must exist in snapshot", async () => {
    const fetch = mockOk({ data: { plan: "free" } });
    await createClient(fetch).getQuota();
    expect(() => assertSdkCallMatches(fetch, "GET", "/v1/definitely-not-a-real-endpoint")).toThrow(
      /is not in the snapshot/,
    );
  });

  it("negative: single-segment widening does NOT collide across templates", () => {
    // If anyone ever loosened `[^/]+` to `.+` in templateRegex, the
    // list template would swallow the get path and this check fires.
    expect(templateRegex("/v1/qurls").test("/v1/qurls/r_x")).toBe(false);
    expect(templateRegex("/v1/qurls/{id}").test("/v1/qurls/r_x/mint_link")).toBe(false);
    // Positive sanity.
    expect(templateRegex("/v1/qurls").test("/v1/qurls")).toBe(true);
    expect(templateRegex("/v1/qurls/{id}").test("/v1/qurls/r_x")).toBe(true);
  });

  it("negative: SDK call to a different (but spec-valid) path fails", async () => {
    // If create() ever typo'd to POST /v1/resolve it would be a
    // spec-valid endpoint but the wrong contract. Membership-only
    // checks would pass; the per-template layer-2 check must fail.
    //
    // The error-string regex below is intentionally strict — a copy
    // edit to assertSdkCallMatches's error message breaks this test,
    // forcing a reviewer to re-confirm the message is still
    // operator-actionable. If you edit that message, update this
    // regex too.
    const fetch = mockOk({ data: { target_url: "https://example.com" } });
    await createClient(fetch).resolve("at_y"); // actually calls POST /v1/resolve
    expect(() => assertSdkCallMatches(fetch, "POST", "/v1/qurls")).toThrow(
      /SDK called POST \/v1\/resolve, expected POST \/v1\/qurls/,
    );
  });
});
