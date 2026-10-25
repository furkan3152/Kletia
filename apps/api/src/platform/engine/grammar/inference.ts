/**
 * Network inference and drafts to action specs.
 */
import {
  CHAINS,
  findAssetBySymbol,
  getProtocol,
  isEvmAddress,
  isSolanaAddress,
  parseAccountId,
  YIELD_VENUES,
  type IntentActionKind,
  type IntentActionSpec,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import {
  EVM_STAKING_NETWORK,
  EVM_STAKING_TOKENS,
  evmStakingToken,
  LIQUID_STAKING_TOKENS,
  NATIVE_STAKE_PROTOCOL,
  NATIVE_STAKE_PROVIDER,
} from "./venues.js";
import {
  clauseError,
  clauseMessage,
  type Draft,
  MissingSourceError,
  protocolName,
} from "./types.js";

export interface InferenceContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accountNetworks: readonly NetworkKey[];
}

/** Networks a swap may run on: Solana and the five EVM production networks (the planner checks live venues). */
export const SWAP_NETWORKS: readonly NetworkKey[] = Object.freeze(["solana", "base", "arbitrum", "ethereum", "optimism", "polygon"]);
const EVM_SWAP_NETWORKS: readonly NetworkKey[] = SWAP_NETWORKS.filter((network) => CHAINS[network].vm === "evm");
const EVM_DEFAULT_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum"];
/** EVM networks a transfer to an address or name may run on, in default order. */
export const EVM_TRANSFER_NETWORKS: readonly NetworkKey[] = Object.freeze(["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"]);

/** Networks with an executable venue of `protocol` for `kind`, in registry order. */
function lendingNetworks(protocol: ProtocolId | undefined, kind: IntentActionKind): NetworkKey[] {
  return [...new Set(YIELD_VENUES
    .filter((venue) => (!protocol || venue.protocol === protocol) && (venue.actions as readonly string[]).includes(kind))
    .map((venue) => venue.network))];
}

function knownOn(network: NetworkKey, token: string): boolean {
  const chain = CHAINS[network];
  if (token.includes(":")) return token.startsWith(`${chain.id}/`);
  if (isEvmAddress(token)) return chain.namespace === "eip155";
  if (isSolanaAddress(token)) return chain.namespace === "solana";
  if (token.toUpperCase() === chain.nativeAsset.symbol.toUpperCase()) return true;
  return findAssetBySymbol(network, token) !== null;
}

function preferred(candidates: readonly NetworkKey[], context: InferenceContext): NetworkKey | null {
  const order = [context.defaultNetwork, ...context.accountNetworks].filter((entry): entry is NetworkKey => entry !== undefined);
  for (const network of order) if (candidates.includes(network)) return network;
  return null;
}

function inferSwapNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const tokens = [draft.from ?? (draft.amount.type === "exact" && draft.amount.usd ? "USDC" : undefined), draft.to]
    .filter((token): token is string => token !== undefined);
  // A named venue keeps the swap on the networks it lists.
  const venueNetworks = draft.protocol ? getProtocol(draft.protocol)?.networks ?? [] : null;
  const networks = venueNetworks ? SWAP_NETWORKS.filter((network) => venueNetworks.includes(network)) : SWAP_NETWORKS;
  const candidates = networks.filter((network) => tokens.every((token) => knownOn(network, token)));
  if (candidates.length === 1) return candidates[0] as NetworkKey;
  if (candidates.length > 1) {
    const pick = preferred(candidates, context);
    if (pick) return pick;
    // Only EVM candidates and no hint: Base, as before more EVM networks swapped.
    if (candidates.every((network) => CHAINS[network].vm === "evm")) {
      const fallback = EVM_DEFAULT_NETWORKS.find((network) => candidates.includes(network));
      if (fallback) return fallback;
    }
    throw clauseError(draft.clause, `Say which network to use, e.g. "${draft.clause} on ${candidates[0]}".`);
  }
  // A token unknown to every EVM registry but plausible on Solana is resolved through Jupiter.
  const solanaVenue = !venueNetworks || venueNetworks.includes("solana");
  const evmKnown = tokens.some((token) => EVM_SWAP_NETWORKS.some((network) => knownOn(network, token)) && !knownOn("solana", token));
  if (solanaVenue && !evmKnown && tokens.every((token) => !isEvmAddress(token))) return "solana";
  if (draft.protocol && venueNetworks) {
    throw clauseError(draft.clause, `${protocolName(draft.protocol)} swaps run on ${venueNetworks.map((network) => CHAINS[network].name).join(", ")}; ${tokens.join(" and ")} are not listed there together.`);
  }
  throw clauseError(draft.clause, `Cannot find one network that lists ${tokens.join(" and ")}. Add "on <network>".`);
}

