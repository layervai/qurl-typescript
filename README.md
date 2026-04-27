# @layerv/qurl

[![npm](https://img.shields.io/npm/v/@layerv/qurl)](https://www.npmjs.com/package/@layerv/qurl)
[![CI](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/layervai/qurl-typescript)](LICENSE)

TypeScript SDK for the [qURL™ API](https://docs.layerv.ai) — secure, time-limited access links for AI agents.

> **Quantum URL (qURL)** · The internet has a hidden layer. This is how you enter.

## Why qURL?

AI agents need to access protected resources — APIs, databases, internal tools — but giving them permanent credentials is a security risk. qURL creates time-limited, auditable access links that expire automatically. The SDK handles authentication, retries, pagination, and error handling so you can focus on your agent logic.

## Installation

```bash
npm install @layerv/qurl
```

Requires Node.js 18+. Both `import { QURLClient } from '@layerv/qurl'` (ESM) and `const { QURLClient } = require('@layerv/qurl')` (CJS) work.

## Quick Start

```typescript
import { QURLClient } from '@layerv/qurl';

const client = new QURLClient({ apiKey: 'lv_live_xxx' });

// Create a protected link
const result = await client.create({
  target_url: 'https://api.example.com/data',
  expires_in: '24h',
  label: 'API access for agent',
});
console.log(result.qurl_link);

// Resolve a token (opens firewall for your IP)
const access = await client.resolve('at_...');
console.log(`Access granted to ${access.target_url} for ${access.access_grant?.expires_in}s`);
```

## API

### `new QURLClient(options)`

| Option | Required | Default |
|--------|----------|---------|
| `apiKey` | Yes | — |
| `baseUrl` | No | `https://api.layerv.ai` |
| `maxRetries` | No | `3` |
| `timeout` | No | `30000` (ms) |
| `fetch` | No | `globalThis.fetch` |
| `userAgent` | No | `qurl-typescript/<version>` |
| `debug` | No | `false` |

### Methods

| Method | Description |
|--------|-------------|
| `create(input)` | Create a protected link |
| `batchCreate(input)` | Create up to 100 protected links in one request |
| `get(id)` | Get qURL details |
| `list(input?)` | List qURLs (single page) |
| `listAll(input?)` | Iterate all qURLs (auto-paginating) |
| `delete(id)` | Revoke a qURL |
| `extend(id, input)` | Extend expiration |
| `update(id, input)` | Update qURL properties |
| `mintLink(id, input?)` | Mint a new access link |
| `resolve(input)` | Resolve token + open firewall |
| `getQuota()` | Get quota/usage info |

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

All API errors throw typed error subclasses, so you can catch specific failure modes:

```typescript
import {
  QURLError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@layerv/qurl';

try {
  await client.create({ target_url: '' });
} catch (err) {
  if (err instanceof ValidationError) {
    console.error('Invalid input:', err.invalidFields);
  } else if (err instanceof RateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfter}s`);
  } else if (err instanceof AuthenticationError) {
    console.error('Bad API key');
  } else if (err instanceof NotFoundError) {
    console.error('Resource not found');
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
const client = new QURLClient({ apiKey: 'lv_live_xxx', debug: true });

// Custom logger
const client = new QURLClient({
  apiKey: 'lv_live_xxx',
  debug: (message, data) => myLogger.debug(message, data),
});
```

## Retry Behavior

The client automatically retries failed requests with exponential backoff:

- **GET/DELETE**: Retries on 429, 502, 503, 504
- **POST/PATCH**: Retries only on 429 (to avoid duplicate side effects)
- **Network errors**: Always retried
- **`Retry-After` header**: Honored on 429 and 503 responses (RFC 7231 §7.1.3). Currently the SDK only parses **delta-seconds** values (e.g. `Retry-After: 30`); HTTP-date values (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`) silently fall back to exponential backoff. Tracked in [#61](https://github.com/layervai/qurl-typescript/issues/61).

Configure with `maxRetries` (default: 3). Set to `0` to disable.

## Versioning & breaking changes

This SDK is pre-1.0; breaking changes between minor versions are possible until the API surface stabilizes. Significant changes are called out in [`CHANGELOG.md`](CHANGELOG.md) and in the corresponding GitHub release notes.

When upgrading, check the release notes for migration guidance — recent breaking changes have included field renames (`description` → `label` on create), removed fields (`metadata`), narrowed type unions (`QURL.status`), and endpoint relocations (`/v1/qurl` → `/v1/qurls`).

## License

MIT
