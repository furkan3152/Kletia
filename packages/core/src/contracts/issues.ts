/**
 * Validation issues and the shared parsers for ABI items, bindings,
 * integrators, params, phrases and limits.
 */
import { isChecksumAddressValid, isEvmAddress } from "../caip.js";
import { isDecimalAmount, toBaseUnits } from "../amounts.js";
import type { AssetDescriptor } from "../assets.js";
import type { ValidationIssue } from "../validation.js";
import {
  CONTRACT_ALIAS_PATTERN,
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_PARAM_NAME_PATTERN,
  CONTRACT_VERB_PATTERN,
} from "./patterns.js";
import type {
  AbiParameter,
  ActionParam,
  ContractAbiItem,
  ContractActionLimits,
  ContractActionPhrases,
  ContractDefinition,
  ContractIntegrator,
  ContractVisibility,
  LiteralBinding,
} from "./types.js";
import { isBeneficiaryArgName } from "./forbidden.js";
import {
  CONNECTOR_WORDS,
  hostMatches,
  KEYWORD_PHRASES,
  reservedContractPhrase,
  reservedIntegratorName,
} from "./reserved.js";
import { hasOwn } from "./targets.js";
import { ABI_NAME, isElementaryBase, SOURCE_TYPES, typeShape } from "./abi.js";
import {
  CONTROL_CHARS,
  isPlainText,
  isRecord,
  normalizeWebOrigin,
} from "./origins.js";

/* ======================================================== definition schema */

export type ContractIssueCode =
  | "CONTRACT_DEFINITION_INVALID"
  | "CONTRACT_FUNCTION_FORBIDDEN"
  | "CONTRACT_ARGUMENT_FORBIDDEN"
  | "CONTRACT_BINDING_INVALID"
  | "CONTRACT_DENIED"
  | "ACTION_URL_FORBIDDEN"
  | "PROGRAM_NOT_ALLOWED";

export interface ContractValidationIssue extends ValidationIssue {
  readonly code: ContractIssueCode;
}

export type ContractValidationResult =
  | { readonly ok: true; readonly value: ContractDefinition }
  | {
      readonly ok: false;
      /** The error code to return: the most specific issue code by `CONTRACT_ISSUE_PRECEDENCE`. */
      readonly code: ContractIssueCode;
      readonly issues: readonly ContractValidationIssue[];
    };

/** Most specific first: the API returns the first code present among the issues. */
export const CONTRACT_ISSUE_PRECEDENCE: readonly ContractIssueCode[] = Object.freeze([
  "CONTRACT_DENIED",
  "CONTRACT_FUNCTION_FORBIDDEN",
  "CONTRACT_ARGUMENT_FORBIDDEN",
  "PROGRAM_NOT_ALLOWED",
  "ACTION_URL_FORBIDDEN",
  "CONTRACT_BINDING_INVALID",
  "CONTRACT_DEFINITION_INVALID",
]);

export function primaryContractIssueCode(issues: readonly { readonly code: ContractIssueCode }[]): ContractIssueCode {
  for (const code of CONTRACT_ISSUE_PRECEDENCE) if (issues.some((issue) => issue.code === code)) return code;
  return "CONTRACT_DEFINITION_INVALID";
}

export interface ContractValidationOptions {
  /** Configured deny entries (`network:address`), e.g. KLETIA_CONTRACT_DENYLIST. */
  readonly denylist?: Iterable<string>;
}

export class IssueList {
  readonly list: ContractValidationIssue[] = [];
  add(code: ContractIssueCode, path: string, message: string): void {
    if (this.list.length < 100) this.list.push({ code, path, message });
  }
  invalid(path: string, message: string): void {
    this.add("CONTRACT_DEFINITION_INVALID", path, message);
  }
}

export function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: IssueList): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.invalid(path ? `${path}.${key}` : key, `Unknown field. Allowed: ${allowed.join(", ")}.`);
  }
}

/* --------------------------------------------------------------- ABI parsing */

