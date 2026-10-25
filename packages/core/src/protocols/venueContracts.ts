/**
 * Every pinned venue contract (VENUE_CONTRACTS), Jupiter DEX families and
 * the venue contract lookups.
 */
import type { NetworkKey } from "../chains.js";
import type { ProtocolId, VenueContract, VenueContractRole } from "./types.js";
import { EVM_PRODUCTION } from "./registry.js";
import {
  FLUID_LENDING_FACTORY,
  FLUID_LIQUIDITY,
  JUPITER_LEND_PROGRAM,
  JUPITER_LIQUIDITY_PROGRAM,
  KAMINO_PROGRAM,
  sameVenueAddress,
  SAVE_PROGRAM,
  YEARN_REGISTRIES,
  YEARN_VAULT_ORIGINAL,
} from "./yieldVenues.js";
import {
  ACROSS_SPOKE_POOLS,
  CCTP_V2_TESTNET_CONTRACTS,
  CURVE_POOLS,
  DEX_DEPLOYMENTS,
  dexContracts,
  WRAPPED_NATIVE,
} from "./dex.js";
import { stakePoolContracts } from "./stakePools.js";

function everyEvm(protocol: ProtocolId, role: VenueContractRole, address: string): VenueContract[] {
  return EVM_PRODUCTION.map((network) => ({ protocol, network, role, address }));
}

