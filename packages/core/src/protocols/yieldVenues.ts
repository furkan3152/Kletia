/**
 * Yield venue builders, pinned addresses and the yield venue registry.
 */
import type { NetworkKey } from "../chains.js";
import type { ProtocolId } from "./types.js";
import type {
  AaveReserveVenue,
  CometVenue,
  CTokenVenue,
  Erc4626Venue,
  FluidFTokenVenue,
  JupiterLendVenue,
  KaminoReserveVenue,
  MorphoGeneration,
  SaveReserveVenue,
  SavingsVaultGeneration,
  SavingsVaultPin,
  SavingsVaultVenue,
  SparkVaultGeneration,
  SparkVaultVenue,
  YearnVaultVenue,
  YieldVenue,
  YieldVenueAction,
} from "./yieldVenueTypes.js";

/** MetaMorpho / Vault V2 factories per network (null: no such factory is used there). */
export const MORPHO_FACTORIES: Readonly<Partial<Record<NetworkKey, Readonly<Record<MorphoGeneration, string | null>>>>> = Object.freeze({
  base: {
    "metamorpho-v1.0": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
    "metamorpho-v1.1": "0xFf62A7c278C62eD665133147129245053Bbf5918",
    "vault-v2": "0x4501125508079A99ebBebCE205DeC9593C2b5857",
  },
  arbitrum: {
    "metamorpho-v1.0": null,
    "metamorpho-v1.1": "0x878988f5f561081deEa117717052164ea1Ef0c82",
    "vault-v2": "0x6b46fa3cc9EBF8aB230aBAc664E37F2966Bf7971",
  },
  ethereum: {
    // the v1.0 factory (same address as Base's) confirms the Steakhouse vaults (isMetaMorpho, 2026-10-15)
    "metamorpho-v1.0": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
    "metamorpho-v1.1": null,
    "vault-v2": "0xA1D94F746dEfa1928926b84fB2596c06926C0405",
  },
  optimism: {
    "metamorpho-v1.0": null,
    "metamorpho-v1.1": "0x3Bb6A6A0Bc85b367EFE0A5bAc81c5E52C892839a",
    // the VaultV2Factory Morpho's API reports for OP vaults; isVaultV2(Re7 WETH) read back 2026-10-23
    "vault-v2": "0x6128b680b277Bf4Df80DFE9D8c55A498660870ef",
  },
  polygon: {
    "metamorpho-v1.0": null,
    "metamorpho-v1.1": "0xa9c87daB340631C34BB738625C70499e29ddDC98",
    "vault-v2": null,
  },
});

const BOTH: readonly YieldVenueAction[] = ["deposit", "withdraw"];

function aave(network: NetworkKey, pool: string, dataProvider: string, asset: string, aToken: string, decimals: number): AaveReserveVenue {
  return aaveFamily("aave-v3", "Aave V3", network, pool, dataProvider, asset, aToken, decimals);
}

