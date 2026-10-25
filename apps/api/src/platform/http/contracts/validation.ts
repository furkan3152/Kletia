/**
 * Definition validation, phrase collisions and on-chain pinning.
 */
import {
  CHAINS,
  validateContractDefinition,
  type ContractDefinition,
  type ContractPins,
  type ContractVerification,
  type EvmContractDefinition,
  type NetworkKey,
  type SolanaActionDefinition,
  type SolanaActionMetadata,
} from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../../errors.js";
import {
  isEvmNetwork,
  proxyRefusalReason,
  type ActionTransport,
  type EvmNetworkKey,
  type SolanaNetworkKey,
} from "../../index.js";
import { isSolanaNetworkKey } from "../../../networks/solana/index.js";
import { createActionTransport } from "../actionTransport.js";
import {
  configuredDenylist,
  contractChecks,
  contractEngine,
  RISK_REFUSAL_SCORE,
  type EvmInspection,
} from "../contractChecks.js";
import { invalidRequest } from "../context.js";
import { type Caller, contractStore } from "./lifecycle.js";

/* ============================================================ validation */

function issuesOf(result: { readonly issues: readonly { readonly path: string; readonly message: string }[] }): PlatformIssue[] {
  return result.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** Maps the core validator's result to the API error; codes are literal so the catalog drift test sees them. */
function definitionError(result: { readonly code: string; readonly issues: readonly { readonly code: string; readonly path: string; readonly message: string }[] }): PlatformError {
  const issues = issuesOf(result);
  const first = result.issues.find((issue) => issue.code === result.code) ?? result.issues[0];
  const detail = first ? ` ${first.path ? `${first.path}: ` : ""}${first.message}` : "";
  switch (result.code) {
    case "CONTRACT_DENIED":
      return new PlatformError("CONTRACT_DENIED", `This contract or program cannot be registered.${detail}`, 422, issues);
    case "CONTRACT_FUNCTION_FORBIDDEN":
      return new PlatformError("CONTRACT_FUNCTION_FORBIDDEN", `The definition includes a function that can never be registered.${detail}`, 422, issues);
    case "CONTRACT_ARGUMENT_FORBIDDEN":
      return new PlatformError("CONTRACT_ARGUMENT_FORBIDDEN", `The definition includes an argument type that can never be registered.${detail}`, 422, issues);
    case "PROGRAM_NOT_ALLOWED":
      return new PlatformError("PROGRAM_NOT_ALLOWED", `A program cannot be allowlisted.${detail}`, 422, issues);
    case "ACTION_URL_FORBIDDEN":
      return new PlatformError("ACTION_URL_FORBIDDEN", `An action URL is refused.${detail}`, 422, issues);
    case "CONTRACT_BINDING_INVALID":
      return new PlatformError("CONTRACT_BINDING_INVALID", `An argument or event binding is invalid.${detail}`, 422, issues);
    default:
      return new PlatformError("CONTRACT_DEFINITION_INVALID", `The contract definition is invalid.${detail}`, 400, issues);
  }
}

/** Static validation with the deployment's deny lists; returns the normalised definition. */
export function validateDefinition(input: unknown): ContractDefinition {
  const result = validateContractDefinition(input, { denylist: configuredDenylist() });
  if (!result.ok) throw definitionError(result);
  return result.value;
}

function phrasePairs(definition: ContractDefinition): Map<string, string> {
  const pairs = new Map<string, string>();
  definition.actions.forEach((action, index) => {
    for (const verb of action.phrases?.verbs ?? []) {
      (action.phrases?.aliases ?? []).forEach((alias, aliasIndex) => {
        pairs.set(`${verb}\u0000${alias}`, `actions[${index}].phrases.aliases[${aliasIndex}]`);
      });
    }
  });
  return pairs;
}

/**
 * A key's registrations on one network may not share a (verb, alias) pair, or
 * "deposit into acme" would be ambiguous (the static validator only checks
 * inside one registration). Project-visible registrations of the project count.
 */
export async function assertPhrasesFree(caller: Caller, definition: ContractDefinition, selfId: string | null): Promise<void> {
  const pairs = phrasePairs(definition);
  if (pairs.size === 0) return;
  for (const entry of await contractStore().listVisible(caller.keyId, caller.projectId)) {
    if (entry.record.id === selfId || entry.record.network !== definition.network) continue;
    for (const revision of [entry.active, entry.pending]) {
      if (!revision) continue;
      for (const key of phrasePairs(revision.definition).keys()) {
        const path = pairs.get(key);
        if (path === undefined) continue;
        const [verb, alias] = key.split("\u0000");
        const message = `"${verb} … ${alias}" is already used by ${entry.record.id} on ${definition.network}. Use another alias or verb.`;
        throw new PlatformError("CONTRACT_DEFINITION_INVALID", `The contract definition is invalid. ${path}: ${message}`, 400, [{ path, message }]);
      }
    }
  }
}

/* ================================================================ pinning */

export function evmNetwork(network: NetworkKey): EvmNetworkKey {
  if (!isEvmNetwork(network)) throw invalidRequest(`${network} is not an EVM network.`, [{ path: "network", message: "Not an EVM network." }]);
  return network;
}

export function solanaNetwork(network: NetworkKey): SolanaNetworkKey {
  if (!isSolanaNetworkKey(network)) throw invalidRequest(`${network} is not a Solana network.`, [{ path: "network", message: "Not a Solana network." }]);
  return network;
}

export interface Pinned {
  readonly pins: ContractPins;
  readonly verification: Omit<ContractVerification, "domain">;
  readonly metadata: Record<string, SolanaActionMetadata>;
}

async function pinEvm(definition: EvmContractDefinition): Promise<Pinned> {
  const network = evmNetwork(definition.network);
  const inspection: EvmInspection = await contractEngine().inspectEvmContract(network, definition.address, definition.addresses ?? []);
  if (inspection.eip7702) {
    throw new PlatformError("CONTRACT_DELEGATED_EOA", "This address is an EIP-7702 delegated account: its code can be swapped at any time, so it cannot be registered.", 422, [
      { path: "address", message: "EIP-7702 delegated account." },
    ]);
  }
  if (inspection.codeSize <= 0) {
    throw new PlatformError("CONTRACT_NOT_DEPLOYED", `No contract code at ${definition.address} on ${CHAINS[network].name}.`, 422, [
      { path: "address", message: "No deployed code." },
    ]);
  }
  const pins = inspection.pins;
  for (const [index, entry] of (definition.addresses ?? []).entries()) {
    const pinned = pins.addresses.find((pin) => pin.label === entry.label && pin.address.toLowerCase() === entry.address.toLowerCase());
    if (inspection.proxyHints.includes(`${entry.label}:eip7702-delegation`)) {
      throw new PlatformError("CONTRACT_DELEGATED_EOA", `${entry.address} (${entry.label}) is an EIP-7702 delegated account.`, 422, [
        { path: `addresses[${index}].address`, message: "EIP-7702 delegated account." },
      ]);
    }
    if (!pinned || pinned.codeSize <= 0 || inspection.proxyHints.includes(`${entry.label}:not-deployed`)) {
      throw new PlatformError("CONTRACT_NOT_DEPLOYED", `No contract code at ${entry.address} (${entry.label}).`, 422, [
        { path: `addresses[${index}].address`, message: "No deployed code." },
      ]);
    }
  }
  const unsupported = proxyRefusalReason(inspection);
  if (unsupported) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", `This proxy cannot be pinned: ${unsupported}`, 422, [
      { path: "address", message: "Unsupported proxy pattern." },
    ]);
  }
  const checks = contractChecks();
  const [sourcify, implementation, risk] = await Promise.all([
    checks.sourcify(network, definition.address),
    pins.proxy ? checks.sourcify(network, pins.proxy.implementation) : Promise.resolve(null),
    checks.risk(network, definition.address),
  ]);
  // Sourcify's proxy resolution is an independent cross-check of the pinned proxy.
  if (sourcify.proxy?.isProxy && !pins.proxy) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", `Sourcify resolves this contract as a ${sourcify.proxy.proxyType ?? "proxy"} that Kletia cannot pin.`, 422, [
      { path: "address", message: "Unsupported proxy pattern." },
    ]);
  }
  if (pins.proxy && sourcify.proxy?.isProxy && sourcify.proxy.implementations.length > 0 && !sourcify.proxy.implementations.includes(pins.proxy.implementation.toLowerCase())) {
    throw new PlatformError("CONTRACT_PROXY_UNSUPPORTED", "Sourcify's proxy resolution disagrees with the implementation read on-chain; registration refused.", 422, [
      { path: "address", message: "Proxy resolution mismatch." },
    ]);
  }
  if (risk?.score !== null && risk?.score !== undefined && risk.score > RISK_REFUSAL_SCORE) {
    throw new PlatformError("CONTRACT_DENIED", `Address risk screening scored this contract ${risk.score}/100; registration refused.`, 422, [
      { path: "address", message: "High risk score." },
    ]);
  }
  return {
    pins,
    verification: { source: sourcify.verification, implementationSource: implementation?.verification ?? null, risk },
    metadata: {},
  };
}

