/**
 * The protocol coverage table as data: one sentence per cell and what must
 * happen to it. Read by the offline gate
 * (`engine/__tests__/protocolCoverage.test.ts`, stub venues from the
 * capability index) and by `npm run verify:coverage` (a live API, dry runs
 * only). A cell either plans with one of the named protocols, or is refused
 * with INTENT_UNSUPPORTED whose message matches and offers at least one
 * sentence that plans (a guided refusal); a bare refusal fails the gate.
 */
import type { NetworkKey, ProtocolId } from "@kletia/core";

export interface CoverageCell {
  readonly network: NetworkKey;
  /** Short cell name ("swap", "stake-stader", ...). */
  readonly kind: string;
  readonly text: string;
  readonly expect: "plans" | "guided";
  /** Per step: the protocols allowed to serve it (plans). */
  readonly protocols?: readonly (readonly ProtocolId[])[];
  /** Symbol of the last step's output (plans). */
  readonly output?: string;
  /** A planner warning the plan must carry (plans). */
  readonly warning?: RegExp;
  /** What the refusal must say (guided). */
  readonly message?: RegExp;
}

const DEAD = "0x000000000000000000000000000000000000dEaD";
const SOL_RECIPIENT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
/** A pinned default validator of Solana mainnet (VENUE_CONTRACTS `vote-account`). */
const VOTE = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";

const EVM_BRIDGES: readonly ProtocolId[] = ["across", "cctp-v2", "relay", "lifi", "debridge-dln"];
const LENDING_VENUE_LESS = /names no venue/u;
const L2_STAKE = /Staking ETH runs on Ethereum .*not on/u;

const plans = (network: NetworkKey, kind: string, text: string, protocols: readonly (readonly ProtocolId[])[], extra: Partial<CoverageCell> = {}): CoverageCell =>
  ({ network, kind, text, expect: "plans", protocols, ...extra });
const guided = (network: NetworkKey, kind: string, text: string, message: RegExp): CoverageCell => ({ network, kind, text, expect: "guided", message });

