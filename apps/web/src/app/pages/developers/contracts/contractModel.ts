/**
 * Register-wizard drafts and their translation into a `ContractDefinition`,
 * plus the status line of a registration. Pure; only `@kletia/core` imports.
 * The definition is always checked again by `validateContractDefinition`
 * (the same rules as the API) before anything is sent.
 */
import {
  abiItemSignature,
  CHAINS,
  isBeneficiaryArgName,
  KLETIA_WELL_KNOWN_PATH,
  type AbiEventItem,
  type AbiFunctionItem,
  type AbiParameter,
  type ActionParam,
  type ContractAbiItem,
  type ContractView,
  type EventBinding,
  type NetworkKey,
} from "@kletia/core";

import type { ArgDraft, ParamDraft } from "./abi";

export interface EventDraft {
  /** Canonical event signature. */
  readonly event: string;
  /** "$self" or an extra address label. */
  readonly emitter: string;
  /** Event input name → "" (not checked), a source (`$account`, …) or `literal:<value>`. */
  readonly where: Readonly<Record<string, string>>;
  /** Event input reporting the output amount, or "". */
  readonly output: string;
}

export interface EvmEntryDraft {
  readonly signature: string;
  readonly id: string;
  readonly label: string;
  readonly args: readonly ArgDraft[];
  /** "" (spends nothing), "native", or a registry symbol on the network. */
  readonly inputToken: string;
  /** "" (no approval), "$self" or an extra address label. */
  readonly approval: string;
  /** "" (no value), "$amount" (native input) or a wei literal. */
  readonly valueBind: string;
  readonly valueMax: string;
  /** "" (no declared output), "$self", an extra address label, or an ERC-20 address. */
  readonly outputToken: string;
  readonly toleranceBps: string;
  readonly events: readonly EventDraft[];
  readonly params: readonly ParamDraft[];
  readonly recipient: "account" | "any";
  /** Comma-separated. */
  readonly verbs: string;
  readonly aliases: string;
  readonly minAmount: string;
  readonly maxAmount: string;
}

export interface AddressDraft {
  readonly label: string;
  readonly address: string;
}

export interface EvmDraft {
  readonly network: NetworkKey;
  readonly address: string;
  readonly name: string;
  readonly website: string;
  readonly visibility: "private" | "project";
  readonly abi: readonly ContractAbiItem[];
  readonly addresses: readonly AddressDraft[];
  readonly entries: readonly EvmEntryDraft[];
}

export interface BuildIssue {
  readonly path: string;
  readonly message: string;
}

