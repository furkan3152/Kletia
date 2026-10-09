/**
 * Argument bindings of registered EVM functions.
 *
 * Kletia never accepts calldata from anyone: every argument of a registered
 * function is bound (at registration) to a declared source or a literal, and
 * the engine encodes the call itself from the snapshot ABI fragment. The
 * payload guard decodes prepared calldata with the same fragment and requires
 * that it re-encodes to the very same bytes (no trailing data, canonical
 * encoding).
 */
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from "viem";
import {
  abiItemSignature,
  bindingReviewSource,
  canonicalAbiType,
  formatAmount,
  fromBaseUnits,
  functionSelector,
  type AbiEventItem,
  type AbiFunctionItem,
  type AbiParameter,
  type ActionParam,
  type ArgBinding,
  type ContractReviewArg,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";

/** Values the declared sources take for one plan / prepare. */
export interface BindingValues {
  /** `$amount`: base units of the step input (null for non-spending entries). */
  readonly amount: bigint | null;
  readonly account: string;
  readonly recipient: string;
  /** `$token`: the ERC-20 input token (null for native or no input). */
  readonly token: string | null;
  readonly self: string;
  /** `$minimumOutput` (null: not known yet; encoded as 0 for the measuring simulation). */
  readonly minimumOutput: bigint | null;
  /** `$deadline` (unix seconds). */
  readonly deadline: bigint;
  /** `$previous.output.amount` / `.asset` (null without a previous step on the same network). */
  readonly previousAmount: bigint | null;
  readonly previousAsset: string | null;
  /** Resolved user parameters (resolveContractParams) and their declarations. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly declarations: readonly ActionParam[];
}

/** Display context for review arguments. */
export interface BindingDisplay {
  readonly input?: { readonly symbol: string; readonly decimals: number };
  readonly output?: { readonly symbol: string; readonly decimals: number };
  readonly previous?: { readonly symbol: string; readonly decimals: number };
}

const INT_TYPE = /^(u?)int(\d+)$/u;

function bindingError(message: string): PlatformError {
  return new PlatformError("CONTRACT_BINDING_INVALID", message, 422);
}

function asFunction(fragment: AbiFunctionItem): AbiFunction {
  return fragment as unknown as AbiFunction;
}

function elementType(type: string): string {
  return type.slice(0, type.lastIndexOf("["));
}

function literalValue(type: string, literal: string | boolean): unknown {
  if (INT_TYPE.test(type)) return BigInt(literal as string);
  if (type === "bool") return literal === true;
  if (type === "address") return getAddress(literal as string);
  if (type === "bytes") {
    if (literal !== "0x") throw bindingError("bytes arguments only accept the empty literal 0x.");
    return "0x";
  }
  return literal;
}

function paramValue(param: AbiParameter, name: string, values: BindingValues): unknown {
  const declaration = values.declarations.find((entry) => entry.name === name);
  const value = values.params[name];
  if (!declaration || value === undefined) throw bindingError(`Parameter ${name} has no value.`);
  const int = INT_TYPE.exec(param.type);
  if (declaration.type === "enum") {
    if (param.type === "string") return String(value);
    const index = (declaration.enum ?? []).indexOf(String(value));
    if (index < 0 || !int) throw bindingError(`Parameter ${name} is not one of its values.`);
    return BigInt(index);
  }
  if (declaration.type === "bool") {
    if (typeof value !== "boolean") throw bindingError(`Parameter ${name} must be a boolean.`);
    return value;
  }
  if (!int || !/^-?\d+$/u.test(String(value))) throw bindingError(`Parameter ${name} must be an integer.`);
  return BigInt(String(value));
}

function sourceValue(binding: string, param: AbiParameter, values: BindingValues): unknown {
  if (binding.startsWith("$param.")) return paramValue(param, binding.slice("$param.".length), values);
  switch (binding) {
    case "$amount":
      if (values.amount === null) throw bindingError("$amount needs an input amount.");
      return values.amount;
    case "$account":
      return getAddress(values.account);
    case "$recipient":
      return getAddress(values.recipient);
    case "$token":
      if (!values.token) throw bindingError("$token needs an ERC-20 input token.");
      return getAddress(values.token);
    case "$self":
      return getAddress(values.self);
    case "$minimumOutput":
      return values.minimumOutput ?? 0n;
    case "$deadline":
      return values.deadline;
    case "$previous.output.amount":
      if (values.previousAmount === null) throw bindingError("$previous.output.amount needs a previous step on the same network that produces an output.");
      return values.previousAmount;
    case "$previous.output.asset":
      if (!values.previousAsset) throw bindingError("$previous.output.asset needs a previous step on the same network with an ERC-20 output.");
      return getAddress(values.previousAsset);
    default:
      throw bindingError(`Unknown binding ${binding.slice(0, 40)}.`);
  }
}

function resolveOne(binding: ArgBinding, param: AbiParameter, values: BindingValues): unknown {
  if (param.type.endsWith("]")) {
    if (typeof binding !== "object" || !("array" in binding)) throw bindingError(`${param.type} arguments bind to an array of literals.`);
    const element: AbiParameter = { ...param, type: elementType(param.type) };
    return binding.array.map((entry) => resolveOne(entry, element, values));
  }
  if (param.type === "tuple") {
    if (typeof binding !== "object" || !("tuple" in binding)) throw bindingError("Tuple arguments bind to { tuple: [...] }.");
    const components = param.components ?? [];
    if (binding.tuple.length !== components.length) throw bindingError("The tuple binding does not match its components.");
    return binding.tuple.map((member, index) => resolveOne(member, components[index] as AbiParameter, values));
  }
  if (typeof binding === "string") return sourceValue(binding, param, values);
  if (typeof binding === "object" && "literal" in binding) return literalValue(param.type, binding.literal);
  throw bindingError(`Cannot bind ${param.type}.`);
}

/** The argument values of `fragment` under `bindings` (viem encoding order). */
export function resolveArgs(fragment: AbiFunctionItem, bindings: readonly ArgBinding[], values: BindingValues): unknown[] {
  if (bindings.length !== fragment.inputs.length) throw bindingError(`${fragment.name} takes ${fragment.inputs.length} arguments.`);
  return fragment.inputs.map((param, index) => resolveOne(bindings[index] as ArgBinding, param, values));
}

/** Calldata of the registered function with resolved arguments. */
export function encodeContractCall(fragment: AbiFunctionItem, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: [asFunction(fragment)], functionName: fragment.name, args } as never);
}

