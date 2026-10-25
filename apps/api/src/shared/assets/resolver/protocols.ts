/**
 * Protocol policy and protocol resolution.
 */
import { normalizeBaseProtocolId } from "../../../networks/base/protocols.js";
import type { NetworkId } from "../../config/networks.js";
import { foldAssetReference } from "../catalog.js";
import {
  EntityResolutionError,
  type IntentEntityResolutionEvidence,
} from "./types.js";
import {
  BASE_BRIDGE_PROTOCOLS,
  BASE_LENDING_PROTOCOLS,
  BASE_STAKING_PROTOCOLS,
  BASE_SWAP_PROTOCOLS,
} from "./policy.js";

function protocolPolicy(action: string): ReadonlySet<string> | null {
  if (["swap", "add_liquidity", "remove_liquidity"].includes(action)) {
    return BASE_SWAP_PROTOCOLS;
  }
  if (
    ["lend", "borrow", "repay", "withdraw", "yield_compare"].includes(action)
  ) {
    return BASE_LENDING_PROTOCOLS;
  }
  if (action === "stake") return BASE_STAKING_PROTOCOLS;
  if (action === "bridge") return BASE_BRIDGE_PROTOCOLS;
  return null;
}

export function resolveProtocol(
  network: NetworkId,
  action: string,
  protocol: string | undefined,
): IntentEntityResolutionEvidence["protocol"] | undefined {
  if (!protocol || protocol.trim().toLowerCase() === "unknown")
    return undefined;
  if (network === "arc") {
    const folded = foldAssetReference(protocol);
    const appKitAction = [
      "stable_swap",
      "appkit_send",
      "appkit_bridge",
    ].includes(action);
    const accepted = appKitAction
      ? new Set(["circleappkit", "appkit", "circle"])
      : new Set(["kletia", "arc", "kletiaarc"]);
    if (!accepted.has(folded)) {
      throw new EntityResolutionError(
        "PROTOCOL_ACTION_UNSUPPORTED",
        `${protocol} protocol does not match Arc ${action} execution pipeline.`,
      );
    }
    return {
      original: protocol,
      canonical: appKitAction ? "circle-app-kit" : "kletia-arc",
      matchedBy: "curated_alias",
    };
  }

  if (network === "arbitrum") {
    const folded = foldAssetReference(protocol);
    const canonical =
      ["uniswap", "uniswapv3", "univ3"].includes(folded) && action === "swap"
        ? "uniswap-v3"
        : ["aave", "aavev3"].includes(folded) &&
            ["lend", "withdraw", "borrow", "borrow_capacity", "repay", "yield_compare"].includes(action)
          ? "aave-v3"
          : ["across", "acrossv3"].includes(folded) && action === "bridge"
            ? "across"
            : null;
    if (!canonical) {
      throw new EntityResolutionError(
        "PROTOCOL_ACTION_UNSUPPORTED",
        `${protocol} is not a verified protocol for the Arbitrum ${action} beta route.`,
      );
    }
    return {
      original: protocol,
      canonical,
      matchedBy: foldAssetReference(protocol) === foldAssetReference(canonical)
        ? "canonical_id"
        : "curated_alias",
    };
  }

  const canonical = normalizeBaseProtocolId(protocol);
  const policy = protocolPolicy(action);
  if (!policy || !canonical || !policy.has(canonical)) {
    throw new EntityResolutionError(
      "PROTOCOL_ACTION_UNSUPPORTED",
      `${protocol} protocol recognized but no verified execution record in Base ${action} feature.`,
    );
  }
  return {
    original: protocol,
    canonical,
    matchedBy:
      foldAssetReference(protocol) === foldAssetReference(canonical)
        ? "canonical_id"
        : "curated_alias",
  };
}
