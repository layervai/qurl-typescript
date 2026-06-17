# Changelog

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
