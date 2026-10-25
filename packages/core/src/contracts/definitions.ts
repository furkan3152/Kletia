/**
 * Public validation entry point, parameter resolution, hashing and
 * definition accessors.
 */
import { CHAINS, isNetworkKey, type NetworkKey } from "../chains.js";
import type { AssetId } from "../caip.js";
import type { AssetDescriptor } from "../assets.js";
import type { ProtocolId } from "../protocols.js";
import type { AssetRef } from "../intent.js";
import type { ValidationIssue } from "../validation.js";
import { CONTRACT_LIMITS } from "./patterns.js";
import type {
  AbiFunctionItem,
  ActionParam,
  ContractDefinition,
  ContractVm,
  EvmContractAction,
  EvmContractDefinition,
  SolanaActionEndpoint,
} from "./types.js";
import { utf8 } from "./forbidden.js";
import { hasOwn } from "./targets.js";
import { abiItemSignature } from "./abi.js";
import { isRecord, resolveContractAsset } from "./origins.js";
import {
  type ContractValidationOptions,
  type ContractValidationResult,
  IssueList,
  parseIntegerBound,
  primaryContractIssueCode,
} from "./issues.js";
import { parseEvmDefinition } from "./evmDefinition.js";
import { parseSolanaDefinition } from "./solanaDefinition.js";

/**
 * Static validation of a registration body (no network access). Returns the
 * normalised definition (checksummed addresses, normalised origins, defaults
 * filled in: `visibility`, `recipient`, `toleranceBps`; ABI items reduced to
 * their meaningful keys) or every issue with its error code.
 */
export function validateContractDefinition(input: unknown, options: ContractValidationOptions = {}): ContractValidationResult {
  const issues = new IssueList();
  if (!isRecord(input)) {
    issues.invalid("", "The definition must be an object.");
    return { ok: false, code: "CONTRACT_DEFINITION_INVALID", issues: issues.list };
  }
  const { vm, network } = input;
  if (vm !== "evm" && vm !== "svm") issues.invalid("vm", "Must be evm or svm.");
  const chain = isNetworkKey(network) ? CHAINS[network] : undefined;
  if (!chain) issues.invalid("network", "Unknown network.");
  else if ((vm === "evm" || vm === "svm") && chain.vm !== vm) {
    issues.invalid("network", vm === "evm" ? "Use an EVM network for vm evm." : "Use a Solana network for vm svm.");
  }
  if (issues.list.length > 0 || !chain) return { ok: false, code: primaryContractIssueCode(issues.list), issues: issues.list };
  const value =
    vm === "evm"
      ? parseEvmDefinition(input, chain.key, issues, options)
      : parseSolanaDefinition(input, chain.key, issues, options);
  if (value && issues.list.length === 0) {
    const size = utf8.encode(canonicalJson(value)).length;
    if (size > CONTRACT_LIMITS.definitionBytes) issues.invalid("", `The definition is ${size} bytes; the limit is ${CONTRACT_LIMITS.definitionBytes}.`);
  }
  if (!value || issues.list.length > 0) {
    if (issues.list.length === 0) issues.invalid("", "Invalid definition.");
    return { ok: false, code: primaryContractIssueCode(issues.list), issues: issues.list };
  }
  return { ok: true, value };
}

/* ====================================================== params at plan time */

export type ContractParamValues = Readonly<Record<string, string | boolean>>;

/**
 * Validates user parameter values against an entry's declared params and
 * fills defaults. `uint`/`int` values become decimal strings, `bool` stays a
 * boolean, `enum` a string. Keys that are not declared are refused, except the
 * planner's own `portionBps`.
 */