function parseAbiParameter(value: unknown, path: string, depth: number, issues: IssueList, event: boolean): AbiParameter | null {
  if (!isRecord(value)) {
    issues.invalid(path, "ABI parameter must be an object.");
    return null;
  }
  const { name, type, internalType, indexed, components } = value;
  if (name !== undefined && name !== "" && (typeof name !== "string" || !ABI_NAME.test(name))) {
    issues.invalid(`${path}.name`, "Must be a Solidity identifier up to 64 characters.");
    return null;
  }
  if (typeof type !== "string") {
    issues.invalid(`${path}.type`, "Must be a canonical ABI type.");
    return null;
  }
  const shape = typeShape(type);
  if (!shape || (shape.base !== "tuple" && !isElementaryBase(shape.base))) {
    issues.invalid(`${path}.type`, `Unsupported or non-canonical ABI type "${type}" (use uint256, not uint; fixed-point types are not supported).`);
    return null;
  }
  if (internalType !== undefined && (typeof internalType !== "string" || internalType.length > 128)) {
    issues.invalid(`${path}.internalType`, "Must be a string up to 128 characters.");
    return null;
  }
  if (indexed !== undefined && (typeof indexed !== "boolean" || !event)) {
    issues.invalid(`${path}.indexed`, "Only event inputs carry a boolean indexed flag.");
    return null;
  }
  let parsedComponents: AbiParameter[] | undefined;
  if (shape.base === "tuple") {
    if (depth >= CONTRACT_LIMITS.abiNesting) {
      issues.invalid(path, `Tuples nest at most ${CONTRACT_LIMITS.abiNesting} levels.`);
      return null;
    }
    if (!Array.isArray(components) || components.length === 0 || components.length > CONTRACT_LIMITS.abiParameters) {
      issues.invalid(`${path}.components`, `A tuple needs 1-${CONTRACT_LIMITS.abiParameters} components.`);
      return null;
    }
    parsedComponents = [];
    for (const [index, component] of components.entries()) {
      const parsed = parseAbiParameter(component, `${path}.components[${index}]`, depth + 1, issues, false);
      if (!parsed) return null;
      parsedComponents.push(parsed);
    }
  } else if (components !== undefined) {
    issues.invalid(`${path}.components`, "Only tuple types have components.");
    return null;
  }
  return {
    ...(typeof name === "string" && name ? { name } : {}),
    type,
    ...(typeof internalType === "string" ? { internalType } : {}),
    ...(event ? { indexed: indexed === true } : {}),
    ...(parsedComponents ? { components: parsedComponents } : {}),
  };
}

export function parseAbiItem(value: unknown, path: string, issues: IssueList): ContractAbiItem | null {
  if (!isRecord(value)) {
    issues.invalid(path, "ABI item must be an object.");
    return null;
  }
  const { type, name } = value;
  if (type !== "function" && type !== "event" && type !== "error") {
    issues.invalid(`${path}.type`, "Only function, event and error items are accepted (no constructor, fallback or receive).");
    return null;
  }
  if (typeof name !== "string" || !ABI_NAME.test(name)) {
    issues.invalid(`${path}.name`, "Must be a Solidity identifier up to 64 characters.");
    return null;
  }
  const rawInputs = value.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > CONTRACT_LIMITS.abiParameters) {
    issues.invalid(`${path}.inputs`, `Must be a list of at most ${CONTRACT_LIMITS.abiParameters} parameters.`);
    return null;
  }
  const inputs: AbiParameter[] = [];
  for (const [index, input] of rawInputs.entries()) {
    const parsed = parseAbiParameter(input, `${path}.inputs[${index}]`, 0, issues, type === "event");
    if (!parsed) return null;
    inputs.push(parsed);
  }
  if (type === "event") {
    if (value.anonymous !== undefined && typeof value.anonymous !== "boolean") {
      issues.invalid(`${path}.anonymous`, "Must be a boolean.");
      return null;
    }
    const anonymous = value.anonymous === true;
    if (inputs.filter((input) => input.indexed).length > (anonymous ? 4 : 3)) {
      issues.invalid(`${path}.inputs`, "Too many indexed inputs.");
      return null;
    }
    return { type, name, anonymous, inputs };
  }
  if (type === "error") return { type, name, inputs };
  const mutability = value.stateMutability;
  if (mutability !== "nonpayable" && mutability !== "payable" && mutability !== "view" && mutability !== "pure") {
    issues.invalid(`${path}.stateMutability`, "Must be nonpayable, payable, view or pure.");
    return null;
  }
  const rawOutputs = value.outputs ?? [];
  if (!Array.isArray(rawOutputs) || rawOutputs.length > CONTRACT_LIMITS.abiParameters) {
    issues.invalid(`${path}.outputs`, `Must be a list of at most ${CONTRACT_LIMITS.abiParameters} parameters.`);
    return null;
  }
  const outputs: AbiParameter[] = [];
  for (const [index, output] of rawOutputs.entries()) {
    const parsed = parseAbiParameter(output, `${path}.outputs[${index}]`, 0, issues, false);
    if (!parsed) return null;
    outputs.push(parsed);
  }
  return { type, name, stateMutability: mutability, inputs, outputs };
}