/** The Solana cluster of the caller: Solana Devnet when the default or every Solana account is on devnet, else Solana. */
function solanaCluster(context: InferenceContext): NetworkKey {
  if (context.defaultNetwork === "solana" || context.defaultNetwork === "solana-devnet") return context.defaultNetwork;
  const solanaAccounts = context.accountNetworks.filter((network) => CHAINS[network].namespace === "solana");
  return solanaAccounts.length > 0 && solanaAccounts.every((network) => network === "solana-devnet") ? "solana-devnet" : "solana";
}

function inferTransferNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const recipient = draft.recipient ?? "";
  if (recipient.includes(":")) {
    const parsed = parseAccountId(recipient);
    if (!parsed) throw clauseError(draft.clause, "The recipient is not a valid CAIP-10 account.");
    return parsed.chain.key;
  }
  // Basenames live on Base; other ENS names follow the caller's EVM network.
  if (/\.base\.eth$/iu.test(recipient)) return "base";
  if (isEvmAddress(recipient) || /\.eth$/iu.test(recipient)) {
    const pick = preferred(EVM_TRANSFER_NETWORKS, context);
    return pick ?? "base";
  }
  if (isSolanaAddress(recipient) || /\.(?:sns|sol)$/iu.test(recipient)) return solanaCluster(context);
  throw clauseError(draft.clause, "The recipient is not a valid EVM or Solana address.");
}

/** A source to show in the "say where the funds come from" hint: never the destination itself. */
function sourceHint(destination: NetworkKey, context: InferenceContext): NetworkKey {
  const lane = CHAINS[destination].environment;
  const order = [context.defaultNetwork, ...context.accountNetworks, "base", "solana", "arbitrum", ...(Object.keys(CHAINS) as NetworkKey[])]
    .filter((entry): entry is NetworkKey => entry !== undefined);
  return order.find((network) => network !== destination && CHAINS[network].environment === lane) ?? "base";
}

export function inferNetwork(draft: Draft, previousDestination: NetworkKey | undefined, context: InferenceContext): NetworkKey {
  if (draft.network) return draft.network;
  switch (draft.kind) {
    case "transfer": {
      const byAddress = inferTransferNetwork(draft, context);
      if (previousDestination && CHAINS[previousDestination].namespace === CHAINS[byAddress].namespace && !draft.recipient?.includes(":")) {
        return previousDestination;
      }
      return byAddress;
    }
    case "stake":
      // EVM liquid staking runs on Ethereum; SOL staking on Solana (Solana Devnet for a caller on the testnet lane).
      return previousDestination ?? (draft.protocol && !draft.native ? EVM_STAKING_NETWORK : solanaCluster(context));
    case "deposit":
    case "withdraw": {
      if (previousDestination) return previousDestination;
      const networks = lendingNetworks(draft.protocol, draft.kind);
      return preferred(networks, context) ?? networks[0] ?? preferred(EVM_DEFAULT_NETWORKS, context) ?? "base";
    }
    case "bridge": {
      if (previousDestination) return previousDestination;
      if (context.defaultNetwork && context.defaultNetwork !== draft.toNetwork) return context.defaultNetwork;
      const destination = draft.toNetwork ?? "solana";
      const message = `Say where the funds come from, e.g. "from ${sourceHint(destination, context)} to ${destination}".`;
      throw new MissingSourceError(clauseMessage(draft.clause, message), [{ path: "text", message }], {
        asset: draft.from ?? (draft.amount.type === "exact" && draft.amount.usd ? "USDC" : null),
        amount: draft.amount.type === "exact" ? draft.amount.value : null,
        toNetwork: destination,
      });
    }
    default:
      return previousDestination ?? inferSwapNetwork(draft, context);
  }
}

/**
 * "ETH" on an EVM network whose gas token is not ether (Polygon PoS: POL) and
 * that lists no ETH token: ether there is WETH. Read so, with a one-line note;
 * never POL. Only for swaps, deposits and withdrawals (a send keeps the
 * symbol it was given and is refused if unknown).
 */
