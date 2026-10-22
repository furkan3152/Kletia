/**
 * Starter sentences of the desk: grouped by capability, each with the
 * networks it touches and the action kinds those networks must offer. The
 * empty desk ("Try one") and the starter menu show only what
 * `GET /v1/networks` says the deployment can do, and re-phrase the
 * sentences from the departure when one is chosen ("deposit 100 USDC into
 * aave on base"). Picking a starter fills the composer; nothing is sent.
 *
 * Every sentence is in the deterministic grammar (the API's GRAMMAR_EXAMPLES
 * and Studio's example groups); `<address>` is a placeholder the composer
 * selects for the user to replace.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  protocolsForNetwork,
  type IntentActionKind,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";

import type { Departure } from "../state/deskModel.ts";

export type StarterCapability = "swap" | "bridge" | "send" | "lend" | "stake" | "test";

export interface StarterRequirement {
  readonly network: NetworkKey;
  readonly action: IntentActionKind;
  /** A registry protocol the network must list (`protocolsForNetwork`). */
  readonly protocol?: ProtocolId;
}

export interface Starter {
  readonly id: string;
  readonly capability: StarterCapability;
  readonly sentence: string;
  /** Networks the plan touches, first action's network first. */
  readonly networks: readonly NetworkKey[];
  readonly requires: readonly StarterRequirement[];
  /** Shown on the empty desk ("Try one"). */
  readonly featured?: boolean;
}

export const STARTER_CAPABILITIES: readonly { readonly id: StarterCapability; readonly label: string }[] = Object.freeze([
  { id: "swap", label: "Swap" },
  { id: "bridge", label: "Bridge" },
  { id: "send", label: "Send" },
  { id: "lend", label: "Lend" },
  { id: "stake", label: "Stake" },
  { id: "test", label: "Test" },
]);

const need = (network: NetworkKey, action: IntentActionKind, protocol?: ProtocolId): StarterRequirement =>
  protocol ? { network, action, protocol } : { network, action };

