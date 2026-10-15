/**
 * Constructor arguments for a deploy (admin design C.1 step 4): each input of
 * the catalog's `constructorInputs` resolves from its source (a role in the
 * network profile, a network constant, a dependency record, an editable
 * literal or the connected wallet), and the deploy data is the artifact's
 * creation bytecode followed by the ABI-encoded arguments. Pure.
 */
import { encodeAbiParameters, getAddress, isAddress, type AbiParameter as ViemAbiParameter, type Hex } from "viem";

import type {
  AbiItem,
  AdminArgSource,
  AdminConstructorInput,
  AdminContractId,
  AdminDeploymentRecord,
  AdminEvmNetwork,
  AdminNetworkConstants,
  AdminNetworkProfile,
  AdminPinnedDeployment,
  AdminRole,
} from "./types.ts";

export interface ArgContext {
  readonly network: AdminEvmNetwork;
  readonly testnet: boolean;
  readonly profile: AdminNetworkProfile | null;
  readonly constants: AdminNetworkConstants | undefined;
  readonly records: readonly AdminDeploymentRecord[];
  readonly pinned: readonly AdminPinnedDeployment[];
  /** The connected EVM wallet that will send the deploy (null when none is connected). */
  readonly signer: string | null;
  /** The owner's edits of editable literals, by input name. */
  readonly literals?: Readonly<Record<string, string>>;
}

export type ArgOrigin = "profile" | "default-role" | "constant" | "record" | "pinned" | "literal" | "wallet";

export type ResolvedArg =
  | { readonly input: AdminConstructorInput; readonly ok: true; readonly value: string; readonly origin: ArgOrigin }
  | { readonly input: AdminConstructorInput; readonly ok: false; readonly reason: string; readonly value?: string };

const ROLE_NAMES: Readonly<Record<AdminRole, string>> = { owner: "owner", guardian: "guardian", treasury: "treasury" };

const UINT_MAX: Readonly<Record<string, bigint>> = {
  uint16: (1n << 16n) - 1n,
  uint256: (1n << 256n) - 1n,
};

/** The address of a dependency: the newest verified record of that target on the network, else the pinned address. */
export function dependencyAddress(
  network: AdminEvmNetwork,
  contractId: AdminContractId,
  instance: string | undefined,
  records: readonly AdminDeploymentRecord[],
  pinned: readonly AdminPinnedDeployment[],
): { readonly address: string; readonly origin: "record" | "pinned" } | null {
  const sameTarget = (item: { network: string; contractId: string; instance?: string }) =>
    item.network === network && item.contractId === contractId && (item.instance ?? undefined) === (instance ?? undefined);
  const verified = records
    .filter((record) => record.status === "verified" && sameTarget(record))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (verified[0]) return { address: verified[0].address, origin: "record" };
  const pin = pinned.find((item) => sameTarget(item) && item.lifecycle !== "legacy");
  return pin ? { address: pin.address, origin: "pinned" } : null;
}

