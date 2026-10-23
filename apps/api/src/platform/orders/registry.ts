/** The native order providers and the order-id format `<protocol>:<network>:<native id>`. */
import { PlatformError } from "../errors.js";
import { cowProvider } from "./cow.js";
import { jupiterRecurringProvider, jupiterTriggerProvider } from "./jupiter.js";
import { ORDER_NETWORKS, type NativeOrderProtocol, type NativeOrderProvider, type NativeOrderRef, type OrderNetwork } from "./types.js";

let providers: readonly NativeOrderProvider[] = Object.freeze([jupiterTriggerProvider, jupiterRecurringProvider, cowProvider]);

export function nativeOrderProviders(): readonly NativeOrderProvider[] {
  return providers;
}

/** Replaces the providers (tests); null restores the defaults. */
export function configureNativeOrderProviders(next: readonly NativeOrderProvider[] | null): void {
  providers = Object.freeze([...(next ?? [jupiterTriggerProvider, jupiterRecurringProvider, cowProvider])]);
}

export function providerFor(protocol: NativeOrderProtocol): NativeOrderProvider {
  const provider = providers.find((entry) => entry.protocol === protocol);
  if (!provider) throw new PlatformError("ORDER_UNSUPPORTED", `${protocol} orders are not available on this deployment.`, 422, undefined, undefined, { reason: "protocol" });
  return provider;
}

const ID_PATTERN = /^(jupiter-trigger|jupiter-recurring|cow-protocol):(solana|ethereum|arbitrum|base):([A-Za-z0-9-]{32,140})$/u;

export function formatOrderId(ref: NativeOrderRef): string {
  return `${ref.protocol}:${ref.network}:${ref.nativeId}`;
}

/** Parses an order id; ORDER_INVALID when malformed or the protocol does not run on the network. */
export function parseOrderId(id: string): NativeOrderRef {
  const match = ID_PATTERN.exec(id);
  const protocol = match?.[1] as NativeOrderProtocol | undefined;
  const network = match?.[2] as OrderNetwork | undefined;
  if (!match || !protocol || !network || !ORDER_NETWORKS.includes(network) || !providerFor(protocol).networks.includes(network)) {
    throw new PlatformError("ORDER_INVALID", "An order id is <protocol>:<network>:<native id>, e.g. cow-protocol:base:0x… or jupiter-trigger:solana:<order account>.", 400, [
      { path: "id", message: "Malformed order id." },
    ]);
  }
  return { protocol, network, nativeId: match[3] as string };
}