export const STARTERS: readonly Starter[] = Object.freeze([
  // Bridge
  { id: "bridge-base-solana", capability: "bridge", sentence: "bridge 25 USDC from base to solana", networks: ["base", "solana"], requires: [need("base", "bridge")], featured: true },
  { id: "bridge-ethereum-base", capability: "bridge", sentence: "bridge 100 USDC from ethereum to base", networks: ["ethereum", "base"], requires: [need("ethereum", "bridge")] },
  { id: "bridge-then-swap", capability: "bridge", sentence: "bridge 50 USDC from base to solana then swap half to JitoSOL", networks: ["base", "solana"], requires: [need("base", "bridge"), need("solana", "swap")] },
  { id: "bridge-then-deposit", capability: "bridge", sentence: "bridge 20 USDC from solana to base and deposit it into aave", networks: ["solana", "base"], requires: [need("solana", "bridge"), need("base", "deposit", "aave-v3")] },
  // Swap
  { id: "swap-sol-usdc", capability: "swap", sentence: "swap 1 SOL to USDC", networks: ["solana"], requires: [need("solana", "swap")], featured: true },
  { id: "swap-eth-base", capability: "swap", sentence: "swap 0.01 ETH for USDC on base", networks: ["base"], requires: [need("base", "swap")] },
  { id: "buy-jitosol", capability: "swap", sentence: "buy JitoSOL with 2 SOL", networks: ["solana"], requires: [need("solana", "swap")] },
  { id: "move-eth-sol", capability: "swap", sentence: "move 0.01 ETH from arbitrum to solana as SOL", networks: ["arbitrum", "solana"], requires: [need("arbitrum", "bridge")] },
  // Lend
  { id: "lend-aave-arbitrum", capability: "lend", sentence: "deposit 100 USDC into aave on arbitrum", networks: ["arbitrum"], requires: [need("arbitrum", "deposit", "aave-v3")], featured: true },
  { id: "lend-morpho-base", capability: "lend", sentence: "deposit 100 USDC into morpho on base", networks: ["base"], requires: [need("base", "deposit", "morpho")] },
  { id: "lend-compound-optimism", capability: "lend", sentence: "deposit 100 USDC into compound on optimism", networks: ["optimism"], requires: [need("optimism", "deposit", "compound-v3")] },
  { id: "lend-jupiter", capability: "lend", sentence: "deposit 10 USDC into jupiter lend", networks: ["solana"], requires: [need("solana", "deposit", "jupiter-lend")] },
  { id: "withdraw-aave-base", capability: "lend", sentence: "withdraw all USDC from aave on base", networks: ["base"], requires: [need("base", "withdraw", "aave-v3")] },
  // Send
  { id: "send-ens-optimism", capability: "send", sentence: "send 5 USDC to vitalik.eth on optimism", networks: ["optimism"], requires: [need("optimism", "transfer")], featured: true },
  { id: "send-basename", capability: "send", sentence: "send 5 USDC to jesse.base.eth on base", networks: ["base"], requires: [need("base", "transfer")] },
  { id: "send-solana", capability: "send", sentence: "send 5 USDC to <address> on solana", networks: ["solana"], requires: [need("solana", "transfer")] },
  // Stake
  { id: "stake-marinade", capability: "stake", sentence: "stake 1.5 SOL with marinade", networks: ["solana"], requires: [need("solana", "stake", "marinade")], featured: true },
  { id: "swap-then-stake", capability: "stake", sentence: "swap 10 USDC to SOL on solana, then stake it with jito", networks: ["solana"], requires: [need("solana", "swap"), need("solana", "stake", "jito")] },
  { id: "stake-lido", capability: "stake", sentence: "stake 0.1 ETH with lido", networks: ["ethereum"], requires: [need("ethereum", "stake")] },
  // Test yard
  { id: "test-arc", capability: "test", sentence: "send 1 USDC to <address> on arc", networks: ["arc"], requires: [need("arc", "transfer")], featured: true },
  { id: "test-arbitrum-sepolia", capability: "test", sentence: "send 0.001 ETH to <address> on arbitrum sepolia", networks: ["arbitrum-sepolia"], requires: [need("arbitrum-sepolia", "transfer")] },
  { id: "test-solana-devnet", capability: "test", sentence: "send 0.1 SOL to <address> on solana devnet", networks: ["solana-devnet"], requires: [need("solana-devnet", "transfer")] },
] satisfies Starter[]);

/** Action kinds per network (`GET /v1/networks`), or null when unknown (nothing is filtered then). */
export type NetworkActions = Readonly<Partial<Record<NetworkKey, readonly string[]>>> | null;

/** `GET /v1/networks` as action kinds per network. */
export function actionsByNetwork(networks: readonly { readonly key: string; readonly actions: readonly string[] }[] | null | undefined): NetworkActions {
  if (!networks) return null;
  const actions: Partial<Record<NetworkKey, readonly string[]>> = {};
  for (const network of networks) {
    if ((NETWORK_KEYS as readonly string[]).includes(network.key)) actions[network.key as NetworkKey] = network.actions;
  }
  return actions;
}

function offers(requirement: StarterRequirement, actions: NetworkActions): boolean {
  if (requirement.protocol && !protocolsForNetwork(requirement.network).some((protocol) => protocol.id === requirement.protocol)) {
    return false;
  }
  if (actions === null) return true;
  return actions[requirement.network]?.includes(requirement.action) === true;
}

/** True when the deployment can plan the starter (every network offers what it needs). */
export function isStarterOffered(starter: Starter, actions: NetworkActions): boolean {
  return starter.requires.every((requirement) => offers(requirement, actions));
}

const isTestnet = (network: NetworkKey) => CHAINS[network].lane === "testnet";

/**
 * The capability's sentence re-phrased to start on `network`, when the
 * network can run it; null otherwise (the original starters stay).
 */