function words(text: string): string[] {
  return [...new Set(text.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

/** `depositFor` → `deposit-for`; ids must start with a letter. */
export function entryIdFrom(name: string): string {
  const id = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 40);
  return id || "action";
}

/** `depositFor` → `Deposit for`. */
export function labelFrom(name: string): string {
  const spaced = name.replace(/^_+/u, "").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/_/gu, " ").toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Action";
}

function guessWhere(input: AbiParameter): string {
  if (input.type === "address" && isBeneficiaryArgName(input.name)) return "$account";
  if (/^u?int/u.test(input.type) && /^_?(amount|assets|value|wad)$/iu.test(input.name ?? "")) return "$amount";
  return "";
}

/** A proof event for an entry: an ABI event named like the function (deposit → Deposit), if any. */
export function guessEvents(fn: AbiFunctionItem, abi: readonly ContractAbiItem[]): EventDraft[] {
  const event = abi.find(
    (item): item is AbiEventItem => item.type === "event" && item.anonymous !== true && item.name.toLowerCase() === fn.name.replace(/^_+/u, "").toLowerCase(),
  );
  if (!event) return [];
  const where: Record<string, string> = {};
  for (const input of event.inputs) if (input.name) where[input.name] = guessWhere(input);
  return [{ event: abiItemSignature(event), emitter: "$self", where, output: "" }];
}

export function newEntryDraft(fn: AbiFunctionItem, abi: readonly ContractAbiItem[], guessArg: (param: AbiParameter) => ArgDraft): EvmEntryDraft {
  const verb = fn.name.replace(/^_+/u, "").toLowerCase();
  return {
    signature: abiItemSignature(fn),
    id: entryIdFrom(fn.name),
    label: labelFrom(fn.name),
    args: fn.inputs.map(guessArg),
    inputToken: "",
    approval: "$self",
    valueBind: fn.stateMutability === "payable" ? "$amount" : "",
    valueMax: "",
    outputToken: "",
    toleranceBps: "10",
    events: guessEvents(fn, abi),
    params: [],
    recipient: "account",
    verbs: /^[a-z]{2,16}$/u.test(verb) ? verb : "",
    aliases: "",
    minAmount: "",
    maxAmount: "",
  };
}

function buildParams(params: readonly ParamDraft[], at: string, issues: BuildIssue[]): ActionParam[] | undefined {
  if (params.length === 0) return undefined;
  return params.map((param, index) => {
    const out: Record<string, unknown> = { name: param.name.trim(), type: param.type };
    if (!param.name.trim()) issues.push({ path: `${at}.params[${index}].name`, message: "Give the parameter a name." });
    if (param.type === "uint" || param.type === "int") {
      if (param.min.trim()) out.min = param.min.trim();
      if (param.max.trim()) out.max = param.max.trim();
    }
    if (param.type === "enum") out.enum = words(param.values).length > 0 ? param.values.split(",").map((value) => value.trim()).filter(Boolean) : [];
    if (param.defaultValue.trim()) out.default = param.type === "bool" ? param.defaultValue.trim() === "true" : param.defaultValue.trim();
    if (param.required) out.required = true;
    return out as unknown as ActionParam;
  });
}

function buildPhrases(verbs: string, aliases: string): { verbs: string[]; aliases: string[] } | undefined {
  const verbList = words(verbs);
  const aliasList = words(aliases);
  if (verbList.length === 0 && aliasList.length === 0) return undefined;
  return { verbs: verbList, aliases: aliasList };
}

function buildLimits(min: string, max: string): { minAmount?: string; maxAmount?: string } | undefined {
  const out: { minAmount?: string; maxAmount?: string } = {};
  if (min.trim()) out.minAmount = min.trim();
  if (max.trim()) out.maxAmount = max.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The EVM definition the draft describes. The ABI is reduced to the chosen
 * functions and the events they bind (the API treats the ABI as an
 * allowlist: every function in it must be used by an action).
 */
export function buildEvmDefinition(
  draft: EvmDraft,
  buildArg: (arg: ArgDraft, param: AbiParameter) => { readonly binding: unknown } | { readonly issue: string },
): { readonly definition: Record<string, unknown>; readonly issues: readonly BuildIssue[] } {
  const issues: BuildIssue[] = [];
  const functions = new Map<string, AbiFunctionItem>();
  const events = new Map<string, AbiEventItem>();
  for (const item of draft.abi) {
    if (item.type === "function") functions.set(abiItemSignature(item), item);
    if (item.type === "event") events.set(abiItemSignature(item), item);
  }
  const usedFunctions: AbiFunctionItem[] = [];
  const usedEvents: AbiEventItem[] = [];
  const actions = draft.entries.map((entry, index) => {
    const at = `actions[${index}]`;
    const fn = functions.get(entry.signature);
    if (!fn) issues.push({ path: `${at}.function`, message: `${entry.signature} is not in the ABI.` });
    else if (!usedFunctions.includes(fn)) usedFunctions.push(fn);
    const args = (fn?.inputs ?? []).map((param, argIndex) => {
      const draftArg = entry.args[argIndex] ?? { mode: "literal" as const, value: "" };
      const built = buildArg(draftArg, param);
      if ("issue" in built) {
        issues.push({ path: `${at}.args[${argIndex}]`, message: built.issue });
        return null;
      }
      return built.binding;
    });
    const action: Record<string, unknown> = { id: entry.id.trim(), label: entry.label.trim(), function: entry.signature, args };
    if (entry.inputToken) {
      action.input = {
        token: entry.inputToken,
        ...(entry.inputToken !== "native" && entry.approval ? { approval: { spender: entry.approval } } : {}),
      };
    }
    if (entry.valueBind) action.value = { bind: entry.valueBind, max: entry.valueMax.trim() };
    if (entry.outputToken) {
      const tolerance = Number.parseInt(entry.toleranceBps, 10);
      action.output = { token: entry.outputToken, ...(Number.isFinite(tolerance) ? { toleranceBps: tolerance } : {}) };
    }
    action.events = entry.events.map((event, eventIndex) => {
      const item = events.get(event.event) ?? [...events.values()].find((candidate) => candidate.name === event.event);
      if (!item) issues.push({ path: `${at}.events[${eventIndex}].event`, message: `${event.event || "The event"} is not in the ABI.` });
      else if (!usedEvents.includes(item)) usedEvents.push(item);
      const where: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(event.where)) {
        if (!value) continue;
        where[field] = value.startsWith("literal:") ? { literal: value.slice("literal:".length) } : value;
      }
      const binding: Record<string, unknown> = { event: event.event, emitter: event.emitter || "$self", where };
      if (event.output) binding.output = event.output;
      return binding as unknown as EventBinding;
    });
    const params = buildParams(entry.params, at, issues);
    if (params) action.params = params;
    if (entry.recipient === "any") action.recipient = "any";
    const phrases = buildPhrases(entry.verbs, entry.aliases);
    if (phrases) action.phrases = phrases;
    const limits = buildLimits(entry.minAmount, entry.maxAmount);
    if (limits) action.limits = limits;
    return action;
  });
  const integrator: Record<string, string> = { name: draft.name.trim() };
  if (draft.website.trim()) integrator.website = draft.website.trim();
  const definition: Record<string, unknown> = {
    vm: "evm",
    network: draft.network,
    address: draft.address.trim(),
    integrator,
    visibility: draft.visibility,
    abi: [...usedFunctions, ...usedEvents],
    actions,
  };
  const addresses = draft.addresses.filter((entry) => entry.label.trim() || entry.address.trim());
  if (addresses.length > 0) definition.addresses = addresses.map((entry) => ({ label: entry.label.trim(), address: entry.address.trim() }));
  if (draft.entries.length === 0) issues.push({ path: "actions", message: "Choose at least one function to register." });
  return { definition, issues };
}

/* ---------------------------------------------------------------- Solana */

export interface PayeeDraft {
  readonly label: string;
  readonly address: string;
  readonly maxLamports: string;
}

export interface SvmEntryDraft {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly primaryProgram: string;
  readonly inputToken: string;
  readonly outputMint: string;
  readonly toleranceBps: string;
  readonly params: readonly ParamDraft[];
  readonly verbs: string;
  readonly aliases: string;
  readonly minAmount: string;
  readonly maxAmount: string;
}

export interface SvmDraft {
  readonly network: NetworkKey;
  readonly name: string;
  readonly website: string;
  readonly visibility: "private" | "project";
  readonly origin: string;
  /** One program id per line. */
  readonly programs: string;
  readonly payees: readonly PayeeDraft[];
  readonly entries: readonly SvmEntryDraft[];
}

export function newSvmEntryDraft(origin: string, programs: readonly string[]): SvmEntryDraft {
  return {
    id: "stake",
    label: "",
    href: origin ? `${origin.replace(/\/+$/u, "")}/api/actions/` : "",
    primaryProgram: programs[0] ?? "",
    inputToken: "",
    outputMint: "",
    toleranceBps: "10",
    params: [],
    verbs: "",
    aliases: "",
    minAmount: "",
    maxAmount: "",
  };
}

export function programList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean))];
}