function etherAlias(network: NetworkKey, symbol: string | undefined, kind: IntentActionKind): string | null {
  if (!symbol || symbol.toUpperCase() !== "ETH" || !["swap", "deposit", "withdraw"].includes(kind)) return null;
  const chain = CHAINS[network];
  if (chain.vm !== "evm" || chain.nativeAsset.symbol.toUpperCase() === "ETH" || findAssetBySymbol(network, "ETH")) return null;
  return findAssetBySymbol(network, "WETH")?.symbol ?? null;
}

function etherNote(network: NetworkKey, weth: string): string {
  return `On ${CHAINS[network].name}, "ETH" was read as ${weth} (bridged ether); ${CHAINS[network].nativeAsset.symbol} is the network's own gas token.`;
}

export function toActionSpec(draft: Draft, network: NetworkKey, index: number, warnings: string[] = []): IntentActionSpec {
  const amount = draft.amount;
  if (draft.kind === "withdraw") {
    if (amount.type === "previous" && !amount.whole) {
      throw clauseError(draft.clause, "Withdraw an exact amount or \"all\" (the whole position).");
    }
    if (!draft.from) throw clauseError(draft.clause, "Say which asset to withdraw, e.g. \"withdraw 50 USDC from aave\".");
    if (amount.type === "exact" && amount.usd && !["USDC", "USDT", "PYUSD", "DAI"].includes(draft.from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be withdrawn in a USD stablecoin.");
    }
  } else if (amount.type === "previous" && index === 0) {
    throw clauseError(draft.clause, "\"all\", \"half\", \"it\" and percentages refer to a previous step; give an explicit amount.");
  }
  let from = draft.from;
  if (amount.type === "exact" && amount.usd) {
    if (from && !["USDC", "USDT", "PYUSD", "DAI"].includes(from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be paid in a USD stablecoin.");
    }
    from = from ?? "USDC";
  }
  const fromAlias = etherAlias(network, from, draft.kind);
  if (fromAlias) {
    from = fromAlias;
    warnings.push(etherNote(network, fromAlias));
  }
  const params: Record<string, string | number | boolean> = {};
  if (amount.type === "previous" && amount.portionBps !== 10_000) params.portionBps = amount.portionBps;
  if (draft.venue) params.venue = draft.venue;
  if (draft.provider) params.provider = draft.provider;
  let to = draft.to;
  const toAlias = etherAlias(network, to, draft.kind);
  if (toAlias) {
    to = toAlias;
    warnings.push(etherNote(network, toAlias));
  }
  let protocol = draft.protocol;
  // Solana Devnet has no liquid staking pool: a stake there without a provider word is native staking.
  const native = draft.native ?? (draft.kind === "stake" && !draft.protocol && !draft.lst && network === "solana-devnet" ? {} : undefined);
  if (native) {
    if (CHAINS[network].namespace !== "solana") {
      throw clauseError(draft.clause, `Native staking stakes SOL on Solana or Solana Devnet, not on ${CHAINS[network].name}.`);
    }
    if (draft.from && draft.from.toUpperCase() !== "SOL") throw clauseError(draft.clause, `Native staking stakes SOL, not ${draft.from}.`);
    to = CHAINS[network].nativeAsset.symbol;
    protocol = NATIVE_STAKE_PROTOCOL;
    params.provider = native.vote ?? NATIVE_STAKE_PROVIDER;
  } else if (draft.kind === "stake") {
    const evm = draft.protocol ? evmStakingToken(draft.lst) ?? EVM_STAKING_TOKENS.lido : undefined;
    const target = evm ?? LIQUID_STAKING_TOKENS[draft.lst ?? "jito"] ?? LIQUID_STAKING_TOKENS.jito;
    to = target?.symbol ?? "JitoSOL";
    params.provider = target?.provider ?? "Jito";
  }
  if (draft.kind === "transfer" && !draft.recipient) throw clauseError(draft.clause, "A recipient address is required.");
  if (draft.kind === "bridge" && !draft.toNetwork) throw clauseError(draft.clause, "A destination network is required.");
  if (draft.kind === "bridge" && draft.toNetwork === network) {
    throw clauseError(draft.clause, "The source and destination networks are the same; use swap or send instead.");
  }
  return {
    kind: draft.kind,
    network,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    amount: amount.type === "exact" ? amount.value : "max",
    ...(draft.toNetwork ? { toNetwork: draft.toNetwork } : {}),
    ...(draft.recipient ? { recipient: draft.recipient } : {}),
    ...(protocol ? { protocol } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}
