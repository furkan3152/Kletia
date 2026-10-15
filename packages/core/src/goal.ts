/**
 * The Goal IR: one clause read as a typed desired end state. A Goal
 * names what is spent, what is wanted, where it should sit (network plus
 * custody: the wallet or a venue position), for whom and under which
 * constraints. The verb said, if any, is only a constraint on the route
 * (`op`).
 *
 * Serialisable and free of the person's words: symbols, decimal amounts,
 * network keys, protocol ids and a recipient reference only. Threads keep
 * goals (`ClarifyThread.goals`) so each turn re-solves from them.
 *
 * Pure types, constants and a validator; nothing here reads the network.
 */
import { isNetworkKey, type NetworkKey } from "./chains.js";
import type { ClarifyStepKind } from "./clarify.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
import type { ValidationIssue, ValidationResult } from "./validation.js";

export const GOAL_SPEC = "kletia.goal/v1";

export const GOAL_KINDS = Object.freeze([
  "convert", "relocate", "deliver", "earn", "exit", "acquire", "consolidate", "rebalance", "fuel", "contract",
] as const);
export type GoalKind = (typeof GOAL_KINDS)[number];

/**
 * The verbs a Goal may carry as `op`: the same list as `CLARIFY_STEP_KINDS`
 * (kept here so goal.ts and clarify.ts do not import each other at run time;
 * a core test checks both lists are equal).
 */
export const GOAL_OPS = Object.freeze(
  ["swap", "bridge", "transfer", "stake", "deposit", "withdraw", "call", "action"] as const satisfies readonly ClarifyStepKind[],
);

export const ASSET_CLASSES = Object.freeze(["usd-stable", "eth", "sol", "any-stable", "gas"] as const);
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const VENUE_CATEGORIES = Object.freeze(["lending", "staking", "any"] as const);
export type VenueCategory = (typeof VENUE_CATEGORIES)[number];

export const GOAL_PREFERENCES = Object.freeze(["cheapest", "fastest", "safest"] as const);
export type GoalPreference = (typeof GOAL_PREFERENCES)[number];

export const GOAL_CONFIDENCES = Object.freeze(["exact", "frame", "llm"] as const);
export type GoalConfidence = (typeof GOAL_CONFIDENCES)[number];

/** Where value sits: the wallet itself, a venue (deposit target) or an existing position. */
export type Custody =
  | { readonly kind: "wallet" }
  | { readonly kind: "venue"; readonly protocol?: ProtocolId; readonly vault?: string; readonly category?: VenueCategory }
  | { readonly kind: "position"; readonly protocol?: ProtocolId };

export interface Place {
  readonly network?: NetworkKey;
  readonly custody: Custody;
}

/** A listed symbol (or a mint / contract address), or a class of assets ("my stablecoins"). */
export type AssetSel = { readonly symbol: string } | { readonly class: AssetClass };

export type AmountSel =
  /** Token units, decimal string. */
  | { readonly t: "exact"; readonly value: string }
  /** "$50 of SOL", "50 bucks". */
  | { readonly t: "usd"; readonly value: string }
  /** "half" (5000), "30%" (3000), "a third" (3333). */
  | { readonly t: "portion"; readonly bps: number }
  /** "all", "everything", "my USDC" (goal scope). */
  | { readonly t: "max" }
  /** "all but 0.1": keep this many token units. */
  | { readonly t: "allBut"; readonly keep: string }
  /** "it", "the proceeds": the previous goal's output. */
  | { readonly t: "previous" };
export type AmountSelKind = AmountSel["t"];

export type Holder =
  | { readonly t: "self" }
  | { readonly t: "address"; readonly value: string }
  | { readonly t: "name"; readonly value: string }
  /** "mom", "my friend": never resolved, always asked. */
  | { readonly t: "nickname" }
  /** "my other wallet". */
  | { readonly t: "selfOther" };

export interface GoalConstraints {
  readonly via?: readonly ProtocolId[];
  readonly avoid?: readonly ProtocolId[];
  readonly prefer?: GoalPreference;
  readonly keepGas?: boolean;
}

export interface Goal {
  readonly kind: GoalKind;
  /** The verb said, if any: a constraint on the route. */
  readonly op?: ClarifyStepKind;
  readonly spend: { readonly asset?: AssetSel; readonly amount?: AmountSel; readonly from?: Place };
  /** `amount` here is a target ("get me 1 ETH"). */
  readonly want: { readonly asset?: AssetSel; readonly amount?: AmountSel; readonly at?: Place };
  readonly holder: Holder;
  readonly constraints: GoalConstraints;
  /** Depends on goal #after's output (an earlier goal of the same list). */
  readonly chain?: { readonly after: number };
  /** How it was read: the strict reader, connector frames, or the LLM proposal layer. */
  readonly confidence: GoalConfidence;
}