/* ------------------------------------------------------------ literal values */

export function intRange(base: string): { readonly signed: boolean; readonly bits: number } | null {
  const match = /^(u?)int([0-9]+)$/u.exec(base);
  return match ? { signed: match[1] === "", bits: Number(match[2]) } : null;
}

/** Problem with a literal for an elementary type, or null when it is valid. */
export function literalProblem(base: string, literal: unknown): string | null {
  const range = intRange(base);
  if (range) {
    if (typeof literal !== "string" || !(range.signed ? /^-?(?:0|[1-9]\d{0,77})$/u : /^(?:0|[1-9]\d{0,77})$/u).test(literal) || literal === "-0") {
      return `${base} literals are decimal integer strings.`;
    }
    const value = BigInt(literal);
    const limit = 1n << BigInt(range.signed ? range.bits - 1 : range.bits);
    if (range.signed ? value < -limit || value >= limit : value >= limit) return `Out of range for ${base}.`;
    return null;
  }
  if (base === "bool") return typeof literal === "boolean" ? null : "bool literals are true or false.";
  if (base === "address") {
    if (typeof literal !== "string" || !isEvmAddress(literal)) return "address literals are 0x addresses.";
    return isChecksumAddressValid(literal) ? null : "The address checksum is wrong (mixed case must be EIP-55).";
  }
  if (base === "string") {
    return typeof literal === "string" && literal.length <= CONTRACT_LIMITS.stringLiteralLength && !CONTROL_CHARS.test(literal)
      ? null
      : `string literals are up to ${CONTRACT_LIMITS.stringLiteralLength} printable characters.`;
  }
  const fixedBytes = /^bytes([0-9]+)$/u.exec(base);
  if (fixedBytes) {
    const size = Number(fixedBytes[1]);
    return typeof literal === "string" && new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`, "u").test(literal) ? null : `${base} literals are 0x hex of exactly ${size} bytes.`;
  }
  return `No literal is accepted for ${base}.`;
}

/* ---------------------------------------------------------- binding checking */

export interface ActionContext {
  readonly issues: IssueList;
  readonly inputKind: "erc20" | "native" | null;
  readonly hasOutput: boolean;
  readonly params: ReadonlyMap<string, ActionParam>;
  readonly usedParams: Set<string>;
  usesAmount: boolean;
}

function paramCompatible(param: ActionParam, base: string): boolean {
  const range = intRange(base);
  switch (param.type) {
    case "uint":
      return range !== null && !range.signed;
    case "int":
      return range !== null && range.signed;
    case "bool":
      return base === "bool";
    case "enum":
      return base === "string" || (range !== null && !range.signed);
    default:
      return false;
  }
}

export function isLiteralBinding(value: unknown): value is LiteralBinding {
  return isRecord(value) && Object.keys(value).length === 1 && "literal" in value;
}

function checkSourceBinding(binding: string, base: string, name: string | undefined, path: string, ctx: ActionContext): void {
  const { issues } = ctx;
  if (base === "bytes") {
    issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes arguments only accept the empty literal { \"literal\": \"0x\" }.");
    return;
  }
  if (binding.startsWith("$param.")) {
    const paramName = binding.slice("$param.".length);
    const param = ctx.params.get(paramName);
    if (!param) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Unknown parameter "${paramName}": declare it in params.`);
      return;
    }
    ctx.usedParams.add(paramName);
    if (!paramCompatible(param, base)) issues.add("CONTRACT_BINDING_INVALID", path, `A ${param.type} parameter cannot bind to ${base}.`);
    return;
  }
  const kind = hasOwn(SOURCE_TYPES, binding) ? SOURCE_TYPES[binding] : undefined;
  if (!kind) {
    issues.add("CONTRACT_BINDING_INVALID", path, `Unknown binding "${binding}". Use ${Object.keys(SOURCE_TYPES).join(", ")}, $param.<name> or { "literal": ... }.`);
    return;
  }
  const range = intRange(base);
  const compatible = kind === "uint" ? range !== null && !range.signed : base === "address";
  if (!compatible) {
    issues.add("CONTRACT_BINDING_INVALID", path, `${binding} binds to ${kind === "uint" ? "uint" : "address"} arguments, not ${base}.`);
    return;
  }
  if (base === "address" && isBeneficiaryArgName(name) && binding !== "$account" && binding !== "$recipient") {
    issues.add("CONTRACT_BINDING_INVALID", path, `${name} receives the result: it must bind to $account or $recipient.`);
  }
  if (binding === "$amount") {
    ctx.usesAmount = true;
    if (!ctx.inputKind) issues.add("CONTRACT_BINDING_INVALID", path, "$amount needs an input token.");
  }
  if (binding === "$token" && ctx.inputKind !== "erc20") issues.add("CONTRACT_BINDING_INVALID", path, "$token needs an ERC-20 input token.");
  if (binding === "$minimumOutput" && !ctx.hasOutput) issues.add("CONTRACT_BINDING_INVALID", path, "$minimumOutput needs a declared output.");
}

