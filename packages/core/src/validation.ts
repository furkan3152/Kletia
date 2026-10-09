/**
 * Dependency-free runtime validation for inbound intent requests. The public
 * API, SDK and widget all use this so an integrator gets identical errors
 * before and after a network round trip.
 */
import { isNetworkKey, type NetworkKey } from "./chains.js";
import { parseAccountId, type AccountId } from "./caip.js";
import { isDecimalAmount } from "./amounts.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
import {
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_REFERENCE_PATTERN,
  normalizeWebOrigin,
  type ContractTestRequest,
  type SessionCreateRequest,
  type SessionIntentRequest,
} from "./contracts.js";
import type {
  IntentActionKind,
  IntentActionSpec,
  IntentConstraints,
  IntentRequest,
} from "./intent.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Every intent action kind, in declaration order. */
export const INTENT_ACTION_KINDS: readonly IntentActionKind[] = Object.freeze([
  "swap",
  "transfer",
  "bridge",
  "stake",
  "unstake",
  "deposit",
  "withdraw",
  "borrow",
  "repay",
  "approve",
  "claim",
  "read",
  "call",
  "action",
]);
const ACTION_KINDS = INTENT_ACTION_KINDS;

/** Kinds bound to an integrator contract registration (`contract` + `entry`). */
export const CONTRACT_ACTION_KINDS: readonly IntentActionKind[] = Object.freeze(["call", "action"]);

export const MAX_INTENT_TEXT_LENGTH = 1_000;
export const MAX_INTENT_ACTIONS = 8;
export const MAX_INTENT_ACCOUNTS = 6;
/** Bounds of `constraints.maxSeconds` (settlement estimate a cross-network step may take). */
export const MIN_MAX_SECONDS = 10;
export const MAX_MAX_SECONDS = 86_400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConstraints(value: unknown, issues: ValidationIssue[]): IntentConstraints | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "constraints", message: "constraints must be an object." });
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (value.maxSlippageBps !== undefined) {
    const bps = value.maxSlippageBps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > 1_000) {
      issues.push({ path: "constraints.maxSlippageBps", message: "Must be an integer between 1 and 1000." });
    } else out.maxSlippageBps = bps;
  }
  if (value.deadline !== undefined) {
    const deadline = value.deadline;
    if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline <= 0) {
      issues.push({ path: "constraints.deadline", message: "Must be unix seconds." });
    } else out.deadline = deadline;
  }
  if (value.maxFeeUsd !== undefined) {
    const fee = value.maxFeeUsd;
    if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) {
      issues.push({ path: "constraints.maxFeeUsd", message: "Must be a non-negative number." });
    } else out.maxFeeUsd = fee;
  }
  if (value.maxSeconds !== undefined) {
    const seconds = value.maxSeconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < MIN_MAX_SECONDS || seconds > MAX_MAX_SECONDS) {
      issues.push({ path: "constraints.maxSeconds", message: `Must be an integer between ${MIN_MAX_SECONDS} and ${MAX_MAX_SECONDS}.` });
    } else out.maxSeconds = seconds;
  }
  for (const key of ["preferProtocols", "avoidProtocols"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || !getProtocol(id))) {
      issues.push({ path: `constraints.${key}`, message: "Must be a list of known protocol ids." });
    } else out[key] = list as ProtocolId[];
  }
  if (value.allowTestnets !== undefined) {
    if (typeof value.allowTestnets !== "boolean") {
      issues.push({ path: "constraints.allowTestnets", message: "Must be a boolean." });
    } else out.allowTestnets = value.allowTestnets;
  }
  return out as IntentConstraints;
}

