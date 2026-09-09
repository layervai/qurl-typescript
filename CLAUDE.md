# CLAUDE.md — qurl-typescript

## Critical Rules

- **NEVER push directly to `main`.** Always create a branch and PR.
- All commits must be signed.

## Project

TypeScript SDK for the qURL API (`npm install @layervai/qurl`). Extracted from `layervai/qurl-integrations`.

## Commands

```bash
npm install                # Install dependencies
npm run build              # Compile TypeScript
npm run prebuild --workspace @layervai/qurl-state-fs # Build native test prerequisite
npm test                   # Run source tests
npm run format:check       # Check formatting (prettier)
npm run format             # Fix formatting
```

## Commit Format

```
<type>: <description>

type: feat | fix | chore | docs | test | refactor | ci
```

Conventional commits drive Release Please versioning.

## Release

Merging to `main` triggers Release Please. Merging the release PR publishes to npm.
