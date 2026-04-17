# CLAUDE.md — qurl-typescript

## Critical Rules

- **NEVER push directly to `main`.** Always create a branch and PR.
- All commits must be signed.

## Project

TypeScript SDK for the QURL API (`npm install @layerv/qurl`). Extracted from `layervai/qurl-integrations`.

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

## Security Workflows

- `codeql.yml` runs CodeQL (JS/TS + `actions` language) with the `security-and-quality` query suite on every PR.
- `dependency-age-check.yml` enforces a 7-day quarantine on newly published npm packages added to `package-lock.json`. Defends against typosquatting / dependency-confusion attacks where an attacker publishes a malicious version and hopes someone pulls it in before the community notices.
  - **Blocked PR escape hatch**: add the `age-check-bypass` label to skip the check for genuine emergencies (e.g., a published CVE that requires urgent upgrade despite age). The label is an auditable override rather than a silent skip.
  - **Manual run**: trigger via `workflow_dispatch` with optional `base_ref` and `min_age_days` inputs.
