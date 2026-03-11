import type { QURLErrorData } from "./types.js";

/** Error thrown by the QURL API client. */
export class QURLError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly invalidFields?: Record<string, string>;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(data: QURLErrorData) {
    super(`${data.title} (${data.status}): ${data.detail}`);
    this.name = "QURLError";
    this.status = data.status;
    this.code = data.code;
    this.detail = data.detail;
    this.invalidFields = data.invalid_fields;
    this.requestId = data.request_id;
    this.retryAfter = data.retry_after;
  }
}
