/**
 * ABI helpers for the register wizard: parse a pasted ABI (JSON or
 * human-readable signatures), list which value sources an argument may bind
 * to (the same rules `validateContractDefinition` enforces), and guess
 * obvious bindings. Pure; only `@kletia/core` imports, so node tests load it.
 */
import {
  abiItemSignature,
  classifyAbiFunction,
  isBeneficiaryArgName,
  type AbiEventItem,
  type AbiFunctionClassification,
  type AbiFunctionItem,
  type AbiParameter,
  type ArgBinding,
  type ContractAbiItem,
  type EventWhereBinding,
} from "@kletia/core";

export interface ParsedAbi {
  readonly items: readonly ContractAbiItem[];
  /** Problems with the text itself (not the rules: those come from core validation). */
  readonly errors: readonly string[];
  /** Items that were skipped on purpose (constructor, fallback, receive). */
  readonly skipped: number;
}

const ITEM_TYPES = new Set(["function", "event", "error"]);
const MUTABILITY = new Set(["nonpayable", "payable", "view", "pure"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonParameter(value: unknown): AbiParameter | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const components = Array.isArray(value.components) ? value.components.map(jsonParameter) : undefined;
  if (components && components.some((component) => component === null)) return null;
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    type: value.type,
    ...(typeof value.indexed === "boolean" ? { indexed: value.indexed } : {}),
    ...(components ? { components: components as AbiParameter[] } : {}),
  };
}

function jsonItem(value: unknown, index: number, errors: string[]): ContractAbiItem | "skip" | null {
  if (!isRecord(value)) {
    errors.push(`Item ${index + 1} is not an object.`);
    return null;
  }
  const type = value.type ?? "function";
  if (type === "constructor" || type === "fallback" || type === "receive") return "skip";
  if (typeof type !== "string" || !ITEM_TYPES.has(type)) {
    errors.push(`Item ${index + 1} has an unknown type.`);
    return null;
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    errors.push(`Item ${index + 1} has no name.`);
    return null;
  }
  const inputs = Array.isArray(value.inputs) ? value.inputs.map(jsonParameter) : [];
  if (inputs.some((input) => input === null)) {
    errors.push(`${value.name}: an input has no type.`);
    return null;
  }
  if (type === "function") {
    const legacyMutability = value.constant === true ? "view" : value.payable === true ? "payable" : "nonpayable";
    const stateMutability = typeof value.stateMutability === "string" && MUTABILITY.has(value.stateMutability) ? value.stateMutability : legacyMutability;
    const outputs = Array.isArray(value.outputs) ? value.outputs.map(jsonParameter).filter((output): output is AbiParameter => output !== null) : [];
    return { type: "function", name: value.name, stateMutability: stateMutability as AbiFunctionItem["stateMutability"], inputs: inputs as AbiParameter[], outputs };
  }
  if (type === "event") {
    return { type: "event", name: value.name, anonymous: value.anonymous === true, inputs: inputs as AbiParameter[] };
  }
  return { type: "error", name: value.name, inputs: inputs as AbiParameter[] };
}

const HUMAN_LINE = /^(function|event|error)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*?)\)\s*(.*)$/u;
const PARAM_MODIFIERS = new Set(["memory", "calldata", "storage"]);

function humanParameters(list: string, event: boolean, where: string, errors: string[]): AbiParameter[] | null {
  const text = list.trim();
  if (!text) return [];
  if (text.includes("(")) {
    errors.push(`${where}: tuple arguments need the JSON ABI.`);
    return null;
  }
  const params: AbiParameter[] = [];
  for (const raw of text.split(",")) {
    const words = raw.trim().split(/\s+/u).filter((word) => !PARAM_MODIFIERS.has(word));
    const [type, ...rest] = words;
    if (!type) {
      errors.push(`${where}: an argument is empty.`);
      return null;
    }
    const indexed = event && rest[0] === "indexed";
    const nameWords = indexed ? rest.slice(1) : rest;
    if (nameWords.length > 1) {
      errors.push(`${where}: could not read "${raw.trim()}".`);
      return null;
    }
    const normalized = type === "uint" ? "uint256" : type === "int" ? "int256" : type;
    params.push({ ...(nameWords[0] ? { name: nameWords[0] } : {}), type: normalized, ...(event ? { indexed } : {}) });
  }
  return params;
}

