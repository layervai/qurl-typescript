# Shared Go and TypeScript API response limit

Decision for [TypeScript #249](https://github.com/layervai/qurl-typescript/issues/249):
keep the existing 1 MiB default and allow an explicit, bounded per-client cap.
The Go and TypeScript SDKs use the same policy.

| Setting | Policy |
| --- | --- |
| Default | 1,048,576 bytes (1 MiB) |
| Explicit range | Integer from 1 through 16,777,216 bytes (16 MiB) |
| Invalid values | Zero, negative, fractional, non-finite, or above the ceiling |
| Bytes counted | Decoded response bytes delivered by the HTTP transport |
| Scope | Each API response, including error and ignored-body responses |

```ts
const client = new QURLClient({
  apiKey,
  maxResponseBodyBytes: 16 * 1024 * 1024,
});
```

```go
client, err := qurl.NewClient(credentials,
    qurl.WithMaxResponseBodyBytes(16 << 20))
```

The Go option also configures resource Clients returned by native agent
lifecycle calls. It does not change native UDP message limits.

Streaming byte accounting is mandatory even when Content-Length is absent or
falsely small. A valid oversized, unencoded Content-Length may reject early;
malformed or duplicate length hints fall back to streaming. An encoded
Content-Length describes compressed wire bytes and is not compared with the
decoded cap. Custom HTTP/fetch providers must supply the documented response
contract. A provider may allocate an oversized chunk or materialized string
before the SDK can reject it.

Invalid configuration fails before I/O: Go returns ErrInvalidClientConfig
(or the native lifecycle configuration error); TypeScript throws
ValidationError with client_validation. An oversized successful response is an
invalid API response: errors.Is(err, qurl.ErrInvalidAPIResponse) in Go, or
ValidationError with unexpected_response in TypeScript. An oversized error
response retains its HTTP status class, without trusting an unread server
error code. Existing endpoint retry and idempotency rules still apply; a body
limit failure does not authorize replaying a mutation.

## Legal pages can exceed the default

The [published OpenAPI contract](https://layerv.ai/docs/qurls.yaml), checked
against the [validation snapshot](../contract/validation-bounds.json), permits
100 resources per page, 2048-character target URLs, 500-character descriptions,
ten 50-character tags, and 256 allowed device keys and passkeys. A passkey name
can have 64 characters. These bounds were checked on 2026-10-31.

Both SDK tests construct a legal 100-row boundary page with unique matching
P-256 resource identities and those field/access-list maxima. Normal service
JSON escaping makes it 14,771,352 bytes. The default rejects it and the explicit
16 MiB cap accepts it. This fixture is not a promise that every possible future
response fits the ceiling. Page count is not a response-byte bound.

## Resume with a smaller page

Keep the last successful next_cursor and all filters. If the next page exceeds
the cap, retry that same cursor with a smaller limit. Do not advance the cursor
from a failed response. The service cursor identifies a position, not a page
size. For example, retry a failed 100-row request with 50, then 25, and continue
halving if needed. Stop if a one-row request still exceeds the cap. Alternatively,
create a client with a larger cap within the shared ceiling and retry the same
read.

The tests cover a successful page, an oversized next page, and a smaller-page
retry from the saved cursor with unchanged filters. No failed page is returned
or silently skipped. Both conditional TypeScript exports are tested.

Keep the default for ordinary traffic. The cap is per response; concurrent
requests multiply the memory budget. Chunk assembly, UTF-8 decoding and JSON
parsing need additional memory. Smaller pages are the first choice for bulk
traversal.
