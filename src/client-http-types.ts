export interface ApiResponse<T> {
  data: T;
  meta?: {
    found_existing?: unknown;
    request_id?: string;
    page_size?: number;
    has_more?: boolean;
    next_cursor?: string;
  };
}

export interface HttpResponse<T> {
  envelope: ApiResponse<T>;
  status: number;
  bodyEmpty: boolean;
  headers?: Headers;
}

export interface ApiErrorEnvelope {
  error?: {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    code?: string;
    instance?: string;
    invalid_fields?: Record<string, string>;
    /**
     * Legacy field from pre-RFC-7807 error shapes. Supported for backward
     * compatibility when the API has been configured to return the older
     * `{ error: { code, message } }` envelope.
     */
    message?: string;
  };
  meta?: { request_id?: string; tombstone?: unknown };
}