function humanItem(line: string, errors: string[]): ContractAbiItem | null {
  const match = HUMAN_LINE.exec(line);
  if (!match) {
    errors.push(`Could not read "${line.length > 60 ? `${line.slice(0, 60)}…` : line}". Use function, event or error signatures, one per line.`);
    return null;
  }
  const [, kind, name, list, tail] = match as unknown as [string, "function" | "event" | "error", string, string, string];
  const inputs = humanParameters(list, kind === "event", name, errors);
  if (!inputs) return null;
  if (kind === "event") return { type: "event", name, anonymous: /\banonymous\b/u.test(tail), inputs };
  if (kind === "error") return { type: "error", name, inputs };
  const mutability = /\bpayable\b/u.test(tail) ? "payable" : /\bview\b/u.test(tail) ? "view" : /\bpure\b/u.test(tail) ? "pure" : "nonpayable";
  const returns = /\breturns\s*\((.*)\)/u.exec(tail);
  const outputs = returns ? humanParameters(returns[1] ?? "", false, `${name} returns`, errors) ?? [] : [];
  return { type: "function", name, stateMutability: mutability, inputs, outputs };
}

/**
 * Reads a pasted ABI: a JSON array (or an object with an `abi` array, as
 * Foundry and Hardhat artifacts have), or human-readable lines such as
 * `function deposit(uint256 assets, address receiver)`.
 */
export function parseAbiText(text: string): ParsedAbi {
  const trimmed = text.trim();
  const errors: string[] = [];
  if (!trimmed) return { items: [], errors: ["Paste an ABI first."], skipped: 0 };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { items: [], errors: ["That is not valid JSON."], skipped: 0 };
    }
    const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.abi) ? value.abi : null;
    if (!list) return { items: [], errors: ["Expected a JSON array of ABI items (or an object with an abi array)."], skipped: 0 };
    let skipped = 0;
    const items: ContractAbiItem[] = [];
    list.forEach((entry, index) => {
      const item = jsonItem(entry, index, errors);
      if (item === "skip") skipped += 1;
      else if (item) items.push(item);
    });
    return { items, errors, skipped };
  }
  const items: ContractAbiItem[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/u, "").trim().replace(/;$/u, "").trim();
    if (!line) continue;
    if (/^(constructor|fallback|receive)\b/u.test(line)) continue;
    const item = humanItem(line, errors);
    if (item) items.push(item);
  }
  return { items, errors, skipped: 0 };
}

export function functionItems(items: readonly ContractAbiItem[]): AbiFunctionItem[] {
  return items.filter((item): item is AbiFunctionItem => item.type === "function");
}

export function eventItems(items: readonly ContractAbiItem[]): AbiEventItem[] {
  return items.filter((item): item is AbiEventItem => item.type === "event" && item.anonymous !== true);
}

/** Every function of the ABI with its allow/deny mark, allowed first, then by name. */
export function classifyFunctions(items: readonly ContractAbiItem[]): AbiFunctionClassification[] {
  const seen = new Set<string>();
  const list: AbiFunctionClassification[] = [];
  for (const item of functionItems(items)) {
    const signature = abiItemSignature(item);
    if (seen.has(signature)) continue;
    seen.add(signature);
    list.push(classifyAbiFunction(item));
  }
  return list.sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.signature.localeCompare(b.signature));
}

export function findFunction(items: readonly ContractAbiItem[], signature: string): AbiFunctionItem | null {
  return functionItems(items).find((item) => abiItemSignature(item) === signature) ?? null;
}

export function findEvent(items: readonly ContractAbiItem[], signature: string): AbiEventItem | null {
  return eventItems(items).find((item) => abiItemSignature(item) === signature || item.name === signature) ?? null;
}

/* ----------------------------------------------------------------- bindings */

export type TypeFamily = "uint" | "int" | "address" | "bool" | "bytesN" | "bytes" | "string" | "complex";

export function typeFamily(type: string): TypeFamily {
  if (type.includes("[") || type.startsWith("tuple")) return "complex";
  if (/^uint\d*$/u.test(type)) return "uint";
  if (/^int\d*$/u.test(type)) return "int";
  if (type === "address") return "address";
  if (type === "bool") return "bool";
  if (type === "bytes") return "bytes";
  if (/^bytes\d+$/u.test(type)) return "bytesN";
  if (type === "string") return "string";
  return "complex";
}

/** A user parameter declared on an entry (`$param.<name>`). */
export interface ParamDraft {
  readonly name: string;
  readonly type: "uint" | "int" | "bool" | "enum";
  readonly min: string;
  readonly max: string;
  /** Comma-separated values (enum). */
  readonly values: string;
  readonly defaultValue: string;
  readonly required: boolean;
}

export interface SourceOption {
  readonly value: string;
  readonly label: string;
}

const UINT_SOURCES: readonly SourceOption[] = [
  { value: "$amount", label: "Step amount (input token, base units)" },
  { value: "$minimumOutput", label: "Guaranteed minimum output" },
  { value: "$deadline", label: "Deadline (payload expiry + 15 min)" },
  { value: "$previous.output.amount", label: "Output of the previous step" },
];
const USER_SOURCES: readonly SourceOption[] = [
  { value: "$account", label: "The user's account (signer)" },
  { value: "$recipient", label: "The step recipient" },
];
const ADDRESS_SOURCES: readonly SourceOption[] = [
  ...USER_SOURCES,
  { value: "$token", label: "The input token" },
  { value: "$self", label: "This contract" },
  { value: "$previous.output.asset", label: "Output token of the previous step" },
];

