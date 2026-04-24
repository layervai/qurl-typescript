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
npm run build          # Compile TypeScript
npm test               # Run tests (vitest)
npm run format:check   # Check formatting (prettier)
npx eslint src/        # Lint
```

All must pass before submitting a PR.

## API Contract Snapshot

`contract/openapi.snapshot.yaml` is a hand-maintained minimal OpenAPI
document listing the exact `(verb, path)` pairs the SDK's public methods
call. The contract test (`src/contract.test.ts`) mocks `fetch`, invokes
each public method, and asserts the captured URL matches the expected
template in the snapshot.

**Adding a new public SDK method?** Do three things in the same PR:

1. Implement the method in `src/client.ts`.
2. Add the `(verb, path)` pair to `contract/openapi.snapshot.yaml`.
3. Add an `it("<method> → VERB /path")` case in `src/contract.test.ts`
   and include the name in `SDK_PUBLIC_METHODS`. Alias methods (e.g.
   `extend` → `update`) get their own case so an alias rewire can't
   silently slip past.

Three mechanisms in `src/contract.test.ts` together fail CI if any of
the three steps is skipped:

- **`SDK_PUBLIC_METHODS` ↔ `QURLClient.prototype`** — catches step 1
  without step 3 (new method, no set entry).
- **`SDK_PUBLIC_METHODS` ↔ `it()` cases** — catches a set entry
  without a corresponding `it()` block (parses this test file's own
  source).
- **Per-case `assertSdkCallMatches` layer-1 check** — catches step 3
  without step 2 (the `it()` case's expected `(verb, path)` isn't in
  the snapshot).

**Upstream API changed an endpoint the SDK uses?** Update
`contract/openapi.snapshot.yaml` to match the new `(verb, path)` AND
update `src/client.ts` to call it. The contract test failing is the
signal to do both in lockstep.

**Scope of the test:** `(verb, path)` only. It does NOT verify request
body field names, response envelope parsing, or query parameter names.
Body/response shape drift is a separate class and would warrant an
`ajv`-backed schema validation layer against the upstream component
schemas.

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
