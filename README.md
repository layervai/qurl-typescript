# @layerv/qurl

TypeScript SDK for the [QURL API](https://docs.layerv.ai) — secure, time-limited access links for AI agents.

## Installation

```bash
npm install @layerv/qurl
```

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
const access = await client.resolve({ access_token: 'at_...' });
console.log(`Access granted to ${access.target_url} for ${access.access_grant?.expires_in}s`);
```

## API

### `new QURLClient(options)`

| Option | Required | Default |
|--------|----------|---------|
| `apiKey` | Yes | — |
| `baseUrl` | No | `https://api.layerv.ai` |
| `maxRetries` | No | `3` |
| `fetch` | No | `globalThis.fetch` |
| `userAgent` | No | `qurl-typescript-sdk/0.1.0` |

### Methods

| Method | Description |
|--------|-------------|
| `create(input)` | Create a protected link |
| `get(id)` | Get QURL details |
| `list(input?)` | List QURLs with filters |
| `delete(id)` | Revoke a QURL |
| `extend(id, input)` | Extend expiration |
| `update(id, input)` | Update description |
| `mintLink(id, input?)` | Mint a new access link |
| `resolve(input)` | Resolve token + open firewall |
| `getQuota()` | Get quota/usage info |

## License

MIT
