import { protocolDependencies, type IntentConstraints, type IntentStep, type ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "./aaveV3.js";
import { acrossAdapter } from "./across.js";
import { cctpV2Adapter } from "./cctpV2.js";
import { contractCallAdapter } from "./contractCall.js";
import { debridgeDlnAdapter } from "./debridge.js";
import { aerodromeAdapter, velodromeAdapter } from "./dex/aerodrome.js";
import { camelotAdapter } from "./dex/camelot.js";
import { curveAdapter } from "./dex/curve.js";
import { pancakeswapV3Adapter } from "./dex/pancakeswap.js";
import { uniswapV3Adapter } from "./dex/uniswapV3.js";
import { evmTransferAdapter } from "./evmTransfer.js";
import { jupiterAdapter } from "./jupiter.js";
import { jupiterLendAdapter } from "./jupiterLend.js";
import { kaminoAdapter } from "./kamino.js";
import { compoundV3Adapter } from "./lending/compoundV3.js";
import { erc4626Adapter } from "./lending/erc4626.js";
import { fluidAdapter } from "./lending/fluid.js";
import { moonwellAdapter } from "./lending/moonwell.js";
import { sparkSavingsAdapter } from "./lending/sparkSavings.js";
import { sparklendAdapter } from "./lending/sparklend.js";
import { yearnAdapter } from "./lending/yearn.js";
import { lifiAdapter } from "./lifi.js";
import { marinadeAdapter } from "./marinade.js";
import { relayAdapter } from "./relay.js";
import { solanaActionAdapter } from "./solanaAction.js";
import { meteoraAdapter, orcaAdapter, raydiumAdapter } from "./solanaDex.js";
import { solanaNativeStakeAdapter } from "./solanaNativeStake.js";
import { jitoStakePoolAdapter, sanctumStakePoolAdapter } from "./solanaStakePool.js";
import { solanaTransferAdapter } from "./solanaTransfer.js";
import { etherfiAdapter } from "./staking/etherfi.js";
import { fraxAdapter } from "./staking/frax.js";
import { lidoAdapter } from "./staking/lido.js";
import { mantleAdapter } from "./staking/mantle.js";
import { rocketPoolAdapter } from "./staking/rocketPool.js";
import { staderAdapter } from "./staking/stader.js";
import type { AdapterRoute, ContractProtocolAdapter, ProtocolAdapter } from "./types.js";
import { wrapAdapter } from "./wrap.js";

/**
 * Adapters of integrator-registered contracts (call / action steps). Route
 * search never selects them (`supports` is false); the planner picks them by
 * protocol. They stay available when embedders configure their own adapter
 * set, unless that set brings its own adapter for the protocol.
 */
export const CONTRACT_ADAPTERS: readonly ContractProtocolAdapter[] = Object.freeze([contractCallAdapter, solanaActionAdapter]);

/**
 * Default preference order when several adapters can serve a route (newer
 * venues appended within their family). Venues not wired yet are `null`
 * placeholders and are skipped, so wiring a venue never reorders the list.
 */
export const ADAPTERS: readonly ProtocolAdapter[] = Object.freeze(
  [
    jupiterAdapter,
    raydiumAdapter,
    orcaAdapter,
    meteoraAdapter,
    // direct Solana staking (competes with the Jupiter route for the same LST)
    jitoStakePoolAdapter,
    sanctumStakePoolAdapter,
    marinadeAdapter,
    solanaNativeStakeAdapter,
    solanaTransferAdapter,
    evmTransferAdapter,
    // 1:1 wrap of the gas asset: serves ETH <-> WETH and POL <-> WPOL alone, never auctioned
    wrapAdapter,
    uniswapV3Adapter,
    aerodromeAdapter,
    velodromeAdapter,
    // EVM DEXs encoded by Kletia
    pancakeswapV3Adapter,
    camelotAdapter,
    curveAdapter,
    relayAdapter,
    acrossAdapter,
    cctpV2Adapter,
    lifiAdapter,
    debridgeDlnAdapter,
    aaveV3Adapter,
    sparklendAdapter,
    compoundV3Adapter,
    erc4626Adapter,
    sparkSavingsAdapter,
    fluidAdapter,
    yearnAdapter,
    moonwellAdapter,
    jupiterLendAdapter,
    kaminoAdapter,
    lidoAdapter,
    rocketPoolAdapter,
    etherfiAdapter,
    // more EVM liquid staking
    staderAdapter,
    mantleAdapter,
    fraxAdapter,
    ...CONTRACT_ADAPTERS,
  ].filter((adapter): adapter is ProtocolAdapter => adapter !== null),
);

export const EXECUTABLE_PROTOCOLS: readonly ProtocolId[] = Object.freeze(
  [...new Set(ADAPTERS.flatMap((adapter) => adapter.protocols))],
);

/**
 * Adapters the engine plans and executes with. Defaults to ADAPTERS; tests and
 * embedders may substitute their own set (e.g. stubbed venues) through
 * `configureAdapters`.
 */
let activeAdapters: readonly ProtocolAdapter[] = ADAPTERS;
/** Bumped by every `configureAdapters`, so derived structures (the solver's capability graph) rebuild. */
let generation = 0;

export function configureAdapters(adapters: readonly ProtocolAdapter[] | null): void {
  if (adapters !== null && adapters.length === 0) {
    throw new PlatformError("ADAPTERS_INVALID", "At least one protocol adapter is required.", 500);
  }
  activeAdapters = adapters === null ? ADAPTERS : Object.freeze([...adapters]);
  generation += 1;
}

/** Identity of the active adapter set: changes whenever `configureAdapters` runs. */
export function adapterGeneration(): number {
  return generation;
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

/**
 * Adapters able to serve a route, ordered by constraints and preference:
 * - an avoided protocol drops its adapter, and so does an avoided protocol it
 *   is routed through (`protocolDependencies`: avoiding jupiter drops raydium);
 * - a named-only adapter (`explicitOnly`) is kept only when `requested` or
 *   `preferProtocols` names its protocol.
 */
export function candidateAdapters(
  route: AdapterRoute,
  constraints: IntentConstraints | undefined,
  requested?: ProtocolId,
): ProtocolAdapter[] {
  const avoid = new Set(constraints?.avoidProtocols ?? []);
  const prefer = constraints?.preferProtocols ?? [];
  const candidates = activeAdapters.filter((adapter) => {
    if (!adapter.supports(route)) return false;
    const protocol = effectiveProtocol(adapter, route);
    if (protocolDependencies(protocol).some((dependency) => avoid.has(dependency))) return false;
    return !adapter.explicitOnly || requested === protocol || prefer.includes(protocol);
  });
  const rank = (adapter: ProtocolAdapter) => {
    const index = prefer.indexOf(effectiveProtocol(adapter, route));
    return index === -1 ? prefer.length : index;
  };
  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
  if (requested) return ordered.filter((adapter) => effectiveProtocol(adapter, route) === requested);
  return ordered;
}

/**
 * Why a named protocol cannot serve: the protocol it is routed through is
 * avoided (refusal text for the planner), or null when nothing it depends on
 * is avoided.
 */
export function avoidedDependency(protocol: ProtocolId, constraints: IntentConstraints | undefined): ProtocolId | null {
  const avoid = new Set(constraints?.avoidProtocols ?? []);
  return protocolDependencies(protocol).slice(1).find((dependency) => avoid.has(dependency)) ?? null;
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
