# Contributing

Thanks for your interest in contributing to `@layervai/qurl`!

## Development Setup

```bash
git clone https://github.com/layervai/qurl-typescript.git
cd qurl-typescript
npm install
```

## Running Checks

```bash
npm run build          # Compile TypeScript (ESM + CJS)
npm test               # Run tests (vitest)
npm run check:fixtures # Reject secret-shaped fixture literals
npm run smoke:dist     # Verify the built ESM and CJS entry points load
npm run format:check   # Check formatting (prettier)
npx eslint src/        # Lint
```

All must pass before submitting a PR.

Use `test-api-key` in fixtures and `YOUR_API_KEY` in examples. The fixture guard
checks every tracked text file for literal qURL live/test key prefixes followed
by a value. It prints file names only. There are no file or line exemptions.
The external-identity response contract requires a valid key shape; its two
fixtures explicitly construct a repeated `a` value and matching short prefix.
Keep that synthetic construction in those contract fixtures; do not copy a
credential-shaped literal. This guard complements the verified-secret scanner;
it does not detect every provider or high-entropy secret.

## Dual Build (ESM + CJS)

The package emits two builds from one source tree:

- `tsconfig.json` → `dist/esm/` (ESM, `module: Node16`)
- `tsconfig.cjs.json` → `dist/cjs/` (CJS, `module: CommonJS`)

`scripts/postbuild.mjs` drops a `package.json` sidecar into each output
directory so Node resolves the emitted `.js` files as the right format
regardless of the root `"type"` field. The package's `exports` field
points each condition (`import`, `require`) at its matching build, with
per-condition `types` so `moduleResolution: Node16` consumers get the
right `.d.ts`.

`smoke/cjs.cjs` and `smoke/esm.mjs` self-reference `@layervai/qurl` and
exercise both entry points end-to-end; `smoke/parity.mjs` additionally
asserts both builds export the same runtime name set. CI runs all three
after the build. These are the load-bearing checks that the consumer-
facing surface still loads — don't skip them when changing build
configuration.

**`npm run dev` only watches the ESM build.** Both configs share
everything except `module`/`moduleResolution`/`outDir`, so a CJS-only
break is unlikely, but run `npm run build` before publishing any
build-config change to confirm both trees still compile.

**Avoid module-scope mutable state** (caches, singletons, `WeakMap`
registries). A mixed-dependency tree can load both `dist/esm/index.js`
and `dist/cjs/index.js` as separate module instances — `instanceof`
checks across the boundary would fail and any shared state would
diverge. Classes and plain constants are safe; only flag state added
at module scope is the hazard.

## TypeScript Toolchain (TS 7 + TS 6 side-by-side)

Two TypeScript versions are installed, both under npm aliases:

- `@typescript/native` → `npm:typescript@^7.0.2` — TypeScript 7, the
  native compiler. Provides the `tsc` binary that `npm run build` and
  `npm run dev` invoke.
- `typescript` → `npm:@typescript/typescript6@^6.0.2` — the TypeScript 6
  API that `require("typescript")` resolves to.