function validateAction(value: unknown, index: number, issues: ValidationIssue[]): IntentActionSpec | null {
  const path = `actions[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "Action must be an object." });
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !ACTION_KINDS.includes(kind as IntentActionKind)) {
    issues.push({ path: `${path}.kind`, message: `Must be one of ${ACTION_KINDS.join(", ")}.` });
  }
  if (!isNetworkKey(value.network)) {
    issues.push({ path: `${path}.network`, message: "Unknown network." });
  }
  if (value.toNetwork !== undefined && !isNetworkKey(value.toNetwork)) {
    issues.push({ path: `${path}.toNetwork`, message: "Unknown network." });
  }
  if (value.amount !== undefined && value.amount !== "max" && !isDecimalAmount(value.amount)) {
    issues.push({ path: `${path}.amount`, message: "Must be a decimal string or \"max\"." });
  }
  for (const key of ["from", "to", "recipient"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).length > 128)) {
      issues.push({ path: `${path}.${key}`, message: "Must be a string up to 128 characters." });
    }
  }
  if (value.protocol !== undefined && (typeof value.protocol !== "string" || !getProtocol(value.protocol))) {
    issues.push({ path: `${path}.protocol`, message: "Unknown protocol." });
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    issues.push({ path: `${path}.params`, message: "Must be an object." });
  } else if (value.params !== undefined) {
    const params = value.params as Record<string, unknown>;
    if (Object.keys(params).length > 8 || Object.values(params).some((entry) => !["string", "number", "boolean"].includes(typeof entry))) {
      issues.push({ path: `${path}.params`, message: "Up to 8 string, number or boolean values." });
    }
    if (params.venue !== undefined && (typeof params.venue !== "string" || !params.venue.trim() || params.venue.length > 128)) {
      issues.push({ path: `${path}.params.venue`, message: "Must be a venue id, slug or address up to 128 characters." });
    }
  }
  const contractKind = typeof kind === "string" && CONTRACT_ACTION_KINDS.includes(kind as IntentActionKind);
  if (contractKind) {
    if (typeof value.contract !== "string" || value.contract.length > CONTRACT_LIMITS.referenceLength || !CONTRACT_REFERENCE_PATTERN.test(value.contract)) {
      issues.push({ path: `${path}.contract`, message: `Required for ${kind}: a contract registration id (ct_...) or alias up to ${CONTRACT_LIMITS.referenceLength} characters.` });
    }
    if (typeof value.entry !== "string" || !CONTRACT_ENTRY_ID_PATTERN.test(value.entry)) {
      issues.push({ path: `${path}.entry`, message: `Required for ${kind}: the registration's action id (${CONTRACT_ENTRY_ID_PATTERN.source}).` });
    }
  } else {
    for (const key of ["contract", "entry"] as const) {
      if (value[key] !== undefined) issues.push({ path: `${path}.${key}`, message: "Only call and action steps reference a contract registration." });
    }
  }
  return value as unknown as IntentActionSpec;
}

function validateActionList(actions: unknown, issues: ValidationIssue[]): IntentActionSpec[] {
  const validated: IntentActionSpec[] = [];
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_INTENT_ACTIONS) {
    issues.push({ path: "actions", message: `Must be a list of 1-${MAX_INTENT_ACTIONS} actions.` });
    return validated;
  }
  actions.forEach((action, index) => {
    const result = validateAction(action, index, issues);
    if (result) validated.push(result);
  });
  return validated;
}

function validateMetadata(value: unknown, issues: ValidationIssue[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).length > 20 ||
    Object.entries(value).some(([key, entry]) => key.length > 40 || typeof entry !== "string" || entry.length > 500)
  ) {
    issues.push({ path: "metadata", message: "Up to 20 string pairs (keys <= 40, values <= 500 chars)." });
    return undefined;
  }
  return value as Record<string, string>;
}

function validateClientReference(value: unknown, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== "string" || !/^[\w.:-]{1,80}$/u.test(value))) {
    issues.push({ path: "clientReference", message: "Must match [A-Za-z0-9_.:-]{1,80}." });
  }
}

function validateAccounts(accounts: unknown, issues: ValidationIssue[]): AccountId[] {
  const validated: AccountId[] = [];
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAX_INTENT_ACCOUNTS) {
    issues.push({ path: "accounts", message: `Provide 1-${MAX_INTENT_ACCOUNTS} CAIP-10 accounts.` });
    return validated;
  }
  accounts.forEach((account, index) => {
    const parsed = parseAccountId(account);
    if (!parsed) issues.push({ path: `accounts[${index}]`, message: "Invalid CAIP-10 account id." });
    else validated.push(parsed.id);
  });
  return validated;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: key, message: `Unknown field. Allowed: ${allowed.join(", ")}.` });
  }
}

function isPositiveDecimal(value: unknown): value is string {
  return isDecimalAmount(value) && !/^0(?:\.0*)?$/u.test(value);
}