export function checkBinding(binding: unknown, param: AbiParameter, path: string, ctx: ActionContext, insideArray: boolean): void {
  const { issues } = ctx;
  const shape = typeShape(param.type);
  if (!shape) {
    issues.invalid(path, "Unsupported ABI type.");
    return;
  }
  if (shape.base === "function") {
    issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "function-typed arguments are not allowed.");
    return;
  }
  if (shape.dims.length > 0) {
    if (shape.base === "bytes") {
      issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes[] arguments are not allowed (arbitrary calldata).");
      return;
    }
    const length = shape.dims[shape.dims.length - 1];
    const elementType = param.type.slice(0, param.type.lastIndexOf("["));
    if (!isRecord(binding) || Object.keys(binding).length !== 1 || !Array.isArray(binding.array)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `${param.type} arguments bind to { "array": [literals] }.`);
      return;
    }
    const elements = binding.array as unknown[];
    if (elements.length > CONTRACT_LIMITS.arrayElements || (length !== null && length !== undefined && elements.length !== length)) {
      issues.add(
        "CONTRACT_BINDING_INVALID",
        path,
        length ? `${param.type} needs exactly ${length} elements (at most ${CONTRACT_LIMITS.arrayElements}).` : `At most ${CONTRACT_LIMITS.arrayElements} elements.`,
      );
      return;
    }
    const element: AbiParameter = { ...param, type: elementType };
    elements.forEach((entry, index) => checkBinding(entry, element, `${path}.array[${index}]`, ctx, true));
    return;
  }
  if (shape.base === "tuple") {
    const components = param.components ?? [];
    if (!isRecord(binding) || Object.keys(binding).length !== 1 || !Array.isArray(binding.tuple)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Tuple arguments bind to { "tuple": [one binding per member] }.`);
      return;
    }
    const members = binding.tuple as unknown[];
    if (members.length !== components.length) {
      issues.add("CONTRACT_BINDING_INVALID", path, `The tuple has ${components.length} members; got ${members.length} bindings.`);
      return;
    }
    members.forEach((member, index) => checkBinding(member, components[index] as AbiParameter, `${path}.tuple[${index}]`, ctx, insideArray));
    return;
  }
  if (typeof binding === "string") {
    if (!binding.startsWith("$")) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Bind to a $source or { "literal": ... } (got a bare string).`);
      return;
    }
    if (insideArray) {
      issues.add("CONTRACT_BINDING_INVALID", path, "Array elements must be literals.");
      return;
    }
    checkSourceBinding(binding, shape.base, param.name, path, ctx);
    return;
  }
  if (isLiteralBinding(binding)) {
    if (shape.base === "bytes") {
      if (binding.literal !== "0x") issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes arguments only accept the empty literal 0x.");
      return;
    }
    if (shape.base === "address" && isBeneficiaryArgName(param.name)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `${param.name} receives the result: it must bind to $account or $recipient, never a fixed address.`);
      return;
    }
    const problem = literalProblem(shape.base, binding.literal);
    if (problem) issues.add("CONTRACT_BINDING_INVALID", path, problem);
    return;
  }
  issues.add("CONTRACT_BINDING_INVALID", path, `Bind ${param.type} to a $source or { "literal": ... }.`);
}