export function resolveContractParams(
  declared: readonly ActionParam[] | undefined,
  values: Readonly<Record<string, string | number | boolean>> | undefined,
): { readonly ok: true; readonly values: ContractParamValues } | { readonly ok: false; readonly issues: readonly ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const out: Record<string, string | boolean> = {};
  const byName = new Map((declared ?? []).map((param) => [param.name, param]));
  for (const key of Object.keys(values ?? {})) {
    if (!byName.has(key) && key !== "portionBps") issues.push({ path: `params.${key}`, message: "Not a parameter of this action." });
  }
  for (const param of declared ?? []) {
    const raw = values && hasOwn(values, param.name) ? values[param.name] : undefined;
    const path = `params.${param.name}`;
    if (raw === undefined) {
      if (param.default !== undefined) out[param.name] = param.default;
      else if (param.required) issues.push({ path, message: "Required." });
      continue;
    }
    if (param.type === "bool") {
      if (typeof raw === "boolean") out[param.name] = raw;
      else if (raw === "true" || raw === "false") out[param.name] = raw === "true";
      else issues.push({ path, message: "Must be true or false." });
      continue;
    }
    if (param.type === "enum") {
      if (typeof raw === "string" && (param.enum ?? []).includes(raw)) out[param.name] = raw;
      else issues.push({ path, message: `Must be one of ${(param.enum ?? []).join(", ")}.` });
      continue;
    }
    const parsed = parseIntegerBound(raw, param.type === "int");
    if (parsed === null) {
      issues.push({ path, message: `Must be an ${param.type === "int" ? "" : "unsigned "}integer.` });
      continue;
    }
    if ((param.min !== undefined && BigInt(parsed) < BigInt(param.min)) || (param.max !== undefined && BigInt(parsed) > BigInt(param.max))) {
      issues.push({ path, message: `Must be between ${param.min ?? "-∞"} and ${param.max ?? "∞"}.` });
      continue;
    }
    out[param.name] = parsed;
  }
  return issues.length ? { ok: false, issues } : { ok: true, values: out };
}

/* ========================================================= canonical hashing */

/** Deterministic JSON: object keys sorted, no whitespace, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite numbers have no canonical JSON form.");
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * The security-relevant part of a definition: everything except each
 * action's `label` and `phrases` (editable without a new revision delay).
 */
export function contractSecurityFields(definition: ContractDefinition): unknown {
  return {
    ...definition,
    actions: definition.actions.map((action) => {
      const { label: _label, phrases: _phrases, ...rest } = action;
      return rest;
    }),
  };
}

/** True when the change between two definitions touches a security-relevant field. */
export function isSecurityRelevantChange(before: ContractDefinition, after: ContractDefinition): boolean {
  return canonicalJson(contractSecurityFields(before)) !== canonicalJson(contractSecurityFields(after));
}

/**
 * `definitionHash`: sha256 hex of `canonicalJson(contractSecurityFields(d))`
 * (Web Crypto; Node can equally hash the same string with createHash).
 */
export async function contractDefinitionHash(definition: ContractDefinition): Promise<string> {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto is not available in this runtime.");
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(canonicalJson(contractSecurityFields(definition))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The store's `target`: lower-case contract address (EVM) or the origin (Solana Actions). */
export function contractTarget(definition: ContractDefinition): string {
  return definition.vm === "evm" ? definition.address.toLowerCase() : definition.origin;
}

/** The function item an EVM action calls (definitions from `validateContractDefinition` always resolve). */
export function contractActionFunction(definition: EvmContractDefinition, action: EvmContractAction): AbiFunctionItem | null {
  return (
    definition.abi.find((item): item is AbiFunctionItem => item.type === "function" && abiItemSignature(item) === action.function) ?? null
  );
}

/** The input asset an action spends, or null for non-spending actions. */
export function contractActionInput(network: NetworkKey, action: EvmContractAction | SolanaActionEndpoint): AssetDescriptor | null {
  return action.input ? resolveContractAsset(network, action.input.token) : null;
}

/** A reference to a registry asset as carried by intents. */
export function contractAssetRef(asset: AssetDescriptor): AssetRef {
  return { asset: asset.id as AssetId, symbol: asset.symbol, decimals: asset.decimals };
}

/** Protocol id executing a step of this VM. */
export function contractProtocol(vm: ContractVm): ProtocolId {
  return vm === "evm" ? "custom-call" : "solana-actions";
}