function compareDecimals(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const width = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(width, "0"));
  const right = BigInt(bWhole + bFraction.padEnd(width, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `POST /v1/sessions`: a fixed template of structured actions (no text), the
 * origins allowed to embed it, an optional bounded amount the visitor may
 * choose for one action, a TTL (60-3600 s, default 900) and a use count
 * (1-100, default 1).
 */
export function validateSessionCreateRequest(input: unknown): ValidationResult<SessionCreateRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  knownKeys(input, ["actions", "amount", "allowedOrigins", "expiresInSeconds", "maxIntents", "constraints", "metadata", "clientReference"], issues);
  if (input.text !== undefined) issues.push({ path: "text", message: "Sessions take structured actions only." });
  const actions = validateActionList(input.actions, issues);
  let amount: SessionCreateRequest["amount"];
  if (input.amount !== undefined) {
    const bounds = input.amount;
    if (!isRecord(bounds)) issues.push({ path: "amount", message: "Must be { action, min, max }." });
    else {
      const index = bounds.action;
      const target = typeof index === "number" && Number.isInteger(index) ? actions[index] : undefined;
      if (!target) issues.push({ path: "amount.action", message: "Must be the index of an action of the template." });
      else if (!isPositiveDecimal(target.amount)) issues.push({ path: `actions[${index as number}].amount`, message: "The action with visitor-chosen amount needs a positive default amount." });
      if (!isPositiveDecimal(bounds.min)) issues.push({ path: "amount.min", message: "Must be a positive decimal string." });
      if (!isPositiveDecimal(bounds.max)) issues.push({ path: "amount.max", message: "Must be a positive decimal string." });
      if (isPositiveDecimal(bounds.min) && isPositiveDecimal(bounds.max)) {
        if (compareDecimals(bounds.min, bounds.max) > 0) issues.push({ path: "amount.min", message: "Must not exceed max." });
        else if (target && isPositiveDecimal(target.amount) && (compareDecimals(target.amount, bounds.min) < 0 || compareDecimals(target.amount, bounds.max) > 0)) {
          issues.push({ path: `actions[${index as number}].amount`, message: "The default amount must lie within amount.min and amount.max." });
        }
        if (target && typeof index === "number") amount = { action: index, min: bounds.min, max: bounds.max };
      }
    }
  }
  const origins: string[] = [];
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0 || input.allowedOrigins.length > CONTRACT_LIMITS.sessionAllowedOrigins) {
    issues.push({ path: "allowedOrigins", message: `List 1-${CONTRACT_LIMITS.sessionAllowedOrigins} origins (https, or http://localhost for development).` });
  } else {
    input.allowedOrigins.forEach((origin, index) => {
      const normalized = normalizeWebOrigin(origin, { allowPort: true, allowLocalhost: true });
      if (!normalized) issues.push({ path: `allowedOrigins[${index}]`, message: "Must be an origin such as https://acme.example (no path)." });
      else if (!origins.includes(normalized)) origins.push(normalized);
    });
  }
  const ttl = input.expiresInSeconds;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < CONTRACT_LIMITS.sessionMinTtlSeconds || ttl > CONTRACT_LIMITS.sessionMaxTtlSeconds)) {
    issues.push({ path: "expiresInSeconds", message: `Must be an integer between ${CONTRACT_LIMITS.sessionMinTtlSeconds} and ${CONTRACT_LIMITS.sessionMaxTtlSeconds}.` });
  }
  const uses = input.maxIntents;
  if (uses !== undefined && (typeof uses !== "number" || !Number.isInteger(uses) || uses < 1 || uses > CONTRACT_LIMITS.sessionMaxIntents)) {
    issues.push({ path: "maxIntents", message: `Must be an integer between 1 and ${CONTRACT_LIMITS.sessionMaxIntents}.` });
  }
  const constraints = validateConstraints(input.constraints, issues);
  const metadata = validateMetadata(input.metadata, issues);
  validateClientReference(input.clientReference, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      actions,
      ...(amount ? { amount } : {}),
      allowedOrigins: origins,
      expiresInSeconds: typeof ttl === "number" ? ttl : CONTRACT_LIMITS.sessionDefaultTtlSeconds,
      maxIntents: typeof uses === "number" ? uses : 1,
      ...(constraints ? { constraints } : {}),
      ...(metadata ? { metadata } : {}),
      ...(typeof input.clientReference === "string" ? { clientReference: input.clientReference } : {}),
    },
  };
}

