/**
 * ABI type shapes, canonical signatures and function classification.
 */
import type {
  AbiFunctionItem,
  AbiParameter,
  ArgBinding,
  ContractReviewArgSource,
} from "./types.js";
import type { AbiFunctionClassification } from "./reviewTypes.js";
import { forbiddenFunctionReason, functionSelector } from "./forbidden.js";

/* ================================================================ ABI helpers */

const INT_WIDTHS = new Set(Array.from({ length: 32 }, (_, index) => String((index + 1) * 8)));
const TYPE_SHAPE = /^(tuple|[a-z]+[0-9]*)((?:\[[0-9]*\])*)$/u;
export const ABI_NAME = /^(?!__proto__$)[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

interface TypeShape {
  readonly base: string;
  /** Array dimensions in declaration order; null for dynamic. */
  readonly dims: readonly (number | null)[];
}

export function typeShape(type: string): TypeShape | null {
  const match = TYPE_SHAPE.exec(type);
  if (!match) return null;
  const dims: (number | null)[] = [];
  for (const dim of (match[2] ?? "").match(/\[[0-9]*\]/gu) ?? []) {
    const inner = dim.slice(1, -1);
    if (inner === "") dims.push(null);
    else {
      if (!/^[1-9][0-9]{0,3}$/u.test(inner)) return null;
      dims.push(Number(inner));
    }
  }
  return { base: match[1] as string, dims };
}

export function isElementaryBase(base: string): boolean {
  if (base === "address" || base === "bool" || base === "string" || base === "bytes" || base === "function") return true;
  const bytes = /^bytes([0-9]+)$/u.exec(base);
  if (bytes) return Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32 && String(Number(bytes[1])) === bytes[1];
  const int = /^u?int([0-9]+)$/u.exec(base);
  return int !== null && INT_WIDTHS.has(int[1] as string);
}

/** Canonical ABI type of a parameter (tuples expanded): `(uint256,address)[]`. */
export function canonicalAbiType(param: AbiParameter): string {
  const shape = typeShape(param.type);
  if (shape?.base === "tuple") {
    const suffix = param.type.slice("tuple".length);
    return `(${(param.components ?? []).map(canonicalAbiType).join(",")})${suffix}`;
  }
  return param.type;
}

/** Canonical signature of an ABI function, event or error: `deposit(uint256,address)`. */
export function abiItemSignature(item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): string {
  return `${item.name}(${item.inputs.map(canonicalAbiType).join(",")})`;
}

/** Signature with argument names, for reviews: `deposit(uint256 assets, address receiver)`. */
export function abiItemDisplaySignature(item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): string {
  return `${item.name}(${item.inputs.map((input) => (input.name ? `${canonicalAbiType(input)} ${input.name}` : canonicalAbiType(input))).join(", ")})`;
}

function containsType(param: AbiParameter, predicate: (base: string, dims: readonly (number | null)[]) => boolean): boolean {
  const shape = typeShape(param.type);
  if (!shape) return false;
  if (predicate(shape.base, shape.dims)) return true;
  return (param.components ?? []).some((component) => containsType(component, predicate));
}

/** A reason the argument types make the function unregistrable, or null. */
function forbiddenArgumentReason(inputs: readonly AbiParameter[]): string | null {
  for (const input of inputs) {
    if (containsType(input, (base) => base === "function")) return `${input.name || "an argument"} has a function type`;
    if (containsType(input, (base, dims) => base === "bytes" && dims.length > 0)) return `${input.name || "an argument"} is a bytes array (arbitrary calldata)`;
  }
  return null;
}

/** Whether (and why not) a function item can be registered; used by inspect and the portal. */
export function classifyAbiFunction(item: AbiFunctionItem): AbiFunctionClassification {
  const signature = abiItemSignature(item);
  const selector = functionSelector(signature);
  const base = { name: item.name, signature, selector, stateMutability: item.stateMutability };
  const forbidden = forbiddenFunctionReason(item.name, signature);
  if (forbidden) return { ...base, allowed: false, code: "CONTRACT_FUNCTION_FORBIDDEN", reason: forbidden, notes: [] };
  if (item.stateMutability === "view" || item.stateMutability === "pure") {
    return { ...base, allowed: false, code: "CONTRACT_FUNCTION_FORBIDDEN", reason: `${item.name} is read-only (${item.stateMutability}); only state-changing functions can be registered.`, notes: [] };
  }
  const argument = forbiddenArgumentReason(item.inputs);
  if (argument) return { ...base, allowed: false, code: "CONTRACT_ARGUMENT_FORBIDDEN", reason: `${signature}: ${argument}.`, notes: [] };
  const notes: string[] = [];
  if (item.inputs.some((input) => containsType(input, (b, dims) => b === "bytes" && dims.length === 0))) {
    notes.push("bytes arguments only accept the empty literal 0x.");
  }
  if (item.stateMutability === "payable") notes.push("payable: needs a value binding with a cap.");
  return { ...base, allowed: true, code: null, reason: null, notes };
}

/* ============================================================ binding sources */

export const SOURCE_TYPES: Readonly<Record<string, "uint" | "address">> = Object.freeze({
  $amount: "uint",
  $minimumOutput: "uint",
  $deadline: "uint",
  "$previous.output.amount": "uint",
  $account: "address",
  $recipient: "address",
  $token: "address",
  $self: "address",
  "$previous.output.asset": "address",
});

/** The review label of a binding (`$previous.*` → `previousOutput`, objects → `literal`). */
export function bindingReviewSource(binding: ArgBinding): ContractReviewArgSource {
  if (typeof binding !== "string") return "literal";
  if (binding.startsWith("$param.")) return "param";
  if (binding.startsWith("$previous.")) return "previousOutput";
  switch (binding) {
    case "$amount":
      return "amount";
    case "$account":
      return "account";
    case "$recipient":
      return "recipient";
    case "$token":
      return "token";
    case "$self":
      return "self";
    case "$minimumOutput":
      return "minimumOutput";
    case "$deadline":
      return "deadline";
    default:
      return "literal";
  }
}
