import type {
  CreateDelegatedQurlBatchInput,
  CreateDelegatedQurlBatchOptions,
  DelegatedQurl,
  DelegatedQurlBatchItemResult,
  GetDelegatedQurlBatchOptions,
} from "./types.js";
import {
  DelegatedBatchOutcomeUnknownError,
  QURLError,
  RuntimeError,
  ValidationError,
} from "./errors.js";
import { clientValidationError, unexpectedResponseError } from "./client-errors.js";
import {
  describeShape,
  requireBooleanIfPresent,
  requireMaxSessionsInRange,
  requireMaxUtf8Bytes,
  requireNoUnknownFields,
  requireValidAccessPolicy,
} from "./client-validation.js";
import {
  DELEGATED_BATCH_CREATE_OPTION_KEYS,
  DELEGATED_BATCH_GET_OPTION_KEYS,
  DELEGATED_BATCH_GRANT_KEYS,
  DELEGATED_BATCH_INPUT_KEYS,
} from "./client-input-fields.js";
import {
  MAX_DELEGATED_BATCH_ITEMS,
  MAX_DELEGATED_ETAG,
  MAX_DELEGATED_MINT_CAPABILITY,
  MAX_IDEMPOTENCY_KEY,
  MAX_LABEL,
  RETRY_AFTER_PARSE_LIMIT_S,
} from "./client-limits.js";
import type { HttpResponse } from "./client-http-types.js";

const MIN_DELEGATED_BATCH_IDEMPOTENCY_KEY = 32;

export const DELEGATED_BATCH_ID_PATTERN = /^dqb_[A-Za-z0-9_-]{22}$/;

export const DELEGATED_QURL_ID_PATTERN = /^q_[0-9a-f]{11}$/;

export const STRONG_ETAG_PATTERN = /^"[\x21\x23-\x7e]+"$/;

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function validateCreateDelegatedQurlBatchInput(
  input: unknown,
): asserts input is CreateDelegatedQurlBatchInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw clientValidationError(
      `createDelegatedQurlBatch: input must be an object (got ${describeShape(input)})`,
    );
  }
  const typed = input as CreateDelegatedQurlBatchInput;
  requireNoUnknownFields(
    typed as unknown as Record<string, unknown>,
    DELEGATED_BATCH_INPUT_KEYS,
    "createDelegatedQurlBatch",
  );
  if (
    typeof typed.mint_capability !== "string" ||
    typed.mint_capability.length < 1 ||
    typed.mint_capability.length > MAX_DELEGATED_MINT_CAPABILITY
  ) {
    throw clientValidationError(
      `createDelegatedQurlBatch: mint_capability must be a string of 1-${MAX_DELEGATED_MINT_CAPABILITY} characters`,
    );
  }
  if (
    !Array.isArray(typed.grants) ||
    typed.grants.length < 1 ||
    typed.grants.length > MAX_DELEGATED_BATCH_ITEMS
  ) {
    throw clientValidationError(
      `createDelegatedQurlBatch: grants must contain 1-${MAX_DELEGATED_BATCH_ITEMS} items`,
    );
  }
  for (const [index, grant] of typed.grants.entries()) {
    const field = `createDelegatedQurlBatch: grants[${index}]`;
    if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
      throw clientValidationError(`${field}: must be an object (got ${describeShape(grant)})`);
    }
    requireNoUnknownFields(
      grant as unknown as Record<string, unknown>,
      DELEGATED_BATCH_GRANT_KEYS,
      field,
    );
    requireMaxUtf8Bytes(grant.label, `${field}.label`, MAX_LABEL);
    requireBooleanIfPresent(grant.one_time_use, `${field}.one_time_use`);
    requireMaxSessionsInRange(grant.max_sessions, `${field}.max_sessions`);
    for (const durationField of ["expires_in", "session_duration"] as const) {
      const value = grant[durationField];
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
        throw clientValidationError(`${field}.${durationField}: must be a non-empty string`);
      }
    }
    if (grant.access_policy !== undefined) {
      requireValidAccessPolicy(grant.access_policy);
    }
  }
}

