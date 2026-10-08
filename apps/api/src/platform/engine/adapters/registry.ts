import type { IntentConstraints, IntentStep, ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "./aave-v3.js";
import { evmTransferAdapter } from "./evm-transfer.js";
import { jupiterAdapter } from "./jupiter.js";
import { relayAdapter } from "./relay.js";
import { solanaTransferAdapter } from "./solana-transfer.js";
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
  const candidates = ADAPTERS.filter(
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

/** The adapter that executes a planned step (by protocol and VM). */
export function adapterForStep(step: Pick<IntentStep, "protocol" | "chain">): ProtocolAdapter {
  const isSolana = step.chain.startsWith("solana:");
  const adapter = step.protocol === "system-transfer"
    ? (isSolana ? solanaTransferAdapter : evmTransferAdapter)
    : ADAPTERS.find((entry) => entry.protocols.includes(step.protocol));
  if (!adapter) {
    throw new PlatformError("PROTOCOL_UNSUPPORTED", `No execution adapter for protocol ${step.protocol}.`, 500);
  }
  return adapter;
}
