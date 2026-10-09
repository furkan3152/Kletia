/**
 * The self-contained registration snapshot a call / action step carries
 * (`IntentStep.call`): everything prepare and verification need (ABI
 * fragments, bindings, pinned addresses, pins, payees), so neither ever reads
 * the registry to know what to encode or what to prove. The service still
 * checks at prepare that the registration is usable, active and unchanged.
 */
import {
  abiItemSignature,
  contractActionFunction,
  CONTRACT_LIMITS,
  findAssetByAddress,
  formatAssetId,
  functionSelector,
  type AbiEventItem,
  type ContractStepEvent,
  type EvmContractAction,
  type EvmContractDefinition,
  type EvmContractPins,
  type SolanaActionDefinition,
  type SolanaActionEndpoint,
  type SolanaProgramPin,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolveAsset, type ResolvedAsset } from "../assets.js";
import { readSolanaAccounts, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { isSolanaNetworkKey } from "../../../networks/solana/index.js";
import type { ContractCallSnapshot } from "../adapters/types.js";
import type { RegisteredContract } from "./directory.js";
import { fillActionParams } from "./solanaActions.js";

function corrupt(message: string): PlatformError {
  return new PlatformError("STEP_INVALID", `The contract registration is inconsistent: ${message}`, 500);
}

/** `$self` or an `addresses` label → the pinned address. */
export function labelledAddress(definition: EvmContractDefinition, reference: string): string {
  if (reference === "$self") return definition.address;
  const entry = (definition.addresses ?? []).find((candidate) => candidate.label === reference);
  if (!entry) throw corrupt(`unknown address label ${reference}.`);
  return entry.address;
}

/** The declared output token address of an EVM entry, or null. */
export function evmOutputToken(definition: EvmContractDefinition, entry: EvmContractAction): string | null {
  if (!entry.output) return null;
  const token = entry.output.token;
  return token.startsWith("0x") ? token : labelledAddress(definition, token);
}

function isEvmPins(pins: RegisteredContract["pins"]): pins is EvmContractPins {
  return !Array.isArray(pins) && typeof (pins as EvmContractPins).codeHash === "string";
}

function integrator(registration: RegisteredContract): ContractCallSnapshot["integrator"] {
  const { name, website } = registration.definition.integrator;
  return { name, ...(website ? { website } : {}), domainVerified: registration.verification.domain.verified };
}

function outputRef(output: ResolvedAsset | null): ContractCallSnapshot["output"] {
  return output ? { asset: output.id, symbol: output.symbol, decimals: output.decimals } : undefined;
}

/** Snapshot of an EVM entry of the active revision. */
export function evmSnapshot(
  registration: RegisteredContract,
  entry: EvmContractAction,
  params: Readonly<Record<string, string | boolean>>,
  output: ResolvedAsset | null,
): ContractCallSnapshot {
  const definition = registration.definition as EvmContractDefinition;
  const fragment = contractActionFunction(definition, entry);
  if (!fragment) throw corrupt(`function ${entry.function} is not in the ABI.`);
  if (!isEvmPins(registration.pins)) throw corrupt("the registration has no EVM pins.");
  const events: ContractStepEvent[] = entry.events.map((binding) => {
    const item = definition.abi.find((candidate): candidate is AbiEventItem => candidate.type === "event" && abiItemSignature(candidate) === binding.event);
    if (!item) throw corrupt(`event ${binding.event} is not in the ABI.`);
    return {
      fragment: item,
      emitter: labelledAddress(definition, binding.emitter),
      where: binding.where,
      ...(binding.output ? { output: binding.output } : {}),
    };
  });
  const ref = outputRef(output);
  return {
    contract: registration.id,
    revision: registration.activeRevision as number,
    definitionHash: registration.definitionHash,
    entry: entry.id,
    vm: "evm",
    target: definition.address,
    integrator: integrator(registration),
    label: entry.label,
    function: entry.function,
    selector: functionSelector(entry.function),
    fragment,
    bindings: entry.args,
    ...(entry.input?.approval ? { approvalSpender: labelledAddress(definition, entry.input.approval.spender) } : {}),
    ...(entry.value ? { value: entry.value } : {}),
    events,
    pins: registration.pins,
    recipientMode: entry.recipient ?? "account",
    toleranceBps: entry.output?.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(ref ? { output: ref } : {}),
  };
}

/** Snapshot of a Solana Actions entry of the active revision. */
export function solanaSnapshot(
  registration: RegisteredContract,
  entry: SolanaActionEndpoint,
  params: Readonly<Record<string, string | boolean>>,
  output: ResolvedAsset | null,
): ContractCallSnapshot {
  const definition = registration.definition as SolanaActionDefinition;
  const pins = Array.isArray(registration.pins) ? (registration.pins as readonly SolanaProgramPin[]) : [];
  const programs = definition.programs.map((program) => {
    const pin = pins.find((candidate) => candidate.program === program);
    if (!pin) throw corrupt(`program ${program} has no pin.`);
    return pin;
  });
  const ref = outputRef(output);
  return {
    contract: registration.id,
    revision: registration.activeRevision as number,
    definitionHash: registration.definitionHash,
    entry: entry.id,
    vm: "svm",
    target: entry.primaryProgram,
    integrator: integrator(registration),
    label: entry.label,
    origin: definition.origin,
    href: fillActionParams(entry.href, params),
    programs,
    ...(definition.payees?.length ? { payees: definition.payees.map((payee) => ({ address: payee.address, maxLamports: payee.maxLamports })) } : {}),
    toleranceBps: entry.output?.toleranceBps ?? CONTRACT_LIMITS.defaultToleranceBps,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(ref ? { output: ref } : {}),
  };
}

/**
 * The declared output asset of an entry: a registry asset, else the token
 * itself read on-chain (ERC-20 metadata; SPL mint decimals). Never a
 * third-party token list: an unlisted output is shown by address.
 */
export async function contractOutputAsset(registration: RegisteredContract, entry: EvmContractAction | SolanaActionEndpoint): Promise<ResolvedAsset | null> {
  const definition = registration.definition;
  if (definition.vm === "evm") {
    const token = evmOutputToken(definition, entry as EvmContractAction);
    return token ? resolveAsset(definition.network, token) : null;
  }
  const mint = (entry as SolanaActionEndpoint).output?.mint;
  if (!mint) return null;
  const listed = findAssetByAddress(definition.network, mint);
  if (listed) return resolveAsset(definition.network, listed.id);
  if (!isSolanaNetworkKey(definition.network)) return null;
  const [account] = await readSolanaAccounts(definition.network, [mint]);
  const owners: readonly string[] = [SOLANA_PROGRAM_IDS.token, SOLANA_PROGRAM_IDS.token2022];
  if (!account || !owners.includes(account.owner) || account.data.length < 82) {
    throw new PlatformError("TOKEN_UNKNOWN", `The declared output ${mint} is not an SPL mint on ${definition.network}.`, 422);
  }
  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  return {
    network: definition.network,
    id: formatAssetId(definition.network, "token", mint),
    symbol: short,
    name: short,
    decimals: account.data[44] as number,
    address: mint,
    isNative: false,
    canonical: false,
    verified: false,
  };
}