export function rephraseStarter(capability: StarterCapability, network: NetworkKey, actions: NetworkActions): Starter | null {
  const chain = CHAINS[network];
  const word = chain.key === "arbitrum-sepolia" ? "arbitrum sepolia" : chain.key === "solana-devnet" ? "solana devnet" : chain.key;
  const make = (sentence: string, networks: readonly NetworkKey[], requires: readonly StarterRequirement[]): Starter | null => {
    const starter: Starter = { id: `${capability}@${network}`, capability, sentence, networks, requires };
    return isStarterOffered(starter, actions) ? starter : null;
  };
  if (isTestnet(network)) {
    if (capability !== "test") return null;
    const asset = chain.namespace === "solana" ? "0.1 SOL" : chain.nativeAsset.symbol === "ETH" ? "0.001 ETH" : "1 USDC";
    return make(`send ${asset} to <address> on ${word}`, [network], [need(network, "transfer")]);
  }
  const evm = chain.namespace === "eip155";
  switch (capability) {
    case "lend":
      return evm
        ? make(`deposit 100 USDC into aave on ${word}`, [network], [need(network, "deposit", "aave-v3")])
        : make("deposit 10 USDC into jupiter lend", [network], [need(network, "deposit", "jupiter-lend")]);
    case "swap":
      return evm
        ? chain.nativeAsset.symbol === "ETH"
          ? make(`swap 0.01 ETH for USDC on ${word}`, [network], [need(network, "swap")])
          : null
        : make("swap 1 SOL to USDC", [network], [need(network, "swap")]);
    case "bridge":
      return network === "solana"
        ? make("bridge 25 USDC from solana to base", ["solana", "base"], [need("solana", "bridge")])
        : make(`bridge 25 USDC from ${word} to solana`, [network, "solana"], [need(network, "bridge")]);
    case "send":
      return evm
        ? make(`send 5 USDC to vitalik.eth on ${word}`, [network], [need(network, "transfer")])
        : make("send 5 USDC to <address> on solana", [network], [need(network, "transfer")]);
    case "stake":
      return network === "solana" ? make("stake 1.5 SOL with marinade", [network], [need(network, "stake", "marinade")]) : null;
    default:
      return null;
  }
}

/**
 * Starters for the empty desk or the starter menu. Auto shows the featured
 * set across lanes; a production departure re-phrases each capability's first
 * sentence from there (and leaves the test yard out); a testnet departure
 * shows the test yard only. Unoffered sentences are never shown.
 */
export function startersFor({
  departure = "auto",
  actions = null,
  capability = null,
  featuredOnly = false,
}: {
  readonly departure?: Departure;
  readonly actions?: NetworkActions;
  readonly capability?: StarterCapability | null;
  readonly featuredOnly?: boolean;
} = {}): readonly Starter[] {
  const yard = departure !== "auto" && isTestnet(departure);
  const pool = STARTERS.filter(
    (starter) =>
      (capability === null || starter.capability === capability) &&
      (!featuredOnly || starter.featured === true) &&
      (yard ? starter.capability === "test" : departure === "auto" || starter.capability !== "test") &&
      isStarterOffered(starter, actions),
  );
  if (departure === "auto") return pool;
  const capabilities = [...new Set(pool.map((starter) => starter.capability))];
  const rephrased = capabilities
    .map((entry) => rephraseStarter(entry, departure, actions))
    .filter((starter): starter is Starter => starter !== null);
  const covered = new Set(rephrased.map((starter) => starter.capability));
  const rest = pool.filter((starter) => !featuredOnly || !covered.has(starter.capability));
  const seen = new Set<string>();
  return [...rephrased, ...rest].filter((starter) => {
    if (seen.has(starter.sentence)) return false;
    seen.add(starter.sentence);
    return true;
  });
}

const ADDRESS_SLOT = /<address>/u;

/**
 * A starter sentence ready for the composer: `<address>` becomes the
 * connected wallet's own address on that namespace (a test-yard send to
 * yourself), or, without one, " to <address>" is dropped so Kletia asks who
 * receives it. A literal placeholder never reaches the composer.
 */
export function fillStarterAddress(
  sentence: string,
  wallets: { readonly evm: string | null; readonly solana: string | null },
): string {
  if (!ADDRESS_SLOT.test(sentence)) return sentence;
  const solana = /\bon solana(?: devnet)?\b/iu.test(sentence);
  const own = solana ? wallets.solana : wallets.evm;
  return own ? sentence.replace(ADDRESS_SLOT, own) : sentence.replace(/\s+to\s+<address>/u, "").replace(ADDRESS_SLOT, "").replace(/\s{2,}/gu, " ").trim();
}