export const VENUE_CONTRACTS: readonly VenueContract[] = Object.freeze([
  // Relay (GET /chains protocol.v2.depository and contracts.*; bytecode present on all five EVM networks)
  ...everyEvm("relay", "depository", "0x4cD00E387622C35bDDB9b4c962C136462338BC31"),
  ...everyEvm("relay", "erc20-router", "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f"),
  ...everyEvm("relay", "approval-proxy", "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE"),
  { protocol: "relay", network: "solana", role: "depository", address: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  // LI.FI (same diamond on these five networks; Unichain differs, so it is pinned per network)
  ...everyEvm("lifi", "diamond", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
  ...everyEvm("lifi", "fee-forwarder", "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd"),
  // deBridge DLN
  ...everyEvm("debridge-dln", "dln-source", "0xeF4fB24aD0916217251F553c0596F8Edc630EB66"),
  ...everyEvm("debridge-dln", "dln-destination", "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f"),
  { protocol: "debridge-dln", network: "solana", role: "dln-source", address: "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4" },
  { protocol: "debridge-dln", network: "solana", role: "dln-destination", address: "dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo" },
  // deBridge source swaps (deBridge's deployed-contracts page lists the forwarder as
  // "DeBridgeRouter"; bytecode read back on all five networks 2026-10-23). The swap-router allowlist is KyberSwap's
  // MetaAggregationRouterV2 only: its calldata is fully decoded (recipient = forwarder). Other routers the API picks
  // are refused until they are decoded the same way. The surplus recipient is the address every create-tx response
  // named on 2026-10-23 for swap output above the order's give amount (the order itself is fixed).
  ...everyEvm("debridge-dln", "dln-forwarder", "0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251"),
  ...everyEvm("debridge-dln", "dln-swap-router", "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
  ...everyEvm("debridge-dln", "dln-surplus-recipient", "0x502ea3d95122b5914850E7A4A4CB9e96cF75A35f"),
  // KyberSwap MetaAggregationRouterV2 (same address on the five networks; bytecode read back 2026-10-23)
  ...everyEvm("kyberswap", "aggregator-router", "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
  // Solana lending programs
  { protocol: "jupiter-lend", network: "solana", role: "program", address: JUPITER_LEND_PROGRAM },
  { protocol: "jupiter-lend", network: "solana", role: "liquidity-program", address: JUPITER_LIQUIDITY_PROGRAM },
  { protocol: "kamino", network: "solana", role: "program", address: KAMINO_PROGRAM },
  { protocol: "kamino", network: "solana", role: "farms-program", address: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr" },
  { protocol: "save", network: "solana", role: "program", address: SAVE_PROGRAM },
  // Name services
  { protocol: "ens", network: "ethereum", role: "registry", address: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" },
  { protocol: "ens", network: "ethereum", role: "universal-resolver", address: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" },
  { protocol: "basenames", network: "base", role: "registry", address: "0xB94704422c2a1E396835A571837Aa5AE53285a95" },
  { protocol: "basenames", network: "base", role: "resolver", address: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" },
  { protocol: "basenames", network: "base", role: "resolver", address: "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875" },
  { protocol: "sns", network: "solana", role: "name-program", address: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX" },
  { protocol: "sns", network: "solana", role: "tld-parent", address: "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx" },
  // ---- read back 2026-10-14
  // DEX deployments (Uniswap V3, Aerodrome and Velodrome Slipstream)
  ...dexContracts(DEX_DEPLOYMENTS),
  // Wrap venue: the canonical wrapped gas asset of each EVM network (the same WETH9 / WPOL the DEX routers report)
  ...(Object.entries(WRAPPED_NATIVE) as [NetworkKey, string][]).map(([network, address]): VenueContract => ({ protocol: "wrap", network, role: "wrapped-native", address })),
  // SparkLend (Aave V3 fork)
  { protocol: "sparklend", network: "ethereum", role: "addresses-provider", address: "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE" },
  // Fluid (same LendingFactory and Liquidity on every network)
  ...(["ethereum", "base", "arbitrum", "polygon"] as const).flatMap((network): VenueContract[] => [
    { protocol: "fluid", network, role: "lending-factory", address: FLUID_LENDING_FACTORY },
    { protocol: "fluid", network, role: "liquidity", address: FLUID_LIQUIDITY },
  ]),
  // Yearn V3 registries (current, legacy) and the vault original every endorsed vault clones
  ...YEARN_REGISTRIES.map((address): VenueContract => ({ protocol: "yearn-v3", network: "ethereum", role: "registry", address })),
  { protocol: "yearn-v3", network: "ethereum", role: "vault-original", address: YEARN_VAULT_ORIGINAL },
  // EVM liquid staking (Ethereum)
  { protocol: "lido", network: "ethereum", role: "deposit-target", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { protocol: "lido", network: "ethereum", role: "lst-token", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
  { protocol: "lido", network: "ethereum", role: "locator", address: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb" },
  { protocol: "rocket-pool", network: "ethereum", role: "storage", address: "0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46" },
  { protocol: "rocket-pool", network: "ethereum", role: "deposit-target", address: "0xCE15294273CFb9D9b628F4D61636623decDF4fdC" },
  { protocol: "rocket-pool", network: "ethereum", role: "lst-token", address: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
  { protocol: "etherfi", network: "ethereum", role: "deposit-target", address: "0xcfC6d9Bd7411962Bfe7145451A7EF71A24b6A7A2" },
  { protocol: "etherfi", network: "ethereum", role: "liquidity-pool", address: "0x308861A430be4cce5502d0A12724771Fc6DaF216" },
  { protocol: "etherfi", network: "ethereum", role: "lst-token", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
  { protocol: "etherfi", network: "ethereum", role: "underlying-token", address: "0x35fA164735182de50811E8e2E824cFb9B6118ac2" },
  // Solana DEX programs, keyed by their Jupiter route label (swaps run through the Jupiter program)
  { protocol: "raydium", network: "solana", role: "program", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", label: "Raydium" },
  { protocol: "raydium", network: "solana", role: "program", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", label: "Raydium CLMM" },
  { protocol: "raydium", network: "solana", role: "program", address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", label: "Raydium CP" },
  { protocol: "orca", network: "solana", role: "program", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", label: "Whirlpool" },
  { protocol: "meteora", network: "solana", role: "program", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", label: "Meteora DLMM" },
  { protocol: "meteora", network: "solana", role: "program", address: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", label: "Meteora DAMM v2" },
  // Across SpokePools. The Solana spoke program (DLv3Ngg…eAru, read back in the evidence file) is not
  // pinned until Across lists Solana in its networks: every row's network must be one its protocol lists.
  ...Object.entries(ACROSS_SPOKE_POOLS).map(([network, address]): VenueContract => ({
    protocol: "across", network: network as NetworkKey, role: "spoke-pool", address: address as string,
  })),
  // Circle CCTP V2 (same addresses on the five EVM networks)
  ...everyEvm("cctp-v2", "token-messenger", "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"),
  ...everyEvm("cctp-v2", "message-transmitter", "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"),
  ...everyEvm("cctp-v2", "token-minter", "0xfd78EE919681417d192449715b2594ab58f5D002"),
  { protocol: "cctp-v2", network: "solana", role: "token-messenger-minter", address: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" },
  { protocol: "cctp-v2", network: "solana", role: "message-transmitter", address: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" },
  // Circle CCTP V2 testnets (Arc Testnet, Arbitrum Sepolia, Solana Devnet): sandbox Iris, testnet lane only
  ...CCTP_V2_TESTNET_CONTRACTS,
  // Pyth (Solana push oracle and its receiver)
  { protocol: "pyth", network: "solana", role: "program", address: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT" },
  { protocol: "pyth", network: "solana", role: "receiver", address: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ" },
  // ---- read back 2026-10-15: packages/core/test/fixtures/protocols-2026-10-15.json
  // Curve pools (generated from CURVE_POOLS)
  ...CURVE_POOLS.map((entry): VenueContract => ({ protocol: "curve", network: entry.network, role: "curve-pool", address: entry.pool })),
  // EVM liquid staking (Ethereum): Stader, Mantle LSP, Frax Ether
  { protocol: "stader", network: "ethereum", role: "deposit-target", address: "0xcf5EA1b38380f6aF39068375516Daf40Ed70D299" },
  { protocol: "stader", network: "ethereum", role: "config", address: "0x4ABEF2263d5A5ED582FC9A9789a41D85b68d69DB" },
  { protocol: "stader", network: "ethereum", role: "lst-token", address: "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b" },
  { protocol: "mantle-lsp", network: "ethereum", role: "deposit-target", address: "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f" },
  { protocol: "mantle-lsp", network: "ethereum", role: "lst-token", address: "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa" },
  { protocol: "mantle-lsp", network: "ethereum", role: "pauser", address: "0x29Ab878aEd032e2e2c86FF4A9a9B05e3276cf1f8" },
  { protocol: "frax-ether", network: "ethereum", role: "deposit-target", address: "0xbAFA44EFE7901E04E39Dad13167D089C559c1138" },
  { protocol: "frax-ether", network: "ethereum", role: "underlying-token", address: "0x5E8422345238F34275888049021821E8E08CAa1f" },
  { protocol: "frax-ether", network: "ethereum", role: "lst-token", address: "0xac3E018457B222d93114458476f3E3416Abbe38F" },
  // ---- read back 2026-10-23: packages/core/test/fixtures/protocols-2026-10-23-evm.json
  // Kelp: LRTDepositPool (lrtConfig() = config), LRTConfig (rsETH() = token; getContract(LRT_DEPOSIT_POOL / LRT_ORACLE) = pool / oracle)
  { protocol: "kelp", network: "ethereum", role: "deposit-target", address: "0x036676389e48133B63a802f8635AD39E752D375D" },
  { protocol: "kelp", network: "ethereum", role: "config", address: "0x947Cb49334e6571ccBFEF1f1f1178d8469D65ec7" },
  { protocol: "kelp", network: "ethereum", role: "lst-token", address: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7" },
  { protocol: "kelp", network: "ethereum", role: "rate-oracle", address: "0x349A73444b1a310BAe67ef67973022020d70020d" },
  // Renzo: RestakeManager (ezETH() = token, renzoOracle() = oracle)
  { protocol: "renzo", network: "ethereum", role: "deposit-target", address: "0x74a09653A083691711cF8215a6ab074BB4e99ef5" },
  { protocol: "renzo", network: "ethereum", role: "lst-token", address: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110" },
  { protocol: "renzo", network: "ethereum", role: "rate-oracle", address: "0x5a12796f7e7EBbbc8a402667d266d2e65A814042" },
  // Solana SPL stake pools (generated from SOLANA_STAKE_POOLS): Jito, the Sanctum pools and BlazeStake; pool fields decoded live
  ...stakePoolContracts(),
  // Marinade: program, state (owned by the program), mSOL mint and the liquidity pool's mSOL leg (decoded from state)
  { protocol: "marinade", network: "solana", role: "program", address: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD" },
  { protocol: "marinade", network: "solana", role: "program-state", address: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC" },
  { protocol: "marinade", network: "solana", role: "pool-mint", address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So" },
  { protocol: "marinade", network: "solana", role: "liquidity-leg", address: "7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE" },
  // Native SOL staking: the Stake program and default vote accounts (mainnet: the three highest-stake 0 % commission
  // validators of vote-accounts-mainnet.json; devnet: the highest-stake devnet validator)
  { protocol: "solana-stake", network: "solana", role: "program", address: "Stake11111111111111111111111111111111111111" },
  { protocol: "solana-stake", network: "solana", role: "vote-account", address: "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk" },
  { protocol: "solana-stake", network: "solana", role: "vote-account", address: "3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g" },
  { protocol: "solana-stake", network: "solana", role: "vote-account", address: "8GbwASqdpw4dVcwbWUxbHXMrjyQx2aKkoBR5H1GJF8iD" },
  { protocol: "solana-stake", network: "solana-devnet", role: "program", address: "Stake11111111111111111111111111111111111111" },
  { protocol: "solana-stake", network: "solana-devnet", role: "vote-account", address: "vgcDar2pryHvMgPkKaZfh8pQy4BJxv7SpwUG7zinWjG" },
] satisfies readonly VenueContract[]);

/* ------------------------------------------------- Jupiter venue families */

/** A Jupiter AMM label and the program it stands for. */
export interface JupiterDexLabel {
  readonly label: string;
  readonly program: string;
}

/**
 * Venue families a Jupiter swap may be restricted to or kept away from
 * (Jupiter's `dexes` / `excludeDexes` quote parameters take the labels).
 * Labels and programs read from Jupiter's /swap/v1/program-id-to-label on
 * 2026-10-23 (fixtures/protocols-2026-10-23-solana.json); Lifinity is no longer
 * listed there, so it cannot be named.
 */
export const JUPITER_DEX_FAMILIES = Object.freeze({
  raydium: [
    { label: "Raydium", program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
    { label: "Raydium CLMM", program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
    { label: "Raydium CP", program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" },
  ],
  orca: [{ label: "Whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" }],
  meteora: [
    { label: "Meteora DLMM", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
    { label: "Meteora DAMM v2", program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG" },
    { label: "Meteora", program: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB" },
  ],
  phoenix: [{ label: "Phoenix", program: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY" }],
  openbook: [{ label: "OpenBook V2", program: "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb" }],
  manifest: [{ label: "Manifest", program: "MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms" }],
  solfi: [
    { label: "SolFi", program: "SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe" },
    { label: "SolFi V2", program: "SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF" },
  ],
  humidifi: [{ label: "HumidiFi", program: "9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp" }],
  zerofi: [{ label: "ZeroFi", program: "ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY" }],
  pumpfun: [
    { label: "Pump.fun", program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
    { label: "Pump.fun Amm", program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  ],
} satisfies Readonly<Record<string, readonly JupiterDexLabel[]>>);

export type JupiterDexFamily = keyof typeof JUPITER_DEX_FAMILIES;

export function isJupiterDexFamily(value: string): value is JupiterDexFamily {
  return Object.hasOwn(JUPITER_DEX_FAMILIES, value);
}

/** The Solana DEX venue behind a Jupiter route label ("Raydium CLMM" -> raydium), or null. */
export function venueByLabel(label: string): VenueContract | null {
  return VENUE_CONTRACTS.find((entry) => entry.label === label) ?? null;
}

/** Pinned addresses of `protocol` on `network`, optionally for one role. */
export function venueContracts(protocol: ProtocolId, network: NetworkKey, role?: VenueContractRole): string[] {
  return VENUE_CONTRACTS
    .filter((entry) => entry.protocol === protocol && entry.network === network && (!role || entry.role === role))
    .map((entry) => entry.address);
}

/** True when `address` is a pinned contract of `protocol` on `network` (EVM: case-insensitive). */
export function isVenueContract(protocol: ProtocolId, network: NetworkKey, address: string, role?: VenueContractRole): boolean {
  return venueContracts(protocol, network, role).some((pinned) => sameVenueAddress(network, pinned, address));
}