/**
 * The value sources an argument may bind to. A beneficiary-named address
 * (`receiver`, `to`, `owner`, …) may only be the user or the step recipient,
 * so a deposit can never be credited to anyone else.
 */
export function sourceOptions(param: AbiParameter, params: readonly ParamDraft[] = []): SourceOption[] {
  const family = typeFamily(param.type);
  const fromParams = (types: readonly ParamDraft["type"][]) =>
    params.filter((entry) => entry.name && types.includes(entry.type)).map((entry) => ({ value: `$param.${entry.name}`, label: `Parameter "${entry.name}"` }));
  switch (family) {
    case "uint":
      return [...UINT_SOURCES, ...fromParams(["uint", "enum"])];
    case "int":
      return fromParams(["int"]);
    case "address":
      return isBeneficiaryArgName(param.name) ? [...USER_SOURCES] : [...ADDRESS_SOURCES];
    case "bool":
      return fromParams(["bool"]);
    case "string":
      return fromParams(["enum"]);
    default:
      return [];
  }
}

/** Whether a fixed literal is allowed for this argument (never for a beneficiary address). */
export function literalAllowed(param: AbiParameter): boolean {
  const family = typeFamily(param.type);
  if (family === "address") return !isBeneficiaryArgName(param.name);
  return family !== "complex";
}

export type ArgDraft =
  | { readonly mode: "source"; readonly value: string }
  | { readonly mode: "literal"; readonly value: string }
  /** Tuples and arrays: the binding as JSON (`{ "tuple": [...] }`, `{ "array": [...] }`). */
  | { readonly mode: "json"; readonly value: string };

/** A first guess like `kletia contracts init`: only unambiguous names; everything else is left for a decision. */
export function guessArg(param: AbiParameter): ArgDraft {
  const family = typeFamily(param.type);
  const name = (param.name ?? "").replace(/^_+/u, "").toLowerCase();
  if (family === "complex") return { mode: "json", value: "" };
  if (family === "address") {
    if (isBeneficiaryArgName(param.name)) return { mode: "source", value: "$account" };
    if (/^(token|asset|underlying)$/u.test(name)) return { mode: "source", value: "$token" };
    return { mode: "literal", value: "" };
  }
  if (family === "uint") {
    if (/^(amount|assets|value|wad|amt|qty|quantity)$/u.test(name)) return { mode: "source", value: "$amount" };
    if (/deadline|expiry|expires/u.test(name)) return { mode: "source", value: "$deadline" };
    if (/^min/u.test(name)) return { mode: "source", value: "$minimumOutput" };
    return { mode: "literal", value: "" };
  }
  if (family === "bytes") return { mode: "literal", value: "0x" };
  return { mode: "literal", value: "" };
}

/** The definition binding of an argument, or the reason it cannot be built yet. */
export function buildArg(arg: ArgDraft, param: AbiParameter): { readonly binding: ArgBinding } | { readonly issue: string } {
  const label = param.name || param.type;
  if (arg.mode === "source") {
    if (!arg.value) return { issue: `${label}: choose where its value comes from.` };
    return { binding: arg.value as ArgBinding };
  }
  if (arg.mode === "json") {
    if (!arg.value.trim()) return { issue: `${label}: write its binding as JSON.` };
    try {
      return { binding: JSON.parse(arg.value) as ArgBinding };
    } catch {
      return { issue: `${label}: the JSON binding does not parse.` };
    }
  }
  const value = arg.value.trim();
  if (!value) return { issue: `${label}: enter a fixed value or choose a source.` };
  if (typeFamily(param.type) === "bool") {
    if (value !== "true" && value !== "false") return { issue: `${label}: a bool is true or false.` };
    return { binding: { literal: value === "true" } };
  }
  return { binding: { literal: value } };
}

/** Bindings an event's `where` may use. */
export const WHERE_SOURCES: readonly SourceOption[] = [
  { value: "$account", label: "The user's account" },
  { value: "$recipient", label: "The step recipient" },
  { value: "$amount", label: "The amount of the landed call" },
  { value: "$token", label: "The input token" },
  { value: "$self", label: "This contract" },
];

/** `where` value as stored in the draft: a source, `literal:<value>`, or "" (not checked). */
export function buildWhere(value: string): EventWhereBinding | null {
  if (!value) return null;
  if (value.startsWith("literal:")) return { literal: value.slice("literal:".length) };
  return value as EventWhereBinding;
}
