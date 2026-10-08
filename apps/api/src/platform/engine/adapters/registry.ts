import type { IntentConstraints, IntentStep, ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "./aaveV3.js";
import { evmTransferAdapter } from "./evmTransfer.js";
import { jupiterAdapter } from "./jupiter.js";
import { relayAdapter } from "./relay.js";
import { solanaTransferAdapter } from "./solanaTransfer.js";
import type { AdapterRoute, ProtocolAdapter } from "./types.js";

/** Default preference order when several adapters can serve a route. */
export const ADAPTERS: readonly ProtocolAdapter[] = Object.freeze([
  jupiterAdapter,
  solanaTransferAdapter,
  evmTransferAdapter,
  relayAdapter,
  aaveV3Adapter,
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
  const matches = activeAdapters.filter((entry) => entry.protocols.includes(step.protocol));
  const family = TRANSFER_FAMILY[step.chain.startsWith("solana:") ? "svm" : "evm"];
  const adapter = matches.length > 1 ? (matches.find((entry) => entry.id === family) ?? matches[0]) : matches[0];
  if (!adapter) {
    throw new PlatformError("PROTOCOL_UNSUPPORTED", `No execution adapter for protocol ${step.protocol}.`, 500);
  }
  return adapter;
}
