# @layervai/qurl

[![npm](https://img.shields.io/npm/v/@layervai/qurl)](https://www.npmjs.com/package/@layervai/qurl)
[![CI](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/layervai/qurl-typescript)](LICENSE)

**Use the LayerV [qURL™ Platform](https://docs.layerv.ai) from TypeScript: protect a
private URL once, then mint short-lived portal links for it.**

> **Quantum URL (qURL)** · The internet has a hidden layer. This is how you enter.

Portal recipients do not need LayerV credentials, API keys, or SDK state. They
open the qURL link. Credentials are only for software that protects URLs or
creates portals.

## Why qURL?

Agents and services increasingly need to reach private MCP servers, APIs, and
internal tools. The issue is visibility: every standing public endpoint becomes
inventory for scanners, fingerprinting, credential attacks, and AI-assisted
probing before a legitimate user or agent ever arrives.

Opening an inbound port, running a VPN, shipping a bastion, publishing a
Cloudflare Tunnel or ngrok URL, or passing around a long-lived key all leave
something durable to find, scan, or steal. qURL flips that model: it is an
invisibility primitive for authenticated access, and the private resource is
not public inventory. A portal is **cryptographic, just-in-time permission for
one actor to reach one private resource** — not another externally visible
endpoint in front of the same service:

- **Time-limited** — portals expire after minutes, hours, or days
- **IP-scoped** — access is granted only to the requesting IP via NHP
- **Auditable** — every access is logged with who, when, and from where
- **Revocable** — kill access instantly if something goes wrong

## Installation

```bash
npm install @layervai/qurl
```

Requires Node.js 22.12+ and has **no runtime dependencies**. Both
`import { QURLClient } from '@layervai/qurl'` (ESM) and
`const { QURLClient } = require('@layervai/qurl')` (CJS) work.

## Quickstart

```typescript
import { QURLClient } from '@layervai/qurl';

const client = new QURLClient({ apiKey: 'YOUR_API_KEY' });

const resource = await client.protectUrl('https://internal.example.com/dashboard');
const portal = await resource.createPortal({ validFor: '5m' });

console.log(portal.link); // Share this link — recipients need no credentials
```

That is the core flow:

| Step | Call | What you provide |
| --- | --- | --- |
| Protect a private URL | `client.protectUrl` | The target URL you already know |
| Mint a short-lived access link | `resource.createPortal` | The returned resource handle |

`protectUrl` is idempotent for the same account and target URL: protecting the
same URL again returns the existing resource. `validFor` accepts a duration
string (`'5m'`, `'24h'`) or a number of milliseconds (whole seconds, at least
one minute); prefer short portal lifetimes.

If qURL Connector protects the service, address its management-plane resource
by immutable slug instead of calling `protectUrl`:

```typescript
const { resource, foundExisting } = await client.ensureConnectorResource(
  'prod-dashboard',
  { idempotencyKey: 'connector-bootstrap-prod-dashboard' },
);
console.log(foundExisting ? 'Using existing connector resource' : 'Created connector resource');
const portal = await resource.createPortal({
  validFor: '5m',
  targetPath: '/api/detect/eib_example',
});
```

`targetPath` is available only when minting for an existing resource. The SDK
checks the non-empty 2048-byte boundary; the API remains authoritative for the
path grammar and the tunnel-only resource gate. `createPortalForUrl` rejects
this option because it creates a URL resource.

`resource.crid` is the required management identifier. Connector lookup, delete,
and portal minting use it with no public-key or private-ID fallback. The SDK
checks that the returned public key matches the CRID.

`resource.resourcePublicKey`, `resource.connectorRoutingId`, and
`resource.knockResourceId` are three distinct server-issued values for verification, reverse routing, and NHP admission. Consume each verbatim; never
derive or substitute one for another. Use `getConnectorResource(crid)`
or `getConnectorResourceBySlug(slug)` for read-only lookup and
`deleteConnectorResource(crid)` to revoke it. This replaces the old
alias-based `connectorResource(connectorId)` method.
`ConnectorResource` instances cannot be constructed directly; the client
returns them only after validating the complete response contract.

`ensureConnectorResource` and `deleteConnectorResource` throw
`ConnectorResourceOutcomeUnknownError` when a dispatched mutation may have
committed but its response cannot prove the result. Reconcile by immutable slug
or CRID before deciding whether to retry. The wrapper deliberately uses
`status: 0`; the original typed error is available as `cause`, including its
observed HTTP status.

Connector lifecycle calls make one HTTP attempt. The SDK does not pace or
replay them; the caller controls any retry after it reconciles state.

`ensureConnectorResource` does not generate an idempotency key because the slug
operation is already idempotent. If you supply an `idempotencyKey`, the SDK
forwards it, and you must reuse it on any deliberate retry. A 409
`bootstrap_key_consumed` response is outcome-unknown because resource binding
can finish before bootstrap-key consumption fails. The original bootstrap key
is terminal: do not retry it. Obtain a new bootstrap key and use normal
owner-authenticated lookup by immutable slug to reconcile the resource first.

The API does not apply idempotency replay to DELETE, so after an outcome-unknown
`deleteConnectorResource` call, reconcile by CRID before issuing a
deliberate retry. A valid exact-201 resource missing only `meta.found_existing`
is known to have selected that row but still fails as an unwrapped
`unexpected_response` because required ensure metadata is absent.

If you persist the CRID, future calls do not need to recreate the
handle (no API call is made until you mint):

```typescript
async function createPortalForStoredResource(storedCrid: string) {
  // Pass the CRID previously returned by the API.
  const resource = client.resourceByCrid(storedCrid);
  return resource.createPortal({ validFor: '1h' });
}
```

For one-off scripts, `client.createPortalForUrl` combines the two API calls
and returns both the portal and a reusable resource handle. The handle carries
the resource id and target URL; use `protectUrl` when you need the full
server-populated resource metadata:

```typescript
const { portal, resource } = await client.createPortalForUrl(
  'https://internal.example.com/dashboard',
  { validFor: '5m' },
);
```

Portal options mirror qurl-go:

```typescript
const portal = await resource.createPortal({
  validFor: 5 * 60 * 1000, // milliseconds work too
  label: 'Alice from Acme',
  oneTimeUse: true,
  maxSessions: 1,
  targetPath: '/api/detect/eib_example',
});
```

`createPortal` sends `{}` when no options are set because the service requires
a JSON object at the wire level.

The Node-only `@layervai/qurl/node` entry opens received qv2 links with native
NHP UDP. It has no relay or HTTP-resolve fallback. Connector assignment and
registration are separate producer operations and are not part of the portal
opener.

If you already hold a CRID, mint a fresh share link directly:

```typescript
const share = await client.shareResource(crid, { ttlSeconds: 300 });
// Optional: verify the response CRID against DER SPKI bytes you already trust
// before the secret leaves this process.
await share.verifyCrid(resourcePublicKeyDer);
await deliverToRecipient(share.link); // Secret; returned once and not retrievable
console.log(share.qurlId); // Safe handle for revoking only this link later
```

`shareResource` returns the current share-safe `#qv2t1...` link. Recipients
open that URL in the qURL browser flow. For native TypeScript opening, pass
`share.link` to `createPortalOpener` from `@layervai/qurl/node` with trusted
`QURL_DEPLOYMENT` configuration and `expectedCRID: advertisedCRID`.
Obtain `advertisedCRID` independently of the response carrying the link.
The opener verifies the issuer signature and CRID/key binding before each
native access request, including renewals. Empty, malformed, unsupported,
and mismatched CRIDs fail closed. Omitting the option retains link-only access.
This verifies resource identity, not content or current revocation state.
The access-binding check accepts only locally registered versions and their
registered digest widths, matching the Go SDK and browser agent. Upgrade the
SDK when a new version is activated. This is stricter than the forwarding
and supplied-key helper below. See the native opener example below.
`verifyCrid` does not open the link or make a network request.

`verifyCrid` verifies that the response CRID derives from the trusted resource
key; it does not independently bind the secret link fragment to that key.
It intentionally follows qurl-go's environment-agnostic key-match rule: CRID
version zero is rejected as reserved, while every other structurally valid
version is accepted and environment classification is not part of key-to-digest
verification. It compares all 32 digest bytes for a full CRID and all 24 for
a truncated CRID; the response determines the digest width. CRIDs use their canonical lowercase base32 spelling; uppercase or
mixed-case spellings fail closed. Binary inputs of any length are hashed;
`invalid_crid_key` is reserved for non-binary or unreadable (detached) runtime
values, and a readable binary key that does not match reports `crid_mismatch`.
Use `error instanceof CRIDVerificationError` (or `error.status === 0`) to
distinguish these local verification failures from a server error that happens
to use the same problem code.
`qurlId` and `singleUse` are undefined when omitted by the service.
`ShareLink` keeps `.link` directly readable but redacts it from JSON, Node
inspection, and object spread to reduce accidental credential logging. Read
`.link` directly before delivery; do not spread or clone a `ShareLink`, because
those operations deliberately omit the credential. Browser developer consoles
can still display non-enumerable properties, so do not log the object there.
The constructor snapshots a caller-provided expiry, and the `ShareLink`
properties are frozen. Each `expiresAt` read returns a defensive `Date` copy;
changing that copy does not change the share metadata.

Omitting `ttlSeconds` matches qurl-go's zero-value behavior and requests the
platform default. TypeScript additionally rejects an explicit zero so a
computed countdown cannot silently become a longer-lived default credential.
A response can report `expiresInSeconds: 0`; do not reuse that value as a
request TTL. Expiry parsing uses the SDK's shared API date parser.

The service chooses single-use policy; this matches the Go SDK options.

qURL Connector assignment and registration use native UDP through
`qurl-connector` and `qurl-go`. This package does not expose an HTTP enrollment API.
Like the Go SDK, credential minting uses HTTPS and token consumption uses
native UDP. The Go SDK currently exposes minting through its restricted
`RegisteredAgentResourceHTTPDoer` bridge; this SDK uses `createApiKey`.
The service controls which credential kinds each caller can mint.
It can mint the one-shot credential consumed by that native enrollment flow:

```typescript
const enrollment = await client.createApiKey({
  kind: 'enrollment_token',
  name: 'prod-dashboard enrollment',
  target: 'connector',
  claims: [{ type: 'connector', id: 'prod-dashboard' }],
  expires_in: '15m',
});
if (!enrollment.api_key) throw new Error('Enrollment response omitted its one-time token');
await deliverEnrollmentTokenSecurely(enrollment.api_key);
```

Durable `api_key` credentials require explicit scopes and do not accept
`expires_in`; enrollment tokens derive their scopes from `target`/`claims` and
expire within 24 hours. A connector claim's `id` is its immutable connector
slug. Request enums are validated against the current service contract;
response types remain additive for forward-compatible reads, and new request
enum values require a matching SDK release. Use
`isApiKeyRequestScope(scope)` to validate response scopes before writing them
back. Reject unknown scopes; do not filter them out, which can remove permissions.
When changing only a name, omit `scopes` from `updateApiKey`.

```typescript
import { isApiKeyRequestScope } from '@layervai/qurl';

const scopes = key.scopes;
if (!scopes?.length || !scopes.every(isApiKeyRequestScope)) {
  throw new Error('Cannot reuse these scopes; check the current SDK contract');
}
await client.updateApiKey(keyId, { scopes });
```

This credential surface requires the kind-first qurl-service contract at or
after commit `047cf31e1cdf545e3060e0f9294d738a19fb997b`.

## Delegated qURL batches

Services with a delegated mint capability can create up to 100 ordered grants
without an API call per recipient:

```typescript
import { DelegatedBatchOutcomeUnknownError, QURLClient } from '@layervai/qurl';

const client = new QURLClient({ apiKey: process.env.QURL_API_KEY! });
const key = crypto.randomUUID();
const mintCapability = process.env.QURL_MINT_CAPABILITY!;
const recipients = [{ name: 'Alice' }];

const accepted = await client
  .createDelegatedQurlBatch(
    {
      mint_capability: mintCapability,
      grants: recipients.map((recipient) => ({ label: recipient.name, expires_in: '1h' })),
    },
    { idempotencyKey: key },
  )
  .catch((error: unknown) => {
    if (error instanceof DelegatedBatchOutcomeUnknownError && error.batchId) {
      console.error('Poll the accepted batch before retrying', { batchId: error.batchId });
    }
    // A deliberate retry must reuse this key and exact body.
    throw error;
  });

let etag = accepted.etag;
let retryAfter = accepted.retry_after;
let state;
const deadline = Date.now() + 60_000;
for (let polls = 0; polls < 30 && Date.now() < deadline; polls++) {
  await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  state = await client.getDelegatedQurlBatch(accepted.batch_id, { etag });
  if (state.http_status === 304) {
    retryAfter = state.retry_after ?? retryAfter;
  } else if (state.http_status === 202) {
    ({ etag, retry_after: retryAfter } = state);
  } else {
    break;
  }
}

if (state?.http_status !== 200) throw new Error('Delegated qURL batch did not finish');

if (state.results[0]?.status === 'succeeded') {
  const qurlId = state.results[0].qurl.qurl_id;
  const metadata = await client.getDelegatedQurl(qurlId);
  console.log(metadata.status);
  await client.deleteDelegatedQurl(qurlId);
}
```

The idempotency key must contain 32–256 visible ASCII characters. A UUID meets
this requirement.

One read makes one HTTP attempt. The caller owns the poll count, total deadline,
and wait from `retry_after`. A `304` means the prior ETag is still current. A
`200` contains the terminal, input-ordered results. Keep each returned qURL as
an opaque bearer link and apply any deployment-specific origin check before
publishing it.

Delegated DELETE calls are not retried automatically. After a transport failure
or `503 mutation_outcome_unknown`, retry the same qURL ID until the service
returns `204`.

## Opening Portals

Most recipients open qURL links directly and do not use this SDK at all. If
you are building a service or agent that opens received qURL links
programmatically, `enterPortal` accepts a full link or a bare access token,
grants network access for the caller's IP, and returns the reachable resource:

```typescript
const handle = await client.enterPortal(link);
console.log(handle.resourceUrl); // The reachable resource location
console.log(handle.openSeconds); // How long access stays open
```

Unlike qurl-go's offline `EnterPortal`, this SDK opens links through the
LayerV API: the client needs an API key with the `qurl:resolve` scope.
`enterPortal` fails closed — if access is granted but no resource URL comes
back, it throws instead of returning an empty handle.

### Proactive native Node opener

Use the Node subpath when a service receives a qv2 link and must keep one NHP
session ready for a low-latency private request. Construct and start one opener
for that link during setup. `start()` sends the native UDP knock and schedules
background renewal before the admission expires. A transient renewal failure
retries after 500 ms, then 1 second, then at most every 2 seconds while the old
admission remains valid. `fetch()` never opens or renews a session, and it never
sleeps. It fails if the cached admission has expired.

Renewal waits at least 5 seconds after a successful open. If a server grants a
session that expires before that safe renewal point, the grant expires without
a background attempt and `start()` is the explicit recovery path. Production
admissions should be longer than this minimum gap.

```javascript
const { createPortalOpener } = require('@layervai/qurl/node');

async function uploadPrivateObject(uploadBody) {
  const opener = createPortalOpener({
    qurl: process.env.PRIVATE_UPLOAD_QURL,
    expectedCRID: process.env.PRIVATE_UPLOAD_CRID ?? '', // Independently held; missing fails closed.
  });
  try {
    await opener.start();
    return await opener.fetch(
      (authenticatedTarget) => ({
        method: 'POST',
        headers: signUploadForExactTarget(authenticatedTarget),
        body: uploadBody,
      }),
      { redirects: 'error' },
    );
  } finally {
    await opener.close();
  }
}
```

For a service whose ACK target is a base path, append only trusted raw path
segments with `fetchDescendant()`. The opener rejects empty, dot, and delimiter
segments and escapes each accepted segment before it sends the request:

```javascript
const response = await opener.fetchDescendant(
  ['eib_example'],
  (authenticatedTarget) => ({ method: 'POST' }),
  { redirects: 'error' },
);
```

The request builder receives a copy of the selected authenticated target. The
opener ignores mutations to that copy and sends the initial request only to the
fixed ACK URL or the validated descendant. A descendant call accepts raw path
segments, not a URL or path string. It preserves the ACK target query and
escapes each segment separately. It adds the private `qurl_vsession` cookie,
replaces a caller-supplied cookie with that name, and preserves other valid
cookies, including duplicate `Cookie` entries that Node joins with semicolons.
It does not accept a caller URL, and it rejects a caller-supplied `Host` header
so Fetch derives the authority from the pinned target. Both `fetch()` and
`fetchDescendant()` use only the cached NHP 1.1 admission. Use
`redirects: 'error'` to keep a descendant request at its initial target. The
default `follow` mode can move outside that path subtree, but only within the
authenticated origin. Also use `redirects: 'error'` for a request whose
signature binds its method, target, timestamp, or nonce. This mode closes a
redirect response and does not replay the request. Follow mode permits at most
10 requests, including the initial request, and uses the standard 301/302/303
method rewrite rules. As in Go, a 3xx response with no `Location` header, or a
307/308 response whose streaming body cannot be replayed, is returned to the
caller without a follow-up request. The caller then owns that response body and
must consume or cancel it. Local admission expiry is checked before the first
request; the protected service remains authoritative while a permitted redirect
chain is in progress.

When `fetch()` rejects before it sends a direct `RequestInit`, it releases a
caller-owned streaming body. It cancels a web `ReadableStream`, destroys a Node
`Readable`, or closes another iterator when that body supports the operation. A
request builder remains lazy and is not called until a grant is ready.

Each open has a whole-operation deadline that covers DNS and UDP.
`openTimeoutMs` sets this ceiling; the default is 15 seconds and the maximum is
60 seconds. Native DNS or address attempts can fail before this ceiling, so a
larger value does not extend their internal timeouts. A renewal also stops at
the old grant's expiry. Pass an abort signal to `start()` when lifecycle code
needs a shorter deadline. Concurrent `start()` calls share one attempt. The
first caller's signal owns that attempt, so its abort fails all waiters but does
not count as an open failure in health. A cold cancellation restores `new`; a
recovery cancellation preserves its prior `degraded` health. A later waiter's
abort stops only that wait.
Content requests use the caller's `RequestInit.signal`; `fetch()` does not add
an independent application-request deadline. The signal stays active while the
returned response body is read. Set the opener's optional `fetch` when the
protected request must use a custom Fetch implementation. Native NHP opening
never uses this function. The custom function receives the `qurl_vsession`
bearer cookie and is inside the credential boundary. It must implement standard
Fetch signal behavior and honor `redirect: 'manual'`. If it needs a receiver,
pass it already bound; the SDK invokes it with the standard global Fetch
receiver. An unfollowed synthetic response can leave `Response.url` empty.
Otherwise, it must report
`Response.url` and `Response.redirected` accurately. It must not log or forward
protected request headers.

TypeScript consumers of `@layervai/qurl/node` must provide Node and Fetch API
declarations, for example current `@types/node`, or a configuration that includes
the `DOM` library for Fetch types. The native opener requires Node 22.12 or later.
This floor ensures that composite request signals are reclaimed on long-lived
openers.

Native opening requires public deployment trust. Set `QURL_DEPLOYMENT` to one
strict JSON object or to a path that contains that object. The object must have
trusted P-256 issuer keys and native cell host, UDP port 443, and X25519 public
key entries. A configured path must be a regular file no larger than 1 MiB.
Construction does no I/O. `start()` resolves and validates the deployment, and
the first successful open pins that resolved trust for renewal and recovery.
The opener does not perform discovery. It fails before DNS if the verified link
names an unknown cell.

Use `opener.health()` for the local `new`, `starting`, `ready`, `degraded`, or
`closed` state. It reports absolute expiry, renewal, and last-success times, a
secret-free failure class, and the number of consecutive unsuccessful open
attempts. A renewal window can contain more than one such attempt. The
`starting` state is only for the first cold open; an explicit recovery from a
failure reports `degraded` until it succeeds. Date fields describe the most
recent successful grant, so use `ready` as the authority for current usability.
A transient renewal failure keeps the state `ready` while the prior admission
is usable. A changed authenticated target is not retried. It keeps the prior
admission until expiry. During that time, `start()` remains idempotent because
the old admission is still usable; `health().lastFailureClass` reports the
target change. After expiry, an explicit `start()` attempts recovery. If the
target change is intentional and permanent, create a new opener for the new
qURL; the old opener stays bound to its first authenticated target. Other
failures retry through the remaining admission window. This does not put an
open or sleep on the `fetch()` path.

Close cancels and waits for an active NHP open, then wipes the mutable
private-key, visitor-secret, and session-token buffers. Close also aborts a
protected request and its returned response body, and prevents another redirect
leg from starting. JavaScript can create immutable string copies during JSON
and HTTP processing, so the SDK cannot promise full memory zeroization before garbage
collection. The opener retains the immutable qURL string until close so it can
verify each renewal. Never log the qURL, ACK body, request cookies, or request
headers.

A cold `start()` failure leaves health at `degraded`. Catch `PortalBusyError`
for an authenticated COOKIE busy response and `PortalInvalidReplyError` for a
malformed authenticated reply. An open deadline throws `PortalOpenTimeoutError`.
The thrown typed error is the cold-start
diagnostic; health does not expose its message or secret values.

Local qv2 verification checks the signed bytes, trust, and clock-free claim
ordering. As in the Go SDK, it does not compare `nbf` or `exp` with the local
clock. The authenticated NHP open is the authoritative live validity check.
The opener also follows the Go NHP COOKIE rule: an authenticated COOKIE is
a busy result and does not use ACK counter correlation or local clock skew
checks. Replaying it can only force another busy result; it cannot grant access.

## REST-Shaped API (Compatibility)

The original REST-shaped methods remain fully supported and share the same
client. Use them for the qURL/resource/token management surface that has no
portal-verb equivalent (listing, updating, revoking, quotas, webhooks, ...) or
if you already build on them:

```typescript
// Create a protected link (portal equivalent: createPortalForUrl)
const result = await client.create({
  target_url: 'https://api.example.com/data',
  expires_in: '24h',
  label: 'API access for agent',
});
console.log(result.qurl_link);

// Resolve a token headlessly (portal equivalent: enterPortal)
const access = await client.resolve('at_k8xqp9h2sj9lx7r4a');
console.log(`Access granted to ${access.target_url} for ${access.access_grant?.expires_in}s`);
```

## API

### `new QURLClient(options)`

| Option | Required | Default |
|--------|----------|---------|
| `apiKey` | Yes | — |
| `baseUrl` | No | `https://api.layerv.ai` |
| `maxRetries` | No | `3` |
| `timeout` | No | `30000` (ms) — *per attempt*, not total |
| `fetch` | No | `globalThis.fetch` |
| `userAgent` | No | `qurl-typescript/<version>` |
| `debug` | No | `false` |

### Portal methods

| Method | Description |
|--------|-------------|
| `protectUrl(targetUrl, opts?)` | Protect a private URL → portal-minting `ProtectedResource` handle |
| `resource.createPortal(opts?)` / `createPortal(resourceOrId, opts?)` | Mint a short-lived portal link; existing resources can set `targetPath` |
| `createPortalForUrl(targetUrl, opts?)` | Protect + mint a URL resource; rejects `targetPath` |
| `ensureConnectorResource(slug, requestOptions?)` | Find or create an active Connector resource by immutable slug |
| `getConnectorResource(crid)` / `getConnectorResourceBySlug(slug)` | Load a validated Connector resource by immutable identity |
| `deleteConnectorResource(crid)` | Revoke a Connector resource by CRID |
| `resourceByCrid(crid)` | Handle from a stored CRID (no API call) |
| `enterPortal(linkOrToken)` | Open a qURL link programmatically → `ResourceHandle` |

### REST-shaped methods

| Method | Description |
|--------|-------------|
| `create(input)` | Create a protected link |
| `batchCreate(input)` | Create up to 100 protected links in one request |
| `get(id)` | Get qURL details |
| `list(input?)` | List qURLs (single page) |
| `listAll(input?)` | Iterate all qURLs (auto-paginating) |
| `delete(id)` | Revoke a qURL resource and all its tokens |
| `extend(id, input)` | Extend expiration |
| `update(id, input)` | Update qURL resource properties |
| `mintLink(id, input?)` | Mint a new access link |
| `resolve(input)` | Resolve token + grant network access |
| `getQuota()` | Get quota/usage info |
| `listResources(input?)` / `listAllResources(input?)` / `createResource(input)` / `getResource(id)` | Resource management |
| `updateResource(id, input)` / `deleteResource(id)` | Update or revoke resources |
| `createQurlForResource(id, input?)` | Mint a qURL for an existing resource |
| `updateResourceQurl(id, qurlId, input)` / `revokeResourceQurl(id, qurlId)` | Manage one token on a resource |
| `listResourceSessions(id)` / `terminateAllResourceSessions(id)` / `terminateResourceSession(id, sessionId)` | Inspect or terminate active sessions |
| `listConnectorInstallations(input?)` / `listAllConnectorInstallations(input?)` | List connector installations |
| `getUsageCurrentPeriod()` / `getUsageDaily()` | Usage reporting |
| `getCustomer()` / `updateCustomer(input)` | Customer settings |
| `createBillingCheckout(input)` / `createBillingPortal()` / `listBillingInvoices(input?)` / `listAllBillingInvoices(input?)` | Billing flows |
| `registerDomain(input)` / `listDomains(input?)` / `listAllDomains(input?)` / `getDomain(domain)` | Custom domain management |
| `verifyDomain(domain)` / `regenerateDomainToken(domain)` / `deleteDomain(domain)` | Domain verification and removal |
| `listWebhooks(input?)` / `listAllWebhooks(input?)` / `createWebhook(input)` / `getWebhook(id)` | Webhook management |
| `updateWebhook(id, input)` / `deleteWebhook(id)` / `regenerateWebhookSecret(id)` | Webhook updates and secret rotation |
| `listWebhookEventTypes()` / `listWebhookDeliveries(id, input?)` / `listAllWebhookDeliveries(id, input?)` | Webhook metadata and delivery history |
| `createApiKey(input)` / `listApiKeys(input?)` / `listAllApiKeys(input?)` / `updateApiKey(id, input)` / `revokeApiKey(id)` | API key management |
| `createAccessCode(input)` / `listAccessCodes()` / `redeemAccessCode(input)` / `revokeAccessCode(id)` | Access code management |

`listResourceSessions(id)` and `listAccessCodes()` reflect currently unpaginated service endpoints. Their outputs always return `has_more: false`; if the service starts surfacing cursor metadata, the SDK emits a debug log rather than exposing an unactionable next-page signal.

`listAll*()` methods validate ids and query params when called, before the async iterator is consumed. Wrap the `listAll*()` call itself in `try/catch` when passing dynamic input.

### `batchCreate(input)`

Create up to 100 qURLs in a single request. **Does not throw on partial or total failure** — per-item errors are returned in the `results` array, so `try/catch` alone won't surface them. Always inspect `result.failed` and iterate `result.results`:

```typescript
const result = await client.batchCreate({
  items: [
    { target_url: 'https://api.example.com/data', expires_in: '24h' },
    { target_url: 'https://api.example.com/admin', expires_in: '1h' },
  ],
});

if (result.failed > 0) {
  for (const r of result.results) {
    if (!r.success) {
      console.error(`items[${r.index}]: ${r.error.code} - ${r.error.message}`);
    }
  }
}
```

Non-400 errors (401, 403, 429, 5xx, and unexpected 400 body shapes) still throw the appropriate `QURLError` subclass.

**Slimmer per-item shape** — `BatchItemSuccess` returns `{ crid, resource_id, qurl_link, qurl_site, expires_at? }` per item. Unlike single `client.create()`, the batch response intentionally **omits `qurl_id` and `label`** to keep the payload compact. If you migrate a per-item `create()` loop to `batchCreate` and rely on `qurl_id` for downstream addressing, check `item.crid` is present, then fetch each via `client.get(item.crid)` after the batch (or stay on the single-create path).

**Result ordering** — `result.results` is **not** guaranteed to be sorted by `index`. Each entry's `index` field carries the position in the original `items` array, so build per-input-position state by keying on `r.index` (e.g., `for (const r of result.results) { byInputIndex[r.index] = r; }`) rather than relying on iteration order.

**Out-of-range or duplicate `index` values** — the SDK throws `QURLError` (`code: "unexpected_response"`) on either condition, since both indicate server misbehavior that would silently break per-item attribution (a `Map` keyed on `r.index` would last-write-wins, an out-of-range index would attribute to a non-existent slot).

## Error Handling

Match errors by type, not message text — every failure throws a typed `QURLError` subclass, and message wording is not part of the API contract:

```typescript
import {
  QURLError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@layervai/qurl';

try {
  await client.enterPortal('https://qurl.link/#at_k8xqp9h2sj9lx7r4a');
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error('Bad API key');
  } else if (err instanceof NotFoundError) {
    console.error('Portal doesn\'t exist or already expired');
  } else if (err instanceof RateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfter}s`);
  } else if (err instanceof ValidationError) {
    console.error('Invalid input:', err.detail, err.invalidFields);
  } else if (err instanceof QURLError) {
    console.error(`API error [${err.code}]: ${err.detail}`);
  }
}
```

| Error Class | HTTP Status | When |
|-------------|-------------|------|
| `AuthenticationError` | 401 | Invalid or missing API key |
| `AuthorizationError` | 403 | Key lacks required scope |
| `NotFoundError` | 404 | Resource doesn't exist |
| `ValidationError` | 400, 422 | Invalid request body |
| `RateLimitError` | 429 | Too many requests |
| `ServerError` | 5xx | Server-side failure |
| `NetworkError` | — | Connection failure |
| `TimeoutError` | — | Request exceeded timeout |
| `DelegatedBatchOutcomeUnknownError` | — | Dispatched batch create needs reconciliation |

Client-detected failures use `status: 0` with a discriminating `code`:
`"client_validation"` for bad input caught before a request, and — on the
portal surface — `"resource_not_found"` / `"ambiguous_resource"` when
`getConnectorResourceBySlug` cannot resolve a slug to exactly one resource,
and `"unexpected_response"` when a response is missing required fields (e.g.
`enterPortal` failing closed on a grant with no resource URL).

## Pagination

```typescript
// Single page
const page = await client.list({ limit: 10, status: 'active' });

