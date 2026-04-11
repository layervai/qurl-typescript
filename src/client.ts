import { createError, NetworkError, QURLError, TimeoutError, ValidationError } from "./errors.js";
import type {
  AccessToken,
  BatchCreateInput,
  BatchCreateOutput,
  ClientOptions,
  CreateInput,
  CreateOutput,
  ExtendInput,
  ListInput,
  ListOutput,
  MintInput,
  MintOutput,
  QURL,
  QURLErrorData,
  Quota,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.layerv.ai";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 30_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_STATUS_MUTATING = new Set([429]);

// Shared empty default for the `passthroughStatuses` parameter on rawRequest,
// so each call that doesn't pass statuses doesn't allocate a fresh `[]`.
const NO_PASSTHROUGH_STATUSES: readonly number[] = [];

/** Allowlist of known query-param keys for the `list()` endpoint. */
const LIST_PARAM_KEYS = [
  "limit",
  "cursor",
  "status",
  "q",
  "sort",
  "created_after",
  "created_before",
  "expires_before",
  "expires_after",
] as const satisfies readonly (keyof ListInput)[];

// Compile-time completeness check: fails if a new key is added to ListInput
// but not to LIST_PARAM_KEYS. `satisfies` alone only validates that entries
// are valid keys, not that every key is listed — this plugs that gap.
type _ListParamKeysComplete =
  Exclude<keyof ListInput, (typeof LIST_PARAM_KEYS)[number]> extends never ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _listParamKeysComplete: _ListParamKeysComplete = true;

/**
 * Construct a {@link ValidationError} for a client-side pre-flight check.
 * Uses `status: 0` (matching {@link NetworkError}/{@link TimeoutError}) and
 * `code: "client_validation"` so catch-by-class still works and callers can
 * tell the error originated inside the SDK rather than from the API.
 */
function clientValidationError(detail: string): ValidationError {
  return new ValidationError({
    status: 0,
    code: "client_validation",
    title: "Invalid Argument",
    detail,
  });
}

interface ApiResponse<T> {
  data: T;
  meta?: {
    request_id?: string;
    page_size?: number;
    has_more?: boolean;
    next_cursor?: string;
  };
}

interface ApiErrorEnvelope {
  error?: {
    type?: string;
    title: string;
    status: number;
    detail: string;
    code: string;
    invalid_fields?: Record<string, string>;
  };
  meta?: { request_id?: string };
}

/** QURL API client. */
export class QURLClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly userAgent: string;
  private readonly debugFn: ((message: string, data?: Record<string, unknown>) => void) | undefined;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.userAgent = options.userAgent ?? `qurl-typescript/${VERSION}`;

    if (options.debug === true) {
      this.debugFn = (msg, data) => console.debug(`[qurl] ${msg}`, data ?? "");
    } else if (typeof options.debug === "function") {
      this.debugFn = options.debug;
    }
  }

  /** Returns a JSON-safe representation with the API key masked. */
  toJSON() {
    return { baseUrl: this.baseUrl, apiKey: this.maskKey() };
  }

  /** Custom Node.js inspect output with the API key masked. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `QURLClient ${JSON.stringify(this.toJSON())}`;
  }

  private maskKey(): string {
    if (this.apiKey.length > 8) {
      return this.apiKey.slice(0, 4) + "***" + this.apiKey.slice(-4);
    }
    return "***";
  }

  private log(message: string, data?: Record<string, unknown>): void {
    this.debugFn?.(message, data);
  }

  // --- Helpers ---

  /**
   * Maps the API's "qurls" field to "access_tokens" on the SDK type.
   * Uses destructuring to avoid mutation and unsafe casts.
   */
  private static mapQurlsField(raw: QURL & { qurls?: AccessToken[] }): QURL {
    const { qurls, ...rest } = raw;
    if (qurls && !rest.access_tokens) {
      return { ...rest, access_tokens: qurls };
    }
    return rest;
  }

  // --- Public API ---

  /** Create a new QURL. */
  async create(input: CreateInput): Promise<CreateOutput> {
    return this.request<CreateOutput>("POST", "/v1/qurls", input);
  }

  /**
   * Batch create multiple QURLs (1-100 items).
   *
   * **Partial failures do not throw.** Two paths resolve normally with
   * structured per-item results:
   * - **HTTP 207 Multi-Status** (some succeeded, some failed) — passes the
   *   `response.ok` check naturally since 207 is in the 2xx range.
   * - **HTTP 400** (every item failed validation) — the API returns a
   *   populated `BatchCreateOutput` body in this case; whitelisted via
   *   `passthroughStatuses` so the structured per-item errors aren't
   *   swallowed by the generic error path.
   *
   * In both cases the caller is responsible for inspecting `result.failed > 0`
   * and iterating `result.results` to see which items succeeded and which
   * errored. Other error statuses (401, 403, 429, 5xx) still throw the
   * appropriate `QURLError` subclass.
   *
   * Throws `ValidationError` client-side (`status: 0`, `code: "client_validation"`)
   * when `items` is empty or exceeds 100, or when the HTTP 400 response body
   * doesn't match the expected `BatchCreateOutput` shape (defense-in-depth
   * for cases where the endpoint returns a non-batch error on 400).
   *
   * Use the discriminated union on each result to narrow safely:
   * ```ts
   * const result = await client.batchCreate({ items });
   * for (const r of result.results) {
   *   if (r.success) handleOk(r.resource_id, r.qurl_link);
   *   else           handleErr(r.index, r.error.code, r.error.message);
   * }
   * ```
   */
  async batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput> {
    if (input.items.length === 0) {
      throw clientValidationError("batchCreate requires at least 1 item");
    }
    if (input.items.length > 100) {
      throw clientValidationError(
        `batchCreate accepts at most 100 items, got ${input.items.length}`,
      );
    }
    // 400 carries per-item errors (see rawRequest JSDoc).
    const result = await this.request<BatchCreateOutput>("POST", "/v1/qurls/batch", input, [400]);
    // Defense-in-depth: the 400 passthrough trusts the response shape, but
    // if the API ever returns 400 with a different body (e.g., a top-level
    // malformed-request error) the caller would silently get undefined
    // fields. Validate the shape before returning and surface a clear
    // error otherwise. The error intentionally does not embed the raw
    // response body — an unexpected body could contain sensitive data
    // (auth details, request echoes) and error messages may end up in
    // client-side logs.
    if (
      !result ||
      typeof result.succeeded !== "number" ||
      typeof result.failed !== "number" ||
      !Array.isArray(result.results)
    ) {
      throw clientValidationError("Unexpected response shape from POST /v1/qurls/batch");
    }
    // Also verify every result entry carries a boolean `success` discriminant.
    // Anything else would break the BatchItemResult narrowing consumers rely on.
    // Deeper per-field validation is intentionally left to the API; this check
    // is the minimum needed to protect the discriminated union contract.
    for (const entry of result.results) {
      if (!entry || typeof (entry as { success?: unknown }).success !== "boolean") {
        throw clientValidationError("Unexpected response shape from POST /v1/qurls/batch");
      }
    }
    return result;
  }

  /** Gets a protected URL and its access tokens. */
  async get(id: string): Promise<QURL> {
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "GET",
      `/v1/qurls/${encodeURIComponent(id)}`,
    );
    return QURLClient.mapQurlsField(raw);
  }

  /**
   * Lists protected URLs. Each QURL groups access tokens sharing the same target URL.
   * Note: list items include qurl_count but not access_tokens (too expensive at scale).
   */
  async list(input: ListInput = {}): Promise<ListOutput> {
    const params = new URLSearchParams();
    // Explicit allowlist rather than Object.entries: TypeScript's structural
    // typing can't prevent callers from spreading untyped objects with extra
    // properties, and String(value) on an unexpected array/object would emit
    // "[object Object]" as a query param.
    for (const key of LIST_PARAM_KEYS) {
      const value = input[key];
      if (value !== null && value !== undefined) params.set(key, String(value));
    }

    const query = params.toString();
    const path = query ? `/v1/qurls?${query}` : "/v1/qurls";

    const { data, meta } = await this.rawRequest<(QURL & { qurls?: AccessToken[] })[]>("GET", path);
    return {
      // Defensive: map in case API includes nested tokens on list items in the future.
      qurls: data.map(QURLClient.mapQurlsField),
      next_cursor: meta?.next_cursor,
      has_more: meta?.has_more ?? false,
    };
  }

  /** Iterate over all QURLs, automatically paginating. */
  async *listAll(input: Omit<ListInput, "cursor"> = {}): AsyncGenerator<QURL, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, cursor });
      for (const qurl of page.qurls) {
        yield qurl;
      }
      cursor = page.next_cursor;
    } while (cursor);
  }

  /** Delete (revoke) a QURL. */
  async delete(id: string): Promise<void> {
    await this.rawRequest("DELETE", `/v1/qurls/${encodeURIComponent(id)}`);
  }

  /**
   * Extend a QURL's expiration.
   *
   * Convenience method — delegates to {@link update} with only the expiration
   * fields. `ExtendInput` is a strict subset of `UpdateInput`, but destructuring
   * before delegation enforces the narrow type at runtime so spread or variable
   * callers can't accidentally leak `description` / `tags` through this path.
   */
  async extend(id: string, input: ExtendInput): Promise<QURL> {
    const { extend_by, expires_at } = input;
    return this.update(id, { extend_by, expires_at });
  }

  /** Update a QURL — extend expiration, change description, etc. */
  async update(id: string, input: UpdateInput): Promise<QURL> {
    // Match batchCreate's client-side validation pattern: catch obvious
    // mistakes before the API round-trip.
    const { extend_by, expires_at, description, tags } = input;
    if (extend_by !== undefined && expires_at !== undefined) {
      throw clientValidationError(
        "update: `extend_by` and `expires_at` are mutually exclusive — provide at most one",
      );
    }
    if (
      extend_by === undefined &&
      expires_at === undefined &&
      description === undefined &&
      tags === undefined
    ) {
      throw clientValidationError(
        "update: at least one field (extend_by, expires_at, description, tags) must be provided",
      );
    }
    const raw = await this.request<QURL & { qurls?: AccessToken[] }>(
      "PATCH",
      `/v1/qurls/${encodeURIComponent(id)}`,
      input,
    );
    return QURLClient.mapQurlsField(raw);
  }

  /** Mint a new access link for a QURL. */
  async mintLink(id: string, input?: MintInput): Promise<MintOutput> {
    if (input?.expires_in !== undefined && input.expires_at !== undefined) {
      throw clientValidationError(
        "mintLink: `expires_in` and `expires_at` are mutually exclusive — provide at most one",
      );
    }
    return this.request<MintOutput>("POST", `/v1/qurls/${encodeURIComponent(id)}/mint_link`, input);
  }

  /**
   * Resolve a QURL access token (headless).
   *
   * Triggers an NHP knock to open firewall access for the caller's IP.
   * Requires `qurl:resolve` scope on the API key.
   *
   * Accepts a plain token string or a `ResolveInput` object.
   */
  async resolve(input: ResolveInput | string): Promise<ResolveOutput> {
    const body = typeof input === "string" ? { access_token: input } : input;
    return this.request<ResolveOutput>("POST", "/v1/resolve", body);
  }

  /** Get quota and usage information. */
  async getQuota(): Promise<Quota> {
    return this.request<Quota>("GET", "/v1/quota");
  }

  // --- Internal HTTP plumbing ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    passthroughStatuses?: readonly number[],
  ): Promise<T> {
    const { data } = await this.rawRequest<T>(method, path, body, passthroughStatuses);
    return data;
  }

  /**
   * Issue an HTTP request and parse the JSON response.
   *
   * `passthroughStatuses` lets a caller opt certain non-2xx codes out of the
   * default throw-on-error path and receive the parsed body instead. This is
   * used by `batchCreate`, where the API returns a structured
   * `BatchCreateOutput` on HTTP 400 (all items rejected) — throwing would
   * drop the per-item errors.
   */
  private async rawRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    passthroughStatuses: readonly number[] = NO_PASSTHROUGH_STATUSES,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const mutating = method === "POST" || method === "PATCH";
    const retryable = mutating ? RETRYABLE_STATUS_MUTATING : RETRYABLE_STATUS;
    const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelay(attempt, lastError);
        this.log(`Retry ${attempt}/${this.maxRetries} after ${delay}ms`, { method, url });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      this.log(`${method} ${url}`);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        lastError = this.classifyFetchError(err);
        this.log(
          `${method} ${url} ${lastError instanceof TimeoutError ? "timed out" : "network error"}`,
          {
            error: lastError.message,
          },
        );
        if (attempt < this.maxRetries) {
          continue;
        }
        throw lastError;
      }

      this.log(`${method} ${url} → ${response.status}`);

      if (response.ok || passthroughStatuses.includes(response.status)) {
        if (response.status === 204) {
          return { data: undefined as unknown as T };
        }
        const json = (await response.json()) as ApiResponse<T>;
        return json;
      }

      const errorData = await this.parseError(response);
      const err = createError(errorData);

      if (retryable.has(response.status) && attempt < this.maxRetries) {
        lastError = err;
        continue;
      }

      throw err;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async parseError(response: Response): Promise<QURLErrorData> {
    try {
      const json = (await response.json()) as ApiErrorEnvelope;
      if (json.error) {
        return {
          status: json.error.status,
          code: json.error.code,
          title: json.error.title,
          detail: json.error.detail,
          invalid_fields: json.error.invalid_fields,
          request_id: json.meta?.request_id,
          retry_after: this.parseRetryAfter(response),
        };
      }
    } catch {
      // Non-JSON error response
    }

    return {
      status: response.status,
      code: "unknown",
      title: response.statusText,
      detail: "",
    };
  }

  private parseRetryAfter(response: Response): number | undefined {
    if (response.status !== 429) return undefined;
    const header = response.headers.get("Retry-After");
    if (!header) return undefined;
    const seconds = parseInt(header, 10);
    return Number.isNaN(seconds) ? undefined : seconds;
  }

  private retryDelay(attempt: number, lastError?: Error): number {
    if (lastError instanceof QURLError && lastError.retryAfter) {
      return Math.min(lastError.retryAfter * 1000, RETRY_MAX_DELAY_MS);
    }
    const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
  }

  private classifyFetchError(err: unknown): TimeoutError | NetworkError {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return new TimeoutError("Request timed out", { cause: err });
    }
    const cause = err instanceof Error ? err : undefined;
    return new NetworkError(cause?.message ?? String(err), { cause });
  }
}