/** Decoded arguments of calldata for the registered function; null when it is not that function's calldata. */
export function decodeContractCall(fragment: AbiFunctionItem, data: string): readonly unknown[] | null {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(data)) return null;
  if (data.slice(0, 10).toLowerCase() !== functionSelector(abiItemSignature(fragment))) return null;
  try {
    const decoded = decodeFunctionData({ abi: [asFunction(fragment)], data: data as Hex });
    return (decoded.args ?? []) as readonly unknown[];
  } catch {
    return null;
  }
}

/** True when `data` is exactly the canonical encoding of a call to `fragment` (decode, re-encode, same bytes). */
export function isCanonicalCall(fragment: AbiFunctionItem, data: string): boolean {
  const args = decodeContractCall(fragment, data);
  if (!args) return false;
  try {
    return encodeContractCall(fragment, args).toLowerCase() === data.toLowerCase();
  } catch {
    return false;
  }
}

/** Values bound to `source` (e.g. `$amount`) in decoded arguments, wherever it sits (tuples included). */
export function boundValues(fragment: AbiFunctionItem, bindings: readonly ArgBinding[], args: readonly unknown[], source: string): unknown[] {
  const found: unknown[] = [];
  const walk = (binding: ArgBinding, param: AbiParameter, value: unknown) => {
    if (typeof binding === "string") {
      if (binding === source) found.push(value);
      return;
    }
    if ("tuple" in binding && Array.isArray(value)) {
      binding.tuple.forEach((member, index) => walk(member, (param.components ?? [])[index] as AbiParameter, value[index]));
    } else if ("tuple" in binding && value && typeof value === "object") {
      binding.tuple.forEach((member, index) => {
        const component = (param.components ?? [])[index] as AbiParameter;
        walk(member, component, (value as Record<string, unknown>)[component.name ?? String(index)]);
      });
    }
  };
  fragment.inputs.forEach((param, index) => walk(bindings[index] as ArgBinding, param, args[index]));
  return found;
}

