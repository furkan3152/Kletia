/**
 * Contract and program labels for wallet history, built once from Kletia's
 * own registries (no address is typed here except the Polymarket exchanges
 * below): VENUE_CONTRACTS, the yield venues' call targets and receipt
 * tokens, the perps deployments, the native order programs and contracts,
 * Jupiter's program and the Jupiter DEX families.
 *
 * Each label carries a `family` the classifier reads (classify.ts).
 */
import {
  CHAINS,
  DRIFT_V2_SOLANA,
  getProtocol,
  GMX_V2_ARBITRUM,
  HYPERLIQUID_MAINNET,
  JUPITER_DEX_FAMILIES,
  NETWORK_KEYS,
  venueByLabel,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  type DataTxProtocol,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { SOLANA_PROGRAM_IDS } from "../engine/chains/solana.js";
import { GPV2_SETTLEMENT, GPV2_VAULT_RELAYER } from "../orders/cowProtocol.js";
import { JUPITER_RECURRING_PROGRAM, JUPITER_TRIGGER_PROGRAM } from "../orders/jupiter.js";
import { ORDER_NETWORKS } from "../orders/types.js";

export type LabelFamily = "bridge" | "dex" | "lending" | "staking" | "perp" | "order" | "prediction" | "token" | "other";

export interface ContractLabel extends DataTxProtocol {
  readonly family: LabelFamily;
}

/**
 * Polymarket's exchanges on Polygon (docs.polymarket.com, "Contract addresses"), read back on
 * 2026-10-24: getCollateral() = USDC.e 0x2791…4174 on both, getCtf() = ConditionalTokens 0x4D97…6045
 * (CTF Exchange) and the NegRiskAdapter 0xd91E…5296 (Neg Risk CTF Exchange). Not a Kletia protocol:
 * labelled for history only.
 */
const POLYMARKET: readonly { readonly address: string; readonly role: string }[] = [
  { address: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", role: "ctf-exchange" },
  { address: "0xC5d563A36AE78145C45a50134d48A1215220f80a", role: "neg-risk-ctf-exchange" },
  { address: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", role: "conditional-tokens" },
  { address: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296", role: "neg-risk-adapter" },
];

/** Registry roles that are tokens: a transfer of them is not a call to the protocol. */
const TOKEN_ROLES: ReadonlySet<string> = new Set(["lst-token", "underlying-token", "pool-mint", "liquidity-leg", "receipt"]);

function familyOf(protocol: ProtocolId): LabelFamily {
  const descriptor = getProtocol(protocol);
  if (!descriptor) return "other";
  if (descriptor.execution === "orders") return "order";
  if (protocol === "wrap") return "dex";
  switch (descriptor.category) {
    case "bridge":
    case "intent-network":
      return "bridge";
    case "dex":
    case "dex-aggregator":
      return "dex";
    case "lending":
    case "yield":
      return "lending";
    case "liquid-staking":
      return "staking";
    case "perps":
      return "perp";
    default:
      return "other";
  }
}

const keyOf = (network: NetworkKey, address: string) => `${network}:${CHAINS[network].vm === "evm" ? address.toLowerCase() : address}`;

function build(): Map<string, ContractLabel> {
  const labels = new Map<string, ContractLabel>();
  const put = (network: NetworkKey, address: string, label: ContractLabel) => {
    const key = keyOf(network, address);
    if (!labels.has(key)) labels.set(key, label);
  };
  const named = (protocol: ProtocolId, role: string, label?: string): ContractLabel => {
    const family = TOKEN_ROLES.has(role) && familyOf(protocol) !== "staking" ? "token" : familyOf(protocol);
    return { id: protocol, label: label ?? getProtocol(protocol)?.name ?? protocol, role, family };
  };
  // deBridge pins other protocols' routers it may call (KyberSwap) and a surplus address: those never name the contract.
  for (const entry of VENUE_CONTRACTS) {
    if (entry.role === "dln-swap-router" || entry.role === "dln-surplus-recipient") continue;
    put(entry.network, entry.address, named(entry.protocol, entry.role, entry.label));
  }
  for (const venue of YIELD_VENUES) {
    put(venue.network, venue.target, named(venue.protocol, "venue", getProtocol(venue.protocol)?.name));
    if ("receipt" in venue && venue.receipt) put(venue.network, venue.receipt.address, named(venue.protocol, "receipt", getProtocol(venue.protocol)?.name));
  }
  for (const [role, address] of [["exchange-router", GMX_V2_ARBITRUM.exchangeRouter], ["router", GMX_V2_ARBITRUM.router], ["order-vault", GMX_V2_ARBITRUM.orderVault]] as const) {
    put("arbitrum", address, named("gmx-v2", role));
  }
  put("arbitrum", HYPERLIQUID_MAINNET.bridge, named("hyperliquid", "bridge"));
  put("solana", DRIFT_V2_SOLANA.program, named("drift-v2", "program"));
  for (const network of ORDER_NETWORKS) {
    if (CHAINS[network].vm !== "evm") continue;
    put(network, GPV2_SETTLEMENT, named("cow-protocol", "settlement"));
    put(network, GPV2_VAULT_RELAYER, named("cow-protocol", "vault-relayer"));
  }
  put("solana", JUPITER_TRIGGER_PROGRAM, named("jupiter-trigger", "program"));
  put("solana", JUPITER_RECURRING_PROGRAM, named("jupiter-recurring", "program"));
  put("solana", SOLANA_PROGRAM_IDS.jupiterV6, named("jupiter", "program", "Jupiter"));
  for (const family of Object.values(JUPITER_DEX_FAMILIES)) {
    for (const dex of family) {
      const protocol = venueByLabel(dex.label)?.protocol ?? null;
      put("solana", dex.program, { id: protocol, label: dex.label, role: "program", family: "dex" });
    }
  }
  for (const entry of POLYMARKET) put("polygon", entry.address, { id: null, label: "Polymarket", role: entry.role, family: "prediction" });
  return labels;
}

let table: Map<string, ContractLabel> | null = null;

/** The label of a contract or program on `network`, or null. */
export function contractLabel(network: NetworkKey, address: string | null | undefined): ContractLabel | null {
  if (!address || !NETWORK_KEYS.includes(network)) return null;
  table ??= build();
  return table.get(keyOf(network, address)) ?? null;
}