/* ------------------------------------------------------------ shared pieces */

export function parseIntegrator(value: unknown, mainnet: boolean, issues: IssueList): ContractIntegrator | null {
  if (!isRecord(value)) {
    issues.invalid("integrator", "Must be { name, website }.");
    return null;
  }
  checkKeys(value, ["name", "website"], "integrator", issues);
  const { name, website } = value;
  let ok = true;
  if (typeof name !== "string" || name.length < 2 || name.length > 40 || !/^[A-Za-z0-9 .,&'()-]+$/u.test(name) || name !== name.trim() || /\s{2}/u.test(name) || !/[A-Za-z]/u.test(name)) {
    issues.invalid("integrator.name", "Must be 2-40 characters of A-Z a-z 0-9 space . , & ' ( ) -, with a letter and single spaces.");
    ok = false;
  }
  let normalizedWebsite: string | undefined;
  if (website !== undefined) {
    const origin = normalizeWebOrigin(website);
    if (!origin) {
      issues.invalid("integrator.website", "Must be an https origin with a public host name and no path (e.g. https://acme.example).");
      ok = false;
    } else normalizedWebsite = origin;
  } else if (mainnet) {
    issues.invalid("integrator.website", "Required on mainnet networks (domain verification uses it).");
    ok = false;
  }
  if (typeof name === "string") {
    const reserved = reservedIntegratorName(name);
    if (reserved) {
      const host = normalizedWebsite ? new URL(normalizedWebsite).hostname : "";
      if (!host || !hostMatches(host, reserved.hosts)) {
        issues.invalid("integrator.name", `"${reserved.word}" is a reserved name; only ${reserved.hosts.join(", ")} (with a verified domain) may use it.`);
        ok = false;
      }
    }
  }
  if (!ok || typeof name !== "string") return null;
  return { name, ...(normalizedWebsite ? { website: normalizedWebsite } : {}) };
}

export function parseVisibility(value: unknown, issues: IssueList): ContractVisibility {
  if (value === undefined || value === "private") return "private";
  if (value === "project") return "project";
  issues.invalid("visibility", value === "public" ? "public visibility is reserved." : "Must be private or project.");
  return "private";
}

export function parseIntegerBound(value: unknown, signed: boolean): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || (!signed && value < 0)) return null;
    return String(value);
  }
  if (typeof value === "string" && (signed ? /^-?(?:0|[1-9]\d{0,76})$/u : /^(?:0|[1-9]\d{0,76})$/u).test(value) && value !== "-0") return value;
  return null;
}

const RESERVED_PARAM_NAMES = new Set(["amount", "amountBaseUnits", "account", "recipient", "venue", "portionBps", "provider"]);