The split exists because typescript-eslint does not support TS 7. The
plugin hard-throws `typescript-eslint does not support TS 7.0` at load
time whenever `require("typescript").versionMajorMinor` is `>= 7`, and
`@typescript-eslint/parser` declares `typescript: ">=4.8.4 <6.1.0"` as a
peer dependency. Pointing the bare `typescript` specifier at the TS 6
API is the arrangement upstream recommends until typescript-eslint
supports TS >= 7.1 ([typescript-eslint#10940][tse-10940]). Note that our
lint config is not type-aware — no `project`/`projectService` in
`parserOptions` — so TS 6 here only parses; it never type-checks.

Both packages ship a `tsc` binary. npm resolves that collision in favor
of `@typescript/native`, so bare `tsc` is TS 7 — `npx tsc --version`
confirms it. The TS 6 compiler stays reachable at
`./node_modules/typescript/bin/tsc` if you need to compare emit.

For this source tree the two compilers emit byte-identical `.js` and
`.d.ts`. They differ only in the `mappings` field of the ESM
`.js.map`/`.d.ts.map` (constructor positions); `sources`, `names`, and
`file` are unchanged. The CJS config sets `sourceMap` and
`declarationMap` to `false`, so that tree is unaffected either way.

**Bumping either version is a manual edit.** Dependabot handles aliased
specifiers poorly ([dependabot-core#1693][db-1693]), so it will not
reliably open TS bump PRs against these two entries. When
typescript-eslint gains TS 7 support, collapse this back to a single
plain `typescript` dependency.

[tse-10940]: https://github.com/typescript-eslint/typescript-eslint/issues/10940
[db-1693]: https://github.com/dependabot/dependabot-core/issues/1693

## API Contract Snapshot

`contract/openapi.snapshot.yaml` is a hand-maintained minimal OpenAPI
document listing the exact `(verb, path)` pairs the SDK's public methods
call. The contract test (`src/contract.test.ts`) mocks `fetch`, invokes
each public method, and asserts the captured URL matches the expected
template in the snapshot.

**Adding a new public SDK method?** Do three things in the same PR:

1. Implement the method in `src/client.ts`.
2. Add the `(verb, path)` pair to `contract/openapi.snapshot.yaml`.
3. Add a `METHOD_CASES` entry in `src/contract.test.ts`. Alias methods
   (e.g. `extend` → `update`) get their own entry so an alias rewire
   can't silently slip past.

Three mechanisms in `src/contract.test.ts` together fail CI on any
direction of drift:

- **`METHOD_CASES` ↔ `QURLClient.prototype`** — catches step 1
  without step 3 (new public method on the client without a
  corresponding test case).
- **Per-case `assertSdkCallMatches` layer-1 check** — catches step 3
  without step 2 (the test case's expected `(verb, path)` isn't in
  the snapshot).
- **Snapshot ↔ `METHOD_CASES` coverage** — catches an orphaned
  snapshot entry that no test exercises (e.g., after a method is
  removed from `client.ts` without trimming the yaml).

**Upstream API changed an endpoint the SDK uses?** Update
`contract/openapi.snapshot.yaml` to match the new `(verb, path)` AND
update `src/client.ts` to call it. The contract test failing is the
signal to do both in lockstep.

**Scope of the test:** `(verb, path)` only. Specifically:

- The SDK's assembled URL is compared on its `pathname`. A doubled
  path like `/v1/v1/qurls` *would* fail the template match and get
  caught. A `baseUrl` bug that swapped hosts without touching the
  path would NOT be caught — host-level regressions are covered by
  the per-feature unit tests in `client*.test.ts`, not here.
- Request body field names, response envelope parsing, and query
  parameter names are NOT validated. Body/response shape drift is a
  separate class and would warrant an `ajv`-backed schema validation
  layer against the upstream component schemas.

### Published API drift

The weekly `Published API drift` workflow compares every operation in
<https://layerv.ai/docs/qurls.yaml> with `contract/upstream-operations.json`.
This producer baseline includes endpoints the SDK does not expose. It is separate
from the hand-maintained SDK subset in `contract/openapi.snapshot.yaml`.
The workflow stores the fetched spec and report, and posts a bot comment on existing
issue #50 only when the report changes, including recovery. It does not open issues,
change either snapshot, or change SDK behavior. Operation drift is a report;
fetch, parse, and publication failures fail the workflow.

To review drift locally:

```sh
node scripts/check-upstream-api.mjs check /path/to/published-qurls.yaml
```

After reviewing upstream changes, update the producer baseline with
`node scripts/check-upstream-api.mjs snapshot /path/to/published-qurls.yaml > contract/upstream-operations.json`.
Update the SDK subset and method tests only when the SDK adopts an endpoint.
The report also compares the API client's listed maximum bounds with
`contract/validation-bounds.json`. Unit CI checks SDK literals against that reviewed
baseline. Weekly CI checks the fresh published numeric constraints and reports
missing or changed bounds before failing the job. Method/path-only drift remains
a report and does not fail the job. This is not full request/response schema validation.

Wire bounds stay numeric literals so the checker can inspect them without executing
the client. Every top-level `MAX_*` constant in `src/client.ts` must be either a contract bound
or an explicitly documented local safety budget. New and stale classifications
fail CI. Response size, diagnostic, traversal, and identifier work budgets remain
local safeguards; a server field change does not justify raising them.
The enrollment-token TTL and target-path byte limit are partly documented in prose.
Their reviewed numeric values and complete published descriptions are pinned;
any description change requires review rather than an automatic text-to-number guess.

When a service bound changes, review the published contract, then update the SDK,
its bound baseline, and boundary tests together. To check the published bounds locally:

```sh
node scripts/check-validation-bounds.mjs /path/to/published-qurls.yaml
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
3. Add tests for new functionality
4. Ensure all checks pass
5. Open a PR — CI runs automatically

## Commit Signing

All commits must be GPG or SSH signed. GitHub will reject unsigned commits.

## Releases

Releases are automated via [Release Please](https://github.com/googleapis/release-please). Conventional commit messages drive version bumps:
- `feat:` → minor version bump
- `fix:` → patch version bump
- `feat!:` or `BREAKING CHANGE:` → major version bump

### Always publish via CI

**Do not run `npm publish` locally.** The project's `.npmrc` sets
`ignore-scripts=true` as a supply-chain defense, which (as a side effect)
suppresses the `prepublishOnly` lifecycle hook. A local publish would ship
whatever is currently in `dist/` without re-running the build. The release
workflow (`.github/workflows/release-please.yml`) explicitly runs
`npm run build` before `npm publish`, so publishing via CI is safe.

If you need to verify a build artifact locally, run `npm run build` directly
rather than invoking `npm publish` with `--dry-run`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