function display(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(display).join(", ")}]`;
  if (value && typeof value === "object") return `(${Object.values(value).map(display).join(", ")})`;
  return String(value);
}

function units(value: unknown, asset: { readonly symbol: string; readonly decimals: number } | undefined): string {
  if (typeof value !== "bigint" || !asset) return display(value);
  return `${formatAmount(fromBaseUnits(value, asset.decimals), asset.decimals)} ${asset.symbol}`;
}

/** Review rows: one per top-level argument, with its value and where it comes from. */
export function reviewArgs(fragment: AbiFunctionItem, bindings: readonly ArgBinding[], args: readonly unknown[], context: BindingDisplay = {}): ContractReviewArg[] {
  return fragment.inputs.map((param, index) => {
    const binding = bindings[index] as ArgBinding;
    const value = args[index];
    let shown: string;
    switch (binding) {
      case "$amount":
        shown = units(value, context.input);
        break;
      case "$minimumOutput":
        shown = units(value, context.output);
        break;
      case "$previous.output.amount":
        shown = units(value, context.previous);
        break;
      case "$deadline":
        shown = typeof value === "bigint" && value < 10_000_000_000n ? new Date(Number(value) * 1000).toISOString() : display(value);
        break;
      default:
        shown = display(value);
    }
    return {
      name: param.name || `arg${index}`,
      type: canonicalAbiType(param),
      display: shown.slice(0, 300),
      source: bindingReviewSource(binding),
    };
  });
}

/** The `msg.value` of the call: `$amount` (native input) or the literal, never above `max`. */
export function callValue(value: { readonly bind: string; readonly max: string } | undefined, amount: bigint | null): bigint {
  if (!value) return 0n;
  const wei = value.bind === "$amount" ? amount : /^\d+$/u.test(value.bind) ? BigInt(value.bind) : null;
  if (wei === null) throw bindingError("The value binding has no amount.");
  if (wei > BigInt(value.max)) {
    throw new PlatformError("CONTRACT_AMOUNT_LIMIT", `The call would send ${wei} wei, above the registered cap of ${value.max} wei.`, 422);
  }
  return wei;
}

/** Event values `where` may compare against at verification. */
export interface WhereValues {
  readonly account: string;
  readonly recipient: string;
  /** The amount decoded from the landed call (not the planned one). */
  readonly amount: bigint | null;
  readonly token: string | null;
  readonly self: string;
}

function equalValue(type: string, actual: unknown, expected: unknown): boolean {
  if (type === "address") return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase() === expected.toLowerCase();
  if (INT_TYPE.test(type)) {
    try {
      return typeof actual === "bigint" && expected !== null && expected !== undefined && actual === BigInt(expected as string | bigint);
    } catch {
      return false;
    }
  }
  if (type === "bool") return actual === expected;
  return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase() === expected.toLowerCase();
}

export interface DecodedEvent {
  readonly args: Readonly<Record<string, unknown>>;
}

/** Decodes a log with the event fragment (strict); null when it is not that event. */
export function decodeEvent(fragment: AbiEventItem, log: { readonly topics: readonly string[]; readonly data: string }): DecodedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: [fragment as unknown as AbiEvent],
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return { args: (decoded.args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** True when every `where` field of a decoded event equals its bound value. */
export function whereMatches(fragment: AbiEventItem, event: DecodedEvent, where: Readonly<Record<string, ArgBinding>>, values: WhereValues): boolean {
  for (const [field, binding] of Object.entries(where)) {
    const input = fragment.inputs.find((entry) => entry.name === field);
    if (!input) return false;
    let expected: unknown;
    if (typeof binding === "string") {
      switch (binding) {
        case "$account":
          expected = values.account;
          break;
        case "$recipient":
          expected = values.recipient;
          break;
        case "$amount":
          expected = values.amount;
          break;
        case "$token":
          expected = values.token;
          break;
        case "$self":
          expected = values.self;
          break;
        default:
          return false;
      }
    } else if ("literal" in binding) {
      expected = binding.literal;
    } else {
      return false;
    }
    if (expected === null || expected === undefined) return false;
    if (!equalValue(input.type, event.args[field], expected)) return false;
  }
  return true;
}