export function validateDelegatedBatchCreateOptions(
  options: unknown,
): asserts options is CreateDelegatedQurlBatchOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw clientValidationError("createDelegatedQurlBatch: options are required");
  }
  requireNoUnknownFields(
    options as Record<string, unknown>,
    DELEGATED_BATCH_CREATE_OPTION_KEYS,
    "createDelegatedQurlBatch options",
  );
  const key = (options as CreateDelegatedQurlBatchOptions).idempotencyKey;
  if (
    typeof key !== "string" ||
    key.length < MIN_DELEGATED_BATCH_IDEMPOTENCY_KEY ||
    key.length > MAX_IDEMPOTENCY_KEY ||
    !/^[!-~]+$/.test(key)
  ) {
    throw clientValidationError(
      `createDelegatedQurlBatch: idempotencyKey must contain ${MIN_DELEGATED_BATCH_IDEMPOTENCY_KEY}-${MAX_IDEMPOTENCY_KEY} visible ASCII characters`,
    );
  }
}

export function validateGetDelegatedQurlBatchOptions(
  options: unknown,
): asserts options is GetDelegatedQurlBatchOptions | undefined {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw clientValidationError(
      `getDelegatedQurlBatch: options must be an object (got ${describeShape(options)})`,
    );
  }
  requireNoUnknownFields(
    options as Record<string, unknown>,
    DELEGATED_BATCH_GET_OPTION_KEYS,
    "getDelegatedQurlBatch options",
  );
  const etag = (options as GetDelegatedQurlBatchOptions).etag;
  if (
    etag !== undefined &&
    (typeof etag !== "string" ||
      etag.length > MAX_DELEGATED_ETAG ||
      !STRONG_ETAG_PATTERN.test(etag))
  ) {
    throw clientValidationError("getDelegatedQurlBatch: etag must be a valid strong ETag");
  }
}

export function delegatedResponseError(
  status: number,
  detail: string,
  requestId?: string,
): ValidationError {
  return unexpectedResponseError(`Delegated qURL batch ${detail}`, { status, requestId });
}

function delegatedResponseObject(
  value: unknown,
  status: number,
  label: string,
  requestId?: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw delegatedResponseError(status, `${label} is not an object`, requestId);
  }
  return value as Record<string, unknown>;
}

export function delegatedEnvelope(
  response: HttpResponse<unknown>,
  status: number,
): { data: Record<string, unknown>; requestId: string } {
  if (
    typeof response.envelope.meta !== "object" ||
    response.envelope.meta === null ||
    Array.isArray(response.envelope.meta)
  ) {
    throw delegatedResponseError(status, "response meta is not an object");
  }
  const meta = response.envelope.meta as Record<string, unknown>;
  if (typeof meta.request_id !== "string") {
    throw delegatedResponseError(status, "response meta has invalid request_id");
  }
  const data = delegatedResponseObject(
    response.envelope.data,
    status,
    "response data",
    meta.request_id,
  );
  return { data, requestId: meta.request_id };
}

export function requiredDelegatedHeader(
  response: HttpResponse<unknown>,
  name: string,
  status: number,
  requestId?: string,
): string {
  const headers = response.headers;
  if (!headers || typeof headers.get !== "function") {
    throw delegatedResponseError(status, "response headers are unavailable", requestId);
  }
  const value = headers.get(name);
  if (value === null) {
    throw delegatedResponseError(status, `response is missing ${name}`, requestId);
  }
  return value;
}

export function hasDelegatedNoStore(value: string | null): boolean {
  if (value === null) return false;
  const directives = new Set(
    value.split(",").map((directive) => directive.trim().split("=", 1)[0].toLowerCase()),
  );
  return directives.has("private") && directives.has("no-store");
}

