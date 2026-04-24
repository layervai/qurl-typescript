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

## OpenAPI Contract Snapshot

`contract/openapi.snapshot.yaml` is a vendored copy of `api/openapi.yaml`
from the [qurl-service](https://github.com/layervai/qurl-service) backend.
The contract test (`src/contract.test.ts`) reads it to assert every SDK
method calls the (verb, path) pair the backend actually exposes.

Regenerate it when adopting a newer qurl-service release:

```bash
# Expects qurl-service checked out at ../qurl-service (sibling directory).
# Override with: QURL_SERVICE_DIR=/path/to/qurl-service
scripts/update-openapi-snapshot.sh               # defaults to origin/main
scripts/update-openapi-snapshot.sh v1.2.3        # pin to a tag
scripts/update-openapi-snapshot.sh <sha>         # pin to a specific commit
```

The script writes the resolved commit SHA into the snapshot header, so
reviewers can see exactly which version of the backend contract the SDK
was last validated against. If the regenerated snapshot breaks the
contract test, that's the signal: qurl-service changed an endpoint the
SDK depends on, and the SDK needs to be updated in lockstep.

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
