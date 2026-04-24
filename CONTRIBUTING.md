# Contributing

Thanks for your interest in contributing to `@layerv/qurl`!

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
npm run smoke:dist     # Verify the built ESM and CJS entry points load
npm run format:check   # Check formatting (prettier)
npx eslint src/        # Lint
```

All must pass before submitting a PR.

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

`smoke/cjs.cjs` and `smoke/esm.mjs` self-reference `@layerv/qurl` and
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
  the existing unit tests in `client.test.ts`, not here.
- Request body field names, response envelope parsing, and query
  parameter names are NOT validated. Body/response shape drift is a
  separate class and would warrant an `ajv`-backed schema validation
  layer against the upstream component schemas.

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