export function delegatedResponseHeaders(
  response: HttpResponse<unknown>,
  status: number,
  requestId?: string,
): { etag?: string; retryAfter?: number } {
  const cacheControl = response.headers?.get("Cache-Control") ?? null;
  if (cacheControl !== null) {
    if (!hasDelegatedNoStore(cacheControl)) {
      throw delegatedResponseError(status, "response has invalid Cache-Control", requestId);
    }
  } else if (status !== 304) {
    requiredDelegatedHeader(response, "Cache-Control", status, requestId);
  }
  const etag = response.headers?.get("ETag") ?? undefined;
  if (etag !== undefined && (etag.length > MAX_DELEGATED_ETAG || !STRONG_ETAG_PATTERN.test(etag))) {
    throw delegatedResponseError(status, "response has invalid strong ETag", requestId);
  }
  const rawRetryAfter = response.headers?.get("Retry-After") ?? "";
  const trimmed = rawRetryAfter.trim();
  const seconds = /^\d+$/.test(trimmed)
    ? Number(trimmed)
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)
      ? Math.ceil((Date.parse(trimmed) - Date.now()) / 1000)
      : NaN;
  const retryAfter =
    Number.isSafeInteger(seconds) && seconds > 0 && seconds <= RETRY_AFTER_PARSE_LIMIT_S
      ? seconds
      : undefined;
  return { etag, retryAfter };
}

export function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function delegatedBatchBase(
  data: Record<string, unknown>,
  status: number,
  requestId: string,
  expectedBatchId?: string,
): { batchId: string; itemCount: number; submittedAt: string } {
  if (
    typeof data.batch_id !== "string" ||
    !DELEGATED_BATCH_ID_PATTERN.test(data.batch_id) ||
    (expectedBatchId !== undefined && data.batch_id !== expectedBatchId)
  ) {
    throw delegatedResponseError(status, "response has invalid batch_id", requestId);
  }
  if (
    !Number.isInteger(data.item_count) ||
    Number(data.item_count) < 1 ||
    Number(data.item_count) > MAX_DELEGATED_BATCH_ITEMS
  ) {
    throw delegatedResponseError(status, "response has invalid item_count", requestId);
  }
  if (!isUtcTimestamp(data.submitted_at)) {
    throw delegatedResponseError(status, "response has invalid submitted_at", requestId);
  }
  return {
    batchId: data.batch_id,
    itemCount: Number(data.item_count),
    submittedAt: data.submitted_at,
  };
}

export function validateDelegatedLocation(
  value: string,
  baseUrl: string,
  batchId: string,
  status: number,
  requestId: string,
): string {
  let location: URL;
  try {
    const base = new URL(`${baseUrl}/`);
    const relative = value.startsWith("/v1/delegated-qurl-batches/")
      ? `${base.pathname.replace(/\/$/, "")}${value}`
      : value;
    location = new URL(relative, base);
  } catch {
    throw delegatedResponseError(status, "response has invalid Location", requestId);
  }
  const expected = new URL(`${baseUrl}/v1/delegated-qurl-batches/${batchId}`);
  if (
    location.username !== "" ||
    location.password !== "" ||
    location.search !== "" ||
    location.hash !== "" ||
    location.href !== expected.href
  ) {
    throw delegatedResponseError(status, "response has invalid Location", requestId);
  }
  return location.href;
}

function validateDelegatedQurlLink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const link = new URL(value);
    return (
      link.protocol === "https:" &&
      link.username === "" &&
      link.password === "" &&
      link.hash.length > 1
    );
  } catch {
    return false;
  }
}

