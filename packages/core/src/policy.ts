/**
 * Rule Book policy language, `kletia.policy/v1` (policy design PF1, §3).
 *
 * A small typed JSON document attached to a project, an API key or a child
 * agent key: allowlists, denylists, enums, decimal-string USD limits and a
 * timetable. No expressions, regexes or code. This module validates and
 * normalises documents, computes their canonical form and `sha256:` hash,
 * classifies amendments (tighten now, loosen later) and ships the templates.
 * Evaluation lives in policyEvaluate.ts. Pure and dependency-free.
 */
import { ASSETS, findAssetBySymbol, type AssetCategory } from "./assets.js";
import { CHAINS, isNetworkKey, type NetworkKey } from "./chains.js";
import { parseAccountId, parseAssetId } from "./caip.js";
import { CONTRACT_ENTRY_ID_PATTERN, CONTRACT_ID_PATTERN, canonicalJson } from "./contracts.js";
import { sha256Hex } from "./hash.js";
import type { IntentActionKind } from "./intent.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
import { INTENT_ACTION_KINDS, type ValidationIssue } from "./validation.js";

/* ================================================================ constants */

export const POLICY_SCHEMA = "kletia.policy/v1" as const;
/** Decision ids: `pdc_` + 24 hex. */
export const POLICY_DECISION_ID_PATTERN = /^pdc_[0-9a-f]{24}$/u;
/** Approval ids: `apr_` + 32 hex (a 128-bit capability). */
export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{32}$/u;
/** Exposure ids: `px_` + 24 hex. */
export const EXPOSURE_ID_PATTERN = /^px_[0-9a-f]{24}$/u;
/** Agent key secrets: `kl_agt_` + 32 base62 (beside `kl_dev_…`). */
export const AGENT_KEY_PATTERN = /^kl_agt_[0-9A-Za-z]{32}$/u;
export const AGENT_KEY_PREFIX = "kl_agt_";
/** API key ids (public identifiers): `key_` + 24 hex. */
export const API_KEY_ID_PATTERN = /^key_[0-9a-f]{24}$/u;
/** USD amounts in policies: decimal strings, never floats. */
export const POLICY_USD_PATTERN = /^\d{1,12}(?:\.\d{1,2})?$/u;
/** Recipient names the planner accepts (ENS, Basenames, SNS), lower-case. */
export const POLICY_NAME_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:eth|sns|sol)$/u;

export const POLICY_LIMITS = Object.freeze({
  /** Canonical JSON of a document, UTF-8 bytes. */
  documentBytes: 16_384,
  labelLength: 64,
  networks: 9,
  protocols: 40,
  contracts: 25,
  contractEntries: 10,
  assets: 50,
  accounts: 20,
  recipients: 200,
  windows: 14,
  approverKeys: 5,
  approverWallets: 10,
  minSteps: 1,
  maxSteps: 8,
  minSlippageBps: 1,
  maxSlippageBps: 1_000,
  minSeconds: 10,
  maxSeconds: 86_400,
  minConfirmTtlSeconds: 300,
  maxConfirmTtlSeconds: 86_400,
  defaultConfirmTtlSeconds: 3_600,
  maxAmendmentDelaySeconds: 604_800,
  /** Agent keys below a project key. */
  maxAgentDepth: 2,
  agentKeysPerProject: 100,
  agentMinTtlSeconds: 3_600,
  agentMaxTtlSeconds: 31_536_000,
  agentDefaultTtlSeconds: 2_592_000,
  /** Violations returned in one decision (the log keeps all). */
  violationsReturned: 20,
});

export type PolicyMode = "live" | "dry-run" | "paused";
export type PolicyLane = "production" | "testnet";
export type RecipientMode = "own" | "allowlist" | "any";
export type RecipientNamesRule = "deny" | "resolve" | "trusted";
export type ConfirmTrigger = "external-recipient" | "contract-call" | "cross-network";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type PolicyPermission = "createChildKeys" | "webhooks" | "registerContracts" | "sessions" | "storeIntents" | "mcpCreateIntents" | "links";
/** Which defaults fill absent fields: project keys and project rule books (`project`) or agent keys (`agent`). */
export type PolicyDefaults = "project" | "agent";

export const POLICY_MODES: readonly PolicyMode[] = Object.freeze(["live", "dry-run", "paused"]);
export const POLICY_LANES: readonly PolicyLane[] = Object.freeze(["production", "testnet"]);
export const RECIPIENT_MODES: readonly RecipientMode[] = Object.freeze(["own", "allowlist", "any"]);
export const RECIPIENT_NAME_RULES: readonly RecipientNamesRule[] = Object.freeze(["deny", "resolve", "trusted"]);
export const CONFIRM_TRIGGERS: readonly ConfirmTrigger[] = Object.freeze(["external-recipient", "contract-call", "cross-network"]);
export const WEEKDAYS: readonly Weekday[] = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const POLICY_PERMISSIONS: readonly PolicyPermission[] = Object.freeze([
  "createChildKeys",
  "webhooks",
  "registerContracts",
  "sessions",
  "storeIntents",
  "mcpCreateIntents",
  "links",
]);
export const ASSET_CATEGORIES: readonly AssetCategory[] = Object.freeze(["native", "stablecoin", "wrapped", "liquid-staking", "governance", "meme", "btc"]);
export const ASSET_GROUPS = Object.freeze(["USDC", "USDT", "ETH", "BTC", "EURC", "SOL"] as const);

/* ==================================================================== types */

export interface PolicyScheduleWindow {
  readonly days: readonly Weekday[];
  /** "HH:MM", inclusive. */
  readonly from: string;
  /** "HH:MM" or "24:00", exclusive. */
  readonly to: string;
}

