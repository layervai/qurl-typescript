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

Requires Node.js 20+ and has **no runtime dependencies**. Both `import { QURLClient } from '@layervai/qurl'` (ESM) and `const { QURLClient } = require('@layervai/qurl')` (CJS) work.

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

If qURL Connector already protects the service, use the connector id instead
of calling `protectUrl`:

```typescript
const resource = await client.connectorResource('prod-dashboard');
const portal = await resource.createPortal({ validFor: '5m' });
```

If you persist the resource id, future calls do not need to recreate the
handle (no API call is made until you mint):

```typescript
const resource = client.resourceById('r_demo1234567');
const portal = await resource.createPortal({ validFor: '1h' });
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
});
```

qURL Connector assignment and registration use native UDP through
`qurl-connector` and `qurl-go`. This TypeScript package handles browser and
management-plane qURL APIs; it does not expose an HTTP enrollment API.

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
| `resource.createPortal(opts?)` / `createPortal(resourceOrId, opts?)` | Mint a short-lived portal link (`Portal`) |
| `createPortalForUrl(targetUrl, opts?)` | Protect + mint in one API call → `{ portal, resource }` |
| `connectorResource(connectorId)` | Handle for a service qURL Connector already protects |
| `resourceById(id)` | Handle from a stored resource id (no API call) |
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

**Slimmer per-item shape** — `BatchItemSuccess` returns `{ resource_id, qurl_link, qurl_site, expires_at? }` per item. Unlike single `client.create()`, the batch response intentionally **omits `qurl_id` and `label`** to keep the payload compact. If you migrate a per-item `create()` loop to `batchCreate` and rely on `qurl_id` for downstream addressing, fetch each via `client.get(resource_id)` after the batch (or stay on the single-create path).

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

Client-detected failures use `status: 0` with a discriminating `code`:
`"client_validation"` for bad input caught before a request, and — on the
portal surface — `"resource_not_found"` / `"ambiguous_resource"` when
`connectorResource` cannot resolve a connector id to exactly one resource,
and `"unexpected_response"` when a response is missing required fields (e.g.
`enterPortal` failing closed on a grant with no resource URL).

## Pagination

```typescript
// Single page
const page = await client.list({ limit: 10, status: 'active' });

// Auto-paginate through all results
for await (const qurl of client.listAll({ status: 'active' })) {
  console.log(qurl.resource_id);
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

The client automatically retries failed requests with exponential backoff:

- **GET/DELETE**: Retries on 429, 502, 503, 504
- **POST/PATCH**: Retries status responses only on 429
- **Network errors**: Always retried; POST/PATCH requests send an `Idempotency-Key` on the first attempt and reuse it on retries
- **`Retry-After` header**: Honored on 429 and 503 responses (RFC 7231 §7.1.3). Currently the SDK only parses **delta-seconds** values (e.g. `Retry-After: 30`); HTTP-date values (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`) silently fall back to exponential backoff. Tracked in [#61](https://github.com/layervai/qurl-typescript/issues/61).

Configure with `maxRetries` (default: 3). Set to `0` to disable.

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