export function buildSvmDefinition(draft: SvmDraft): { readonly definition: Record<string, unknown>; readonly issues: readonly BuildIssue[] } {
  const issues: BuildIssue[] = [];
  const actions = draft.entries.map((entry, index) => {
    const at = `actions[${index}]`;
    const action: Record<string, unknown> = {
      id: entry.id.trim(),
      label: entry.label.trim(),
      href: entry.href.trim(),
      primaryProgram: entry.primaryProgram.trim(),
    };
    if (entry.inputToken) action.input = { token: entry.inputToken };
    if (entry.outputMint.trim()) {
      const tolerance = Number.parseInt(entry.toleranceBps, 10);
      action.output = { mint: entry.outputMint.trim(), ...(Number.isFinite(tolerance) ? { toleranceBps: tolerance } : {}) };
    }
    const params = buildParams(entry.params, at, issues);
    if (params) action.params = params;
    const phrases = buildPhrases(entry.verbs, entry.aliases);
    if (phrases) action.phrases = phrases;
    const limits = buildLimits(entry.minAmount, entry.maxAmount);
    if (limits) action.limits = limits;
    return action;
  });
  const integrator: Record<string, string> = { name: draft.name.trim() };
  if (draft.website.trim()) integrator.website = draft.website.trim();
  const definition: Record<string, unknown> = {
    vm: "svm",
    network: draft.network,
    integrator,
    visibility: draft.visibility,
    origin: draft.origin.trim(),
    programs: programList(draft.programs),
    actions,
  };
  const payees = draft.payees.filter((payee) => payee.label.trim() || payee.address.trim());
  if (payees.length > 0) definition.payees = payees.map((payee) => ({ label: payee.label.trim(), address: payee.address.trim(), maxLamports: payee.maxLamports.trim() }));
  if (draft.entries.length === 0) issues.push({ path: "actions", message: "Add at least one action." });
  return { definition, issues };
}