async function pinSolana(definition: SolanaActionDefinition): Promise<Pinned> {
  const network = solanaNetwork(definition.network);
  await contractChecks().actionOrigin(definition.origin);
  const engine = contractEngine();
  const pins = await engine.readSolanaProgramPins(network, definition.programs);
  for (const [index, program] of definition.programs.entries()) {
    if (!pins.some((pin) => pin.program === program)) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `Program ${program} could not be pinned (not an executable program account).`, 422, [
        { path: `programs[${index}]`, message: "Not an executable program." },
      ]);
    }
  }
  const transport = directoryTransport();
  const metadata: Record<string, SolanaActionMetadata> = {};
  for (const action of definition.actions) {
    metadata[action.id] = await engine.fetchSolanaActionMetadata(transport, action.href, network);
  }
  const programs = await Promise.all(definition.programs.map((program) => contractChecks().ottersec(program)));
  return { pins, verification: { programs, risk: null }, metadata };
}

export function pin(definition: ContractDefinition): Promise<Pinned> {
  return definition.vm === "evm" ? pinEvm(definition) : pinSolana(definition);
}

/* ======================================================= action transport */

let transport: ActionTransport | null = null;

export function directoryTransport(): ActionTransport {
  transport ??= createActionTransport();
  return transport;
}