/** `POST /v1/sessions/{id}/intents`: the visitor's accounts, an optional amount and the host page origin. */
export function validateSessionIntentRequest(input: unknown): ValidationResult<SessionIntentRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  knownKeys(input, ["accounts", "amount", "hostOrigin"], issues);
  const accounts = validateAccounts(input.accounts, issues);
  if (input.amount !== undefined && !isPositiveDecimal(input.amount)) issues.push({ path: "amount", message: "Must be a positive decimal string." });
  const hostOrigin = normalizeWebOrigin(input.hostOrigin, { allowPort: true, allowLocalhost: true });
  if (!hostOrigin) issues.push({ path: "hostOrigin", message: "Required: the origin of the page hosting the frame." });
  if (issues.length > 0 || !hostOrigin) return { ok: false, issues };
  return { ok: true, value: { accounts, ...(typeof input.amount === "string" ? { amount: input.amount } : {}), hostOrigin } };
}

/** `POST /v1/contracts/{id}/test`. */
export function validateContractTestRequest(input: unknown): ValidationResult<ContractTestRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  knownKeys(input, ["entry", "account", "amount", "params", "recipient"], issues);
  if (typeof input.entry !== "string" || !CONTRACT_ENTRY_ID_PATTERN.test(input.entry)) {
    issues.push({ path: "entry", message: `Must be an action id of the registration (${CONTRACT_ENTRY_ID_PATTERN.source}).` });
  }
  const account = parseAccountId(input.account);
  if (!account) issues.push({ path: "account", message: "Must be a CAIP-10 account on the registration's network." });
  if (input.amount !== undefined && !isPositiveDecimal(input.amount)) issues.push({ path: "amount", message: "Must be a positive decimal string." });
  if (input.params !== undefined) {
    const params = input.params;
    if (!isRecord(params) || Object.keys(params).length > 8 || Object.values(params).some((entry) => !["string", "number", "boolean"].includes(typeof entry))) {
      issues.push({ path: "params", message: "Up to 8 string, number or boolean values." });
    }
  }
  if (input.recipient !== undefined && (typeof input.recipient !== "string" || !input.recipient.trim() || input.recipient.length > 128)) {
    issues.push({ path: "recipient", message: "Must be a string up to 128 characters." });
  }
  if (issues.length > 0 || !account) return { ok: false, issues };
  return {
    ok: true,
    value: {
      entry: input.entry as string,
      account: account.id,
      ...(typeof input.amount === "string" ? { amount: input.amount } : {}),
      ...(isRecord(input.params) ? { params: input.params as Record<string, string | number | boolean> } : {}),
      ...(typeof input.recipient === "string" ? { recipient: input.recipient } : {}),
    },
  };
}

export function validateIntentRequest(input: unknown): ValidationResult<IntentRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  }
  const text = input.text;
  const actions = input.actions;
  if (text === undefined && actions === undefined) {
    issues.push({ path: "", message: "Provide `text` or `actions`." });
  }
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > MAX_INTENT_TEXT_LENGTH)) {
    issues.push({ path: "text", message: `Must be a non-empty string up to ${MAX_INTENT_TEXT_LENGTH} characters.` });
  }
  const validatedActions: IntentActionSpec[] = actions !== undefined ? validateActionList(actions, issues) : [];
  const validatedAccounts = validateAccounts(input.accounts, issues);
  if (input.defaultNetwork !== undefined && !isNetworkKey(input.defaultNetwork)) {
    issues.push({ path: "defaultNetwork", message: "Unknown network." });
  }
  const constraints = validateConstraints(input.constraints, issues);
  const metadata = validateMetadata(input.metadata, issues);
  validateClientReference(input.clientReference, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...(typeof text === "string" ? { text: text.trim() } : {}),
      ...(validatedActions.length ? { actions: validatedActions } : {}),
      accounts: validatedAccounts,
      ...(input.defaultNetwork ? { defaultNetwork: input.defaultNetwork as NetworkKey } : {}),
      ...(constraints ? { constraints } : {}),
      ...(metadata ? { metadata } : {}),
      ...(typeof input.clientReference === "string" ? { clientReference: input.clientReference } : {}),
    },
  };
}
