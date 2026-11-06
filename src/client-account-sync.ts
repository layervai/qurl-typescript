import type {
  AccessRules,
  InboxState,
  ReceivedHistory,
  SaveAccessRulesInput,
  SaveInboxStateInput,
  SaveReceivedHistoryInput,
} from "./types.js";
import { clientValidationError, unexpectedResponseError } from "./client-errors.js";
import {
  requireNoUnknownFields,
  requireObjectInput,
  requireStringArrayElements,
} from "./client-validation.js";

// Versioned account documents: the SDK checks structure and leaves field rules
// to the service, which answers 400 for an invalid document and 409 for a stale
// version.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

function requireSaveInput(
  input: unknown,
  method: string,
  fields: readonly string[],
): asserts input is Record<string, unknown> {
  requireObjectInput(input, method);
  requireNoUnknownFields(input, fields, method);
  if (!isVersion(input.version)) {
    throw clientValidationError(`${method}: version must be the non-negative integer last read`);
  }
}

function requireSaveItems(input: unknown, method: string, fields: readonly string[]): void {
  requireSaveInput(input, method, fields);
  if (!Array.isArray(input.items) || !input.items.every(isObject)) {
    throw clientValidationError(`${method}: items must be an array of objects`);
  }
}

export function validateSaveAccessRulesInput(input: SaveAccessRulesInput): void {
  // quick_share_rule_id is qURL Desktop's choice; the service keeps it when a save omits it.
  requireSaveItems(input, "saveAccessRules", [
    "version",
    "items",
  ] satisfies (keyof SaveAccessRulesInput)[]);
}

export function validateSaveReceivedHistoryInput(input: SaveReceivedHistoryInput): void {
  // cleared_at is read-only; the service refuses it in requests.
  requireSaveItems(input, "saveReceivedHistory", [
    "version",
    "items",
  ] satisfies (keyof SaveReceivedHistoryInput)[]);
}

export function validateSaveInboxStateInput(input: SaveInboxStateInput): void {
  requireSaveInput(input, "saveInboxState", [
    "version",
    "seen_through",
    "dismissed",
  ] satisfies (keyof SaveInboxStateInput)[]);
  requireStringArrayElements(input.dismissed, "dismissed", "saveInboxState");
  if (!isOptionalString(input.seen_through)) {
    throw clientValidationError("saveInboxState: seen_through must be an RFC 3339 time");
  }
}

const isRule = (rule: unknown): boolean =>
  isObject(rule) &&
  typeof rule.id === "string" &&
  typeof rule.name === "string" &&
  typeof rule.mode === "string";

export function requireAccessRules(value: unknown, method: string): AccessRules {
  if (
    !isObject(value) ||
    typeof value.account_id !== "string" ||
    !value.account_id ||
    !isVersion(value.version) ||
    !Array.isArray(value.items) ||
    !value.items.every(isRule) ||
    !Array.isArray(value.built_ins) ||
    !value.built_ins.every(isRule) ||
    !isOptionalString(value.quick_share_rule_id)
  ) {
    throw unexpectedResponseError(`${method}: invalid access rules response`);
  }
  return value as unknown as AccessRules;
}

export function requireInboxState(value: unknown, method: string): InboxState {
  if (
    !isObject(value) ||
    !isVersion(value.version) ||
    !isOptionalString(value.seen_through) ||
    !Array.isArray(value.dismissed) ||
    !value.dismissed.every((key) => typeof key === "string")
  ) {
    throw unexpectedResponseError(`${method}: invalid inbox state response`);
  }
  return value as unknown as InboxState;
}

const isTime = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;

export function requireReceivedHistory(value: unknown, method: string): ReceivedHistory {
  if (
    !isObject(value) ||
    !isVersion(value.version) ||
    (value.cleared_at !== undefined && !isTime(value.cleared_at)) ||
    !Array.isArray(value.items) ||
    !value.items.every(
      (item) =>
        isObject(item) &&
        typeof item.crid === "string" &&
        isTime(item.opened_at) &&
        isOptionalString(item.name) &&
        (item.added_at === undefined || isTime(item.added_at)),
    )
  ) {
    throw unexpectedResponseError(`${method}: invalid received history response`);
  }
  return value as unknown as ReceivedHistory;
}
