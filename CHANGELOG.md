# Changelog

## Unreleased

### SDK 2.x Go parity

- Add explicit HTTPS relay and pinned discovery providers. Native opens refuse
  unknown cells without relay fallback. NHP remains version 1.1.
- Add producer registration, durable resume, refresh, relocation, credential
  recovery, and exact session retirement through the Node entry point.
- Add secure native filesystem state and Go-compatible sealed envelopes, with
  separate SSM, Secrets Manager, and KMS adapters in `@layervai/qurl-aws`.
- Gate wire, state, and local UDP lifecycle behavior against SHA-pinned Go code.
- Keep all three npm packages on the SDK 2.x release line.

### ⚠ BREAKING CHANGES

- **client:** Connector get/delete and handle-based portal minting now use
  CRIDs only. Connector management responses must include a CRID that matches
  the returned public key. Public-key arguments and CRID-less responses are
  rejected; there is no backward-compatibility fallback.

- **client:** `delete()` no longer requires a legacy `r_...` resource ID. It
  accepts current opaque public resource IDs and CRIDs, leaving identifier
  grammar to qurl-service, while rejecting qURL display IDs before the legacy
  whole-resource DELETE endpoint can be called accidentally.
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