export function parseParams(value: unknown, path: string, issues: IssueList): ActionParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTRACT_LIMITS.paramsPerAction) {
    issues.invalid(path, `Must be a list of at most ${CONTRACT_LIMITS.paramsPerAction} parameters.`);
    return [];
  }
  const out: ActionParam[] = [];
  const names = new Set<string>();
  value.forEach((raw, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.invalid(at, "Must be an object.");
      return;
    }
    checkKeys(raw, ["name", "type", "min", "max", "enum", "default", "required"], at, issues);
    const { name, type } = raw;
    if (typeof name !== "string" || !CONTRACT_PARAM_NAME_PATTERN.test(name) || RESERVED_PARAM_NAMES.has(name)) {
      issues.invalid(`${at}.name`, `Must match ${CONTRACT_PARAM_NAME_PATTERN.source} and not be one of ${[...RESERVED_PARAM_NAMES].join(", ")}.`);
      return;
    }
    if (names.has(name)) {
      issues.invalid(`${at}.name`, "Duplicate parameter name.");
      return;
    }
    names.add(name);
    if (type !== "uint" && type !== "int" && type !== "bool" && type !== "enum") {
      issues.invalid(`${at}.type`, "Must be uint, int, bool or enum (never addresses or bytes).");
      return;
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") issues.invalid(`${at}.required`, "Must be a boolean.");
    const required = raw.required === true;
    if (type === "uint" || type === "int") {
      const signed = type === "int";
      const min = raw.min === undefined ? undefined : parseIntegerBound(raw.min, signed);
      const max = raw.max === undefined ? undefined : parseIntegerBound(raw.max, signed);
      if (min === null) issues.invalid(`${at}.min`, `Must be an ${signed ? "" : "unsigned "}integer (number or decimal string).`);
      if (max === null) issues.invalid(`${at}.max`, `Must be an ${signed ? "" : "unsigned "}integer (number or decimal string).`);
      if (min && max && BigInt(min) > BigInt(max)) issues.invalid(`${at}.max`, "Must be at least min.");
      if (raw.enum !== undefined) issues.invalid(`${at}.enum`, "Only enum parameters list values.");
      let defaultValue: string | undefined;
      if (raw.default !== undefined) {
        const parsed = parseIntegerBound(raw.default, signed);
        if (parsed === null || (min && BigInt(parsed) < BigInt(min)) || (max && BigInt(parsed) > BigInt(max))) {
          issues.invalid(`${at}.default`, "Must be an integer within min and max.");
        } else defaultValue = parsed;
      }
      out.push({ name, type, ...(min ? { min } : {}), ...(max ? { max } : {}), ...(defaultValue !== undefined ? { default: defaultValue } : {}), ...(required ? { required } : {}) });
      return;
    }
    if (raw.min !== undefined || raw.max !== undefined) issues.invalid(at, "Only uint and int parameters take min and max.");
    if (type === "bool") {
      if (raw.enum !== undefined) issues.invalid(`${at}.enum`, "Only enum parameters list values.");
      if (raw.default !== undefined && typeof raw.default !== "boolean") issues.invalid(`${at}.default`, "Must be a boolean.");
      out.push({ name, type, ...(typeof raw.default === "boolean" ? { default: raw.default } : {}), ...(required ? { required } : {}) });
      return;
    }
    const values = raw.enum;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 16 ||
      values.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/u.test(entry) || !/[A-Za-z0-9]/u.test(entry)) ||
      new Set(values).size !== values.length
    ) {
      issues.invalid(`${at}.enum`, "Must list 1-16 unique values of [A-Za-z0-9_.-]{1,32} (with a letter or digit).");
      return;
    }
    if (raw.default !== undefined && (typeof raw.default !== "string" || !values.includes(raw.default))) {
      issues.invalid(`${at}.default`, "Must be one of the enum values.");
    }
    out.push({ name, type, enum: values as string[], ...(typeof raw.default === "string" && values.includes(raw.default) ? { default: raw.default } : {}), ...(required ? { required } : {}) });
  });
  return out;
}

const VERB_KEYWORDS = new Set([...CONNECTOR_WORDS, ...KEYWORD_PHRASES]);

export function parsePhrases(value: unknown, path: string, issues: IssueList): ContractActionPhrases | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.invalid(path, "Must be { verbs, aliases }.");
    return undefined;
  }
  checkKeys(value, ["verbs", "aliases"], path, issues);
  const { verbs, aliases } = value;
  let ok = true;
  if (!Array.isArray(verbs) || verbs.length === 0 || verbs.length > CONTRACT_LIMITS.verbsPerAction) {
    issues.invalid(`${path}.verbs`, `List 1-${CONTRACT_LIMITS.verbsPerAction} verbs (with aliases).`);
    ok = false;
  } else {
    verbs.forEach((verb, index) => {
      if (typeof verb !== "string" || !CONTRACT_VERB_PATTERN.test(verb) || VERB_KEYWORDS.has(verb)) {
        issues.invalid(`${path}.verbs[${index}]`, `Must match ${CONTRACT_VERB_PATTERN.source} and not be a grammar keyword.`);
        ok = false;
      }
    });
    if (new Set(verbs).size !== verbs.length) {
      issues.invalid(`${path}.verbs`, "Duplicate verb.");
      ok = false;
    }
  }
  if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > CONTRACT_LIMITS.aliasesPerAction) {
    issues.invalid(`${path}.aliases`, `List 1-${CONTRACT_LIMITS.aliasesPerAction} aliases (with verbs).`);
    ok = false;
  } else {
    aliases.forEach((alias, index) => {
      if (typeof alias !== "string" || !CONTRACT_ALIAS_PATTERN.test(alias) || /\s{2}|\s$/u.test(alias)) {
        issues.invalid(`${path}.aliases[${index}]`, `Must match ${CONTRACT_ALIAS_PATTERN.source} with single spaces.`);
        ok = false;
        return;
      }
      const reserved = reservedContractPhrase(alias);
      if (reserved) {
        issues.invalid(`${path}.aliases[${index}]`, `"${alias}" uses the reserved word "${reserved}" (networks, assets, built-in venues, kletia and grammar keywords are reserved).`);
        ok = false;
      }
    });
    if (new Set(aliases).size !== aliases.length) {
      issues.invalid(`${path}.aliases`, "Duplicate alias.");
      ok = false;
    }
  }
  return ok ? { verbs: verbs as string[], aliases: aliases as string[] } : undefined;
}

