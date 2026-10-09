import type { IntentConstraints, IntentStep, ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "./aaveV3.js";
import { contractCallAdapter } from "./contractCall.js";
import { debridgeDlnAdapter } from "./debridge.js";
import { evmTransferAdapter } from "./evmTransfer.js";
import { jupiterAdapter } from "./jupiter.js";
import { jupiterLendAdapter } from "./jupiterLend.js";
import { kaminoAdapter } from "./kamino.js";
import { compoundV3Adapter } from "./lending/compoundV3.js";
import { erc4626Adapter } from "./lending/erc4626.js";
import { moonwellAdapter } from "./lending/moonwell.js";
import { lifiAdapter } from "./lifi.js";
import { relayAdapter } from "./relay.js";
import { solanaActionAdapter } from "./solanaAction.js";
import { solanaTransferAdapter } from "./solanaTransfer.js";
import type { AdapterRoute, ContractProtocolAdapter, ProtocolAdapter } from "./types.js";

/**
 * Adapters of integrator-registered contracts (call / action steps). Route
 * search never selects them (`supports` is false); the planner picks them by
 * protocol. They stay available when embedders configure their own adapter
 * set, unless that set brings its own adapter for the protocol.
 */
export const CONTRACT_ADAPTERS: readonly ContractProtocolAdapter[] = Object.freeze([contractCallAdapter, solanaActionAdapter]);

/** Default preference order when several adapters can serve a route. */
export const ADAPTERS: readonly ProtocolAdapter[] = Object.freeze([
  jupiterAdapter,
  solanaTransferAdapter,
  evmTransferAdapter,
  relayAdapter,
  lifiAdapter,
  debridgeDlnAdapter,
  aaveV3Adapter,
  compoundV3Adapter,
  erc4626Adapter,
  moonwellAdapter,
  jupiterLendAdapter,
  kaminoAdapter,
  ...CONTRACT_ADAPTERS,
]);

export const EXECUTABLE_PROTOCOLS: readonly ProtocolId[] = Object.freeze(
  [...new Set(ADAPTERS.flatMap((adapter) => adapter.protocols))],
);

/**
 * Adapters the engine plans and executes with. Defaults to ADAPTERS; tests and
 * embedders may substitute their own set (e.g. stubbed venues) through
 * `configureAdapters`.
 */
let activeAdapters: readonly ProtocolAdapter[] = ADAPTERS;

export function configureAdapters(adapters: readonly ProtocolAdapter[] | null): void {
  if (adapters !== null && adapters.length === 0) {
    throw new PlatformError("ADAPTERS_INVALID", "At least one protocol adapter is required.", 500);
  }
  activeAdapters = adapters === null ? ADAPTERS : Object.freeze([...adapters]);
}

export function activeProtocolAdapters(): readonly ProtocolAdapter[] {
  return activeAdapters;
}

/** The protocol id a route executes under with this adapter. */
export function effectiveProtocol(adapter: ProtocolAdapter, route: AdapterRoute): ProtocolId {
  if (route.kind === "transfer" && adapter.protocols.includes("system-transfer")) {
    return route.input.isNative ? "system-transfer" : adapter.id;
  }
  return adapter.id;
}

/** Adapters able to serve a route, ordered by constraints and preference. */
export function candidateAdapters(
  route: AdapterRoute,
  constraints: IntentConstraints | undefined,
  requested?: ProtocolId,
): ProtocolAdapter[] {
  const avoid = new Set(constraints?.avoidProtocols ?? []);
  const prefer = constraints?.preferProtocols ?? [];
  const candidates = activeAdapters.filter(
    (adapter) => adapter.supports(route) && !avoid.has(effectiveProtocol(adapter, route)),
  );
  const rank = (adapter: ProtocolAdapter) => {
    const index = prefer.indexOf(effectiveProtocol(adapter, route));
    return index === -1 ? prefer.length : index;
  };
  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
  if (requested) return ordered.filter((adapter) => effectiveProtocol(adapter, route) === requested);
  return ordered;
}

/** Primary adapter id of each VM's transfer family (both execute `system-transfer`). */
const TRANSFER_FAMILY: Readonly<Record<"evm" | "svm", ProtocolId>> = { evm: "erc20-transfer", svm: "spl-token" };

/**
 * The adapter that executes a planned step. Several adapters may share a
 * protocol id (`system-transfer` exists on every VM), so ties are broken by
 * the step's VM.
 */
export function adapterForStep(step: Pick<IntentStep, "protocol" | "chain">): ProtocolAdapter {
  if (step.protocol === "custom-call" || step.protocol === "solana-actions") return adapterForProtocol(step.protocol);
  const matches = activeAdapters.filter((entry) => entry.protocols.includes(step.protocol));
  const family = TRANSFER_FAMILY[step.chain.startsWith("solana:") ? "svm" : "evm"];
  const adapter = matches.length > 1 ? (matches.find((entry) => entry.id === family) ?? matches[0]) : matches[0];
  if (!adapter) {
    throw new PlatformError("PROTOCOL_UNSUPPORTED", `No execution adapter for protocol ${step.protocol}.`, 500);
  }
  return adapter;
}

export function isContractAdapter(adapter: ProtocolAdapter): adapter is ContractProtocolAdapter {
  const candidate = adapter as Partial<ContractProtocolAdapter>;
  return candidate.contract === true && typeof candidate.planCall === "function" && typeof candidate.prepareCall === "function";
}

/**
 * The adapter executing call (`custom-call`) or action (`solana-actions`)
 * steps: a configured adapter for the protocol when the embedder supplied
 * one, else the built-in one.
 */
export function adapterForProtocol(protocol: ProtocolId): ContractProtocolAdapter {
  const configured = activeAdapters.find((entry) => entry.protocols.includes(protocol) && isContractAdapter(entry));
  const adapter = configured ?? CONTRACT_ADAPTERS.find((entry) => entry.protocols.includes(protocol));
  if (!adapter || !isContractAdapter(adapter)) {
    throw new PlatformError("PROTOCOL_UNSUPPORTED", `No execution adapter for protocol ${protocol}.`, 500);
  }
  return adapter;
}
