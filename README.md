# @layerv/qurl

[![npm](https://img.shields.io/npm/v/@layerv/qurl)](https://www.npmjs.com/package/@layerv/qurl)
[![CI](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/layervai/qurl-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/layervai/qurl-typescript)](LICENSE)

TypeScript SDK for the [QURL API](https://docs.layerv.ai) — secure, time-limited access links for AI agents.

## Why QURL?

AI agents need to access protected resources — APIs, databases, internal tools — but giving them permanent credentials is a security risk. QURL creates time-limited, auditable access links that expire automatically. The SDK handles authentication, retries, pagination, and error handling so you can focus on your agent logic.

## Installation

```bash
npm install @layerv/qurl
```

> **Note:** This package is ESM-only. It requires Node.js 18+ and `"type": "module"` in your `package.json` (or use `.mjs` extensions).

## Quick Start

```typescript
import { QURLClient } from '@layerv/qurl';

const client = new QURLClient({ apiKey: 'lv_live_xxx' });

// Create a protected link
const result = await client.create({
  target_url: 'https://api.example.com/data',
  expires_in: '24h',
  description: 'API access for agent',
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
| `get(id)` | Get QURL details |
| `list(input?)` | List QURLs (single page) |
| `listAll(input?)` | Iterate all QURLs (auto-paginating) |
| `delete(id)` | Revoke a QURL |
| `extend(id, input)` | Extend expiration |
| `update(id, input)` | Update QURL properties |
| `mintLink(id, input?)` | Mint a new access link |
| `resolve(input)` | Resolve token + open firewall |
| `getQuota()` | Get quota/usage info |

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
- **429 responses**: Honors `Retry-After` header

Configure with `maxRetries` (default: 3). Set to `0` to disable.

## License

MIT
