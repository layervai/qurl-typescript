import { createError, NetworkError, QURLError, TimeoutError } from "./errors.js";
import type {
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
const RETRYABLE_STATUS_POST = new Set([429]);

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
  private readonly debugFn:
    | ((message: string, data?: Record<string, unknown>) => void)
    | undefined;

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

  // --- Public API ---

  /** Create a new QURL. */
  async create(input: CreateInput): Promise<CreateOutput> {
    return this.request<CreateOutput>("POST", "/v1/qurl", input);
  }

  /** Get a QURL by ID. */
  async get(id: string): Promise<QURL> {
    return this.request<QURL>("GET", `/v1/qurls/${encodeURIComponent(id)}`);
  }

  /** List QURLs with optional filters (single page). */
  async list(input: ListInput = {}): Promise<ListOutput> {
    const params = new URLSearchParams();
    if (input.limit !== null && input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor !== null && input.cursor !== undefined) params.set("cursor", input.cursor);
    if (input.status !== null && input.status !== undefined) params.set("status", input.status);
    if (input.q !== null && input.q !== undefined) params.set("q", input.q);
    if (input.sort !== null && input.sort !== undefined) params.set("sort", input.sort);

    const query = params.toString();
    const path = query ? `/v1/qurls?${query}` : "/v1/qurls";

    const { data, meta } = await this.rawRequest<QURL[]>("GET", path);
    return {
      qurls: data,
      next_cursor: meta?.next_cursor,
      has_more: meta?.has_more ?? false,
    };
  }

  /** Iterate over all QURLs, automatically paginating. */
  async *listAll(
    input: Omit<ListInput, "cursor"> = {},
  ): AsyncGenerator<QURL, void, undefined> {
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
    await this.request<void>("DELETE", `/v1/qurls/${encodeURIComponent(id)}`);
  }

  /**
   * Extend a QURL's expiration.
   *
   * Convenience method — equivalent to `update(id, input)`.
   */
  async extend(id: string, input: ExtendInput): Promise<QURL> {
    return this.update(id, input);
  }

  /** Update a QURL — extend expiration, change description, etc. */
  async update(id: string, input: UpdateInput): Promise<QURL> {
    return this.request<QURL>("PATCH", `/v1/qurls/${encodeURIComponent(id)}`, input);
  }

  /** Mint a new access link for a QURL. */
  async mintLink(id: string, input?: MintInput): Promise<MintOutput> {
    return this.request<MintOutput>(
      "POST",
      `/v1/qurls/${encodeURIComponent(id)}/mint_link`,
      input,
    );
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await this.rawRequest<T>(method, path, body);
    return data;
  }

  private async rawRequest<T>(
    method: string,
    path: string,
    body?: unknown,
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

    const retryable = method === "POST" ? RETRYABLE_STATUS_POST : RETRYABLE_STATUS;
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
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === "TimeoutError";
        lastError = isTimeout
          ? new TimeoutError("Request timed out", { cause: err })
          : new NetworkError(
              err instanceof Error ? err.message : String(err),
              { cause: err instanceof Error ? err : undefined },
            );
        this.log(`${method} ${url} ${isTimeout ? "timed out" : "network error"}`, {
          error: lastError.message,
        });
        if (attempt < this.maxRetries) {
          continue;
        }
        throw lastError;
      }

      this.log(`${method} ${url} → ${response.status}`);

      if (response.ok) {
        if (response.status === 204) {
          return { data: undefined as T };
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
          retry_after:
            response.status === 429
              ? parseInt(response.headers.get("Retry-After") ?? "", 10) || undefined
              : undefined,
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

  private retryDelay(attempt: number, lastError?: Error): number {
    if (lastError instanceof QURLError && lastError.retryAfter) {
      return Math.min(lastError.retryAfter * 1000, RETRY_MAX_DELAY_MS);
    }
    const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
  }
}