function checksum(value: string): string | null {
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

/** Checks a literal against its type and bounds; returns the reason it is refused, or null. */
export function literalProblem(input: AdminConstructorInput, value: string, source: Extract<AdminArgSource, { kind: "literal" }>): string | null {
  if (input.type === "string") return value.length === 0 ? `${input.label} is empty.` : null;
  if (input.type === "address") return checksum(value) ? null : `${input.label} is not an address.`;
  if (!/^\d+$/u.test(value)) return `${input.label} must be a whole number.`;
  const number = BigInt(value);
  const max = UINT_MAX[input.type];
  if (max !== undefined && number > max) return `${input.label} is too large for ${input.type}.`;
  if (source.min !== undefined && number < BigInt(source.min)) return `${input.label} must be at least ${source.min}.`;
  if (source.max !== undefined && number > BigInt(source.max)) return `${input.label} must be at most ${source.max}.`;
  return null;
}

export function resolveArg(input: AdminConstructorInput, context: ArgContext): ResolvedArg {
  const source = input.source;
  switch (source.kind) {
    case "role": {
      const fromProfile = context.profile?.[source.role] ?? null;
      const fallback = context.constants?.defaultRoles?.[source.role] ?? null;
      const value = fromProfile ?? fallback;
      if (!value) return { input, ok: false, reason: `Set the ${ROLE_NAMES[source.role]} address in the network profile first.` };
      const address = checksum(value);
      if (!address) return { input, ok: false, reason: `The ${ROLE_NAMES[source.role]} address in the profile is not valid.` };
      return { input, ok: true, value: address, origin: fromProfile ? "profile" : "default-role" };
    }
    case "network-constant": {
      const value = context.constants?.[source.key];
      const address = value ? checksum(value) : null;
      if (!address) return { input, ok: false, reason: `No pinned ${source.key} on this network.` };
      return { input, ok: true, value: address, origin: "constant" };
    }
    case "dependency": {
      const found = dependencyAddress(context.network, source.contractId, source.instance, context.records, context.pinned);
      if (!found) return { input, ok: false, reason: `Waiting for ${source.contractId}${source.instance ? ` (${source.instance})` : ""}: deploy and verify it first.` };
      return { input, ok: true, value: getAddress(found.address), origin: found.origin };
    }
    case "literal": {
      const edited = source.editable ? context.literals?.[input.name] : undefined;
      const value = (edited ?? source.value).trim();
      const problem = literalProblem(input, value, source);
      if (problem) return { input, ok: false, reason: problem, value };
      return { input, ok: true, value: input.type === "address" ? (checksum(value) as string) : value, origin: "literal" };
    }
    case "session-address": {
      if (!context.signer) return { input, ok: false, reason: "Connect the EVM admin wallet: this argument is the deploying wallet." };
      const address = checksum(context.signer);
      if (!address) return { input, ok: false, reason: "The connected wallet address is not valid." };
      return { input, ok: true, value: address, origin: "wallet" };
    }
    default:
      return { input, ok: false, reason: "Unknown argument source." };
  }
}

export interface ResolvedArgs {
  readonly args: readonly ResolvedArg[];
  readonly ready: boolean;
  /** Values by input name (only the resolved ones), as the API's `constructorArgs` expects. */
  readonly values: Readonly<Record<string, string>>;
  /** The first reason the deploy cannot start, for the disabled button. */
  readonly blocked: string | null;
}

export function resolveArgs(inputs: readonly AdminConstructorInput[], context: ArgContext): ResolvedArgs {
  const args = inputs.map((input) => resolveArg(input, context));
  const values: Record<string, string> = {};
  for (const arg of args) if (arg.ok) values[arg.input.name] = arg.value;
  const firstProblem = args.find((arg): arg is Extract<ResolvedArg, { ok: false }> => !arg.ok);
  return { args, ready: !firstProblem, values, blocked: firstProblem?.reason ?? null };
}

/** The value as the ABI encoder takes it. */
export function abiValue(type: string, value: string): unknown {
  if (type === "address") return getAddress(value);
  if (/^u?int\d*$/u.test(type)) return BigInt(value);
  if (type === "bool") return value === "true";
  return value;
}

/** The constructor of an ABI (empty inputs when it has none). */
export function constructorOf(abi: readonly AbiItem[]): AbiItem {
  return abi.find((item) => item.type === "constructor") ?? { type: "constructor", inputs: [] };
}

/**
 * Creation data: bytecode + ABI-encoded constructor arguments in the
 * constructor's own order. Fails when the catalog and the artifact disagree on
 * an input name (the core test pins them, this is the runtime guard).
 */
export function buildDeployData(abi: readonly AbiItem[], bytecode: string, values: Readonly<Record<string, string>>): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/u.test(bytecode)) throw new Error("The artifact has no creation bytecode.");
  const inputs = constructorOf(abi).inputs ?? [];
  const args = inputs.map((input, index) => {
    const name = input.name ?? `arg${index}`;
    const value = values[name];
    if (value === undefined) throw new Error(`Missing constructor argument ${name}.`);
    return abiValue(input.type, value);
  });
  const encoded = inputs.length > 0 ? encodeAbiParameters(inputs as readonly ViemAbiParameter[], args) : "0x";
  return `${bytecode}${encoded.slice(2)}` as Hex;
}

export interface RoleCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** The owner has no code on a mainnet: the typed acknowledgement is required. */
  readonly needsEoaAck: boolean;
}

/** The profile form's rules (admin design C.1 step 2). */
export function validateRoles(
  roles: { readonly owner: string; readonly guardian: string; readonly treasury: string },
  context: { readonly testnet: boolean; readonly wrappedNative?: string; readonly ownerHasCode: boolean | null },
): RoleCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed: Partial<Record<AdminRole, string>> = {};
  for (const role of ["owner", "guardian", "treasury"] as const) {
    const raw = roles[role].trim();
    if (!raw) {
      errors.push(`The ${role} address is required.`);
      continue;
    }
    const address = checksum(raw);
    if (!address) {
      errors.push(`The ${role} address is not valid.`);
      continue;
    }
    if (/^0x0{40}$/iu.test(address)) {
      errors.push(`The ${role} cannot be the zero address.`);
      continue;
    }
    parsed[role] = address;
  }
  const { owner, guardian, treasury } = parsed;
  const pairs: [string | undefined, string | undefined, string][] = [
    [owner, guardian, "The owner and the guardian are the same address."],
    [owner, treasury, "The owner and the treasury are the same address."],
    [guardian, treasury, "The guardian and the treasury are the same address."],
  ];
  for (const [a, b, text] of pairs) if (a && b && a === b) warnings.push(context.testnet ? text : `${text} Production policy wants three distinct addresses.`);
  if (treasury && context.wrappedNative && checksum(context.wrappedNative) === treasury) errors.push("The treasury cannot be the wrapped native token.");
  const needsEoaAck = !context.testnet && Boolean(owner) && context.ownerHasCode === false;
  if (needsEoaAck) warnings.push("EOA owner: production policy wants a Safe as owner.");
  return { errors, warnings, needsEoaAck };
}

/** The sentence the owner types to accept an EOA owner on a mainnet. */
export function eoaAckPhrase(networkName: string): string {
  return `I accept an EOA owner on ${networkName}`;
}
