# CLAUDE.md — qurl-typescript

## Critical Rules

- **NEVER push directly to `main`.** Always create a branch and PR.
- All commits must be signed.

## Project

TypeScript SDK for the qURL API (`npm install @layerv/qurl`). Extracted from `layervai/qurl-integrations`.

## Commands

```bash
npm install                # Install dependencies
npm run build              # Compile TypeScript
npm test                   # Run tests (vitest)
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
