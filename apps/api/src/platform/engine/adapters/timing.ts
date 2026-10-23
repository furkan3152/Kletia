/**
 * One time basis for every cross-network venue: a leg's `estimatedSeconds` is
 * the provider's fill estimate plus the source network's confirmation time,
 * nothing else. Wallet signing time is priced separately (lambdaS per signature
 * in routing/score.ts), so no adapter adds a signing margin of its own (ad-hoc
 * 15 s margins on Relay, LI.FI, Across and deBridge DLN used to skew their
 * comparison with CCTP).
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

/** Seconds until a source transaction is safe to act on (Ethereum 15 s, L2 4 s, Solana 2 s). */
const CONFIRMATION_SECONDS: Readonly<Partial<Record<NetworkKey, number>>> = Object.freeze({
  ethereum: 15,
  base: 4,
  optimism: 4,
  arbitrum: 4,
  polygon: 5,
  solana: 2,
  arc: 2,
  "arbitrum-sepolia": 4,
  "solana-devnet": 2,
});

export function sourceConfirmationSeconds(network: NetworkKey): number {
  return CONFIRMATION_SECONDS[network] ?? (CHAINS[network].vm === "svm" ? 2 : 15);
}

/** `estimatedSeconds` of a cross-network leg: the provider's fill estimate plus the source confirmation. */
export function crossNetworkSeconds(network: NetworkKey, fillSeconds: number): number {
  const fill = Number.isFinite(fillSeconds) && fillSeconds > 0 ? Math.ceil(fillSeconds) : 0;
  return fill + sourceConfirmationSeconds(network);
}
