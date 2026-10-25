/**
 * Venue and staking vocabularies: lending, bridge and swap venues,
 * liquid-staking tokens, EVM and native staking.
 */
import {
  ASSETS,
  capabilityIndex,
  CHAINS,
  findAssetByAddress,
  findAssetBySymbol,
  getProtocol,
  PROTOCOLS,
  venueContracts,
  YIELD_VENUES,
  type NetworkKey,
  type ProtocolDescriptor,
  type ProtocolId,
} from "@kletia/core";

/** A venue word pattern and the protocol it names. */
export interface VenueWord {
  readonly pattern: RegExp;
  readonly protocol: ProtocolId;
}

/* -------------------------------------------- venue words from the registry */

/**
 * Venue words of registry protocols the hand-written lists below do not
 * cover yet: generated from descriptor `words`, so a new venue needs no
 * grammar edit. The hand-written patterns stay as they are (no behaviour
 * change for existing venues); a generated word only adds a reading, and a
 * protocol without a live adapter is refused by the planner as before.
 */
function escapeWord(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Regex alternation of words (longest first, spaces and hyphens interchangeable). */
export function wordAlternation(words: readonly string[]): string {
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((word) => word.trim().toLowerCase().split(/[\s-]+/u).map(escapeWord).join("[\\s-]+"))
    .join("|");
}

function generatedVenueWords(covered: readonly ProtocolId[], select: (protocol: ProtocolDescriptor) => boolean): VenueWord[] {
  return PROTOCOLS
    .filter((protocol) => !covered.includes(protocol.id) && (protocol.words ?? []).length > 0 && select(protocol))
    .map((protocol) => ({ pattern: new RegExp(`^(?:${wordAlternation(protocol.words ?? [])})$`, "iu"), protocol: protocol.id }));
}

/** The hand-written lending and savings protocols; later ones read their registry words. */
const HAND_WRITTEN_LENDING: readonly ProtocolId[] = [
  "aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino", "sparklend", "spark-savings", "fluid", "yearn-v3",
];
/** Registry lending and savings protocols with words and no hand-written pattern (Save, Sky, Ethena). */
const GENERATED_LENDING: readonly ProtocolDescriptor[] = PROTOCOLS.filter((protocol) =>
  (protocol.category === "lending" || protocol.category === "yield") && (protocol.kinds ?? []).includes("deposit") &&
  (protocol.words ?? []).length > 0 && !HAND_WRITTEN_LENDING.includes(protocol.id));

/** Lending and savings venue words -> protocol (bare "spark" is Spark Savings, with a warning naming SparkLend). */
export const LENDING_VENUES: readonly VenueWord[] = Object.freeze([
  { pattern: /^aave(?:[\s-]*v3)?$/iu, protocol: "aave-v3" },
  { pattern: /^(?:compound(?:[\s-]*v3)?|comet)$/iu, protocol: "compound-v3" },
  { pattern: /^morpho(?:[\s-]+vaults?)?$/iu, protocol: "morpho" },
  { pattern: /^moonwell$/iu, protocol: "moonwell" },
  { pattern: /^(?:jupiter|jup)[\s-]+(?:lend|earn)$/iu, protocol: "jupiter-lend" },
  { pattern: /^kamino(?:[\s-]+lend)?$/iu, protocol: "kamino" },
  { pattern: /^spark[\s-]*lend$/iu, protocol: "sparklend" },
  { pattern: /^spark(?:[\s-]+savings)?$/iu, protocol: "spark-savings" },
  { pattern: /^fluid(?:[\s-]+(?:lend|lending))?$/iu, protocol: "fluid" },
  { pattern: /^yearn(?:[\s-]+v3)?$/iu, protocol: "yearn-v3" },
  ...generatedVenueWords(HAND_WRITTEN_LENDING, (protocol) => GENERATED_LENDING.includes(protocol)),
]);
export const LENDING_WORDS =
  "aave(?:[\\s-]*v3)?|compound(?:[\\s-]*v3)?|comet|morpho(?:[\\s-]+vaults?)?|moonwell|(?:jupiter|jup)[\\s-]+(?:lend|earn)|kamino(?:[\\s-]+lend)?|" +
  "spark[\\s-]*lend|spark(?:[\\s-]+savings)?|fluid(?:[\\s-]+(?:lending|lend))?|yearn(?:[\\s-]+v3)?" +
  (GENERATED_LENDING.length > 0 ? `|${wordAlternation(GENERATED_LENDING.flatMap((protocol) => protocol.words ?? []))}` : "");
/**
 * Lending protocols whose venues may be named by slug ("into morpho spark-usdc", "into yearn usdc-1", "into spark
 * spusdc", "into kamino jlp-usdc", "into sky sdai").
 */
export const VAULT_PROTOCOLS: readonly ProtocolId[] = ["morpho", "spark-savings", "yearn-v3", "kamino", "sky"];
/** Venue words that are the name of one venue ("into sdai", "into susds", "into savings dai"): the word names the vault. */
const VENUE_NAME_WORDS: Readonly<Record<string, string>> = Object.freeze({ "savings dai": "sdai" });

/**
 * The vault a venue word itself names ("sdai" is the Sky venue sdai), or undefined: a word equal to one of the
 * protocol's venue slugs, or a reviewed name of one.
 */
export function vaultOfVenueWord(protocol: string, word: string | undefined): string | undefined {
  const spaced = (word ?? "").trim().toLowerCase().replace(/[\s-]+/gu, " ");
  const slug = VENUE_NAME_WORDS[spaced] ?? spaced;
  return YIELD_VENUES.some((venue) => venue.protocol === protocol && venue.slug === slug && slug !== protocol) ? slug : undefined;
}

/**
 * Exits a venue does not run: Ethena's sUSDe leaves through its cooldown, which Kletia shows and never
 * runs; the refusal says what to do instead.
 */
export const EXIT_GUIDES: Readonly<Partial<Record<ProtocolId, string>>> = Object.freeze({
  ethena:
    "Kletia does not withdraw from Ethena: sUSDe leaves through Ethena's cooldown (cooldownShares on ethena.fi, then unstake once it ends). " +
    "Kletia shows the cooldown when you deposit and does not run the exit.",
});

/** Cross-network venue words -> protocol ("bridge ... via lifi"). */
export const BRIDGE_VENUES: readonly VenueWord[] = Object.freeze([
  { pattern: /^(?:li\.?fi)$/iu, protocol: "lifi" },
  { pattern: /^(?:debridge(?:[\s-]+dln)?|dln)$/iu, protocol: "debridge-dln" },
  { pattern: /^relay$/iu, protocol: "relay" },
  { pattern: /^across$/iu, protocol: "across" },
  { pattern: /^cctp(?:[\s-]*v2)?$/iu, protocol: "cctp-v2" },
]);
export const BRIDGE_WORDS = "li\\.?fi|debridge(?:[\\s-]+dln)?|dln|relay|across|cctp(?:[\\s-]*v2)?";

const BUILTIN_SWAP_VENUES: readonly VenueWord[] = [
  { pattern: /^(?:jupiter|jup)$/iu, protocol: "jupiter" },
  { pattern: /^raydium$/iu, protocol: "raydium" },
  { pattern: /^orca$/iu, protocol: "orca" },
  { pattern: /^meteora$/iu, protocol: "meteora" },
  { pattern: /^uniswap(?:[\s-]+v3)?$/iu, protocol: "uniswap-v3" },
  { pattern: /^aerodrome$/iu, protocol: "aerodrome" },
  { pattern: /^velodrome$/iu, protocol: "velodrome" },
];
/** Registry DEX protocols with words and no hand-written pattern (PancakeSwap V3, Camelot, Curve). */
const GENERATED_SWAP_PROTOCOLS: readonly ProtocolDescriptor[] = PROTOCOLS.filter((protocol) =>
  protocol.category === "dex" && (protocol.kinds ?? []).includes("swap") && (protocol.words ?? []).length > 0 &&
  !BUILTIN_SWAP_VENUES.some((venue) => venue.protocol === protocol.id));
/** Same-network swap venue words -> protocol ("swap ... via orca"). */
export const SWAP_VENUES: readonly VenueWord[] = Object.freeze([
  ...BUILTIN_SWAP_VENUES,
  ...generatedVenueWords(BUILTIN_SWAP_VENUES.map((venue) => venue.protocol), (protocol) => GENERATED_SWAP_PROTOCOLS.includes(protocol)),
]);
export const SWAP_VENUE_WORDS = [
  "jupiter|jup|raydium|orca|meteora|uniswap(?:[\\s-]+v3)?|aerodrome|velodrome",
  ...(GENERATED_SWAP_PROTOCOLS.length > 0 ? [wordAlternation(GENERATED_SWAP_PROTOCOLS.flatMap((protocol) => protocol.words ?? []))] : []),
].join("|");

/** Liquid staking targets reachable through Jupiter routes. */
export const LIQUID_STAKING_TOKENS: Readonly<Record<string, { symbol: string; provider: string }>> = Object.freeze({
  jito: { symbol: "JitoSOL", provider: "Jito" },
  jitosol: { symbol: "JitoSOL", provider: "Jito" },
  marinade: { symbol: "mSOL", provider: "Marinade" },
  msol: { symbol: "mSOL", provider: "Marinade" },
  jupiter: { symbol: "JupSOL", provider: "Jupiter" },
  jupsol: { symbol: "JupSOL", provider: "Jupiter" },
  sanctum: { symbol: "JupSOL", provider: "Jupiter" },
  // BlazeStake and the Sanctum single-validator pools (SPL stake pools, also routable through Jupiter)
  blazestake: { symbol: "bSOL", provider: "BlazeStake" },
  solblaze: { symbol: "bSOL", provider: "BlazeStake" },
  bsol: { symbol: "bSOL", provider: "BlazeStake" },
  hsol: { symbol: "hSOL", provider: "Sanctum" },
  dsol: { symbol: "dSOL", provider: "Sanctum" },
  bonksol: { symbol: "bonkSOL", provider: "Sanctum" },
});

/** EVM liquid staking on Ethereum: the staking word -> the token it mints and its protocol. */
export const EVM_STAKING_TOKENS: Readonly<Record<string, { symbol: string; provider: string; protocol: ProtocolId }>> = Object.freeze({
  lido: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  steth: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  wsteth: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  "rocket pool": { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  rocketpool: { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  reth: { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  "ether.fi": { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  etherfi: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  weeth: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  eeth: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  // Generated from the registry (descriptor words; the token is the protocol's pinned lst-token).
  ...Object.fromEntries(generatedEvmStaking().map((entry) => [entry.word, { symbol: entry.symbol, provider: entry.provider, protocol: entry.protocol }])),
});
/** Words of the generated EVM staking entries (also stake-sentence LST words). */
export const GENERATED_EVM_STAKING_WORDS: readonly string[] = generatedEvmStaking().map((entry) => entry.word);
/** The network EVM liquid staking runs on. */
export const EVM_STAKING_NETWORK: NetworkKey = "ethereum";

/**
 * Staking ETH on an EVM network other than Ethereum: no staking contract
 * runs there, so the alternatives are buying a listed liquid staking token
 * at market on that network (a swap, never called a stake) or bridging to
 * Ethereum and staking there. `etherSymbol` is what ether is called on the
 * network (WETH on Polygon PoS); `tokens` the liquid staking tokens listed
 * there that a swap venue can route (transfer-only rows excluded). Null on
 * Ethereum, on non-EVM networks and on testnets.
 */
export interface L2StakeAlternatives {
  readonly network: NetworkKey;
  readonly etherSymbol: string;
  readonly tokens: readonly string[];
}

export function l2StakeAlternatives(network: NetworkKey): L2StakeAlternatives | null {
  const chain = CHAINS[network];
  if (chain.vm !== "evm" || network === EVM_STAKING_NETWORK || chain.environment !== "mainnet") return null;
  const etherSymbol = chain.nativeAsset.symbol.toUpperCase() === "ETH" ? chain.nativeAsset.symbol : findAssetBySymbol(network, "WETH")?.symbol;
  if (!etherSymbol) return null;
  const swappable = capabilityIndex(network, "swap").length > 0;
  const tokens = swappable
    ? ASSETS.filter((asset) => asset.network === network && asset.category === "liquid-staking" && !asset.transferOnly).map((asset) => asset.symbol)
    : [];
  return { network, etherSymbol, tokens };
}

/** The protocol of native SOL staking to a validator (stake account, no liquid token). */
export const NATIVE_STAKE_PROTOCOL: ProtocolId = "solana-stake";
/**
 * Native staking words ("with native stake", "with validator <vote>") from the
 * registry descriptor; "natively" is read without a connector ("stake 2 SOL
 * natively"), so it is not a venue word after "with".
 */
export const NATIVE_STAKE_WORDS: readonly string[] = Object.freeze(
  (getProtocol(NATIVE_STAKE_PROTOCOL)?.words ?? []).map((word) => word.trim().toLowerCase()).filter((word) => word !== "natively"),
);
/** Provider label the grammar writes for a native stake without a named validator. */
export const NATIVE_STAKE_PROVIDER = getProtocol(NATIVE_STAKE_PROTOCOL)?.name ?? "Native SOL staking";

function isNativeStakeWord(word: string | undefined): boolean {
  return word !== undefined && NATIVE_STAKE_WORDS.includes(word.trim().toLowerCase().replace(/[\s-]+/gu, " "));
}

/**
 * Ethereum liquid-staking protocols with words and no hand-written entry
 * (Stader, Mantle LSP, Frax Ether): each word -> the asset of the
 * protocol's pinned `lst-token` on Ethereum. A protocol without that pin, or
 * whose token is not a registry asset, gets no words (nothing to mint).
 */
function generatedEvmStaking(): { word: string; symbol: string; provider: string; protocol: ProtocolId }[] {
  const handWritten: readonly ProtocolId[] = ["lido", "rocket-pool", "etherfi"];
  return PROTOCOLS.flatMap((protocol) => {
    if (protocol.category !== "liquid-staking" || handWritten.includes(protocol.id) || !protocol.networks.includes("ethereum")) return [];
    const [token] = venueContracts(protocol.id, "ethereum", "lst-token");
    const asset = token ? findAssetByAddress("ethereum", token) : null;
    if (!asset) return [];
    return (protocol.words ?? []).map((word) => ({
      word: word.trim().toLowerCase().replace(/[\s-]+/gu, " "),
      symbol: asset.symbol,
      provider: protocol.name,
      protocol: protocol.id,
    }));
  });
}

export function evmStakingToken(word: string | undefined) {
  if (!word) return undefined;
  return EVM_STAKING_TOKENS[word.toLowerCase().replace(/[\s-]+/gu, " ")];
}

/**
 * Every venue word and phrase the built-in sentences recognise (lending,
 * bridge, swap and liquid-staking venues). Contract aliases may never use
 * them: the engine's drift test checks each is in @kletia/core
 * RESERVED_CONTRACT_PHRASES and still matches the patterns above.
 */
export const GRAMMAR_VENUE_WORDS: readonly string[] = Object.freeze([
  "aave", "aave v3", "aavev3", "aave-v3",
  "compound", "compound v3", "compoundv3", "compound-v3", "comet",
  "morpho", "morpho vault", "morpho vaults",
  "moonwell",
  "jupiter lend", "jupiter earn", "jup lend", "jup earn",
  "kamino", "kamino lend",
  "sparklend", "spark lend", "spark-lend", "spark", "spark savings", "spark-savings",
  "fluid", "fluid lend", "fluid lending",
  "yearn", "yearn v3", "yearn-v3",
  // Generated lending and savings words (Save, Sky, Ethena).
  ...GENERATED_LENDING.flatMap((protocol) => (protocol.words ?? []).map((word) => word.toLowerCase())),
  "lifi", "li.fi", "debridge", "debridge dln", "dln", "relay", "across", "cctp", "cctp v2",
  "jup", "raydium", "orca", "meteora", "uniswap", "uniswap v3", "aerodrome", "velodrome",
  ...Object.keys(LIQUID_STAKING_TOKENS),
  ...Object.keys(EVM_STAKING_TOKENS),
  // Generated swap venue words (generated staking words are EVM_STAKING_TOKENS keys above).
  ...GENERATED_SWAP_PROTOCOLS.flatMap((protocol) => (protocol.words ?? []).map((word) => word.toLowerCase())),
  ...NATIVE_STAKE_WORDS,
]);

/** True when `word` is a venue the built-in patterns match (drift test). */
export function isGrammarVenueWord(word: string): boolean {
  return [...LENDING_VENUES, ...BRIDGE_VENUES, ...SWAP_VENUES].some((venue) => venue.pattern.test(word)) ||
    Object.hasOwn(LIQUID_STAKING_TOKENS, word.toLowerCase()) || evmStakingToken(word) !== undefined || isNativeStakeWord(word);
}
