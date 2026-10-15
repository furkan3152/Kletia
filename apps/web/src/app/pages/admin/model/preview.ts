/**
 * What a transaction preview prints (admin design D.3-D.5): the decoded call
 * with address-book names, which functions the panel offers and how risky
 * each one is, and typed input parsing for the generic write form. Pure.
 */
import { decodeFunctionData, getAddress, isAddress, isHex, type Abi, type Hex } from "viem";

import type { AbiItem, AbiParameter, AdminActionSpec, AdminCatalog, AdminNetworkProfile, AdminOwnerModel } from "./types.ts";

/* ---------------- Address book ---------------- */

export type AddressBook = ReadonlyMap<string, string>;

const CONTRACT_LABELS: Readonly<Record<string, string>> = {
  wrappedNative: "Wrapped native token",
  uniswapV2Router: "Uniswap V2 Router02",
  uniswapV2Factory: "Uniswap V2 Factory",
  arcForwarder: "Kletia Arc forwarder",
  arcKlet: "KLET token (Arc)",
  arcSwap: "Kletia Arc swap",
};

const ROLE_LABELS: Readonly<Record<string, string>> = { owner: "Governance owner", guardian: "Guardian", treasury: "Treasury" };

/** Known names for addresses (Base Safes, network constants, pinned contracts, the admin wallets). */
export function buildAddressBook(input: {
  readonly catalog: AdminCatalog | null;
  readonly profiles?: readonly AdminNetworkProfile[];
  readonly sessionAddress?: string | null;
  readonly signer?: string | null;
}): AddressBook {
  const book = new Map<string, string>();
  const add = (address: string | null | undefined, name: string) => {
    if (!address || !isAddress(address, { strict: false })) return;
    const key = address.toLowerCase();
    if (!book.has(key)) book.set(key, name);
  };
  // Base Safes first: their names are the most specific.
  const base = input.catalog?.constants.base;
  add(base?.defaultRoles?.owner, "Governance Safe");
  add(base?.defaultRoles?.guardian, "Guardian Safe");
  add(base?.defaultRoles?.treasury, "Treasury Safe");
  add(input.signer, "Connected admin wallet");
  if (input.sessionAddress && isAddress(input.sessionAddress, { strict: false })) add(input.sessionAddress, "Admin wallet");
  for (const constants of Object.values(input.catalog?.constants ?? {})) {
    for (const [key, label] of Object.entries(CONTRACT_LABELS)) add((constants as unknown as Record<string, string | undefined>)[key], label);
    for (const [safe, owners] of Object.entries(constants.safeOwners ?? {})) {
      owners.forEach((owner, index) => add(owner, `Safe co-owner ${index + 1} of ${safe.slice(0, 6)}…${safe.slice(-4)}`));
    }
  }
  for (const profile of input.profiles ?? []) {
    for (const role of ["owner", "guardian", "treasury"] as const) add(profile[role], `${ROLE_LABELS[role]} (${profile.network})`);
  }
  for (const pin of input.catalog?.pinned ?? []) {
    const spec = input.catalog?.contracts[pin.contractId];
    add(pin.address, `${spec?.name ?? pin.contractId}${pin.instance ? ` (${pin.instance})` : ""} on ${pin.network}`);
  }
  return book;
}

export function nameFor(book: AddressBook, address: string | null | undefined): string | null {
  if (!address) return null;
  return book.get(address.toLowerCase()) ?? null;
}

/* ---------------- Decoding ---------------- */