export function parseLimits(
  value: unknown,
  path: string,
  input: AssetDescriptor | null,
  mainnet: boolean,
  issues: IssueList,
): ContractActionLimits | undefined {
  if (value === undefined) {
    if (mainnet && input) issues.invalid(`${path}.maxAmount`, "limits.maxAmount is required for spending actions on mainnet.");
    return undefined;
  }
  if (!isRecord(value)) {
    issues.invalid(path, "Must be { minAmount, maxAmount }.");
    return undefined;
  }
  checkKeys(value, ["minAmount", "maxAmount"], path, issues);
  if (!input) {
    issues.invalid(path, "Limits apply to the input token: declare input first.");
    return undefined;
  }
  const out: { minAmount?: string; maxAmount?: string } = {};
  for (const key of ["minAmount", "maxAmount"] as const) {
    const amount = value[key];
    if (amount === undefined) continue;
    if (!isDecimalAmount(amount) || /^0(?:\.0*)?$/u.test(amount)) {
      issues.invalid(`${path}.${key}`, "Must be a positive decimal string in input-token units.");
      continue;
    }
    try {
      toBaseUnits(amount, input.decimals);
      out[key] = amount;
    } catch {
      issues.invalid(`${path}.${key}`, `At most ${input.decimals} decimals for ${input.symbol}.`);
    }
  }
  if (mainnet && !out.maxAmount) issues.invalid(`${path}.maxAmount`, "Required for spending actions on mainnet.");
  if (out.minAmount && out.maxAmount && BigInt(toBaseUnits(out.minAmount, input.decimals)) > BigInt(toBaseUnits(out.maxAmount, input.decimals))) {
    issues.invalid(`${path}.minAmount`, "Must not exceed maxAmount.");
  }
  return out;
}

export function parseTolerance(value: unknown, path: string, issues: IssueList): number {
  if (value === undefined) return CONTRACT_LIMITS.defaultToleranceBps;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > CONTRACT_LIMITS.maxToleranceBps) {
    issues.invalid(path, `Must be an integer between 0 and ${CONTRACT_LIMITS.maxToleranceBps}.`);
    return CONTRACT_LIMITS.defaultToleranceBps;
  }
  return value;
}

export function parseCommonAction(raw: Record<string, unknown>, at: string, ids: Set<string>, issues: IssueList): { id: string; label: string } | null {
  const { id, label } = raw;
  let ok = true;
  if (typeof id !== "string" || !CONTRACT_ENTRY_ID_PATTERN.test(id)) {
    issues.invalid(`${at}.id`, `Must match ${CONTRACT_ENTRY_ID_PATTERN.source}.`);
    ok = false;
  } else if (ids.has(id)) {
    issues.invalid(`${at}.id`, "Duplicate action id.");
    ok = false;
  } else ids.add(id);
  if (!isPlainText(label, CONTRACT_LIMITS.labelLength)) {
    issues.invalid(`${at}.label`, `Must be 1-${CONTRACT_LIMITS.labelLength} printable characters.`);
    ok = false;
  }
  return ok ? { id: id as string, label: label as string } : null;
}

export function checkPhraseCollisions(actions: readonly { readonly phrases?: ContractActionPhrases }[], issues: IssueList): void {
  const seen = new Map<string, number>();
  actions.forEach((action, index) => {
    for (const alias of action.phrases?.aliases ?? []) {
      for (const verb of action.phrases?.verbs ?? []) {
        const key = `${verb} ${alias}`;
        const other = seen.get(key);
        if (other !== undefined && other !== index) {
          issues.invalid(`actions[${index}].phrases`, `"${verb} … ${alias}" already selects actions[${other}]; each (verb, alias) pair must select one action.`);
        } else seen.set(key, index);
      }
    }
  });
}