function aaveFamily(
  protocol: "aave-v3" | "sparklend",
  label: string,
  network: NetworkKey,
  pool: string,
  dataProvider: string,
  asset: string,
  aToken: string,
  decimals: number,
): AaveReserveVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:${protocol}:${slug}`, slug, protocol, network, kind: "aave-reserve", name: `${label} ${asset}`,
    asset, target: pool, spender: pool, dataProvider, receipt: { address: aToken, decimals }, actions: BOTH,
  };
}

function comet(network: NetworkKey, address: string, asset: string, decimals: number): CometVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:compound-v3:${slug}`, slug, protocol: "compound-v3", network, kind: "comet", name: `Compound V3 ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals }, actions: BOTH,
  };
}

function vault(network: NetworkKey, slug: string, name: string, address: string, asset: string, generation: MorphoGeneration): Erc4626Venue {
  const factory = MORPHO_FACTORIES[network]?.[generation];
  if (!factory) throw new Error(`No ${generation} factory is pinned for ${network}.`);
  return {
    id: `${network}:morpho:${slug}`, slug, protocol: "morpho", network, kind: "erc4626", name,
    asset, target: address, spender: address, receipt: { address, decimals: 18 }, generation, factory, actions: BOTH,
  };
}

function mtoken(
  network: NetworkKey,
  address: string,
  asset: string,
  comptroller: string,
  native?: { readonly router: string; readonly payout: string },
): CTokenVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:moonwell:${slug}`, slug, protocol: "moonwell", network, kind: "ctoken", name: `Moonwell ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals: 8 }, comptroller,
    ...(native ? { nativeRouter: native.router, nativePayout: native.payout } : {}), actions: BOTH,
  };
}

export const JUPITER_LEND_PROGRAM = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
export const JUPITER_LIQUIDITY_PROGRAM = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";

function jlToken(asset: string, mint: string, decimals: number, actions: readonly YieldVenueAction[] = BOTH): JupiterLendVenue {
  const slug = asset.toLowerCase();
  return {
    id: `solana:jupiter-lend:${slug}`, slug, protocol: "jupiter-lend", network: "solana", kind: "jupiter-lend",
    name: `Jupiter Lend ${asset}`, asset, target: JUPITER_LEND_PROGRAM, receipt: { address: mint, decimals },
    liquidityProgram: JUPITER_LIQUIDITY_PROGRAM, actions,
  };
}

export const KAMINO_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";

interface KaminoMarket {
  /** Slug prefix ("" for the main market, whose venues keep their original slugs). */
  readonly prefix: string;
  readonly name: string;
  readonly address: string;
  /** PDA("lma", market). */
  readonly authority: string;
}

const KAMINO_MAIN: KaminoMarket = { prefix: "", name: "Kamino Main", address: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF", authority: "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo" };
/**
 * The JLP and Altcoins markets (names from api.kamino.finance/v2/kamino-market; market owner, authority
 * derivation and every reserve's market, mint and supply vault read back on 2026-10-23, fixtures/protocols-2026-10-23-solana.json).
 */
const KAMINO_JLP: KaminoMarket = { prefix: "jlp-", name: "Kamino JLP", address: "DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek", authority: "B9spsrMK6pJicYtukaZzDyzsUQLgc3jbx5gHVwdDxb6y" };
const KAMINO_ALTCOINS: KaminoMarket = { prefix: "altcoins-", name: "Kamino Altcoins", address: "ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5", authority: "81BgcfZuZf9bESLvw3zDkh7cZmMtDwTPgkCvYu7zx26o" };

function kaminoReserve(
  asset: string,
  reserve: string,
  supplyVault?: string,
  market: KaminoMarket = KAMINO_MAIN,
): KaminoReserveVenue {
  const slug = `${market.prefix}${asset.toLowerCase()}`;
  return {
    id: `solana:kamino:${slug}`, slug, protocol: "kamino", network: "solana", kind: "kamino-reserve",
    name: `${market.name} ${asset}`, asset, target: KAMINO_PROGRAM, market: market.address, reserve,
    marketAuthority: market.authority, ...(supplyVault ? { supplyVault } : {}), actions: BOTH,
    // Markets other than Main execute only when named ("into kamino jlp-usdc"): the default stays the Main market.
    ...(market !== KAMINO_MAIN ? { namedOnly: true as const } : {}),
  };
}

/**
 * Save (ex-Solend) main pool: program, market and authority PDA([market]) from api.solend.fi/v1/markets/configs
 * (market "main", isPrimary) and read back on 2026-10-23 with each reserve (fixtures/protocols-2026-10-23-solana.json).
 */
export const SAVE_PROGRAM = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const SAVE_MAIN_MARKET = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";
const SAVE_MAIN_AUTHORITY = "DdZR6zRFiUt4S5mg7AV1uKB2z1f1WzcNYCaTEEWPAuby";

function saveReserve(asset: string, reserve: string, supplyVault: string, cToken: string, decimals: number): SaveReserveVenue {
  const slug = asset.toLowerCase();
  return {
    id: `solana:save:${slug}`, slug, protocol: "save", network: "solana", kind: "save-reserve", name: `Save Main ${asset}`,
    asset, target: SAVE_PROGRAM, market: SAVE_MAIN_MARKET, reserve, marketAuthority: SAVE_MAIN_AUTHORITY, supplyVault,
    receipt: { address: cToken, decimals }, actions: BOTH,
  };
}

function sparkVault(
  network: NetworkKey,
  slug: string,
  name: string,
  address: string,
  asset: string,
  decimals: number,
  generation: SparkVaultGeneration,
  implementation: string,
  pins: { readonly psm?: string; readonly admin?: string },
): SparkVaultVenue {
  return {
    id: `${network}:spark-savings:${slug}`, slug, protocol: "spark-savings", network, kind: "spark-vault", name,
    asset, target: address, spender: address, receipt: { address, decimals }, generation, implementation, ...pins, actions: BOTH,
  };
}

/** Fluid's LendingFactory and Liquidity share one address on every network Kletia uses. */
export const FLUID_LENDING_FACTORY = "0x54B91A0D94cb471F37f949c60F7Fa7935b551D03";
export const FLUID_LIQUIDITY = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";

function fToken(network: NetworkKey, asset: string, address: string, decimals: number): FluidFTokenVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:fluid:${slug}`, slug, protocol: "fluid", network, kind: "fluid-ftoken", name: `Fluid ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals },
    lendingFactory: FLUID_LENDING_FACTORY, liquidity: FLUID_LIQUIDITY, actions: BOTH,
  };
}

/** Yearn V3: the current and legacy registries, and the 3.0.2 vault every endorsed vault clones. */
export const YEARN_REGISTRIES = Object.freeze(["0xd40ecF29e001c76Dcc4cC0D9cd50520CE845B038", "0xff31A1B020c868F6eA3f61Eb953344920EeCA3af"]);
export const YEARN_VAULT_ORIGINAL = "0x1ab62413e0cf2eBEb73da7D40C70E7202ae14467";

function yearnVault(network: NetworkKey, slug: string, name: string, address: string, asset: string, decimals: number): YearnVaultVenue {
  return {
    id: `${network}:yearn-v3:${slug}`, slug, protocol: "yearn-v3", network, kind: "yearn-vault", name,
    asset, target: address, spender: address, receipt: { address, decimals },
    registries: YEARN_REGISTRIES, apiVersion: "3.0.2", implementation: YEARN_VAULT_ORIGINAL, actions: BOTH,
  };
}

function savingsVault(
  protocol: "sky" | "ethena",
  slug: string,
  name: string,
  address: string,
  asset: string,
  generation: SavingsVaultGeneration,
  implementation: string | null,
  pins: readonly SavingsVaultPin[],
  actions: readonly YieldVenueAction[] = BOTH,
): SavingsVaultVenue {
  return {
    id: `ethereum:${protocol}:${slug}`, slug, protocol, network: "ethereum", kind: "savings-vault", name,
    asset, target: address, spender: address, receipt: { address, decimals: 18 }, generation, implementation, pins, actions,
  };
}

/** sUSDS (UUPS): implementation read back 2026-10-23 (getImplementation() and the EIP-1967 slot agree). */
const SUSDS_IMPLEMENTATION = "0x4e7991e5C547ce825BdEb665EE14a3274f9F61e0";
const USDS_TOKEN = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
const SPARKLEND_POOL = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";
const SPARKLEND_DATA = "0xFc21d6d146E6086B8359705C8b28512a983db0cb";
const SPARK_VAULT_V2_IMPLEMENTATION = "0x1b992302652A92611DCd5090D1Cb388C6377f455";
const SPARK_VAULT_V2_ADMIN = "0x3300f198988e4C9C63F75dF86De36421f06af8c4";

const BASE_AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const BASE_AAVE_DATA = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";
/** Arbitrum, OP Mainnet and Polygon share the Pool and data-provider addresses (different deployments). */
const L2_AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const L2_AAVE_DATA = "0x243Aa95cAC2a25651eda86e80bEe66114413c43b";
const ETHEREUM_AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ETHEREUM_AAVE_DATA = "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD";
const BASE_MOONWELL = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";
const OPTIMISM_MOONWELL = "0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9";

/**
 * Curated deposit/withdraw venues. Within one (network, protocol, asset) the
 * first entry is the default the planner picks when no venue is named.
 */
export const YIELD_VENUES: readonly YieldVenue[] = Object.freeze([
  // Aave V3 reserves (Pool = spender; aToken = receipt)
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "USDC", "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", 6),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "WETH", "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7", 18),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "cbBTC", "0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6", 8),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0x724dc807b04555b71ed48a6896b6F41593b8C637", 6),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "USDC", "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", 6),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "WETH", "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8", 18),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5", 6),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD", 6),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  // reserves read back 2026-10-15: active, not frozen, not paused; existing defaults stay first
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "USDT", "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a", 6),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "wstETH", "0x0B925eD163218f6662a35e0f0371Ac234f9E9371", 18),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "cbBTC", "0x5c647cE0Ae10658ec44FA4E11A51c96e94efd1Dd", 8),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "USDT0", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", 6),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "wstETH", "0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf", 18),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "USDT", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", 6),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "wstETH", "0xc45A479877e1e9Dfe9FcD4056c699575a1045dAA", 18),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "USDT0", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", 6),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "wstETH", "0xf59036CAEBeA7dC4b86638DFA2E3C97dA9FcCd40", 18),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "wstETH", "0x99CBC45ea5bb7eF3a5BC08FB1B7E56bB2442Ef0D", 18),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "cbETH", "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad", 18),
  // Aave V3 Arbitrum Sepolia (testnet market; reserve #0 is Circle's test USDC)
  aave("arbitrum-sepolia", "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff", "0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01", "USDC", "0x460b97BD498E1157530AEb3086301d5225b91216", 6),
  // Compound V3 Comets (base asset only)
  comet("base", "0xb125E6687d4313864e53df431d5425969c15Eb2F", "USDC", 6),
  comet("base", "0x46e6b214b524310239732D51387075E0e70970bf", "WETH", 18),
  comet("arbitrum", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "USDC", 6),
  comet("arbitrum", "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", "WETH", 18),
  comet("ethereum", "0xc3d688B66703497DAA19211EEdff47f25384cdc3", "USDC", 6),
  comet("ethereum", "0xA17581A9E3356d9A858b789D68B4d866e593aE94", "WETH", 18),
  comet("optimism", "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", "USDC", 6),
  comet("optimism", "0xE36A30D249f7761327fd973001A32010b521b6Fd", "WETH", 18),
  // USDT0 / USDT comets (baseToken read back) and the Ethereum wstETH comet
  comet("arbitrum", "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", "USDT0", 6),
  comet("optimism", "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214", "USDT", 6),
  comet("polygon", "0xaeB318360f27748Acb200CE616E389A6C9409a07", "USDT0", 6),
  comet("ethereum", "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3", "wstETH", 18),
  // added 2026-10-23 (baseToken() read back; addresses from Compound's docs deployment tables)
  comet("ethereum", "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", "USDT", 6),
  comet("ethereum", "0x5D409e56D886231aDAf00c8775665AD0f9897b56", "USDS", 18),
  comet("base", "0x784efeB622244d2348d4F2522f8860B96fbEcE89", "AERO", 18),
  // Moonwell mTokens (8-decimal receipts; recipient must be the account)
  mtoken("base", "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", "USDC", BASE_MOONWELL),
  mtoken("base", "0x628ff693426583D9a7FB391E54366292F509D457", "WETH", BASE_MOONWELL, {
    router: "0x70778cfcFC475c7eA0f24cC625Baf6EaE475D0c9",
    payout: "0x1382cFf3CeE10D283DccA55A30496187759e4cAf",
  }),
  mtoken("optimism", "0x8E08617b0d66359D73Aa11E11017834C29155525", "USDC", OPTIMISM_MOONWELL),
  mtoken("optimism", "0xb4104C02BBf4E9be85AAa41a62974E4e28D59A33", "WETH", OPTIMISM_MOONWELL, {
    router: "0xc4Ab8C031717d7ecCCD653BE898e0f92410E11dC",
    payout: "0xa962F2974A846b30366251f4634384C1e42aeF16",
  }),
  // Morpho ERC-4626 vaults (curated by (network, address); never resolved by name or symbol)
  vault("base", "steakhouse-prime-usdc", "Steakhouse Prime USDC", "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", "USDC", "vault-v2"),
  vault("base", "gauntlet-usdc-prime", "Gauntlet USDC Prime", "0x050cE30b927Da55177A4914EC73480238BAD56f0", "USDC", "vault-v2"),
  vault("base", "gauntlet-usdc-prime-v1", "Gauntlet USDC Prime (V1)", "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", "USDC", "metamorpho-v1.0"),
  vault("base", "spark-usdc", "Spark USDC Vault", "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", "USDC", "metamorpho-v1.1"),
  vault("base", "moonwell-flagship-eth", "Moonwell Flagship ETH", "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1", "WETH", "metamorpho-v1.0"),
  vault("base", "steakhouse-prime-eth", "Steakhouse Prime ETH", "0xbeef00f0A818894a2Cf111644A5098421611100E", "WETH", "vault-v2"),
  vault("arbitrum", "steakhouse-high-yield-usdc", "Steakhouse High Yield USDC", "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA", "USDC", "metamorpho-v1.1"),
  vault("arbitrum", "bitget-steakhouse-usdc", "Bitget x Steakhouse USDC", "0xbeeff1D5dE8F79ff37a151681100B039661da518", "USDC", "vault-v2"),
  vault("ethereum", "steakhouse-prime-usdc", "Steakhouse Prime USDC", "0xbeef088055857739C12CD3765F20b7679Def0f51", "USDC", "vault-v2"),
  vault("ethereum", "gauntlet-usdc-prime", "Gauntlet USDC Prime", "0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0", "USDC", "vault-v2"),
  // isMetaMorpho confirmed by the pinned factories on 2026-10-15
  vault("ethereum", "steakhouse-usdc", "Steakhouse USDC", "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", "USDC", "metamorpho-v1.0"),
  vault("ethereum", "steakhouse-usdt", "Steakhouse USDT", "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa", "USDT", "metamorpho-v1.0"),
  vault("ethereum", "steakhouse-eth", "Steakhouse ETH", "0xBEEf050ecd6a16c4e7bfFbB52Ebba7846C4b8cD4", "WETH", "metamorpho-v1.0"),
  vault("optimism", "gauntlet-usdc-prime", "Gauntlet USDC Prime", "0xC30ce6A5758786e0F640cC5f881Dd96e9a1C5C59", "USDC", "metamorpho-v1.1"),
  vault("polygon", "compound-usdc", "Compound USDC", "0x781FB7F6d845E3bE129289833b04d43Aa8558c42", "USDC", "metamorpho-v1.1"),
  vault("polygon", "compound-usdt", "Compound USDT", "0xfD06859A671C21497a2EB8C5E3fEA48De924D6c8", "USDT0", "metamorpho-v1.1"),
  // added 2026-10-23 (factory isMetaMorpho / isVaultV2, asset(), decimals() and Vault V2 gates read back; existing defaults stay first)
  vault("ethereum", "spark-blue-chip-usdt", "Spark Blue Chip USDT Vault", "0xb0c424116172B55CbB6dD3136F5989F7959e5B91", "USDT", "vault-v2"),
  vault("ethereum", "steakhouse-prime-usdt", "Steakhouse Prime USDT", "0xbeef003C68896c7D2c3c60d363e8d71a49Ab2bf9", "USDT", "vault-v2"),
  vault("ethereum", "sky-usds-flagship", "sky.money USDS Flagship", "0xE15fcC81118895b67b6647BBd393182dF44E11E0", "USDS", "vault-v2"),
  vault("ethereum", "gauntlet-weth-prime", "Gauntlet WETH Prime", "0x2371e134e3455e0593363cBF89d3b6cf53740618", "WETH", "metamorpho-v1.0"),
  vault("base", "steakhouse-high-yield-usdc", "Steakhouse High Yield USDC Edition", "0xbeeff2490FEffa212faC2f6553682C219E6a8845", "USDC", "vault-v2"),
  vault("base", "grove-steakhouse-usdc", "Grove x Steakhouse USDC", "0xbeef0786756810478b88982DE00F3CD7fdB8e7c7", "USDC", "vault-v2"),
  vault("base", "steakhouse-eurc", "Steakhouse EURC", "0xBeEF086b8807Dc5E5A1740C5E3a7C4c366eA6ab5", "EURC", "metamorpho-v1.0"),
  vault("arbitrum", "bitget-steakhouse-usdt", "Bitget x Steakhouse USDT", "0xbeeff77CE5C059445714E6A3490E273fE7F2492F", "USDT0", "vault-v2"),
  vault("optimism", "re7-weth", "Re7 WETH", "0x3d63934715b6D4c4DFbBC1a00Fe2A2145079DD76", "WETH", "vault-v2"),
  vault("polygon", "compound-weth", "Compound WETH", "0xF5C81d25ee174d83f1FD202cA94AE6070d073cCF", "WETH", "metamorpho-v1.1"),
  // SparkLend reserves (Aave V3 fork: same venue kind, protocol "sparklend")
  aaveFamily("sparklend", "SparkLend", "ethereum", SPARKLEND_POOL, SPARKLEND_DATA, "USDC", "0x377C3bd93f2a2984E1E7bE6A5C22c525eD4A4815", 6),
  aaveFamily("sparklend", "SparkLend", "ethereum", SPARKLEND_POOL, SPARKLEND_DATA, "WETH", "0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB", 18),
  // Spark Savings (sUSDC first: Ethereum's default USDC savings venue)
  sparkVault("ethereum", "usdc", "Spark Savings USDC (sUSDC)", "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE", "USDC", 18, "susdc-v1", "0xf943Cb8D5f06f2bBF352878ebEF3Ec5C537A20bA", { psm: "0xA188EEC8F81263234dA3622A406892F3D630f98c" }),
  sparkVault("ethereum", "spusdc", "Spark Savings USDC (spUSDC)", "0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d", "USDC", 6, "spark-vault-v2", SPARK_VAULT_V2_IMPLEMENTATION, { admin: SPARK_VAULT_V2_ADMIN }),
  sparkVault("ethereum", "speth", "Spark Savings ETH (spETH)", "0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f", "WETH", 18, "spark-vault-v2", SPARK_VAULT_V2_IMPLEMENTATION, { admin: SPARK_VAULT_V2_ADMIN }),
  sparkVault("base", "usdc", "Spark Savings USDC (sUSDC)", "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858", "USDC", 18, "susdc-v1", "0x6ACC02ddd82206a44ff4EC13977E63d1a29C7723", { psm: "0x1601843c5E9bC251A3272907010AFa41Fa18347E" }),
  sparkVault("arbitrum", "usdc", "Spark Savings USDC (sUSDC)", "0x940098b108fB7D0a7E374f6eDED7760787464609", "USDC", 18, "susdc-v1", "0xdC8DF20bE448E41FdE88E2478d6Bc4d3C9A092d6", { psm: "0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266" }),
  sparkVault("optimism", "usdc", "Spark Savings USDC (sUSDC)", "0xCF9326e24EBfFBEF22ce1050007A43A3c0B6DB55", "USDC", 18, "susdc-v1", "0x3a1d3A9B0eD182d7B17aa61393D46a4f4EE0CEA5", { psm: "0xe0F9978b907853F354d79188A3dEfbD41978af62" }),
  // Fluid fTokens (proven by the LendingFactory)
  fToken("ethereum", "USDC", "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", 6),
  fToken("ethereum", "WETH", "0x90551c1795392094FE6D29B758EcCD233cFAa260", 18),
  fToken("arbitrum", "USDC", "0x1A996cb54bb95462040408C06122D45D6Cdb6096", 6),
  fToken("arbitrum", "WETH", "0x45Df0656F8aDf017590009d2f1898eeca4F0a205", 18),
  fToken("base", "USDC", "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", 6),
  fToken("base", "WETH", "0x9272D6153133175175Bc276512B2336BE3931CE9", 18),
  fToken("polygon", "USDC", "0x571d456b578fDC34E26E6D636736ED7c0CDB9d89", 6),
  fToken("polygon", "WETH", "0xD3154535E4D0e179583ad694859E4e876EB12d24", 18),
  // Yearn V3 vaults (registry-endorsed clones of the 3.0.2 vault)
  yearnVault("ethereum", "usdc-1", "Yearn V3 USDC-1", "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204", "USDC", 6),
  yearnVault("ethereum", "weth-1", "Yearn V3 WETH-1", "0xc56413869c6CDf96496f2b1eF801fEDBdFA7dDB0", "WETH", 18),
  // Sky savings (sUSDS first: Ethereum's default USDS savings venue) and Ethena sUSDe (deposits only: cooldown exits)
  savingsVault("sky", "susds", "Sky Savings USDS (sUSDS)", "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", "USDS", "susds", SUSDS_IMPLEMENTATION, [{ call: "usds", address: USDS_TOKEN }]),
  savingsVault("sky", "sdai", "Savings Dai (sDAI)", "0x83F20F44975D03b1b09e64809B757c47f942BEeA", "DAI", "sdai", null, [
    { call: "pot", address: "0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7" },
    { call: "daiJoin", address: "0x9759A6Ac90977b93B58547b4A71c78317f391A28" },
  ]),
  savingsVault("ethena", "susde", "Ethena Staked USDe (sUSDe)", "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", "USDe", "susde", null, [
    { call: "silo", address: "0x7FC7c91D556B400AFa565013E3F32055a0713425" },
  ], ["deposit"]),
  // Jupiter Lend Earn (jlToken mint = receipt). jlWSOL is listed for discovery until SOL wrapping is supported.
  jlToken("USDC", "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", 6),
  jlToken("USDT", "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A", 6),
  jlToken("SOL", "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", 9, []),
  // Kamino main market reserves (pinned by reserve address: the market also lists decoy USDC reserves)
  kaminoReserve("USDC", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"),
  kaminoReserve("SOL", "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U"),
  kaminoReserve("USDT", "H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S"),
  kaminoReserve("PYUSD", "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN"),
  // Kamino JLP and Altcoins market reserves (the Altcoins market lists capped USDC decoys: pinned by address).
  // Named only: executed when a sentence names the venue ("into kamino jlp-usdc"), never picked for a plain "kamino".
  kaminoReserve("USDC", "Ga4rZytCpq1unD4DbEJ5bkHeUz9g3oh9AAFEi6vSauXp", "GENey8es3EgGiNTM8H8gzA3vf98haQF8LHiYFyErjgrv", KAMINO_JLP),
  kaminoReserve("USDT", "2ov3CMqPBYG3jNBmmpXgK9KMW5GmU5GWZNGcwf7w3BC1", "BXE6FX8arPDS9uaQzdpTeqvFt4zAzWeUhnYuXUFzA8Hb", KAMINO_JLP),
  kaminoReserve("PYUSD", "FswUCVjvfAuzHCgPDF95eLKscGsLHyJmD6hzkhq26CLe", "5aeoJKE5beaV8uJJnWRbGYxRTRrZCJi4mGgmK8yPE1wr", KAMINO_JLP),
  kaminoReserve("USDC", "9TD2TSv4pENb8VwfbVYg25jvym7HN6iuAR6pFNSrKjqQ", "HTyrXvSvBbD7WstvU3oqFTBZM1fPZJPxVRvwLAmCTDyJ", KAMINO_ALTCOINS),
  // Save main pool reserves (cToken = reserve collateral mint, liquidity decimals)
  saveReserve("USDC", "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw", "8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf", "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk", 6),
  saveReserve("USDT", "8K9WC8xoh2rtQNY7iEGXtPvfbDCi563SdWhCAhuMP2xE", "3CdpSW5dxM7RTxBgxeyt8nnnjqoDbZe48tsBs9QUrmuN", "BTsbZDV7aCMRJ3VNy9ygV4Q2UeEo9GpR8D6VvmMZzNr8", 6),
] satisfies readonly YieldVenue[]);

const VENUE_BY_ID = new Map<string, YieldVenue>(YIELD_VENUES.map((venue) => [venue.id, venue]));

export function getYieldVenue(id: string): YieldVenue | null {
  return VENUE_BY_ID.get(id) ?? null;
}

export function yieldVenuesFor(network: NetworkKey, protocol?: ProtocolId): YieldVenue[] {
  return YIELD_VENUES.filter((venue) => venue.network === network && (!protocol || venue.protocol === protocol));
}

export function sameVenueAddress(network: NetworkKey, a: string, b: string): boolean {
  return network.startsWith("solana") ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Finds a venue on `network` by id, slug, target address or receipt token
 * (case-insensitive on EVM). Never matches across networks.
 */
export function findYieldVenue(network: NetworkKey, reference: string, protocol?: ProtocolId): YieldVenue | null {
  const wanted = reference.trim();
  if (!wanted) return null;
  const candidates = yieldVenuesFor(network, protocol);
  return (
    candidates.find((venue) => venue.id === wanted) ??
    candidates.find((venue) => venue.slug === wanted.toLowerCase()) ??
    candidates.find((venue) => venue.kind !== "kamino-reserve" && venue.kind !== "jupiter-lend" && venue.kind !== "save-reserve" && sameVenueAddress(network, venue.target, wanted)) ??
    candidates.find((venue) => "receipt" in venue && sameVenueAddress(network, venue.receipt.address, wanted)) ??
    candidates.find((venue) => (venue.kind === "kamino-reserve" || venue.kind === "save-reserve") && venue.reserve === wanted) ??
    null
  );
}