/* ------------------------------------------------------- wizard and status */

export type EvmStep = 1 | 2 | 3 | 4 | 5 | 6;

/** The wizard step where an issue (by its definition path) is fixed. */
export function evmStepOf(path: string): EvmStep {
  if (path === "network" || path === "address" || path === "vm" || path === "") return 1;
  if (path.startsWith("abi")) return 2;
  if (/^actions\[\d+\]\.events/u.test(path)) return 4;
  if (/^actions\[\d+\]\.(phrases|limits|label|id)/u.test(path) || path.startsWith("integrator") || path === "visibility") return 5;
  if (path === "actions") return 2;
  return 3;
}

export type SvmSection = "origin" | "programs" | "payees" | "actions" | "integrator";

export function svmSectionOf(path: string): SvmSection {
  if (path.startsWith("origin") || path === "network") return "origin";
  if (path.startsWith("programs")) return "programs";
  if (path.startsWith("payees")) return "payees";
  if (path.startsWith("integrator") || path === "visibility") return "integrator";
  return "actions";
}

export type StatusTone = "green" | "yellow" | "red";

const SUSPENSION_TEXT: Readonly<Record<string, string>> = {
  pins_changed: "The deployed code changed since it was pinned.",
  program_changed: "A pinned Solana program changed since it was pinned.",
  outcome_mismatch: "A landed call did not match its declared events and asset changes.",
  domain_unverified: "The integrator name needs a verified domain and the domain file is gone.",
};

/** Plain words for a suspension reason (`operator: …` keeps the operator's text). */
export function suspensionText(reason: string | null | undefined): string {
  if (!reason) return "Suspended.";
  if (reason.startsWith("operator:")) return `Suspended by the operator: ${reason.slice("operator:".length).trim() || "no reason given"}.`;
  return SUSPENSION_TEXT[reason] ?? `Suspended (${reason}).`;
}

export interface ContractStatusView {
  readonly label: string;
  readonly tone: StatusTone;
  /** "Activates in 12 min 4 s", the suspension reason, or a pending revision. */
  readonly detail: string | null;
}

function secondsLeft(at: string | null, now: number): number | null {
  if (!at) return null;
  const time = Date.parse(at);
  return Number.isFinite(time) ? Math.max(0, Math.ceil((time - now) / 1000)) : null;
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

export function contractStatus(view: Pick<ContractView, "status" | "activatesAt" | "pendingRevision" | "suspendedReason">, now: number): ContractStatusView {
  if (view.status === "suspended") return { label: "Suspended", tone: "red", detail: suspensionText(view.suspendedReason) };
  const left = secondsLeft(view.activatesAt, now);
  if (view.status === "pending") {
    return { label: "Pending", tone: "yellow", detail: left === null ? "Waiting for activation." : left > 0 ? `Activates in ${clock(left)}.` : "Activating now." };
  }
  if (view.pendingRevision !== null && view.pendingRevision !== undefined) {
    return {
      label: "Active",
      tone: "green",
      detail: left !== null && left > 0 ? `Revision ${view.pendingRevision} activates in ${clock(left)}.` : `Revision ${view.pendingRevision} is activating.`,
    };
  }
  return { label: "Active", tone: "green", detail: null };
}

/** Whether new registrations on this network wait for the activation delay (mainnet networks do). */
export function waitsForActivation(network: NetworkKey): boolean {
  return CHAINS[network]?.environment === "mainnet";
}

/** The domain verification file to publish at `<website>/.well-known/kletia.json`. */
export function wellKnownSnippet(contractIds: readonly string[], linkIds: readonly string[] = [], keyIds: readonly string[] = []): string {
  const body: Record<string, string[]> = {};
  if (contractIds.length > 0) body.contracts = [...contractIds];
  if (linkIds.length > 0) body.links = [...linkIds];
  if (keyIds.length > 0) body.keys = [...keyIds];
  return JSON.stringify(body, null, 2);
}

export const WELL_KNOWN_PATH = KLETIA_WELL_KNOWN_PATH;

