/**
 * Dependency-free runtime validation for inbound intent requests. The public
 * API, SDK and widget all use this so an integrator gets identical errors
 * before and after a network round trip.
 */
import { isNetworkKey, type NetworkKey } from "./chains.js";
import { parseAccountId, type AccountId } from "./caip.js";
import { isDecimalAmount } from "./amounts.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
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

const ACTION_KINDS: readonly IntentActionKind[] = [
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
];

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
  return value as unknown as IntentActionSpec;
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
  const validatedActions: IntentActionSpec[] = [];
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_INTENT_ACTIONS) {
      issues.push({ path: "actions", message: `Must be a list of 1-${MAX_INTENT_ACTIONS} actions.` });
    } else {
      actions.forEach((action, index) => {
        const validated = validateAction(action, index, issues);
        if (validated) validatedActions.push(validated);
      });
    }
  }
  const accounts = input.accounts;
  const validatedAccounts: AccountId[] = [];
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAX_INTENT_ACCOUNTS) {
    issues.push({ path: "accounts", message: `Provide 1-${MAX_INTENT_ACCOUNTS} CAIP-10 accounts.` });
  } else {
    accounts.forEach((account, index) => {
      const parsed = parseAccountId(account);
      if (!parsed) issues.push({ path: `accounts[${index}]`, message: "Invalid CAIP-10 account id." });
      else validatedAccounts.push(parsed.id);
    });
  }
  if (input.defaultNetwork !== undefined && !isNetworkKey(input.defaultNetwork)) {
    issues.push({ path: "defaultNetwork", message: "Unknown network." });
  }
  const constraints = validateConstraints(input.constraints, issues);
  let metadata: Record<string, string> | undefined;
  if (input.metadata !== undefined) {
    if (
      !isRecord(input.metadata) ||
      Object.keys(input.metadata).length > 20 ||
      Object.entries(input.metadata).some(
        ([key, value]) => key.length > 40 || typeof value !== "string" || value.length > 500,
      )
    ) {
      issues.push({ path: "metadata", message: "Up to 20 string pairs (keys <= 40, values <= 500 chars)." });
    } else metadata = input.metadata as Record<string, string>;
  }
  if (
    input.clientReference !== undefined &&
    (typeof input.clientReference !== "string" || !/^[\w.:-]{1,80}$/u.test(input.clientReference))
  ) {
    issues.push({ path: "clientReference", message: "Must match [A-Za-z0-9_.:-]{1,80}." });
  }
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
