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

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