export const GOAL_LIMITS = Object.freeze({
  /** Goals per thread (one per clause). */
  maxGoals: 8,
  maxRouteSteps: 4,
  /** Route candidates the solver keeps. */
  candidates: 3,
  dustUsd: 1,
  /** A difference is material when it is at least this many USD ... */
  materialUsd: 0.5,
  /** ... and at least this share of the value moved. */
  materialBps: 100,
  /** A network's share of a possessive scope before SCOPE_AMBIGUOUS is asked. */
  scopeShareBps: 1000,
  priceMaxAgeMs: 60_000,
  sweepDeadlineMs: 3_000,
  /** Protocol ids in `constraints.via` / `constraints.avoid`. */
  maxProtocols: 8,
});

// ------------------------------------------------------------ validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "Unknown field." });
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const SYMBOL_PATTERN = /^\S{1,128}$/u;
const VAULT_PATTERN = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const HOLDER_PATTERN = /^\S{1,128}$/u;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/u;
const ZERO = /^0(?:\.0+)?$/u;

function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === "string" && getProtocol(value) !== null;
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function assetIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "An asset is { symbol } or { class }." });
    return;
  }
  if ("symbol" in value) {
    unknownKeys(value, ["symbol"], path, issues);
    if (typeof value.symbol !== "string" || !SYMBOL_PATTERN.test(value.symbol)) {
      issues.push({ path: join(path, "symbol"), message: "A symbol or address of at most 128 characters, no spaces." });
    }
    return;
  }
  unknownKeys(value, ["class"], path, issues);
  if (!includes(ASSET_CLASSES, value.class)) issues.push({ path: join(path, "class"), message: `Must be one of ${ASSET_CLASSES.join(", ")}.` });
}

function amountIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "An amount is { t, ... }." });
    return;
  }
  const positive = (key: string, allowZero: boolean) => {
    const raw = value[key];
    if (typeof raw !== "string" || !POSITIVE_DECIMAL.test(raw) || (!allowZero && ZERO.test(raw))) {
      issues.push({ path: join(path, key), message: allowZero ? "A non-negative decimal string." : "A positive decimal string." });
    }
  };
  switch (value.t) {
    case "exact":
    case "usd":
      unknownKeys(value, ["t", "value"], path, issues);
      positive("value", false);
      return;
    case "portion":
      unknownKeys(value, ["t", "bps"], path, issues);
      if (!Number.isInteger(value.bps) || (value.bps as number) < 1 || (value.bps as number) > 10_000) {
        issues.push({ path: join(path, "bps"), message: "An integer from 1 to 10000." });
      }
      return;
    case "allBut":
      unknownKeys(value, ["t", "keep"], path, issues);
      positive("keep", false);
      return;
    case "max":
    case "previous":
      unknownKeys(value, ["t"], path, issues);
      return;
    default:
      issues.push({ path: join(path, "t"), message: "Must be one of exact, usd, portion, max, allBut, previous." });
  }
}

function placeIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "A place is { network?, custody }." });
    return;
  }
  unknownKeys(value, ["network", "custody"], path, issues);
  if (value.network !== undefined && !isNetworkKey(value.network)) issues.push({ path: join(path, "network"), message: "Unknown network." });
  const custody = value.custody;
  const at = join(path, "custody");
  if (!isRecord(custody)) {
    issues.push({ path: at, message: "Custody is { kind: wallet | venue | position, ... }." });
    return;
  }
  switch (custody.kind) {
    case "wallet":
      unknownKeys(custody, ["kind"], at, issues);
      return;
    case "venue":
      unknownKeys(custody, ["kind", "protocol", "vault", "category"], at, issues);
      if (custody.vault !== undefined && (typeof custody.vault !== "string" || !VAULT_PATTERN.test(custody.vault))) {
        issues.push({ path: join(at, "vault"), message: "A venue id, slug or address." });
      }
      if (custody.category !== undefined && !includes(VENUE_CATEGORIES, custody.category)) {
        issues.push({ path: join(at, "category"), message: `Must be one of ${VENUE_CATEGORIES.join(", ")}.` });
      }
      break;
    case "position":
      unknownKeys(custody, ["kind", "protocol"], at, issues);
      break;
    default:
      issues.push({ path: join(at, "kind"), message: "Must be wallet, venue or position." });
      return;
  }
  if (custody.protocol !== undefined && !isProtocolId(custody.protocol)) issues.push({ path: join(at, "protocol"), message: "Unknown protocol." });
}

function sideIssues(value: unknown, path: string, placeKey: "from" | "at", issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: `An object of asset?, amount?, ${placeKey}?.` });
    return;
  }
  unknownKeys(value, ["asset", "amount", placeKey], path, issues);
  if (value.asset !== undefined) assetIssues(value.asset, join(path, "asset"), issues);
  if (value.amount !== undefined) amountIssues(value.amount, join(path, "amount"), issues);
  if (value[placeKey] !== undefined) placeIssues(value[placeKey], join(path, placeKey), issues);
}

function holderIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "A holder is { t, value? }." });
    return;
  }
  switch (value.t) {
    case "self":
    case "nickname":
    case "selfOther":
      unknownKeys(value, ["t"], path, issues);
      return;
    case "address":
    case "name":
      unknownKeys(value, ["t", "value"], path, issues);
      if (typeof value.value !== "string" || !HOLDER_PATTERN.test(value.value)) {
        issues.push({ path: join(path, "value"), message: "At most 128 characters, no spaces." });
      }
      return;
    default:
      issues.push({ path: join(path, "t"), message: "Must be one of self, address, name, nickname, selfOther." });
  }
}

function protocolListIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (
    !Array.isArray(value) || value.length === 0 || value.length > GOAL_LIMITS.maxProtocols ||
    value.some((entry) => !isProtocolId(entry)) || new Set(value).size !== value.length
  ) {
    issues.push({ path, message: `1 to ${GOAL_LIMITS.maxProtocols} distinct known protocol ids.` });
  }
}

function constraintIssues(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Constraints are { via?, avoid?, prefer?, keepGas? }." });
    return;
  }
  unknownKeys(value, ["via", "avoid", "prefer", "keepGas"], path, issues);
  if (value.via !== undefined) protocolListIssues(value.via, join(path, "via"), issues);
  if (value.avoid !== undefined) protocolListIssues(value.avoid, join(path, "avoid"), issues);
  if (Array.isArray(value.via) && Array.isArray(value.avoid) && value.via.some((id) => (value.avoid as unknown[]).includes(id))) {
    issues.push({ path: join(path, "avoid"), message: "A protocol cannot be both required and avoided." });
  }
  if (value.prefer !== undefined && !includes(GOAL_PREFERENCES, value.prefer)) {
    issues.push({ path: join(path, "prefer"), message: `Must be one of ${GOAL_PREFERENCES.join(", ")}.` });
  }
  if (value.keepGas !== undefined && typeof value.keepGas !== "boolean") issues.push({ path: join(path, "keepGas"), message: "Must be a boolean." });
}

/**
 * Collects the issues of one Goal at `path`. `index` is the goal's place in
 * its list (a chain must point to an earlier goal); without it, `chain.after`
 * only has to be a non-negative integer.
 */
export function goalIssues(input: unknown, path: string, issues: ValidationIssue[], index?: number): void {
  if (!isRecord(input)) {
    issues.push({ path, message: "A goal is an object." });
    return;
  }
  unknownKeys(input, ["kind", "op", "spend", "want", "holder", "constraints", "chain", "confidence"], path, issues);
  if (!includes(GOAL_KINDS, input.kind)) issues.push({ path: join(path, "kind"), message: `Must be one of ${GOAL_KINDS.join(", ")}.` });
  if (input.op !== undefined && !includes(GOAL_OPS, input.op)) issues.push({ path: join(path, "op"), message: `Must be one of ${GOAL_OPS.join(", ")}.` });
  sideIssues(input.spend, join(path, "spend"), "from", issues);
  sideIssues(input.want, join(path, "want"), "at", issues);
  holderIssues(input.holder, join(path, "holder"), issues);
  constraintIssues(input.constraints, join(path, "constraints"), issues);
  if (input.chain !== undefined) {
    const chain = input.chain;
    const at = join(path, "chain");
    if (!isRecord(chain)) issues.push({ path: at, message: "A chain is { after }." });
    else {
      unknownKeys(chain, ["after"], at, issues);
      const after = chain.after;
      if (!Number.isInteger(after) || (after as number) < 0 || (index !== undefined && (after as number) >= index)) {
        issues.push({ path: join(at, "after"), message: index !== undefined ? "The index of an earlier goal." : "A non-negative integer." });
      }
    }
  }
  if (!includes(GOAL_CONFIDENCES, input.confidence)) {
    issues.push({ path: join(path, "confidence"), message: `Must be one of ${GOAL_CONFIDENCES.join(", ")}.` });
  }
}

/** Collects the issues of a goal list (at most GOAL_LIMITS.maxGoals; chains point backwards). */
export function goalListIssues(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(input) || input.length > GOAL_LIMITS.maxGoals) {
    issues.push({ path, message: `At most ${GOAL_LIMITS.maxGoals} goals.` });
    return;
  }
  input.forEach((goal, index) => goalIssues(goal, `${path}[${index}]`, issues, index));
}

/** Shape and value syntax of one Goal. */
export function validateGoal(input: unknown): ValidationResult<Goal> {
  const issues: ValidationIssue[] = [];
  goalIssues(input, "", issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as Goal };
}

/** Shape and value syntax of a goal list (a thread's `goals`). */
export function validateGoals(input: unknown): ValidationResult<readonly Goal[]> {
  const issues: ValidationIssue[] = [];
  goalListIssues(input, "", issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as readonly Goal[] };
}