export interface DecodedArg {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface DecodedCall {
  readonly fn: string;
  readonly signature: string;
  readonly args: readonly DecodedArg[];
}

/** A value as one line of text: addresses checksummed, numbers in decimal, arrays and tuples as JSON. */
export function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return isAddress(value, { strict: false }) ? getAddress(value) : value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

export function functionSignature(item: Pick<AbiItem, "name" | "inputs">): string {
  return `${item.name ?? ""}(${(item.inputs ?? []).map((input) => input.type).join(",")})`;
}

/** Decodes calldata against an ABI; null when no function matches. */
export function decodeCall(abi: readonly AbiItem[], data: string): DecodedCall | null {
  if (!isHex(data) || data.length < 10) return null;
  try {
    const decoded = decodeFunctionData({ abi: abi as unknown as Abi, data: data as Hex });
    const item = abi.find((entry) => entry.type === "function" && entry.name === decoded.functionName && (entry.inputs?.length ?? 0) === (decoded.args?.length ?? 0));
    const inputs = item?.inputs ?? [];
    const args = (decoded.args ?? []).map((value, index) => ({
      name: inputs[index]?.name || `arg${index}`,
      type: inputs[index]?.type ?? "unknown",
      value: formatValue(value),
    }));
    return { fn: decoded.functionName, signature: functionSignature(item ?? { name: decoded.functionName, inputs: [] }), args };
  } catch {
    return null;
  }
}

/* ---------------- Which functions, how risky ---------------- */

export const RENOUNCE_DISABLED = "Disabled by the panel.";
export const OTHER_FUNCTION_NOTE = "Not marked as an owner function. The call is simulated first; it may revert.";

export interface WriteFunction {
  readonly item: AbiItem;
  readonly signature: string;
  readonly action: AdminActionSpec | null;
  readonly payable: boolean;
  /** Set when the panel never offers the function. */
  readonly disabled: string | null;
  readonly danger: Danger;
}

export interface Danger {
  readonly level: "routine" | "sensitive" | "dangerous";
  /** Ownership moves in one step (OZ Ownable, the Arc custom owner): no acceptance, no undo. */
  readonly singleStepTransfer: boolean;
  readonly message: string | null;
}

export const SINGLE_STEP_WARNING = "This transfer takes effect immediately and cannot be undone by you.";
export const TWO_STEP_NOTE = "The new owner must accept. Until then the current owner stays in control.";

export function dangerOf(fn: string, action: AdminActionSpec | null, ownerModel: AdminOwnerModel): Danger {
  const singleStep = fn === "transferOwnership" && (ownerModel === "ownable" || ownerModel === "custom-single-step");
  if (singleStep) return { level: "dangerous", singleStepTransfer: true, message: SINGLE_STEP_WARNING };
  if (fn === "transferOwnership") return { level: "dangerous", singleStepTransfer: false, message: TWO_STEP_NOTE };
  const level = action?.risk ?? "sensitive";
  return { level, singleStepTransfer: false, message: action?.warning ?? null };
}

/** Every state-changing function of an ABI: catalog actions first (in catalog order), then the rest. */
export function writeFunctions(abi: readonly AbiItem[], actions: readonly AdminActionSpec[], ownerModel: AdminOwnerModel): { owner: WriteFunction[]; other: WriteFunction[] } {
  const writes = abi.filter((item) => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure");
  const owner: WriteFunction[] = [];
  const other: WriteFunction[] = [];
  const toWrite = (item: AbiItem, action: AdminActionSpec | null): WriteFunction => ({
    item,
    signature: functionSignature(item),
    action,
    payable: item.stateMutability === "payable",
    disabled: item.name === "renounceOwnership" ? RENOUNCE_DISABLED : null,
    danger: dangerOf(item.name ?? "", action, ownerModel),
  });
  for (const action of actions) {
    const item = writes.find((entry) => entry.name === action.fn);
    if (item) owner.push(toWrite(item, action));
  }
  for (const item of writes) {
    if (owner.some((entry) => entry.item === item)) continue;
    other.push(toWrite(item, null));
  }
  return { owner, other };
}

/* ---------------- Typed inputs ---------------- */

export type ParsedInput = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Parses a form value for an ABI input (address, uint/int, bool, bytes, string, arrays and tuples as JSON). */
export function parseInput(param: AbiParameter, raw: string): ParsedInput {
  const type = param.type;
  const text = raw.trim();
  if (type.endsWith("]") || type === "tuple") {
    try {
      const parsed: unknown = JSON.parse(text || "null");
      if (type.endsWith("]") && !Array.isArray(parsed)) return { ok: false, error: "Enter a JSON array." };
      return { ok: true, value: convertJson(param, parsed) };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message.startsWith("Invalid") ? error.message : "Enter valid JSON." };
    }
  }
  return parseScalar(type, text);
}

function parseScalar(type: string, text: string): ParsedInput {
  if (type === "address") return isAddress(text, { strict: false }) ? { ok: true, value: getAddress(text) } : { ok: false, error: "Enter an address (0x and 40 hex digits)." };
  if (type === "bool") {
    if (text === "true" || text === "false") return { ok: true, value: text === "true" };
    return { ok: false, error: "Enter true or false." };
  }
  const integer = /^(u?)int(\d*)$/u.exec(type);
  if (integer) {
    if (!/^-?\d+$/u.test(text)) return { ok: false, error: "Enter a whole number." };
    const value = BigInt(text);
    const bits = BigInt(integer[2] || "256");
    if (integer[1] === "u") {
      if (value < 0n || value >= 1n << bits) return { ok: false, error: `Out of range for ${type}.` };
    } else if (value < -(1n << (bits - 1n)) || value >= 1n << (bits - 1n)) {
      return { ok: false, error: `Out of range for ${type}.` };
    }
    return { ok: true, value };
  }
  const bytes = /^bytes(\d*)$/u.exec(type);
  if (bytes) {
    if (!isHex(text) || text.length % 2 !== 0) return { ok: false, error: "Enter hex bytes starting with 0x." };
    if (bytes[1] && (text.length - 2) / 2 !== Number(bytes[1])) return { ok: false, error: `Enter exactly ${bytes[1]} bytes.` };
    return { ok: true, value: text };
  }
  if (type === "string") return { ok: true, value: text };
  return { ok: false, error: `The panel cannot edit ${type} values.` };
}

function convertJson(param: AbiParameter, value: unknown): unknown {
  const type = param.type;
  if (type.endsWith("]")) {
    const inner: AbiParameter = { ...param, type: type.slice(0, type.lastIndexOf("[")) };
    if (!Array.isArray(value)) throw new Error("Invalid array value.");
    return value.map((item) => convertJson(inner, item));
  }
  if (type === "tuple") {
    const components = param.components ?? [];
    if (Array.isArray(value)) return value.map((item, index) => convertJson(components[index] ?? { type: "string" }, item));
    if (value && typeof value === "object") {
      return Object.fromEntries(components.map((component) => [component.name ?? "", convertJson(component, (value as Record<string, unknown>)[component.name ?? ""])]));
    }
    throw new Error("Invalid tuple value.");
  }
  const parsed = parseScalar(type, typeof value === "string" ? value : JSON.stringify(value));
  if (!parsed.ok) throw new Error(`Invalid ${type}: ${parsed.error}`);
  return parsed.value;
}

/* ---------------- Ownership transfer guard ---------------- */

/** Checks for a single-step ownership transfer (admin design D.5); returns the problems. */
export function transferOwnerProblems(input: {
  readonly newOwner: string;
  readonly confirm: string;
  readonly contract: string;
  readonly knownTokens?: readonly string[];
  readonly singleStep: boolean;
}): string[] {
  const problems: string[] = [];
  if (!isAddress(input.newOwner.trim(), { strict: false })) return ["Enter the new owner's address."];
  const owner = input.newOwner.trim().toLowerCase();
  if (/^0x0{40}$/u.test(owner)) problems.push("The new owner cannot be the zero address.");
  if (owner === input.contract.toLowerCase()) problems.push("The new owner cannot be the contract itself.");
  if ((input.knownTokens ?? []).some((token) => token.toLowerCase() === owner)) problems.push("The new owner cannot be a token contract.");
  if (input.singleStep && input.confirm.trim().toLowerCase() !== owner) problems.push("Type the new owner's address a second time, exactly.");
  return problems;
}
