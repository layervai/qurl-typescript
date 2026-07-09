# Changelog

## Unreleased

### ⚠ BREAKING CHANGES

- **client:** The NHP-native `bootstrapAgent` free function (and `registerAgent`)
  enroll over NHP against the qURL API origin (`api.layerv.ai`) rather than the
  pre-NHP `POST /v1/agent/bootstrap` endpoint. The legacy `QURLClient.bootstrapAgent`
  method is unchanged in behavior but is now deprecated in favor of `registerAgent`;
  its endpoint/origin and single-purpose (identity-only, no device credential)
  return value are superseded by the NHP enrollment engine, which mints a device
  REST credential and returns a ready-to-use client. New crypto dependencies
  (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) are added. These are
  ESM-only and are imported lazily, so importing the package and using the rest
  of the client is unaffected on any supported Node; but `registerAgent` /
  `bootstrapAgent` called through the **CommonJS** build (`require("@layervai/qurl")`)
  need Node ≥ 20.19 (which added `require()` of ES modules). CJS consumers on an
  older Node 20.x should call these via the ESM entry.

### Features

- **client:** add NHP-native `registerAgent(apiKey, store, opts?)` — the idempotent
  front door for enrolling an agent and getting a ready-to-use `QURLClient`. Covers
  both the pre-issued (bootstrap) key path (one-call enrollment) and the account
  email-OTP path (two-phase: `OTPPendingError` then resume with `withOTP`), with a
  fast path that serves the client from persisted state with no network. Adds
  `AgentState` / `AgentStateStore` / `FileAgentStateStore` / `MemoryAgentStateStore`,
  the vendored NHP wire crypto (`src/crypto/`, ported byte-for-byte from the NHP
  js-agent — X25519 / AES-256-GCM / BLAKE2s Noise handshake), and the registration
  error taxonomy (`OTPPendingError`, `RegisterKeyRejectedError`,
  `AgentIdentityConflictError`, `RegistrationDenyError`,
  `RegistrationTransportError`, …). The vendored wire is byte-fenced against the
  qurl-conformance agent-registration golden vectors (`crypto/golden.test.ts`) —
  `buildMessage` reproduces the OTP/REG `packet_hex` exactly and `decryptReply`
  opens the frozen RAK replies; the vectors are a temporary vendor pending the
  published `@layervai/qurl-conformance` accessor (layervai/qurl-typescript#176).
- **client:** add NHP-native `bootstrapAgent(setupKey, store, opts?)` free function
  (deprecated in favor of `registerAgent`) that runs the same NHP enrollment engine
  on the pre-issued-key path and returns the registered `AgentState`.

## [0.3.1](https://github.com/layervai/qurl-typescript/compare/qurl-v0.3.0...qurl-v0.3.1) (2026-07-05)


### Features

* add portal-verb API surface (protectUrl → createPortal → enterPortal) ([#162](https://github.com/layervai/qurl-typescript/issues/162)) ([00b19d2](https://github.com/layervai/qurl-typescript/commit/00b19d21c64670fc40a00b47d298ea773f8f1cba))

## [0.3.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.2.0...qurl-v0.3.0) (2026-06-17)


### ⚠ BREAKING CHANGES

* Mutating POST/PATCH requests now require `globalThis.crypto.getRandomValues` to generate SDK idempotency keys. Runtimes without Web Crypto must pass `RequestOptions.idempotencyKey`.

### Features

* send Idempotency-Key on mutating retries ([#131](https://github.com/layervai/qurl-typescript/issues/131)) ([70ee6ab](https://github.com/layervai/qurl-typescript/commit/70ee6ab85cde77caf1fac37df4635faaf275bcdb))
* support target_path on createQurlForResource ([#145](https://github.com/layervai/qurl-typescript/issues/145)) ([5ec2305](https://github.com/layervai/qurl-typescript/commit/5ec2305d667c656130b37122e93cde4745774bc8))


### Bug Fixes

* **ci:** drop registry-url so trusted publishing works for @layervai/qurl ([#127](https://github.com/layervai/qurl-typescript/issues/127)) ([cd454a6](https://github.com/layervai/qurl-typescript/commit/cd454a6613e7782abda096023465f2c9efa71935))
* **ci:** restore registry-url for OIDC trusted publishing (reverses [#127](https://github.com/layervai/qurl-typescript/issues/127)) ([#129](https://github.com/layervai/qurl-typescript/issues/129)) ([1bd18c0](https://github.com/layervai/qurl-typescript/commit/1bd18c00399c5c727f7b882cd666294e6a965348))

## [0.2.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.1.0...qurl-v0.2.0) (2026-06-06)


### ⚠ BREAKING CHANGES

* align types and client with latest API spec ([#14](https://github.com/layervai/qurl-typescript/issues/14))
* restructure QURL type — add AccessToken type ([#19](https://github.com/layervai/qurl-typescript/issues/19))

### Features

* align types and client with latest API spec ([#14](https://github.com/layervai/qurl-typescript/issues/14)) ([a8b2d56](https://github.com/layervai/qurl-typescript/commit/a8b2d568ee3d6c0bcebeac22570f01a23686f4f8))
* **ci:** adopt fleet issue-template + priority-enforcement pattern ([#45](https://github.com/layervai/qurl-typescript/issues/45)) ([04e6f75](https://github.com/layervai/qurl-typescript/commit/04e6f756be3545ceeb1ada642ce9e02209ea48df))
* initial TypeScript SDK setup ([#1](https://github.com/layervai/qurl-typescript/issues/1)) ([24915d7](https://github.com/layervai/qurl-typescript/commit/24915d75ab17a72298a437040c1c8e001b5266f8))
* restructure QURL type — add AccessToken type ([#19](https://github.com/layervai/qurl-typescript/issues/19)) ([a3619e1](https://github.com/layervai/qurl-typescript/commit/a3619e142e327acb4e81c139c8a8d0a06fc0d077))
* sync qurl-service API contract ([#113](https://github.com/layervai/qurl-typescript/issues/113)) ([e0208fe](https://github.com/layervai/qurl-typescript/commit/e0208fede64c68e063df0450841678a52b0d64a1))


### Bug Fixes

* use canonical /v1/qurls path for create (plural) ([#46](https://github.com/layervai/qurl-typescript/issues/46)) ([e6a199d](https://github.com/layervai/qurl-typescript/commit/e6a199d258c54f32a4ac402348b49b0ff7792621))

## Changelog