// Auto-paginate through all results
for await (const qurl of client.listAll({ status: 'active' })) {
  if (!qurl.crid) throw new Error("The API response has no resource CRID");
  console.log(qurl.crid);
}
```

## Debug Logging

Enable debug output to see all HTTP requests and retries:

```typescript
// Log to console
const client = new QURLClient({ apiKey: 'YOUR_API_KEY', debug: true });

// Custom logger
const clientWithLogger = new QURLClient({
  apiKey: 'YOUR_API_KEY',
  debug: (message, data) => myLogger.debug(message, data),
});
```

## Retry Behavior

The client retries only requests whose replay contract is explicit:

- **GET**: Retries on 429, 502, 503, 504 and transport failures, including a
  dropped response body after successful headers arrive
- **POST/PATCH**: Retries complete status responses only on 429. A transport
  failure while reading a response body is not replayed because the mutation
  may have applied.
- **POST/PATCH fetch failures**: Retried with the `Idempotency-Key` generated on
  the first attempt when no response is available
- **DELETE**: Never replayed automatically, including on 429. A transport
  failure after dispatch makes the mutation outcome unknown, and the HTTP verb
  alone cannot prove a replay safe. Reconcile resource state before you issue
  a deliberate retry. This matches qurl-go's explicit-caller-retry model.
- **`Retry-After` header**: Preserved on 429 and 503 responses, including when
  a mid-body transport failure produces a status-derived error (RFC 7231
  §7.1.3), and honored by automatic GET retries. Currently the SDK only parses
  **delta-seconds** values (e.g.
  `Retry-After: 30`); HTTP-date values (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`)
  silently fall back to exponential backoff. Tracked in
  [#61](https://github.com/layervai/qurl-typescript/issues/61).
- **Response failures**: Redirects, oversized successful bodies, and malformed
  UTF-8 successful bodies are not retried. Retryable error statuses remain
  retryable when an intermediary returns HTML, an empty body, malformed UTF-8,
  or another complete non-envelope error response. A mid-stream transport
  failure is retried for a successful GET or a GET with a retryable status.
  A hard 4xx GET is not retried. An independent `AbortError` or `TimeoutError`
  from an injected fetch, or while reading a successful response body, is a
  non-retried `NetworkError`. After non-success headers arrive, the SDK
  preserves the status-derived error class and attaches the independent
  failure as its cause without retrying it. Only the SDK's timeout signal
  produces a `TimeoutError`. Mutations require reconciliation.

All documented no-content DELETE operations require exactly HTTP 204 with an
empty response body. Alternate success statuses or response bytes fail closed
as `unexpected_response` contract errors whose `.status` preserves the
observed HTTP status. The delete may already have applied; reconcile resource
state before retrying.

Configure with `maxRetries` (default: 3). Set to `0` to disable.

When DELETE returns `RateLimitError`, use `retryAfter` for scheduling but
reconcile current resource state before issuing a deliberate retry; the SDK
does not assume the rejected response proves the mutation never ran.

> **Worst-case latency**: `timeout` is enforced per *attempt*, not for the whole request. Total worst-case latency is roughly `timeout × (maxRetries + 1) + sum(retry delays)`. Operators tuning `timeout` should account for this when sizing health-check budgets.

For POST/PATCH requests, the SDK generates a UUIDv7 `Idempotency-Key` once per logical call and reuses it across SDK-managed retries, so the API can return the original result instead of creating duplicate resources. If your application catches an error and calls the SDK again, pass a stable override so the new call deduplicates with the first one. Caller-provided keys must be non-empty printable ASCII strings of at most 256 characters and must not start or end with spaces. Use a unique key for each logical operation; reusing one key for a different request can return the first cached response. To tie retries to your own upstream job or request ID, pass a per-call override:

```typescript
await client.create(
  { target_url: 'https://api.example.com/data' },
  { idempotencyKey: 'job_12345_create_qurl' },
);
```

The portal verbs take the same per-call options as their final argument, e.g.
`resource.createPortal({ validFor: '5m' }, { idempotencyKey: 'mint-alice-1' })`.

SDK-generated keys require `globalThis.crypto.getRandomValues`, which is available in supported Node 20+ runtimes and modern edge/browser runtimes. In constrained runtimes without Web Crypto, pass a caller-provided key with `idempotencyKey`; otherwise POST/PATCH calls throw `RuntimeError` before sending a request.

## Security Notes

- Treat API keys and qURL links like credentials. Do not log them.
- Resource/qURL path arguments reject pasted access tokens and full URLs before
  dispatch without echoing the caller input. Pass the opaque identifier returned
  by the API (public resource key or CRID); never derive it from a secret qURL
  link. Private `r_` storage IDs are not public API identifiers.
- SDK API requests use manual redirect handling. Redirect-capable HTTP statuses
  (300, 301, 302, 303, 305, 307, 308), filtered `opaqueredirect` responses in
  browsers and Node native fetch, and responses a custom fetch reports as
  already redirected are rejected as a typed `QURLError`
  (`code: "unexpected_response"`) without requesting the `Location` target.
  This prevents forwarding `Authorization` and
  `Idempotency-Key` when the fetch implementation honors `redirect: "manual"`
  and accurately exposes `Response.redirected`. A shim must also leave
  `Response.url` empty or report the normalized request URL when it did not
  follow a redirect. Every Response-like shim must provide `headers.get(name)`.
  A non-empty invalid `Response.url` fails closed with an SDK-authored error
  that names this shim requirement but does not reflect the invalid value. A
  non-redirecting 304 is handled as an ordinary unsuccessful API response
  rather than mislabeled as a redirect.
- API success and error bodies are limited to **1 MiB (1,048,576 bytes)**,
  matching qurl-go's security posture. The SDK checks `Content-Length` when
  present and independently counts streamed bytes, so missing or inaccurate
  headers cannot bypass the limit. Bodies exactly at the limit are accepted.
  This fixed security limit has no override. Callers must request a smaller
  page, and the SDKs must not independently widen the limit.
  A maximum-size list page can exceed the cap after JSON escaping; request a
  smaller page if a list call reports the body-limit error. For resumable list
  reads, use the page method, save each successful `next_cursor`, and resume
  from that cursor with a smaller `limit`. A shared configurable-cap decision
  is tracked in [#249](https://github.com/layervai/qurl-typescript/issues/249).
  Standards-compliant fetch implementations are bounded while streaming;
  custom Response-like shims that omit `body` are validated after their
  `text()`/`json()` result has already been materialized by that shim.
  Oversized bodies fail with a typed error before JSON decoding while
  preserving the observed status-derived error class and `Retry-After`.
  Transient error statuses retain the normal retry policy for GET and
  idempotency-key-backed mutations; oversized successful responses and DELETE
  responses are not retried.
  Successful JSON bodies with malformed UTF-8 are rejected without replay.
  Server-provided error title/detail snippets and `invalidFields` keys/values
  have controls and bidirectional formatting characters removed, are
  normalized to one line, and are capped at 512 UTF-8 bytes. Machine-readable
  error codes, RFC 7807 type/instance values, and request IDs are kept only
  when they need no normalization and fit the same limit. At most 100
  `invalidFields` entries are retained, and each retained
  `invalidFields` or debug `body_keys` collection has an 8 KiB UTF-8 budget.
  Redirect/body-limit contract-error details do not include `Location` values
  or response-body snippets. Standard request debug logging includes the request
  URL, so do not place credentials in identifiers or enable debug output in a
  sensitive logging environment.
- Prefer short portal lifetimes such as `validFor: '5m'`.
- Do not ask portal recipients to handle credentials. Recipients only need
  the link.
- `protectUrl` and `createPortalForUrl` reject malformed target URLs and URLs
  with embedded credentials (`https://user:pass@...`) before any request,
  matching qurl-go.
- The programmatic opener fails closed: `enterPortal` throws when access is
  granted without a resource URL, and its error messages never echo the link.

## Versioning & breaking changes

This SDK is pre-1.0; breaking changes between minor versions are possible until the API surface stabilizes. Significant changes are called out in [`CHANGELOG.md`](CHANGELOG.md) and in the corresponding GitHub release notes.

When upgrading, check the release notes for migration guidance — recent breaking changes have included field renames (`description` → `label` on create), removed fields (`metadata`), narrowed type unions (`QURL.status`), and endpoint relocations (`/v1/qurl` → `/v1/qurls`).

## License

MIT

Resource verification requires Web Crypto (`crypto.subtle`). In browsers, use
an HTTPS page or localhost. Raw REST response types keep `crid` optional;
resource handles and portals require a validated CRID.

## Node producer runtime (SDK 2.x, NHP 1.1)

The SDK implements the producer lifecycle in TypeScript. A small optional native
package, `@layervai/qurl-state-fs`, supplies descriptor-relative filesystem
operations on Linux and macOS. There is no bundled Go runtime. The portable
`@layervai/qurl` entry point does not load the native module.

```ts
import { FileAgentState, connectAgentRuntime } from '@layervai/qurl/node';

const store = new FileAgentState('/private/agent/state.json');
const runtime = await connectAgentRuntime(store, {
  hub: { host: 'hub.nhp.layerv.ai', port: 443, server_public_key_b64: hubPublicKey },
  headless: true,
  enrollmentCredential: bootstrapCredential,
});
try {
  // runtime.client uses the durable device credential, with bounded reloads.
  const grant = await runtime.knock(knockResourceID, {
    protectedResourceID: crid, runID: '0123456789abcdef', runAttempt: 1n,
  });
  // Keep the original receipt. It retains the issuing cell across relocation.
  await runtime.retire(grant.receipt);
} finally {
  runtime.close();
  store.close();
}
```

A registered state opens without enrollment or network work while its assignment
lease is current. An explicit Hub option or the `hub` field in `QURL_DEPLOYMENT`
provides refresh trust. `runtime.refresh()` handles assignment renewal and
relocation. `knock()` attempts renewal near lease expiry and refuses expired
assignments. Account enrollment uses an explicit `otpProvider` instead of
`headless`. Resume an interrupted enrollment with the same credential and
metadata. The SDK persists activation and completion replay authority before
sending the corresponding mutation.

`recoverAgentRuntime(store, recoveryCredential, { hub })` starts explicit device
credential recovery. It persists the issue nonce, replacement candidate, and
recovery horizon. It saves the recovered credential before mandatory assignment
refresh. A failed refresh resumes without another recovery grant. No startup
path silently resets an existing identity.

`FileAgentState` uses a private directory, mode 0600 files, a process-safe setup
lock, exclusive temporary files, file and directory fsync, and atomic replacement.
It rejects symlinks, hard links, unsafe permissions, and directory or lock
replacement. Keep the store open until its runtime has closed. Filesystem state
uses synchronous native I/O, including fsync, on the event loop. Use local storage;
slow or network filesystems can block the process. Continuity checks also run before
lifecycle datagrams and cannot be cached safely across external directory changes.
An existing state directory must be owned by the process user with mode 0700.
On macOS, `/var`, `/tmp`, and `/etc` resolve through their standard `/private` paths.
A save error after rename can mean the new state is present but its durability is
unconfirmed; do not assume the previous state remains. Filesystem state
currently requires Linux or macOS; unsupported platforms fail closed. Install
scripts may be disabled when a matching prebuilt native binary is available.
Linux x64/arm64 prebuilds distinguish glibc and musl; CI tests Ubuntu 24.04 and
Alpine 3.22. macOS prebuilds cover x64 and arm64.

For sealed state, use `openSealedFileAgentState(path, providerID, keyWrapper,
expectedAgentID)`. Each save uses a fresh AES-256-GCM key and verifies wrapping and
unwrapping before commit. The envelope is compatible with the pinned Go SDK.
Sealing authenticates the agent, provider, purpose, version, and wrapped-key
metadata. It does not detect rollback to an older valid envelope. JavaScript
strings cannot be reliably erased; avoid logging state or credentials.

AWS adapters are separate exports from `@layervai/qurl-aws` (ESM and CommonJS):

- `createSSMAgentStateStore(ssmClient, parameterName, { kmsKeyID, tier })` stores
  SecureString parameters and enforces tier size limits.
- `createSecretsManagerAgentStateStore(secretsClient, secretID, kmsKeyID)` handles
  missing-secret creation races with one write token.
- `createKMSAgentStateKeyWrapper(kmsClient, keyID)` wraps only the data key and
  authenticates all four state-binding fields in the KMS encryption context.

SSM and Secrets Manager stores serialize lifecycle calls within one store handle.
They require one process to own each state object: these services do not provide
an agent setup transaction lock. KMS is a key wrapper, not a state store.

## Explicit relay and discovery

Native UDP remains the default transport. An unknown cell fails closed, including
when a relay allowlist exists. Select `transport: 'relay'` explicitly to use HTTPS
relay. Relay URLs come from verified qv2 claims and must match deployment trust.
Redirects and oversized responses are refused.

`createStaticProvider(deployment)` snapshots fixed trust. For discovery, use
`createDiscoveryProvider({ fetcher, pinSHA256, manifestKeys, requireSignature,
minVersion, expectedProfile })` and `createHTTPManifestFetcher(httpsURL)`. Supply
a manifest pin or signing keys. Discovery verifies the domain-separated low-S
signature when configured, validity times, profile, and monotonic version floor.
It never returns stale trust after a failed refresh. Persist `minVersion` in
configuration when downgrade protection must survive process restarts.

```ts
const opener = createPortalOpener({ qurl: signedLink, provider, transport: 'relay' });
```

The SHA-pinned reviewed baseline and behavior gates are in `parity-manifest.json`.
CI reports the candidate SHA and tests that candidate against pinned Go behavior.
It does not require release or dependency PRs to match the baseline tree.
Run `npm run build`, `npm test`, `npm run smoke:dist`, and `npm run parity:go`.
Set `QURL_GO_REFERENCE` to a clean checkout at the manifest's exact Go revision.
The direct gate compares producer wire bytes and sealed-state reads and writes
across both languages. It also runs the TypeScript lifecycle against a local Go UDP
peer: registration, restart, relocation, exact retirement, and credential recovery.
This checks protocol interoperability; the peer is not a sandbox authority.
Shared conformance vectors cover assignment, registration,
OTP, and completion packet construction and reply decryption.
