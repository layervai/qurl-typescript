# Changelog

## Unreleased

### Breaking changes

- `AccessToken.expires_at` is optional, matching the API token summary schema.
  Check that the value is defined before parsing or formatting it. An omitted
  value does not imply an unlimited lifetime. Runtime responses are unchanged.

## [4.0.0](https://github.com/layervai/qurl-typescript/compare/qurl-v3.1.1...qurl-v4.0.0) (2026-11-01)


### ⚠ BREAKING CHANGES

* **types:** AccessToken.expires_at is optional. Check for undefined before parsing or formatting it. Omission does not imply an unlimited lifetime. Runtime responses are unchanged.

### Features

* add a bounded per-client API response limit ([#337](https://github.com/layervai/qurl-typescript/issues/337)) ([8da35c5](https://github.com/layervai/qurl-typescript/commit/8da35c5575ad328bd6b67e6500461609d38b57e9))
* create external identity bindings through the SDK ([#309](https://github.com/layervai/qurl-typescript/issues/309)) ([d2a16cc](https://github.com/layervai/qurl-typescript/commit/d2a16cc5104e89c2d76a849a0738245385a6e063))
* expose per-result response correlation metadata ([#331](https://github.com/layervai/qurl-typescript/issues/331)) ([bf6ccdd](https://github.com/layervai/qurl-typescript/commit/bf6ccddf72042a35eccc4f2793fe2c5cdbc4f461))
* support Stripe payments for CRID contracts ([#338](https://github.com/layervai/qurl-typescript/issues/338)) ([c0653c1](https://github.com/layervai/qurl-typescript/commit/c0653c1ece1fab3575c49a6038e59315e5c128f4))


### Bug Fixes

* **ci:** update Node setup and restore npm dependency age checks ([#302](https://github.com/layervai/qurl-typescript/issues/302)) ([d5632e1](https://github.com/layervai/qurl-typescript/commit/d5632e1b90927d132b021fa4b7f92df4e0b9d0a3))
* honor past and capped HTTP-date retry directives ([#310](https://github.com/layervai/qurl-typescript/issues/310)) ([82153bc](https://github.com/layervai/qurl-typescript/commit/82153bc6a2f987b6d5948f22b13ccb15dd3dbccc))
* preserve the native fetch receiver in edge runtimes ([#342](https://github.com/layervai/qurl-typescript/issues/342)) ([42db9ba](https://github.com/layervai/qurl-typescript/commit/42db9ba5c2f73441034e2cae55180c29216e3ee5))
* preserve tombstone metadata on Gone errors ([#315](https://github.com/layervai/qurl-typescript/issues/315)) ([ca80c5c](https://github.com/layervai/qurl-typescript/commit/ca80c5c97d866d1198999b2d093f9a7794498e1c)), closes [#133](https://github.com/layervai/qurl-typescript/issues/133)
* reject missing session termination counts ([#332](https://github.com/layervai/qurl-typescript/issues/332)) ([b5cb138](https://github.com/layervai/qurl-typescript/commit/b5cb138e2348db125693f014c29de0e749795a56))
* **types:** allow omitted token summary expiration ([#314](https://github.com/layervai/qurl-typescript/issues/314)) ([538c587](https://github.com/layervai/qurl-typescript/commit/538c58711c46ebb92f3c64485f4a1062276559eb))
* validate and retain recorded portal path scopes ([#335](https://github.com/layervai/qurl-typescript/issues/335)) ([bc43c38](https://github.com/layervai/qurl-typescript/commit/bc43c38a3b14822568a1c114bc805e98e6e66ec8))
* validate package contents and lint all smoke tooling ([#311](https://github.com/layervai/qurl-typescript/issues/311)) ([15857cd](https://github.com/layervai/qurl-typescript/commit/15857cd297785b503705c9a84b103c591e71707c))

## [3.1.1](https://github.com/layervai/qurl-typescript/compare/qurl-v3.1.0...qurl-v3.1.1) (2026-10-18)


### Bug Fixes

* require the SDK major used by the AWS adapters ([#294](https://github.com/layervai/qurl-typescript/issues/294)) ([b6eb23f](https://github.com/layervai/qurl-typescript/commit/b6eb23f83677d5ecc20f4eecfa700cf7ea838fc3))

## [3.1.0](https://github.com/layervai/qurl-typescript/compare/qurl-v3.0.0...qurl-v3.1.0) (2026-10-17)


### Features

* expose email-backed consumer grants ([#291](https://github.com/layervai/qurl-typescript/issues/291)) ([612cd67](https://github.com/layervai/qurl-typescript/commit/612cd674318ecb9cafdbcda597f321d7f258d5d8))
* support private qURL creation and device-key deltas ([#293](https://github.com/layervai/qurl-typescript/issues/293)) ([3dc7600](https://github.com/layervai/qurl-typescript/commit/3dc7600c8309dcd6e283a63de8c0acfa8b846b7d))

## [3.0.0](https://github.com/layervai/qurl-typescript/compare/qurl-v2.0.0...qurl-v3.0.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* Quota.rate_limits no longer declares max_tokens_per_qurl. Remove reads of that retired per-resource cap; it no longer limits qURL minting. This is a public TypeScript type change even though runtime response parsing is unchanged. A later package release must carry the breaking-change version and migration note; this cleanup does not publish it.

### Features

* add private consumer access policies and owner actions ([#286](https://github.com/layervai/qurl-typescript/issues/286)) ([ff0ce3e](https://github.com/layervai/qurl-typescript/commit/ff0ce3efbcffe45fd3c8a9752a68afdc5ec98ae7))


### Bug Fixes

* complete paged resource session operations ([#280](https://github.com/layervai/qurl-typescript/issues/280)) ([c77bafa](https://github.com/layervai/qurl-typescript/commit/c77bafa2d1ffe060f88c7e447c7e06cbc3c7b613))
* remove unused quota cap declaration ([#278](https://github.com/layervai/qurl-typescript/issues/278)) ([1bdab3c](https://github.com/layervai/qurl-typescript/commit/1bdab3c2b53acdf71625300f6a1604d8a33d6db5))
* stop forcing SDK releases to an existing version ([#290](https://github.com/layervai/qurl-typescript/issues/290)) ([a6c2c8a](https://github.com/layervai/qurl-typescript/commit/a6c2c8a43b8bc7a91a5a3bb225172d3341346fd4))

## [2.0.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.7.0...qurl-v2.0.0) (2026-09-10)

### SDK 2.x Go parity

- Add explicit HTTPS relay and pinned discovery providers. Native opens refuse
  unknown cells without relay fallback. NHP remains version 1.1.
- Add producer registration, durable resume, refresh, relocation, credential
  recovery, and exact session retirement through the Node entry point.
- Add secure native filesystem state and Go-compatible sealed envelopes, with
  separate SSM, Secrets Manager, and KMS adapters in `@layervai/qurl-aws`.
- Gate wire, state, and local UDP lifecycle behavior against SHA-pinned Go code.
- Expose frozen, deduplicated `partialQurlIds` on malformed terminal batch errors
  so callers can clean up valid successful items.
- Keep all three npm packages on the SDK 2.x release line.

### ⚠ BREAKING CHANGES

- **delegated batches:** `etag` and `retry_after` are now optional response
  fields. Poll without `If-None-Match` when no ETag is supplied, and use a bounded
  polling delay when Retry-After is absent or invalid. Retry-After accepts an
  HTTP date or positive delta seconds up to one hour. Invalid supplied ETags
  still fail validation. Discord applies its existing deadline and polling delay.

- **client:** Connector get/delete and handle-based portal minting now use
  CRIDs only. Connector management responses must include a CRID that matches
  the returned public key. Public-key arguments and CRID-less responses are
  rejected; there is no backward-compatibility fallback.

- **client:** resource item methods, including `delete()`, `deleteResource()`,
  `getResource()`, `createQurlForResource()`, and `revokeResourceQurl()`, require
  a CRID. They reject public-key resource IDs before sending a request, even
  where qurl-service still accepts those IDs. `get()` and `extend()` accept
  either a CRID or a `q_` display ID; `delete()` rejects display IDs because it
  revokes the whole resource. Before upgrading, store and pass the `crid`
  returned in API responses instead of the public-key `resource_id`. A stored
  public key alone is not a CRID and cannot be converted into one. SDK 3.0.0+
  adds `deleteResourceByIdentifier()` to delete resources known only by a
  legacy or public-key resource ID.
- **client:** path identifiers now reject raw or repeatedly encoded `.` / `..`
  segments, URL-shaped values, and embedded qURL
  access-token credentials before making a request. Resource/qURL identifier
  parameters additionally reject bare `at_...` access tokens. These inputs
  previously reached the service and normally returned an HTTP error; callers
  now receive a synchronous `ValidationError`.
- **client:** adopt qurl-service's kind-first credential API. Retired
  `purpose`/`tunnel_slug` fields are removed; durable API keys and one-shot
  enrollment tokens now enforce their distinct scopes, targets, claims, and
  expiry contracts before dispatch. In particular, durable keys no longer
  accept `expires_in`; only enrollment tokens may carry a lifetime. Requires a
  qurl-service deployment with the kind-first credential contract at or after
  `047cf31e1cdf545e3060e0f9294d738a19fb997b`.
- **client:** create/update API-key request scopes now use the service's closed
  `qurl:read`, `qurl:write`, `qurl:resolve`, and `qurl:agent` vocabulary. API-key
  response scopes remain forward-compatible with future server values, but
  callers must validate/narrow response values before writing them back through
  the closed request type.
- **client:** replace alias-based `connectorResource(connectorId)` with the
  explicit Connector lifecycle methods below.

### Features

- **client:** add qurl-go-compatible Connector resource management by immutable
  slug and canonical public resource ID. Connector identity, reverse routing,
  and NHP admission IDs are validated and exposed separately.

* **client:** bind portal access to an independently held CRID ([#258](https://github.com/layervai/qurl-typescript/issues/258)) ([aace347](https://github.com/layervai/qurl-typescript/commit/aace3470edb1def4d25b8ef5ce6d0a6160e1af67))
* **client:** support delegated qURL batches ([#255](https://github.com/layervai/qurl-typescript/issues/255)) ([734cddf](https://github.com/layervai/qurl-typescript/commit/734cddf0033490355a6df4abb641db7ed31c7aaa))
* complete Go parity for the TypeScript SDK 2.x ([#265](https://github.com/layervai/qurl-typescript/issues/265)) ([92f57e6](https://github.com/layervai/qurl-typescript/commit/92f57e6c62086d37347dea151a0fc69eea29f625))

### Bug Fixes

- **client:** keep slug-idempotent Connector ensure off the generic automatic
  idempotency path, and treat a consumed bootstrap key as outcome-unknown.
- **client:** send the required `{}` body for a default portal mint.

## [0.7.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.6.0...qurl-v0.7.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* share resources and use CRID resource addresses ([#246](https://github.com/layervai/qurl-typescript/issues/246))
* **client:** use Connector CRIDs and fix resource deletion ([#244](https://github.com/layervai/qurl-typescript/issues/244))
* **client:** adopt the kind-first credential API ([#223](https://github.com/layervai/qurl-typescript/issues/223))

### Features

* **client:** adopt the kind-first credential API ([#223](https://github.com/layervai/qurl-typescript/issues/223)) ([6a4bbf7](https://github.com/layervai/qurl-typescript/commit/6a4bbf7221dde0b6537fc64b470765d3cdcb880f))
* **client:** use Connector CRIDs and fix resource deletion ([#244](https://github.com/layervai/qurl-typescript/issues/244)) ([9cbca42](https://github.com/layervai/qurl-typescript/commit/9cbca425f3b6d277575d4c722c43633925beaaba))
* share resources and use CRID resource addresses ([#246](https://github.com/layervai/qurl-typescript/issues/246)) ([a624566](https://github.com/layervai/qurl-typescript/commit/a6245664cf1d24f62a89ac52e15445519a32e151))

## [0.6.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.5.0...qurl-v0.6.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* **client:** align Connector resource lifecycle with Go ([#247](https://github.com/layervai/qurl-typescript/issues/247))

### Features

* **client:** align Connector resource lifecycle with Go ([#247](https://github.com/layervai/qurl-typescript/issues/247)) ([e6dfcb6](https://github.com/layervai/qurl-typescript/commit/e6dfcb6bc509150cf140f85aad7e835d2173539c))

## [0.5.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.4.0...qurl-v0.5.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* **api:** the Node PortalOpener configuration, health types, lifecycle states, cancellation behavior, Node version floor, and error surface now match the reviewed qurl-go PortalOpener contract. Existing proactive-opener consumers must update to the new API.

### Features

* **api:** add scoped descendant portal requests ([#253](https://github.com/layervai/qurl-typescript/issues/253)) ([f761e89](https://github.com/layervai/qurl-typescript/commit/f761e8999052488b398b604b4c90bac06a37c26a))


### Bug Fixes

* **api:** align portal opener with Go lifecycle ([#251](https://github.com/layervai/qurl-typescript/issues/251)) ([be901e7](https://github.com/layervai/qurl-typescript/commit/be901e7ed159e8c5d248fbab08b6bf2255029379))

## [0.4.0](https://github.com/layervai/qurl-typescript/compare/qurl-v0.3.1...qurl-v0.4.0) (2026-09-06)

### ⚠ BREAKING CHANGES

- **client:** DELETE operations are no longer retried after transport, 429, or 5xx
  failures. This matches qurl-go's no-hidden-HTTP-retry rule, avoids request-path
  pacing, and requires the caller to use `retryAfter` and reconcile state before
  a deliberate retry. Documented no-content DELETE endpoints now require an
  exact empty HTTP 204 response
  ([#213](https://github.com/layervai/qurl-typescript/issues/213)).
- **client:** server-provided error titles, details, and up to 100
  invalid-field entries have controls and bidirectional formatting characters
  removed, are normalized to one line, and are capped at 512 UTF-8 bytes per
  key/value and 8 KiB per retained collection so error objects and debug paths
  stay bounded. Exact machine identifiers (`code`, RFC 7807 `type` and
  `instance`, and request IDs) are not normalized or truncated into false
  identifiers: changed or overlong values are dropped, and an invalid code
  becomes `unknown`. Non-string invalid-field values are omitted, and
  normalized-key collisions retain the first diagnostic.
- **client:** API redirects are refused instead of followed, including when an
  injected fetch implementation follows one before returning a response.
- **client:** API response bodies larger than 1 MiB and successful JSON bodies
  with malformed UTF-8 are rejected before JSON parsing. The size limit also
  applies to streamed bodies without a trustworthy Content-Length. Resume
  collection reads from the last successful cursor with a smaller page. The
  fixed shared-cap decision is tracked in #249.
- **client:** GET requests now retry transport failures from successful response
  bodies and from the normal retryable error statuses. Hard 4xx responses are
  not replayed. Mutations require reconciliation and are not replayed after a
  response-body transport failure.
- **client:** the observed HTTP status now controls server-error classification;
  a conflicting RFC 7807 `error.status` value can no longer change the typed
  error class.
- **client:** remove the unsafe legacy HTTP bootstrap method
  ([#209](https://github.com/layervai/qurl-typescript/issues/209)) and incomplete
  relay registration implementation
  ([#206](https://github.com/layervai/qurl-typescript/issues/206)). Native NHP 1.1
  assignment, registration, and proactive opener parity replace them under the
  program tracked in #248.

### Features

- Add the proactive native NHP portal opener
  ([#250](https://github.com/layervai/qurl-typescript/issues/250)).
- Add native NHP agent registration
  ([#177](https://github.com/layervai/qurl-typescript/issues/177)).

### Bug Fixes

- **client:** preserve the status-derived error class and `Retry-After` on 429
  and 503 responses whose body is unreadable or is not a valid API error
  envelope; unreadable bodies retain the transport failure as `cause`.
- **client:** classify an injected fetch failure or successful response body's
  independent `AbortError` or `TimeoutError` as a non-retried `NetworkError`;
  after non-success headers, preserve the status-derived class and attach the
  failure as its cause. Only the SDK timeout signal produces `TimeoutError`.
  Deterministic Response-like materialization failures retain their SDK-authored
  detail and cause and are not retried.
- Make the review workflow validate the destination origin instead of one exact
  URL ([#234](https://github.com/layervai/qurl-typescript/issues/234)).

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