export interface PolicyDocument {
  readonly schema: typeof POLICY_SCHEMA;
  /** ≤ 64 printable characters. */
  readonly label?: string;
  readonly mode?: PolicyMode;
  readonly networks?: { readonly allow?: readonly NetworkKey[]; readonly lanes?: readonly PolicyLane[] };
  readonly kinds?: { readonly allow?: readonly IntentActionKind[] };
  readonly protocols?: { readonly allow?: readonly ProtocolId[]; readonly deny?: readonly ProtocolId[] };
  /** BYOC registrations (and entries) the key may call. Absent on an agent key: none. */
  readonly contracts?: { readonly allow?: readonly { readonly id: string; readonly entries?: readonly string[] }[] };
  /** `allow` entries: `SYMBOL`, `SYMBOL@network`, `group:USDC`, or a CAIP-19 id. */
  readonly assets?: { readonly allow?: readonly string[]; readonly categories?: readonly AssetCategory[]; readonly unlisted?: "deny" | "allow" };
  /** CAIP-10 patterns: exact, or `eip155:*:<addr>` / `solana:*:<addr>`. */
  readonly accounts?: { readonly allow?: readonly string[] };
  /** Patterns as accounts, or names (ENS, Basenames, SNS). Deny always wins. */
  readonly recipients?: { readonly mode?: RecipientMode; readonly allow?: readonly string[]; readonly deny?: readonly string[]; readonly names?: RecipientNamesRule };
  readonly limits?: {
    readonly maxSteps?: number;
    readonly maxSlippageBps?: number;
    /** USD per step, value paid on top of the input. */
    readonly maxExtraCostUsd?: string;
    /** USD per intent, estimated network fees. */
    readonly maxFeeUsd?: string;
    /** Settlement estimate per cross-network step. */
    readonly maxSeconds?: number;
  };
  readonly caps?: { readonly perStepUsd?: string; readonly perIntentUsd?: string; readonly dailyUsd?: string; readonly weeklyUsd?: string };
  readonly schedule?: { readonly timezone: string; readonly windows: readonly PolicyScheduleWindow[] };
  readonly confirm?: {
    readonly aboveUsd?: string;
    readonly when?: readonly ConfirmTrigger[];
    readonly approvers?: { readonly keys?: readonly string[]; readonly wallets?: readonly string[]; readonly requireWallet?: boolean };
    readonly ttlSeconds?: number;
  };
  /** API rights of an agent key (ignored on project keys). */
  readonly permissions?: { readonly [P in PolicyPermission]?: boolean };
  readonly execution?: { readonly pinNonce?: boolean };
  readonly amendments?: { readonly delaySeconds?: number };
}

export interface PolicyWarning {
  readonly code: "ACCOUNTS_NOT_PINNED" | "NO_CAPS" | "TRUSTED_NAMES" | "CONTRACT_KINDS_WITHOUT_CONTRACTS" | "CONFIRM_NEVER_TRIGGERS" | "EMPTY_ALLOWLIST";
  readonly path: string;
  readonly message: string;
}

export type PolicyValidationResult =
  | { readonly ok: true; readonly value: PolicyDocument; readonly issues: readonly []; readonly warnings: readonly PolicyWarning[] }
  | { readonly ok: false; readonly value: null; readonly issues: readonly ValidationIssue[]; readonly warnings: readonly PolicyWarning[] };

export interface PolicyValidationOptions {
  /** `agent`: warnings consider agent defaults (recipients `own`, no contracts). Default `project`. */
  readonly defaults?: PolicyDefaults;
}

/* ============================================================== validation */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

let supportedZones: Set<string> | null = null;

/** IANA time zones the runtime can format (`Intl.supportedValuesOf("timeZone")`, plus UTC). */
export function isSupportedTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length > 64) return false;
  if (zone === "UTC" || zone === "Etc/UTC") return true;
  if (supportedZones === null) {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    supportedZones = new Set(typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : []);
  }
  if (supportedZones.size > 0) return supportedZones.has(zone);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** USD decimal string → integer micro-dollars. */