export function validateDelegatedQurl(
  value: unknown,
  expectedQurlId: string,
  status: number,
  requestId: string,
): DelegatedQurl {
  const data = delegatedResponseObject(value, status, "response data", requestId);
  if (data.qurl_id !== expectedQurlId) {
    throw delegatedResponseError(status, "response has invalid qurl_id", requestId);
  }
  if (
    data.status !== "active" &&
    data.status !== "consumed" &&
    data.status !== "expired" &&
    data.status !== "revoked"
  ) {
    throw delegatedResponseError(status, "response has invalid status", requestId);
  }
  if (
    !isUtcTimestamp(data.expires_at) ||
    typeof data.one_time_use !== "boolean" ||
    !Number.isInteger(data.max_sessions) ||
    Number(data.max_sessions) < 0 ||
    !Number.isInteger(data.session_duration) ||
    Number(data.session_duration) <= 0 ||
    (data.label !== undefined && typeof data.label !== "string") ||
    (data.access_policy !== undefined &&
      (typeof data.access_policy !== "object" ||
        data.access_policy === null ||
        Array.isArray(data.access_policy)))
  ) {
    throw delegatedResponseError(status, "response has invalid qURL metadata", requestId);
  }
  return { ...(data as unknown as DelegatedQurl), request_id: requestId };
}

export function validateDelegatedBatchResults(
  value: unknown,
  itemCount: number,
  batchStatus: "succeeded" | "partially_failed" | "failed",
  status: number,
  requestId: string,
): DelegatedQurlBatchItemResult[] {
  if (!Array.isArray(value) || value.length !== itemCount) {
    throw delegatedResponseError(status, "terminal response has invalid results", requestId);
  }
  let succeeded = 0;
  const qurlIds = new Set<string>();
  const links = new Set<string>();
  const results = value.map((raw, index): DelegatedQurlBatchItemResult => {
    const item = delegatedResponseObject(raw, status, `result ${index}`, requestId);
    if (item.index !== index) {
      throw delegatedResponseError(status, `result ${index} has invalid index`, requestId);
    }
    if (item.status === "succeeded") {
      if (item.error !== undefined && item.error !== null) {
        throw delegatedResponseError(status, `result ${index} has conflicting fields`, requestId);
      }
      const qurl = delegatedResponseObject(item.qurl, status, `result ${index} qurl`, requestId);
      if (
        typeof qurl.qurl_id !== "string" ||
        !DELEGATED_QURL_ID_PATTERN.test(qurl.qurl_id) ||
        !validateDelegatedQurlLink(qurl.qurl_link) ||
        !isUtcTimestamp(qurl.expires_at) ||
        qurlIds.has(qurl.qurl_id) ||
        links.has(qurl.qurl_link)
      ) {
        throw delegatedResponseError(status, `result ${index} has invalid qurl`, requestId);
      }
      qurlIds.add(qurl.qurl_id);
      links.add(qurl.qurl_link);
      succeeded++;
      return {
        index,
        status: "succeeded",
        qurl: {
          qurl_id: qurl.qurl_id,
          qurl_link: qurl.qurl_link,
          expires_at: qurl.expires_at,
        },
      };
    }
    if (item.status !== "failed" || (item.qurl !== undefined && item.qurl !== null)) {
      throw delegatedResponseError(status, `result ${index} has invalid status`, requestId);
    }
    const error = delegatedResponseObject(item.error, status, `result ${index} error`, requestId);
    if (
      typeof error.code !== "string" ||
      error.code.length === 0 ||
      typeof error.message !== "string"
    ) {
      throw delegatedResponseError(status, `result ${index} has invalid error`, requestId);
    }
    return {
      index,
      status: "failed",
      error: { code: error.code, message: error.message },
    };
  });
  if (
    (batchStatus === "succeeded" && succeeded !== itemCount) ||
    (batchStatus === "failed" && succeeded !== 0) ||
    (batchStatus === "partially_failed" && (succeeded === 0 || succeeded === itemCount))
  ) {
    throw delegatedResponseError(status, "terminal status does not match results", requestId);
  }
  return results;
}

export function classifyDelegatedBatchCreateFailure(error: unknown, batchId?: string): never {
  if (!(error instanceof QURLError)) {
    throw new DelegatedBatchOutcomeUnknownError(
      new RuntimeError("Unexpected failure after delegated batch dispatch", { cause: error }),
      batchId,
    );
  }
  if ((error.status >= 400 && error.status < 500 && error.status !== 408) || error.status === 501) {
    throw error;
  }
  throw new DelegatedBatchOutcomeUnknownError(error, batchId);
}