export const COVERAGE_CELLS: readonly CoverageCell[] = Object.freeze([
  // Ethereum: uniswap, pancake, curve (+relay); aave(+USDT, wstETH, cbBTC), compound(+wstETH), morpho(+3), sparklend, spark, fluid, yearn; six stakes.
  plans("ethereum", "swap", "swap 100 USDC to ETH on ethereum", [["uniswap-v3", "pancakeswap-v3", "relay"]]),
  plans("ethereum", "swap-pancake", "swap 100 USDC to ETH via pancake on ethereum", [["pancakeswap-v3"]]),
  plans("ethereum", "swap-curve", "swap 100 USDC to USDT via curve on ethereum", [["curve"]], { output: "USDT" }),
  plans("ethereum", "swap-usdt", "swap 100 USDC to USDT on ethereum", [["uniswap-v3", "pancakeswap-v3", "curve", "relay"]]),
  plans("ethereum", "deposit-aave-usdt", "deposit 100 USDT into aave on ethereum", [["aave-v3"]]),
  plans("ethereum", "deposit-aave-cbbtc", "deposit 0.01 cbBTC into aave on ethereum", [["aave-v3"]]),
  plans("ethereum", "deposit-compound-wsteth", "deposit 1 wstETH into compound on ethereum", [["compound-v3"]]),
  plans("ethereum", "deposit-morpho-usdt", "deposit 100 USDT into morpho on ethereum", [["morpho"]]),
  plans("ethereum", "deposit-morpho-steakhouse", "deposit 100 USDC into morpho steakhouse-usdc on ethereum", [["morpho"]]),
  plans("ethereum", "deposit-sparklend", "deposit 100 USDC into sparklend on ethereum", [["sparklend"]]),
  plans("ethereum", "deposit-yearn", "deposit 100 USDC into yearn on ethereum", [["yearn-v3"]]),
  plans("ethereum", "stake-lido", "stake 1 ETH with lido", [["lido"]], { output: "wstETH" }),
  plans("ethereum", "stake-rocket-pool", "stake 1 ETH with rocket pool", [["rocket-pool"]], { output: "rETH" }),
  plans("ethereum", "stake-etherfi", "stake 1 ETH with ether.fi", [["etherfi"]], { output: "weETH" }),
  plans("ethereum", "stake-stader", "stake 1 ETH with stader", [["stader"]], { output: "ETHx" }),
  plans("ethereum", "stake-mantle", "stake 1 ETH with mantle", [["mantle-lsp"]], { output: "mETH" }),
  plans("ethereum", "stake-frax", "stake 1 ETH with frax", [["frax-ether"]], { output: "sfrxETH" }),
  plans("ethereum", "bridge", "bridge 100 USDC from ethereum to base", [EVM_BRIDGES]),
  guided("ethereum", "deposit-venue-less", "deposit 100 USDC on ethereum", LENDING_VENUE_LESS),
  guided("ethereum", "borrow", "borrow 100 USDC on ethereum", /Borrowing is not available yet/u),
  // Base: uniswap, aerodrome, pancake; aave(+wstETH, cbETH); buy wstETH / cbETH instead of staking.
  plans("base", "swap", "swap 100 USDC to ETH on base", [["uniswap-v3", "aerodrome", "pancakeswap-v3", "relay"]]),
  plans("base", "swap-pancake", "swap 100 USDC to ETH via pancakeswap on base", [["pancakeswap-v3"]]),
  plans("base", "swap-aerodrome", "swap 100 USDC to ETH via aerodrome on base", [["aerodrome"]]),
  plans("base", "buy-cbeth", "swap 1 ETH to cbETH on base", [["uniswap-v3", "aerodrome", "pancakeswap-v3", "relay"]], { output: "cbETH" }),
  plans("base", "deposit-aave-wsteth", "deposit 1 wstETH into aave on base", [["aave-v3"]]),
  plans("base", "deposit-aave-cbeth", "deposit 1 cbETH into aave on base", [["aave-v3"]]),
  plans("base", "deposit-moonwell", "deposit 100 USDC into moonwell on base", [["moonwell"]]),
  plans("base", "deposit-fluid", "deposit 100 USDC into fluid on base", [["fluid"]]),
  plans("base", "bridge-solana", "bridge 100 USDC from base to solana", [EVM_BRIDGES]),
  guided("base", "stake", "stake 1 ETH on base", L2_STAKE),
  guided("base", "deposit-venue-less", "deposit 100 USDC on base", LENDING_VENUE_LESS),
  // Arbitrum: uniswap, pancake, camelot; aave(+USDT0, wstETH), compound(+USDT0).
  plans("arbitrum", "swap", "swap 100 USDC to ETH on arbitrum", [["uniswap-v3", "pancakeswap-v3", "camelot", "relay"]]),
  plans("arbitrum", "swap-camelot", "swap 100 USDC to ETH via camelot on arbitrum", [["camelot"]]),
  plans("arbitrum", "swap-usdt", "swap 100 USDC to USDT on arbitrum", [["uniswap-v3", "pancakeswap-v3", "camelot", "relay"]], { output: "USDT0" }),
  plans("arbitrum", "deposit-aave-usdt", "deposit 100 USDT into aave on arbitrum", [["aave-v3"]]),
  plans("arbitrum", "deposit-compound-usdt", "deposit 100 USDT into compound on arbitrum", [["compound-v3"]]),
  plans("arbitrum", "deposit-aave-wsteth", "deposit 1 wstETH into aave on arbitrum", [["aave-v3"]]),
  guided("arbitrum", "stake", "stake 1 ETH on arbitrum", L2_STAKE),
  // OP Mainnet: uniswap, velodrome; aave(+USDT, wstETH), compound(+USDT), moonwell, spark, morpho; bridge + Lido offer.
  plans("optimism", "swap-velodrome", "swap 100 USDC to ETH via velodrome on optimism", [["velodrome"]]),
  plans("optimism", "deposit-morpho", "deposit 100 USDC into morpho on optimism", [["morpho"]]),
  plans("optimism", "deposit-compound-usdt", "deposit 100 USDT into compound on optimism", [["compound-v3"]]),
  plans("optimism", "deposit-aave-wsteth", "deposit 1 wstETH into aave on optimism", [["aave-v3"]]),
  guided("optimism", "stake", "stake 1 ETH on optimism", L2_STAKE),
  // Polygon: uniswap (ETH read as WETH); aave(+USDT0, wstETH), fluid, compound USDT0, morpho x2.
  plans("polygon", "swap-eth", "swap 100 USDC to ETH on polygon", [["uniswap-v3", "relay"]], { output: "WETH", warning: /"ETH" was read as WETH/u }),
  plans("polygon", "deposit-compound-usdt", "deposit 100 USDT into compound on polygon", [["compound-v3"]]),
  plans("polygon", "deposit-morpho-usdc", "deposit 100 USDC into morpho on polygon", [["morpho"]]),
  plans("polygon", "deposit-morpho-usdt", "deposit 100 USDT into morpho on polygon", [["morpho"]]),
  guided("polygon", "stake", "stake 1 ETH on polygon", L2_STAKE),
  // Solana: jupiter (+ named raydium, orca, meteora); kamino, jupiter-lend; jito, sanctum, marinade direct; native.
  plans("solana", "swap", "swap 1 SOL to USDC", [["jupiter", "relay"]]),
  plans("solana", "swap-orca", "swap 1 SOL to USDC via orca", [["orca"]]),
  plans("solana", "deposit-kamino", "deposit 10 USDC into kamino", [["kamino"]]),
  plans("solana", "deposit-jupiter-lend", "deposit 10 USDC into jupiter lend", [["jupiter-lend"]]),
  plans("solana", "stake-jito", "stake 1 SOL with jito", [["jito"]], { output: "JitoSOL" }),
  plans("solana", "stake-marinade", "stake 1 SOL with marinade", [["marinade"]], { output: "mSOL" }),
  plans("solana", "stake-sanctum", "stake 1 SOL with jupsol", [["sanctum"]], { output: "JupSOL" }),
  // Stake-pool LSTs are registry assets (staking words for them are a reader hook)
  plans("solana", "buy-bsol", "swap 1 SOL to bSOL", [["jupiter", "relay"]], { output: "bSOL" }),
  plans("solana", "buy-hsol", "swap 1 SOL to hSOL", [["jupiter", "relay"]], { output: "hSOL" }),
  plans("solana", "stake-native", "stake 2 SOL natively", [["solana-stake"]], { output: "SOL" }),
  plans("solana", "stake-validator", `stake 2 SOL with validator ${VOTE}`, [["solana-stake"]], { output: "SOL" }),
  plans("solana", "bridge", "bridge 25 USDC from solana to base", [["relay", "debridge-dln"]]),
  plans("solana", "transfer", `send 1 USDC to ${SOL_RECIPIENT}`, [["spl-token"]]),
  // Arc Testnet: USDC / EURC transfers, CCTP.
  plans("arc", "transfer", `send 1 USDC to ${DEAD} on arc`, [["system-transfer", "erc20-transfer"]]),
  plans("arc", "transfer-eurc", `send 1 EURC to ${DEAD} on arc`, [["erc20-transfer"]]),
  plans("arc", "bridge", "bridge 1 USDC from arc to arbitrum sepolia", [["cctp-v2"]]),
  // Arbitrum Sepolia: uniswap (test), aave USDC, cctp.
  plans("arbitrum-sepolia", "swap", "swap 1 USDC to ETH on arbitrum sepolia", [["uniswap-v3"]]),
  plans("arbitrum-sepolia", "deposit", "deposit 1 USDC into aave on arbitrum sepolia", [["aave-v3"]]),
  plans("arbitrum-sepolia", "bridge", "bridge 1 USDC from arbitrum sepolia to arc", [["cctp-v2"]]),
  plans("arbitrum-sepolia", "bridge-solana-devnet", "bridge 1 USDC from arbitrum sepolia to solana devnet", [["cctp-v2"]]),
  // Solana Devnet: native stake, CCTP in.
  plans("solana-devnet", "stake", "stake 1 SOL on solana devnet", [["solana-stake"]], { output: "SOL" }),
  plans("solana-devnet", "transfer", `send 0.1 SOL to ${SOL_RECIPIENT} on solana devnet`, [["system-transfer"]]),
]);

const SENTENCE_VERBS = /^(?:swap|buy|bridge|send|stake|deposit|withdraw)\s/iu;

/** The sentences a refusal offers ("... e.g. \"deposit 100 USDC into aave on base\"."), never the refused sentence itself. */
export function quotedSentences(message: string, refused?: string): string[] {
  const own = refused?.trim().toLowerCase();
  return [...new Set([...message.matchAll(/"([^"]{6,200})"/gu)].map((match) => match[1] as string))]
    .filter((text) => SENTENCE_VERBS.test(text) && text.trim().toLowerCase() !== own);
}