export function policyUsdMicros(value: string): bigint {
  if (!POLICY_USD_PATTERN.test(value)) throw new Error(`Invalid USD amount: ${value}`);
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

/** Integer micro-dollars → decimal string with 2 decimals, rounded up (conservative). */
export function formatUsdMicros(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const centsValue = (absolute + 9_999n) / 10_000n;
  const text = `${centsValue / 100n}.${(centsValue % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** Minutes of "HH:MM" ("24:00" = 1440). */
export function policyTimeMinutes(value: string): number | null {
  if (value === "24:00") return 1_440;
  if (!TIME.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function firstChainOf(namespace: "eip155" | "solana"): string {
  return Object.values(CHAINS).find((chain) => chain.namespace === namespace)?.id ?? `${namespace}:1`;
}

/**
 * Normalises a CAIP-10 pattern: exact accounts (`eip155:8453:0x…`) or the
 * same address on every chain of a namespace (`eip155:*:0x…`,
 * `solana:*:<base58>`). EVM addresses are lower-cased. Null when invalid.
 */
export function normalizeAccountPattern(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 160) return null;
  const match = /^(eip155|solana):\*:(.+)$/u.exec(value);
  if (match) {
    const namespace = match[1] as "eip155" | "solana";
    const parsed = parseAccountId(`${firstChainOf(namespace)}:${match[2]}`);
    if (!parsed) return null;
    return `${namespace}:*:${namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address}`;
  }
  const parsed = parseAccountId(value);
  if (!parsed) return null;
  return `${parsed.chain.id}:${parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address}`;
}

/**
 * True when a CAIP-10 account matches a pattern. The pattern is normalised
 * here too, so a stored document that skipped validation can never make a
 * deny entry miss because of address case.
 */
export function accountMatchesPattern(account: string, pattern: string): boolean {
  const parsed = parseAccountId(account);
  const normalized = normalizeAccountPattern(pattern);
  if (!parsed || !normalized) return false;
  const address = parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
  const wildcard = /^(eip155|solana):\*:(.+)$/u.exec(normalized);
  if (wildcard) return wildcard[1] === parsed.chain.namespace && wildcard[2] === address;
  return normalized === `${parsed.chain.id}:${address}`;
}

/** Normalises an asset entry (`USDC`, `USDC@base`, `group:ETH`, CAIP-19) to its canonical spelling; null when unknown. */
export function normalizeAssetEntry(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return null;
  if (value.toLowerCase().startsWith("group:")) {
    const group = value.slice(6).toUpperCase();
    return (ASSET_GROUPS as readonly string[]).includes(group) ? `group:${group}` : null;
  }
  if (value.includes("/")) {
    const parsed = parseAssetId(value);
    if (!parsed) return null;
    return parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : parsed.id;
  }
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const network = value.slice(at + 1);
    if (!isNetworkKey(network)) return null;
    const asset = findAssetBySymbol(network, value.slice(0, at));
    return asset ? `${asset.symbol}@${network}` : null;
  }
  const wanted = value.toUpperCase();
  const asset = ASSETS.find((candidate) => candidate.symbol.toUpperCase() === wanted);
  return asset ? asset.symbol : null;
}

function normalizeRecipientPattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (POLICY_NAME_PATTERN.test(lower)) return lower;
  return normalizeAccountPattern(value);
}

function weekdayOrder(day: Weekday): number {
  return WEEKDAYS.indexOf(day);
}

function sortedUnique<T extends string>(values: readonly T[], compare?: (a: T, b: T) => number): T[] {
  return [...new Set(values)].sort(compare);
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, message: `Unknown field. Allowed: ${allowed.join(", ")}.` });
  }
}

function stringList<T extends string>(
  value: unknown,
  path: string,
  max: number,
  normalize: (entry: unknown) => T | null,
  what: string,
  issues: ValidationIssue[],
  options: { readonly minItems?: number } = {},
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.length < (options.minItems ?? 0)) {
    issues.push({ path, message: `Must be a list of ${options.minItems ? `${options.minItems}-` : "at most "}${max} ${what}.` });
    return undefined;
  }
  const out: T[] = [];
  value.forEach((entry, index) => {
    const normalized = normalize(entry);
    if (normalized === null) issues.push({ path: `${path}[${index}]`, message: `Unknown or malformed ${what.replace(/s$/u, "")}.` });
    else if (out.includes(normalized)) issues.push({ path: `${path}[${index}]`, message: "Duplicate entry." });
    else out.push(normalized);
  });
  return out;
}

const enumOf = <T extends string>(values: readonly T[]) => (entry: unknown): T | null =>
  typeof entry === "string" && (values as readonly string[]).includes(entry) ? (entry as T) : null;

function integer(value: unknown, path: string, min: number, max: number, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    issues.push({ path, message: `Must be an integer between ${min} and ${max}.` });
    return undefined;
  }
  return value;
}

function usd(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !POLICY_USD_PATTERN.test(value)) {
    issues.push({ path, message: "Must be a USD decimal string with at most 2 decimals, e.g. \"1500\" or \"12.50\"." });
    return undefined;
  }
  // Canonical spelling: no leading zeros, no trailing fraction zeros.
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return `${BigInt(whole).toString()}${trimmed ? `.${trimmed}` : ""}`;
}

function bool(value: unknown, path: string, issues: ValidationIssue[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    issues.push({ path, message: "Must be a boolean." });
    return undefined;
  }
  return value;
}

function section(input: Record<string, unknown>, key: string, allowed: readonly string[], issues: ValidationIssue[]): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: key, message: "Must be an object." });
    return undefined;
  }
  knownKeys(value, allowed, key, issues);
  return value;
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * Validates and normalises a policy document (policy design §3.3): shape,
 * enums, ranges, decimal strings, unknown fields, sizes, registry identifiers
 * and cross-field consistency. `value` is the normalised document (sets
 * de-duplicated and sorted, EVM addresses lower-cased, registry spellings),
 * ready to store. Warnings never block.
 */
export function validatePolicy(input: unknown, options: PolicyValidationOptions = {}): PolicyValidationResult {
  const issues: ValidationIssue[] = [];
  const warnings: PolicyWarning[] = [];
  if (!isRecord(input)) return { ok: false, value: null, issues: [{ path: "", message: "A policy is a JSON object." }], warnings };
  knownKeys(input, ["schema", "label", "mode", "networks", "kinds", "protocols", "contracts", "assets", "accounts", "recipients", "limits", "caps", "schedule", "confirm", "permissions", "execution", "amendments"], "", issues);
  if (input.schema !== POLICY_SCHEMA) issues.push({ path: "schema", message: `Must be "${POLICY_SCHEMA}".` });

  let label: string | undefined;
  if (input.label !== undefined) {
    if (typeof input.label !== "string" || input.label.trim().length === 0 || [...input.label].length > POLICY_LIMITS.labelLength || NON_PRINTABLE.test(input.label)) {
      issues.push({ path: "label", message: `Must be 1-${POLICY_LIMITS.labelLength} printable characters.` });
    } else label = input.label;
  }
  let mode: PolicyMode | undefined;
  if (input.mode !== undefined) {
    if (!(POLICY_MODES as readonly unknown[]).includes(input.mode)) issues.push({ path: "mode", message: `Must be one of ${POLICY_MODES.join(", ")}.` });
    else mode = input.mode as PolicyMode;
  }

  const networksIn = section(input, "networks", ["allow", "lanes"], issues);
  const networks = networksIn
    ? compact({
        allow: stringList(networksIn.allow, "networks.allow", POLICY_LIMITS.networks, (entry) => (isNetworkKey(entry) ? entry : null), "network keys", issues),
        lanes: stringList(networksIn.lanes, "networks.lanes", 2, enumOf(POLICY_LANES), "lanes", issues),
      })
    : undefined;

  const kindsIn = section(input, "kinds", ["allow"], issues);
  const kinds = kindsIn
    ? compact({ allow: stringList(kindsIn.allow, "kinds.allow", INTENT_ACTION_KINDS.length, enumOf(INTENT_ACTION_KINDS), "step kinds", issues) })
    : undefined;

  const protocolsIn = section(input, "protocols", ["allow", "deny"], issues);
  const protocolId = (entry: unknown): ProtocolId | null => (typeof entry === "string" && getProtocol(entry) ? (entry as ProtocolId) : null);
  const protocols = protocolsIn
    ? compact({
        allow: stringList(protocolsIn.allow, "protocols.allow", POLICY_LIMITS.protocols, protocolId, "protocol ids", issues),
        deny: stringList(protocolsIn.deny, "protocols.deny", POLICY_LIMITS.protocols, protocolId, "protocol ids", issues),
      })
    : undefined;

  const contractsIn = section(input, "contracts", ["allow"], issues);
  let contracts: PolicyDocument["contracts"];
  if (contractsIn && contractsIn.allow !== undefined) {
    const list = contractsIn.allow;
    if (!Array.isArray(list) || list.length > POLICY_LIMITS.contracts) {
      issues.push({ path: "contracts.allow", message: `Must be a list of at most ${POLICY_LIMITS.contracts} registrations.` });
    } else {
      const allow: { id: string; entries?: string[] }[] = [];
      list.forEach((entry, index) => {
        const path = `contracts.allow[${index}]`;
        if (!isRecord(entry)) {
          issues.push({ path, message: "Must be { id, entries? }." });
          return;
        }
        knownKeys(entry, ["id", "entries"], path, issues);
        if (typeof entry.id !== "string" || !CONTRACT_ID_PATTERN.test(entry.id)) {
          issues.push({ path: `${path}.id`, message: "Must be a contract registration id (ct_ + 24 hex)." });
          return;
        }
        if (allow.some((existing) => existing.id === entry.id)) {
          issues.push({ path: `${path}.id`, message: "Duplicate registration." });
          return;
        }
        const entries = stringList(entry.entries, `${path}.entries`, POLICY_LIMITS.contractEntries, (value) => (typeof value === "string" && CONTRACT_ENTRY_ID_PATTERN.test(value) ? value : null), "entry ids", issues, { minItems: 1 });
        allow.push({ id: entry.id, ...(entries ? { entries: sortedUnique(entries) } : {}) });
      });
      contracts = { allow: allow.sort((a, b) => (a.id < b.id ? -1 : 1)) };
    }
  } else if (contractsIn) contracts = {};

  const assetsIn = section(input, "assets", ["allow", "categories", "unlisted"], issues);
  let assets: PolicyDocument["assets"];
  if (assetsIn) {
    let unlisted: "deny" | "allow" | undefined;
    if (assetsIn.unlisted !== undefined) {
      if (assetsIn.unlisted !== "deny" && assetsIn.unlisted !== "allow") issues.push({ path: "assets.unlisted", message: "Must be deny or allow." });
      else unlisted = assetsIn.unlisted;
    }
    assets = compact({
      allow: stringList(assetsIn.allow, "assets.allow", POLICY_LIMITS.assets, normalizeAssetEntry, "asset entries (SYMBOL, SYMBOL@network, group:X or CAIP-19)", issues),
      categories: stringList(assetsIn.categories, "assets.categories", ASSET_CATEGORIES.length, enumOf(ASSET_CATEGORIES), "asset categories", issues),
      unlisted,
    });
  }

  const accountsIn = section(input, "accounts", ["allow"], issues);
  const accounts = accountsIn
    ? compact({ allow: stringList(accountsIn.allow, "accounts.allow", POLICY_LIMITS.accounts, normalizeAccountPattern, "CAIP-10 account patterns", issues) })
    : undefined;

  const recipientsIn = section(input, "recipients", ["mode", "allow", "deny", "names"], issues);
  let recipients: PolicyDocument["recipients"];
  if (recipientsIn) {
    let recipientMode: RecipientMode | undefined;
    if (recipientsIn.mode !== undefined) {
      if (!(RECIPIENT_MODES as readonly unknown[]).includes(recipientsIn.mode)) issues.push({ path: "recipients.mode", message: `Must be one of ${RECIPIENT_MODES.join(", ")}.` });
      else recipientMode = recipientsIn.mode as RecipientMode;
    }
    let names: RecipientNamesRule | undefined;
    if (recipientsIn.names !== undefined) {
      if (!(RECIPIENT_NAME_RULES as readonly unknown[]).includes(recipientsIn.names)) issues.push({ path: "recipients.names", message: `Must be one of ${RECIPIENT_NAME_RULES.join(", ")}.` });
      else names = recipientsIn.names as RecipientNamesRule;
    }
    recipients = compact({
      mode: recipientMode,
      allow: stringList(recipientsIn.allow, "recipients.allow", POLICY_LIMITS.recipients, normalizeRecipientPattern, "recipient patterns or names", issues),
      deny: stringList(recipientsIn.deny, "recipients.deny", POLICY_LIMITS.recipients, normalizeRecipientPattern, "recipient patterns or names", issues),
      names,
    });
  }

  const limitsIn = section(input, "limits", ["maxSteps", "maxSlippageBps", "maxExtraCostUsd", "maxFeeUsd", "maxSeconds"], issues);
  const limits = limitsIn
    ? compact({
        maxSteps: integer(limitsIn.maxSteps, "limits.maxSteps", POLICY_LIMITS.minSteps, POLICY_LIMITS.maxSteps, issues),
        maxSlippageBps: integer(limitsIn.maxSlippageBps, "limits.maxSlippageBps", POLICY_LIMITS.minSlippageBps, POLICY_LIMITS.maxSlippageBps, issues),
        maxExtraCostUsd: usd(limitsIn.maxExtraCostUsd, "limits.maxExtraCostUsd", issues),
        maxFeeUsd: usd(limitsIn.maxFeeUsd, "limits.maxFeeUsd", issues),
        maxSeconds: integer(limitsIn.maxSeconds, "limits.maxSeconds", POLICY_LIMITS.minSeconds, POLICY_LIMITS.maxSeconds, issues),
      })
    : undefined;

  const capsIn = section(input, "caps", ["perStepUsd", "perIntentUsd", "dailyUsd", "weeklyUsd"], issues);
  const caps = capsIn
    ? compact({
        perStepUsd: usd(capsIn.perStepUsd, "caps.perStepUsd", issues),
        perIntentUsd: usd(capsIn.perIntentUsd, "caps.perIntentUsd", issues),
        dailyUsd: usd(capsIn.dailyUsd, "caps.dailyUsd", issues),
        weeklyUsd: usd(capsIn.weeklyUsd, "caps.weeklyUsd", issues),
      })
    : undefined;
  if (caps) {
    const order = ["perStepUsd", "perIntentUsd", "dailyUsd", "weeklyUsd"] as const;
    const present = order.filter((key) => caps[key] !== undefined);
    for (let index = 1; index < present.length; index += 1) {
      const lower = present[index - 1] as (typeof order)[number];
      const higher = present[index] as (typeof order)[number];
      if (policyUsdMicros(caps[lower] as string) > policyUsdMicros(caps[higher] as string)) {
        issues.push({ path: `caps.${lower}`, message: `Must not exceed caps.${higher} (perStepUsd ≤ perIntentUsd ≤ dailyUsd ≤ weeklyUsd).` });
      }
    }
  }

  const scheduleIn = section(input, "schedule", ["timezone", "windows"], issues);
  let schedule: PolicyDocument["schedule"];
  if (scheduleIn) {
    if (!isSupportedTimeZone(scheduleIn.timezone)) issues.push({ path: "schedule.timezone", message: "Must be an IANA time zone this runtime supports, e.g. Europe/Istanbul." });
    const windowsIn = scheduleIn.windows;
    const windows: PolicyScheduleWindow[] = [];
    if (!Array.isArray(windowsIn) || windowsIn.length === 0 || windowsIn.length > POLICY_LIMITS.windows) {
      issues.push({ path: "schedule.windows", message: `List 1-${POLICY_LIMITS.windows} windows; overnight windows are two windows.` });
    } else {
      windowsIn.forEach((window, index) => {
        const path = `schedule.windows[${index}]`;
        if (!isRecord(window)) {
          issues.push({ path, message: "Must be { days, from, to }." });
          return;
        }
        knownKeys(window, ["days", "from", "to"], path, issues);
        const days = stringList(window.days, `${path}.days`, 7, enumOf(WEEKDAYS), "weekdays (mon-sun)", issues, { minItems: 1 });
        const from = typeof window.from === "string" && window.from !== "24:00" ? policyTimeMinutes(window.from) : null;
        const to = typeof window.to === "string" ? policyTimeMinutes(window.to) : null;
        if (from === null) issues.push({ path: `${path}.from`, message: "Must be HH:MM (00:00-23:59)." });
        if (to === null) issues.push({ path: `${path}.to`, message: "Must be HH:MM (00:01-24:00)." });
        if (from !== null && to !== null && from >= to) issues.push({ path: `${path}.to`, message: "Must be later than from; split overnight windows in two." });
        if (days && from !== null && to !== null && from < to) {
          windows.push({ days: sortedUnique(days, (a, b) => weekdayOrder(a) - weekdayOrder(b)), from: window.from as string, to: window.to as string });
        }
      });
    }
    if (typeof scheduleIn.timezone === "string") {
      schedule = {
        timezone: scheduleIn.timezone,
        windows: windows.sort((a, b) => {
          const left = [weekdayOrder(a.days[0] as Weekday), a.from, a.to, a.days.join(",")];
          const right = [weekdayOrder(b.days[0] as Weekday), b.from, b.to, b.days.join(",")];
          for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return (left[index] as number | string) < (right[index] as number | string) ? -1 : 1;
          }
          return 0;
        }),
      };
    }
  }

  const confirmIn = section(input, "confirm", ["aboveUsd", "when", "approvers", "ttlSeconds"], issues);
  let confirm: PolicyDocument["confirm"];
  if (confirmIn) {
    let approvers: NonNullable<PolicyDocument["confirm"]>["approvers"];
    if (confirmIn.approvers !== undefined) {
      if (!isRecord(confirmIn.approvers)) issues.push({ path: "confirm.approvers", message: "Must be { keys?, wallets?, requireWallet? }." });
      else {
        knownKeys(confirmIn.approvers, ["keys", "wallets", "requireWallet"], "confirm.approvers", issues);
        approvers = compact({
          keys: stringList(confirmIn.approvers.keys, "confirm.approvers.keys", POLICY_LIMITS.approverKeys, (entry) => (typeof entry === "string" && API_KEY_ID_PATTERN.test(entry) ? entry : null), "project key ids", issues),
          wallets: stringList(confirmIn.approvers.wallets, "confirm.approvers.wallets", POLICY_LIMITS.approverWallets, normalizeAccountPattern, "CAIP-10 wallet patterns", issues),
          requireWallet: bool(confirmIn.approvers.requireWallet, "confirm.approvers.requireWallet", issues),
        });
      }
    }
    confirm = compact({
      aboveUsd: usd(confirmIn.aboveUsd, "confirm.aboveUsd", issues),
      when: stringList(confirmIn.when, "confirm.when", CONFIRM_TRIGGERS.length, enumOf(CONFIRM_TRIGGERS), "triggers", issues),
      approvers,
      ttlSeconds: integer(confirmIn.ttlSeconds, "confirm.ttlSeconds", POLICY_LIMITS.minConfirmTtlSeconds, POLICY_LIMITS.maxConfirmTtlSeconds, issues),
    });
    if (approvers?.requireWallet && !(approvers.wallets && approvers.wallets.length > 0)) {
      issues.push({ path: "confirm.approvers.requireWallet", message: "requireWallet needs confirm.approvers.wallets." });
    }
  }

  const permissionsIn = section(input, "permissions", POLICY_PERMISSIONS, issues);
  const permissions = permissionsIn
    ? compact(Object.fromEntries(POLICY_PERMISSIONS.map((permission) => [permission, bool(permissionsIn[permission], `permissions.${permission}`, issues)])))
    : undefined;
  const executionIn = section(input, "execution", ["pinNonce"], issues);
  const execution = executionIn ? compact({ pinNonce: bool(executionIn.pinNonce, "execution.pinNonce", issues) }) : undefined;
  const amendmentsIn = section(input, "amendments", ["delaySeconds"], issues);
  const amendments = amendmentsIn
    ? compact({ delaySeconds: integer(amendmentsIn.delaySeconds, "amendments.delaySeconds", 0, POLICY_LIMITS.maxAmendmentDelaySeconds, issues) })
    : undefined;

  const effectiveRecipientMode = recipients?.mode ?? (options.defaults === "agent" ? "own" : "any");
  if (recipients?.mode === "allowlist" && !(recipients.allow && recipients.allow.length > 0)) {
    issues.push({ path: "recipients.allow", message: "recipients.mode allowlist needs recipients.allow." });
  }

  // Warnings that matter for agents (also shown in the portal).
  if (effectiveRecipientMode === "own" && !(accounts?.allow && accounts.allow.length > 0)) {
    warnings.push({ code: "ACCOUNTS_NOT_PINNED", path: "accounts.allow", message: "Recipients must be the request's own accounts, but accounts are not pinned: an agent can list an account it controls in accounts and receive funds there. Pin accounts." });
  }
  if ((mode ?? "live") === "live" && !caps) {
    warnings.push({ code: "NO_CAPS", path: "caps", message: "Nothing bounds how much value this key moves. Set caps." });
  }
  if (recipients?.names === "trusted") {
    warnings.push({ code: "TRUSTED_NAMES", path: "recipients.names", message: "Whoever controls a trusted name's records controls the destination." });
  }
  if (kinds?.allow?.some((kind) => kind === "call" || kind === "action") && !(contracts?.allow && contracts.allow.length > 0)) {
    warnings.push({ code: "CONTRACT_KINDS_WITHOUT_CONTRACTS", path: "contracts.allow", message: options.defaults === "agent" ? "call and action steps are allowed, but no registration is listed, so an agent can call none." : "call and action steps are allowed for every registration this key can use. List registrations in contracts.allow." });
  }
  if (confirm?.aboveUsd !== undefined && caps?.perIntentUsd !== undefined && policyUsdMicros(confirm.aboveUsd) >= policyUsdMicros(caps.perIntentUsd)) {
    warnings.push({ code: "CONFIRM_NEVER_TRIGGERS", path: "confirm.aboveUsd", message: "confirm.aboveUsd is not below caps.perIntentUsd, so it can never trigger." });
  }
  for (const [path, list] of [["networks.allow", networks?.allow], ["kinds.allow", kinds?.allow], ["protocols.allow", protocols?.allow], ["assets.allow", assets?.allow], ["accounts.allow", accounts?.allow]] as const) {
    if (list && list.length === 0) warnings.push({ code: "EMPTY_ALLOWLIST", path, message: `${path} is empty: nothing is allowed.` });
  }

  if (issues.length > 0) return { ok: false, value: null, issues, warnings };
  const value = Object.fromEntries(
    Object.entries({
      schema: POLICY_SCHEMA,
      label,
      mode,
      networks: networks ? { ...(networks.allow ? { allow: sortedUnique(networks.allow) } : {}), ...(networks.lanes ? { lanes: sortedUnique(networks.lanes) } : {}) } : undefined,
      kinds: kinds ? { ...(kinds.allow ? { allow: sortedUnique(kinds.allow) } : {}) } : undefined,
      protocols: protocols ? { ...(protocols.allow ? { allow: sortedUnique(protocols.allow) } : {}), ...(protocols.deny ? { deny: sortedUnique(protocols.deny) } : {}) } : undefined,
      contracts,
      assets: assets
        ? { ...(assets.allow ? { allow: sortedUnique(assets.allow) } : {}), ...(assets.categories ? { categories: sortedUnique(assets.categories) } : {}), ...(assets.unlisted ? { unlisted: assets.unlisted } : {}) }
        : undefined,
      accounts: accounts ? { ...(accounts.allow ? { allow: sortedUnique(accounts.allow) } : {}) } : undefined,
      recipients: recipients
        ? {
            ...(recipients.mode ? { mode: recipients.mode } : {}),
            ...(recipients.allow ? { allow: sortedUnique(recipients.allow) } : {}),
            ...(recipients.deny ? { deny: sortedUnique(recipients.deny) } : {}),
            ...(recipients.names ? { names: recipients.names } : {}),
          }
        : undefined,
      limits,
      caps,
      schedule,
      confirm: confirm
        ? {
            ...confirm,
            ...(confirm.when ? { when: sortedUnique(confirm.when) } : {}),
            ...(confirm.approvers
              ? {
                  approvers: {
                    ...confirm.approvers,
                    ...(confirm.approvers.keys ? { keys: sortedUnique(confirm.approvers.keys) } : {}),
                    ...(confirm.approvers.wallets ? { wallets: sortedUnique(confirm.approvers.wallets) } : {}),
                  },
                }
              : {}),
          }
        : undefined,
      permissions,
      execution,
      amendments,
    }).filter(([, entry]) => entry !== undefined),
  ) as unknown as PolicyDocument;
  const bytes = new TextEncoder().encode(canonicalJson(value)).length;
  if (bytes > POLICY_LIMITS.documentBytes) {
    return { ok: false, value: null, issues: [{ path: "", message: `The canonical document is ${bytes} bytes; the limit is ${POLICY_LIMITS.documentBytes}.` }], warnings };
  }
  return { ok: true, value, issues: [], warnings };
}

/* ========================================================== canonical form */

/** Canonical JSON of a document: validated, normalised, defaults NOT filled, keys sorted. Throws when invalid. */
export function canonicalPolicy(document: unknown): string {
  const result = validatePolicy(document);
  if (!result.ok) throw new Error(`Invalid policy: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  return canonicalJson(result.value);
}

/** `"sha256:" + hex(SHA-256(canonicalPolicy(document)))`; the SDK guard pins this value. */
export function policyHash(document: unknown): string {
  return `sha256:${sha256Hex(canonicalPolicy(document))}`;
}

/* ================================================================ defaults */

/**
 * Defaults an agent key's rule book takes for absent fields, so forgetting a
 * section never widens an agent (policy design §3.2).
 */
export const AGENT_POLICY_DEFAULTS = Object.freeze({
  recipientsMode: "own" as RecipientMode,
  contractsAllow: Object.freeze([]) as readonly { readonly id: string; readonly entries?: readonly string[] }[],
  assetsUnlisted: "deny" as const,
  permissions: Object.freeze({
    createChildKeys: false,
    webhooks: false,
    registerContracts: false,
    sessions: false,
    storeIntents: true,
    mcpCreateIntents: false,
    links: false,
  }) as Readonly<Record<PolicyPermission, boolean>>,
  pinNonce: true,
});

/** The agent rule book when none is given at creation: the `observer` template. */
export const OBSERVER_POLICY: PolicyDocument = Object.freeze({ schema: POLICY_SCHEMA, mode: "dry-run" });

/**
 * The document with defaults filled, for display (`GET …/policy` →
 * `effective.document`). Evaluation applies the same defaults itself.
 */
export function effectivePolicyDocument(document: PolicyDocument | null, defaults: PolicyDefaults): PolicyDocument {
  const base = document ?? (defaults === "agent" ? OBSERVER_POLICY : { schema: POLICY_SCHEMA });
  if (defaults === "project") return base;
  return {
    ...base,
    recipients: { ...base.recipients, mode: base.recipients?.mode ?? AGENT_POLICY_DEFAULTS.recipientsMode },
    contracts: { allow: base.contracts?.allow ?? AGENT_POLICY_DEFAULTS.contractsAllow },
    assets: { ...base.assets, unlisted: base.assets?.unlisted ?? AGENT_POLICY_DEFAULTS.assetsUnlisted },
    permissions: { ...AGENT_POLICY_DEFAULTS.permissions, ...base.permissions },
    execution: { pinNonce: base.execution?.pinNonce ?? AGENT_POLICY_DEFAULTS.pinNonce },
  };
}

/* ============================================================== comparison */

export interface PolicyComparison {
  /** Field paths that got tighter (they apply at once). */
  readonly tightened: readonly string[];
  /** Field paths that got looser (the version waits the active version's `amendments.delaySeconds`). */
  readonly loosened: readonly string[];
}

type Verdict = "equal" | "tighter" | "looser";

/** null = everything. */
function compareAllowlist(active: readonly string[] | null, next: readonly string[] | null): Verdict {
  const same = (a: readonly string[] | null, b: readonly string[] | null) =>
    a === null ? b === null : b !== null && a.length === b.length && a.every((entry) => b.includes(entry));
  if (same(active, next)) return "equal";
  if (active === null) return "tighter";
  if (next === null) return "looser";
  return next.every((entry) => active.includes(entry)) ? "tighter" : "looser";
}

function compareDenylist(active: readonly string[], next: readonly string[]): Verdict {
  if (active.length === next.length && active.every((entry) => next.includes(entry))) return "equal";
  return active.every((entry) => next.includes(entry)) ? "tighter" : "looser";
}

/** Lower is tighter; null = unlimited. */
function compareLimit(active: bigint | null, next: bigint | null): Verdict {
  if (active === next) return "equal";
  if (next === null) return "looser";
  if (active === null) return "tighter";
  return next < active ? "tighter" : "looser";
}

/** Higher rank is tighter. */
function compareRank(active: number, next: number): Verdict {
  return active === next ? "equal" : next > active ? "tighter" : "looser";
}

const usdOrNull = (value: string | undefined): bigint | null => (value === undefined ? null : policyUsdMicros(value));
const intOrNull = (value: number | undefined): bigint | null => (value === undefined ? null : BigInt(value));

/** 7 × 1440 open-minute bitmap of a schedule (null schedule = always open). */
export function scheduleBitmap(schedule: PolicyDocument["schedule"] | null | undefined): Uint8Array {
  const bitmap = new Uint8Array(7 * 1_440);
  if (!schedule) return bitmap.fill(1);
  for (const window of schedule.windows) {
    const from = policyTimeMinutes(window.from) ?? 0;
    const to = policyTimeMinutes(window.to) ?? 0;
    for (const day of window.days) {
      const base = weekdayOrder(day) * 1_440;
      for (let minute = from; minute < to; minute += 1) bitmap[base + minute] = 1;
    }
  }
  return bitmap;
}

function compareSchedule(active: PolicyDocument["schedule"], next: PolicyDocument["schedule"]): Verdict {
  if (!active && !next) return "equal";
  if (!next) return "looser";
  if (active && active.timezone !== next.timezone) return "looser";
  const left = scheduleBitmap(active);
  const right = scheduleBitmap(next);
  let equal = true;
  for (let index = 0; index < left.length; index += 1) {
    if (right[index] === 1 && left[index] !== 1) return "looser";
    if (left[index] !== right[index]) equal = false;
  }
  return equal ? "equal" : "tighter";
}

function contractsVerdict(active: PolicyDocument["contracts"], next: PolicyDocument["contracts"], defaults: PolicyDefaults): Verdict {
  const fill = (value: PolicyDocument["contracts"]) => value?.allow ?? (defaults === "agent" ? AGENT_POLICY_DEFAULTS.contractsAllow : null);
  const left = fill(active);
  const right = fill(next);
  const flatten = (list: readonly { id: string; entries?: readonly string[] }[]) => list.map((entry) => `${entry.id}:${entry.entries ? [...entry.entries].sort().join(",") : "*"}`).sort();
  if (left === null && right === null) return "equal";
  if (left === null) return "tighter";
  if (right === null) return "looser";
  if (flatten(left).join("|") === flatten(right).join("|")) return "equal";
  const covered = right.every((entry) => {
    const match = left.find((candidate) => candidate.id === entry.id);
    if (!match) return false;
    if (!match.entries) return true;
    return entry.entries !== undefined && entry.entries.every((name) => match.entries?.includes(name));
  });
  return covered ? "tighter" : "looser";
}

/**
 * Classifies every field of an amendment (policy design §3.5): tighter when
 * allowlists shrink, denylists grow, limits and caps drop, the mode moves
 * towards `paused`, recipients towards `own`, names towards `deny`,
 * schedules shrink inside the same time zone, confirmation thresholds drop
 * or triggers grow, approver wallets are removed, an approver key list is
 * set or narrowed (an empty or absent key list lets every project key
 * approve, so emptying it loosens), permissions turn off, nonce pinning
 * turns on, and the amendment delay grows. `active` null: the first
 * version (everything present tightens). `next` null: removal (every
 * restriction loosens).
 */
export function comparePolicies(active: PolicyDocument | null, next: PolicyDocument | null, options: { readonly defaults?: PolicyDefaults } = {}): PolicyComparison {
  const defaults: PolicyDefaults = next === null ? "project" : options.defaults ?? "project";
  const a: PolicyDocument = active ?? { schema: POLICY_SCHEMA };
  const b: PolicyDocument = next ?? { schema: POLICY_SCHEMA };
  const agent = defaults === "agent";
  const verdicts: [string, Verdict][] = [];
  const add = (path: string, verdict: Verdict) => verdicts.push([path, verdict]);
  const modeRank = (mode: PolicyMode | undefined) => POLICY_MODES.indexOf(mode ?? "live");
  add("mode", compareRank(modeRank(a.mode), modeRank(b.mode)));
  add("networks.allow", compareAllowlist(a.networks?.allow ?? null, b.networks?.allow ?? null));
  add("networks.lanes", compareAllowlist(a.networks?.lanes ?? null, b.networks?.lanes ?? null));
  add("kinds.allow", compareAllowlist(a.kinds?.allow ?? null, b.kinds?.allow ?? null));
  add("protocols.allow", compareAllowlist(a.protocols?.allow ?? null, b.protocols?.allow ?? null));
  add("protocols.deny", compareDenylist(a.protocols?.deny ?? [], b.protocols?.deny ?? []));
  add("contracts.allow", contractsVerdict(a.contracts, b.contracts, defaults));
  add("assets.allow", compareAllowlist(a.assets?.allow ?? null, b.assets?.allow ?? null));
  add("assets.categories", compareAllowlist(a.assets?.categories ?? null, b.assets?.categories ?? null));
  const unlistedRank = (value: "deny" | "allow" | undefined) => ((value ?? (agent ? "deny" : "allow")) === "deny" ? 1 : 0);
  add("assets.unlisted", compareRank(unlistedRank(a.assets?.unlisted), unlistedRank(b.assets?.unlisted)));
  add("accounts.allow", compareAllowlist(a.accounts?.allow ?? null, b.accounts?.allow ?? null));
  const recipientRank = (mode: RecipientMode | undefined) => 2 - RECIPIENT_MODES.indexOf(mode ?? (agent ? "own" : "any"));
  add("recipients.mode", compareRank(recipientRank(a.recipients?.mode), recipientRank(b.recipients?.mode)));
  add("recipients.allow", compareAllowlist(a.recipients?.allow ?? [], b.recipients?.allow ?? []));
  add("recipients.deny", compareDenylist(a.recipients?.deny ?? [], b.recipients?.deny ?? []));
  const namesRank = (rule: RecipientNamesRule | undefined) => 2 - RECIPIENT_NAME_RULES.indexOf(rule ?? "resolve");
  add("recipients.names", compareRank(namesRank(a.recipients?.names), namesRank(b.recipients?.names)));
  add("limits.maxSteps", compareLimit(intOrNull(a.limits?.maxSteps), intOrNull(b.limits?.maxSteps)));
  add("limits.maxSlippageBps", compareLimit(intOrNull(a.limits?.maxSlippageBps), intOrNull(b.limits?.maxSlippageBps)));
  add("limits.maxExtraCostUsd", compareLimit(usdOrNull(a.limits?.maxExtraCostUsd), usdOrNull(b.limits?.maxExtraCostUsd)));
  add("limits.maxFeeUsd", compareLimit(usdOrNull(a.limits?.maxFeeUsd), usdOrNull(b.limits?.maxFeeUsd)));
  add("limits.maxSeconds", compareLimit(intOrNull(a.limits?.maxSeconds), intOrNull(b.limits?.maxSeconds)));
  for (const cap of ["perStepUsd", "perIntentUsd", "dailyUsd", "weeklyUsd"] as const) {
    add(`caps.${cap}`, compareLimit(usdOrNull(a.caps?.[cap]), usdOrNull(b.caps?.[cap])));
  }
  add("schedule", compareSchedule(a.schedule, b.schedule));
  add("confirm.aboveUsd", compareLimit(usdOrNull(a.confirm?.aboveUsd), usdOrNull(b.confirm?.aboveUsd)));
  // Triggers: more triggers is tighter (a denylist-like set).
  add("confirm.when", compareDenylist(a.confirm?.when ?? [], b.confirm?.when ?? []));
  // Approver keys: a listed set lets only those project keys approve, while an empty or absent list lets
  // every project key outside the requester's subtree approve (§7.3), so it is the loosest value (null =
  // everyone): adding a key or dropping the list loosens, narrowing a list or setting one tightens.
  const approverKeys = (document: PolicyDocument): readonly string[] | null => {
    const keys = document.confirm?.approvers?.keys;
    return keys && keys.length > 0 ? keys : null;
  };
  add("confirm.approvers.keys", compareAllowlist(approverKeys(a), approverKeys(b)));
  // Approver wallets: only listed wallets approve, so an empty list is the tightest value.
  add("confirm.approvers.wallets", compareAllowlist(a.confirm?.approvers?.wallets ?? [], b.confirm?.approvers?.wallets ?? []));
  add("confirm.approvers.requireWallet", compareRank(a.confirm?.approvers?.requireWallet ? 1 : 0, b.confirm?.approvers?.requireWallet ? 1 : 0));
  add("confirm.ttlSeconds", compareLimit(BigInt(a.confirm?.ttlSeconds ?? POLICY_LIMITS.defaultConfirmTtlSeconds), BigInt(b.confirm?.ttlSeconds ?? POLICY_LIMITS.defaultConfirmTtlSeconds)));
  for (const permission of POLICY_PERMISSIONS) {
    const value = (document: PolicyDocument) => document.permissions?.[permission] ?? (agent ? AGENT_POLICY_DEFAULTS.permissions[permission] : true);
    add(`permissions.${permission}`, compareRank(value(a) ? 0 : 1, value(b) ? 0 : 1));
  }
  const pin = (document: PolicyDocument) => document.execution?.pinNonce ?? (agent ? AGENT_POLICY_DEFAULTS.pinNonce : false);
  add("execution.pinNonce", compareRank(pin(a) ? 1 : 0, pin(b) ? 1 : 0));
  add("amendments.delaySeconds", compareRank(a.amendments?.delaySeconds ?? 0, b.amendments?.delaySeconds ?? 0));
  if (next === null) {
    // Removing a rule book loosens every field it set (policy design §3.5).
    return { tightened: [], loosened: verdicts.filter(([, verdict]) => verdict !== "equal").map(([path]) => path) };
  }
  return {
    tightened: verdicts.filter(([, verdict]) => verdict === "tighter").map(([path]) => path),
    loosened: verdicts.filter(([, verdict]) => verdict === "looser").map(([path]) => path),
  };
}

/* =============================================================== templates */

export type PolicyTemplateId = "observer" | "payments-agent" | "treasury-rebalancer" | "contract-operator";

export interface PolicyTemplate {
  readonly id: PolicyTemplateId;
  readonly title: string;
  readonly summary: string;
  /** Starting document (`fill` paths must be filled before it validates, except where noted). */
  readonly document: PolicyDocument;
  /** Fields the portal or CLI asks for (`policyFromTemplate`). */
  readonly fill: readonly ("accounts.allow" | "recipients.allow" | "confirm.approvers.wallets" | "contracts.allow")[];
}

const STABLE_BRIDGES: readonly ProtocolId[] = ["relay", "lifi", "debridge-dln", "across", "cctp-v2"];

/** Rule book templates (policy design §3.6). */
export const POLICY_TEMPLATES: Readonly<Record<PolicyTemplateId, PolicyTemplate>> = Object.freeze({
  observer: {
    id: "observer",
    title: "Observer",
    summary: "Plans, quotes and dry runs only. Nothing is stored or prepared.",
    document: OBSERVER_POLICY,
    fill: [],
  },
  "payments-agent": {
    id: "payments-agent",
    title: "Payments agent",
    summary: "Transfers and bridges of stablecoins to listed recipients, $200 a step and $1,000 a day; above $500 a listed wallet approves.",
    document: {
      schema: POLICY_SCHEMA,
      label: "Payments agent",
      mode: "live",
      networks: { lanes: ["production"] },
      kinds: { allow: ["bridge", "transfer"] },
      assets: { categories: ["stablecoin"], unlisted: "deny" },
      recipients: { mode: "allowlist", names: "resolve" },
      caps: { perStepUsd: "200", perIntentUsd: "1000", dailyUsd: "1000", weeklyUsd: "5000" },
      confirm: { aboveUsd: "500", approvers: { requireWallet: true } },
      execution: { pinNonce: true },
      amendments: { delaySeconds: 3600 },
    },
    fill: ["accounts.allow", "recipients.allow", "confirm.approvers.wallets"],
  },
  "treasury-rebalancer": {
    id: "treasury-rebalancer",
    title: "Treasury rebalancer",
    summary: "Bridges, swaps, deposits and withdrawals between your own pinned accounts on weekdays, $25,000 a day; above $10,000 needs approval.",
    document: {
      schema: POLICY_SCHEMA,
      label: "Treasury rebalancer",
      mode: "live",
      networks: { lanes: ["production"] },
      kinds: { allow: ["bridge", "deposit", "swap", "withdraw"] },
      protocols: { allow: [...STABLE_BRIDGES, "aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino", "jupiter"] },
      assets: { unlisted: "deny" },
      recipients: { mode: "own" },
      caps: { dailyUsd: "25000", weeklyUsd: "100000" },
      confirm: { aboveUsd: "10000" },
      schedule: { timezone: "UTC", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00", to: "18:00" }] },
      execution: { pinNonce: true },
      amendments: { delaySeconds: 3600 },
    },
    fill: ["accounts.allow"],
  },
  "contract-operator": {
    id: "contract-operator",
    title: "Contract operator",
    summary: "Calls of listed custom contract entries only, $1,000 a step.",
    document: {
      schema: POLICY_SCHEMA,
      label: "Contract operator",
      mode: "live",
      kinds: { allow: ["action", "call"] },
      recipients: { mode: "own" },
      caps: { perStepUsd: "1000" },
      execution: { pinNonce: true },
    },
    fill: ["contracts.allow", "accounts.allow"],
  },
});

export interface PolicyTemplateFill {
  readonly accounts?: readonly string[];
  readonly recipients?: readonly string[];
  readonly approverWallets?: readonly string[];
  readonly contracts?: readonly { readonly id: string; readonly entries?: readonly string[] }[];
}

/** A template with its fill points applied, validated (agent defaults for warnings). */
export function policyFromTemplate(id: PolicyTemplateId, fill: PolicyTemplateFill = {}): PolicyValidationResult {
  const template = POLICY_TEMPLATES[id];
  if (!template) return { ok: false, value: null, issues: [{ path: "template", message: "Unknown template." }], warnings: [] };
  const base = template.document;
  const document: PolicyDocument = {
    ...base,
    ...(fill.accounts ? { accounts: { allow: fill.accounts } } : {}),
    ...(fill.recipients && base.recipients ? { recipients: { ...base.recipients, allow: fill.recipients } } : {}),
    ...(fill.approverWallets && base.confirm ? { confirm: { ...base.confirm, approvers: { ...base.confirm.approvers, wallets: fill.approverWallets } } } : {}),
    ...(fill.contracts ? { contracts: { allow: fill.contracts } } : {}),
  };
  return validatePolicy(document, { defaults: "agent" });
}
