import { getAddress, type Address } from "viem";

export type BaseRiskTier = "core" | "established" | "elevated";
export type BaseProtocolDomain = "swap" | "lending" | "staking";
export type BaseExecutionMode = "direct" | "kletia_fee_router";
export type BaseCallerSemantics =
  "explicit_recipient" | "on_behalf_of" | "msg_sender_owns_position";

export interface BaseTokenDefinition {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly riskTier: BaseRiskTier;
}

const token = (
  symbol: string,
  address: string,
  decimals: number,
  riskTier: BaseRiskTier,
): BaseTokenDefinition => ({
  symbol,
  address: getAddress(address.toLowerCase()),
  decimals,
  riskTier,
});

export const BASE_TOKEN_REGISTRY = {
  ETH: token("ETH", "0x4200000000000000000000000000000000000006", 18, "core"),
  WETH: token("WETH", "0x4200000000000000000000000000000000000006", 18, "core"),
  USDC: token("USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913", 6, "core"),
  USDBC: token(
    "USDbC",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    6,
    "established",
  ),
  CBBTC: token(
    "cbBTC",
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    8,
    "core",
  ),
  DAI: token(
    "DAI",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
    18,
    "established",
  ),
  AERO: token(
    "AERO",
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
    18,
    "established",
  ),
  DEGEN: token(
    "DEGEN",
    "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
    18,
    "elevated",
  ),
  BRETT: token(
    "BRETT",
    "0x532f27101965dd16442e59d40670faf5ebb142e4",
    18,
    "elevated",
  ),
  TOSHI: token(
    "TOSHI",
    "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4",
    18,
    "elevated",
  ),
  WSTETH: token(
    "wstETH",
    "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
    18,
    "established",
  ),
  CBETH: token(
    "cbETH",
    "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
    18,
    "established",
  ),
  RETH: token(
    "rETH",
    "0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c",
    18,
    "established",
  ),
  WEETH: token(
    "weETH",
    "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a",
    18,
    "established",
  ),
  EZETH: token(
    "ezETH",
    "0x2416092f143378750bb29b79ed961ab195cceea5",
    18,
    "established",
  ),
  WRSETH: token(
    "wrsETH",
    "0xedfa23602d0ec14714057867a78d01e94176bea0",
    18,
    "established",
  ),
  GHO: token(
    "GHO",
    "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee",
    18,
    "established",
  ),
  EURC: token(
    "EURC",
    "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    6,
    "established",
  ),
  AAVE: token(
    "AAVE",
    "0x63706e401c06ac8513145b7687a14804d17f814b",
    18,
    "established",
  ),
  TBTC: token(
    "tBTC",
    "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
    18,
    "established",
  ),
  LBTC: token(
    "LBTC",
    "0xecac9c5f704e954931349da37f60e39f515c11c1",
    8,
    "established",
  ),
  SYRUPUSDC: token(
    "syrupUSDC",
    "0x660975730059246a68521a3e2fbd4740173100f5",
    6,
    "established",
  ),
  USDS: token(
    "USDS",
    "0x820c137fa70c8691f0e44dc420a5e53c168921dc",
    18,
    "established",
  ),
  WELL: token(
    "WELL",
    "0xa88594d404727625a9437c3f886c7643872296ae",
    18,
    "established",
  ),
  VIRTUAL: token(
    "VIRTUAL",
    "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
    18,
    "elevated",
  ),
  MORPHO: token(
    "MORPHO",
    "0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842",
    18,
    "established",
  ),
  CBXRP: token(
    "cbXRP",
    "0xcb585250f852c6c6bf90434ab21a00f02833a4af",
    6,
    "elevated",
  ),
  MAMO: token(
    "MAMO",
    "0x7300b37dfdfab110d83290a29dfb31b1740219fe",
    18,
    "elevated",
  ),
  VVV: token(
    "VVV",
    "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf",
    18,
    "elevated",
  ),
  COMP: token(
    "COMP",
    "0x9e1028f5f1d5ede59748ffcee5532509976840e0",
    18,
    "established",
  ),
  SEAM: token(
    "SEAM",
    "0x1c7a460413dd4e964f96d8dfc56e7223ce88cd85",
    18,
    "established",
  ),
  SUSDS: token(
    "sUSDS",
    "0x5875eee11cf8398102fdad704c9e96607675467a",
    18,
    "established",
  ),
} as const satisfies Record<string, BaseTokenDefinition>;

export const BASE_TOKEN_ADDRESSES: Record<string, Address> = Object.freeze(
  Object.fromEntries(
    Object.entries(BASE_TOKEN_REGISTRY).map(([symbol, definition]) => [
      symbol,
      definition.address,
    ]),
  ),
);

export interface AaveReserveDefinition {
  readonly token: keyof typeof BASE_TOKEN_REGISTRY;
  readonly riskTier: BaseRiskTier;
}

export const AAVE_V3_BASE = {
  pool: getAddress("0xa238dd80c259a72e81d7e4664a9801593f98d1c5"),
  protocolDataProvider: getAddress(
    "0x0f43731eb8d45a581f4a36dd74f5f358bc90c73a",
  ),
  reserves: [
    { token: "WETH", riskTier: "core" },
    { token: "CBETH", riskTier: "established" },
    { token: "USDBC", riskTier: "established" },
    { token: "WSTETH", riskTier: "established" },
    { token: "USDC", riskTier: "core" },
    { token: "WEETH", riskTier: "established" },
    { token: "CBBTC", riskTier: "core" },
    { token: "EZETH", riskTier: "established" },
    { token: "GHO", riskTier: "established" },
    { token: "WRSETH", riskTier: "established" },
    { token: "LBTC", riskTier: "established" },
    { token: "EURC", riskTier: "established" },
    { token: "AAVE", riskTier: "established" },
    { token: "TBTC", riskTier: "established" },
    { token: "SYRUPUSDC", riskTier: "established" },
  ] as const satisfies readonly AaveReserveDefinition[],
  officialSources: [
    "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol",
    "https://aave.com/docs/developers/smart-contracts/pool",
  ],
} as const;

export interface MoonwellMarketDefinition {
  readonly token: keyof typeof BASE_TOKEN_REGISTRY;
  readonly market: Address;
  readonly riskTier: BaseRiskTier;
}

const moonwellMarket = (
  tokenSymbol: keyof typeof BASE_TOKEN_REGISTRY,
  address: string,
  riskTier: BaseRiskTier,
): MoonwellMarketDefinition => ({
  token: tokenSymbol,
  market: getAddress(address.toLowerCase()),
  riskTier,
});

export const MOONWELL_BASE = {
  comptroller: getAddress("0xfbb21d0380bee3312b33c4353c8936a0f13ef26c"),
  views: getAddress("0x6834770aba6c2028f448e3259ddee4bcb879d459"),
  markets: [
    moonwellMarket(
      "USDBC",
      "0x703843c3379b52f9ff486c9f5892218d2a065cc8",
      "established",
    ),
    moonwellMarket(
      "WETH",
      "0x628ff693426583d9a7fb391e54366292f509d457",
      "core",
    ),
    moonwellMarket(
      "CBETH",
      "0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5",
      "established",
    ),
    moonwellMarket(
      "DAI",
      "0x73b06d8d18de422e269645eace15400de7462417",
      "established",
    ),
    moonwellMarket(
      "USDC",
      "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22",
      "core",
    ),
    moonwellMarket(
      "WSTETH",
      "0x627fe393bc6edda28e99ae648fd6ff362514304b",
      "established",
    ),
    moonwellMarket(
      "RETH",
      "0xcb1dacd30638ae38f2b94ea64f066045b7d45f44",
      "established",
    ),
    moonwellMarket(
      "AERO",
      "0x73902f619ceb9b31fd8efecf435cbdf89e369ba6",
      "established",
    ),
    moonwellMarket(
      "WEETH",
      "0xb8051464c8c92209c92f3a4cd9c73746c4c3cfb3",
      "established",
    ),
    moonwellMarket(
      "CBBTC",
      "0xf877acafa28c19b96727966690b2f44d35ad5976",
      "core",
    ),
    moonwellMarket(
      "EURC",
      "0xb682c840b5f4fc58b20769e691a6fa1305a501a2",
      "established",
    ),
    moonwellMarket(
      "WRSETH",
      "0xfc41b49d064ac646015b459c522820db9472f4b5",
      "established",
    ),
    moonwellMarket(
      "WELL",
      "0xdc7810b47eaab250de623f0ee07764afa5f71ed1",
      "established",
    ),
    moonwellMarket(
      "USDS",
      "0xb6419c6c2e60c4025d6d06ee4f913ce89425a357",
      "established",
    ),
    moonwellMarket(
      "TBTC",
      "0x9a858ebff1beb0d3495bb0e2897c1528ed84a218",
      "established",
    ),
    moonwellMarket(
      "LBTC",
      "0x10ff57877b79e9bd949b3815220ec87b9fc5d2ee",
      "established",
    ),
    moonwellMarket(
      "VIRTUAL",
      "0xde8df9d942d78ede3ca06e60712582f79cfffc64",
      "elevated",
    ),
    moonwellMarket(
      "MORPHO",
      "0x6308204872bdb7432df97b04b42443c714904f3e",
      "established",
    ),
    moonwellMarket(
      "CBXRP",
      "0xb4fb8fed5b3aaa8434f0b19b1b623d977e07e86d",
      "elevated",
    ),
    moonwellMarket(
      "MAMO",
      "0x2f90bb22eb3979f5ffad31ea6c3f0792ca66da32",
      "elevated",
    ),
    moonwellMarket(
      "VVV",
      "0xd64bcb70c613a6d1f4d7d57ba64bb4a0767a9682",
      "elevated",
    ),
  ],
  officialSources: [
    "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
    "https://github.com/moonwell-fi/moonwell-contracts-v2",
  ],
} as const;

export interface CompoundCometDefinition {
  readonly id: string;
  readonly token: keyof typeof BASE_TOKEN_REGISTRY;
  readonly comet: Address;
  readonly riskTier: BaseRiskTier;
}

const comet = (
  id: string,
  tokenSymbol: keyof typeof BASE_TOKEN_REGISTRY,
  address: string,
  riskTier: BaseRiskTier,
): CompoundCometDefinition => ({
  id,
  token: tokenSymbol,
  comet: getAddress(address.toLowerCase()),
  riskTier,
});

export const COMPOUND_V3_BASE = {
  markets: [
    comet(
      "compound-aero",
      "AERO",
      "0x784efeb622244d2348d4f2522f8860b96fbecE89",
      "established",
    ),
    comet(
      "compound-usdbc",
      "USDBC",
      "0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf",
      "established",
    ),
    comet(
      "compound-usdc",
      "USDC",
      "0xb125e6687d4313864e53df431d5425969c15eb2f",
      "core",
    ),
    comet(
      "compound-usds",
      "USDS",
      "0x2c776041ccfe903071af44aa147368a9c8eea518",
      "established",
    ),
    comet(
      "compound-weth",
      "WETH",
      "0x46e6b214b524310239732d51387075e0e70970bf",
      "core",
    ),
  ],
  officialSources: [
    "https://github.com/compound-finance/comet/tree/main/deployments/base",
    "https://docs.compound.finance/",
  ],
} as const;

export interface BaseErc4626VaultDefinition {
  readonly id: string;
  readonly protocolId:
    "moonwell-vault" | "seamless-vault" | "spark-vault" | "fluid-vault";
  readonly name: string;
  readonly token: keyof typeof BASE_TOKEN_REGISTRY;
  readonly vault: Address;
  readonly riskTier: BaseRiskTier;
  readonly officialSource: string;
}

const erc4626Vault = (
  id: string,
  protocolId: BaseErc4626VaultDefinition["protocolId"],
  name: string,
  tokenSymbol: keyof typeof BASE_TOKEN_REGISTRY,
  address: string,
  officialSource: string,
): BaseErc4626VaultDefinition => ({
  id,
  protocolId,
  name,
  token: tokenSymbol,
  vault: getAddress(address.toLowerCase()),
  riskTier: "established",
  officialSource,
});

export const BASE_ERC4626_VAULTS = [
  erc4626Vault(
    "moonwell-usdc",
    "moonwell-vault",
    "Moonwell Flagship USDC",
    "USDC",
    "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca",
    "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
  ),
  erc4626Vault(
    "moonwell-weth",
    "moonwell-vault",
    "Moonwell Flagship ETH",
    "WETH",
    "0xa0e430870c4604ccfc7b38ca7845b1ff653d0ff1",
    "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
  ),
  erc4626Vault(
    "moonwell-eurc",
    "moonwell-vault",
    "Moonwell Flagship EURC",
    "EURC",
    "0xf24608e0ccb972b0b0f4a6446a0bbf58c701a026",
    "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
  ),
  erc4626Vault(
    "moonwell-cbbtc",
    "moonwell-vault",
    "Moonwell Frontier cbBTC",
    "CBBTC",
    "0x543257ef2161176d7c8cd90ba65c2d4caef5a796",
    "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
  ),
  erc4626Vault(
    "seamless-usdc",
    "seamless-vault",
    "Seamless USDC Vault",
    "USDC",
    "0x616a4e1db48e22028f6bbf20444cd3b8e3273738",
    "https://docs.seamlessprotocol.com/technical/smart-contracts-1",
  ),
  erc4626Vault(
    "seamless-cbbtc",
    "seamless-vault",
    "Seamless cbBTC Vault",
    "CBBTC",
    "0x5a47c803488fe2bb0a0eaaf346b420e4df22f3c7",
    "https://docs.seamlessprotocol.com/technical/smart-contracts-1",
  ),
  erc4626Vault(
    "seamless-weth",
    "seamless-vault",
    "Seamless WETH Vault",
    "WETH",
    "0x27d8c7273fd3fcc6956a0b370ce5fd4a7fc65c18",
    "https://docs.seamlessprotocol.com/technical/smart-contracts-1",
  ),
  erc4626Vault(
    "spark-susdc",
    "spark-vault",
    "Spark USDC Vault (sUSDC)",
    "USDC",
    "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858",
    "https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Base.sol",
  ),
  erc4626Vault(
    "spark-morpho-usdc",
    "spark-vault",
    "Spark Curated Morpho USDC",
    "USDC",
    "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a",
    "https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Base.sol",
  ),
  erc4626Vault(
    "fluid-usdc",
    "fluid-vault",
    "Fluid USDC",
    "USDC",
    "0xf42f5795d9ac7e9d757db633d693cd548cfd9169",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
  erc4626Vault(
    "fluid-weth",
    "fluid-vault",
    "Fluid WETH",
    "WETH",
    "0x9272d6153133175175bc276512b2336be3931ce9",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
  erc4626Vault(
    "fluid-eurc",
    "fluid-vault",
    "Fluid EURC",
    "EURC",
    "0x1943fa26360f038230442525cf1b9125b5dcb401",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
  erc4626Vault(
    "fluid-gho",
    "fluid-vault",
    "Fluid GHO",
    "GHO",
    "0x8ddbffa3cfda2355a23d6b11105ac624bdbe3631",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
  erc4626Vault(
    "fluid-susds",
    "fluid-vault",
    "Fluid Savings USDS",
    "SUSDS",
    "0xf62e339f21d8018940f188f6987bcdf02a849619",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
  erc4626Vault(
    "fluid-wsteth",
    "fluid-vault",
    "Fluid wstETH",
    "WSTETH",
    "0x896e39f0e9af61eca9dd2938e14543506ef2c2b5",
    "https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base",
  ),
] as const satisfies readonly BaseErc4626VaultDefinition[];

export const BASE_STAKING_CONTRACTS = {
  veAero: getAddress("0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4"),
  stkWell: getAddress("0xe66e3a37c3274ac24fe8590f7d84a2427194dc17"),
  stkSeam: getAddress("0x73f0849756f6a79c1d536b7abab1e6955f7172a4"),
} as const;

export const MORPHO_BLUE_BASE = {
  core: getAddress("0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"),
  adaptiveCurveIrm: getAddress("0x46415998764c29ab2a25cbea6254146d50d22687"),
  oracleFactory: getAddress("0x2dc205f24bcb6b311e5cdf0745b0741648aebd3d"),
  executionReady: false,
  reason:
    "Generic Morpho execution requires an exact verified MarketParams tuple; the core address alone is not a safe executable route.",
  officialSources: ["https://docs.morpho.org/developers/contracts/addresses/"],
} as const;

export interface BaseSwapCandidate {
  readonly id: string;
  readonly name: string;
  readonly target: Address;
  readonly integrationStatus:
    | "live"
    | "fee_router_allowlist_required"
    | "dynamic_api_binding_required"
    | "incompatible_permit2";
  readonly officialSource: string;
}

const swapCandidate = (
  id: string,
  name: string,
  target: string,
  integrationStatus: BaseSwapCandidate["integrationStatus"],
  officialSource: string,
): BaseSwapCandidate => ({
  id,
  name,
  target: getAddress(target.toLowerCase()),
  integrationStatus,
  officialSource,
});

export const BASE_SWAP_EXPANSION_CANDIDATES = [
  swapCandidate(
    "zero-x",
    "0x AllowanceHolder (API-bound spender)",
    "0x0000000000001ff3684f28c67538d4d072c22734",
    "dynamic_api_binding_required",
    "https://docs.0x.org/docs/core-concepts/contracts",
  ),
  swapCandidate(
    "one-inch",
    "1inch AggregationRouterV6",
    "0x111111125421ca6dc452d289314280a0f8842a65",
    "fee_router_allowlist_required",
    "https://business.1inch.com/portal/documentation/apis/swap/classic-swap/quick-start",
  ),
  swapCandidate(
    "odos",
    "Odos Router V2",
    "0x19ceead7105607cd444f5ad10dd51356436095a1",
    "fee_router_allowlist_required",
    "https://github.com/odos-xyz/odos-router-v2",
  ),
  swapCandidate(
    "kyber",
    "Kyber MetaAggregationRouterV2",
    "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
    "fee_router_allowlist_required",
    "https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/contracts",
  ),
  swapCandidate(
    "balancer-v2",
    "Balancer V2 Vault",
    "0xba12222222228d8ba445958a75a0704d566bf2c8",
    "fee_router_allowlist_required",
    "https://github.com/balancer/balancer-deployments",
  ),
  swapCandidate(
    "curve",
    "Curve Router",
    "0x4f37a9d177470499a2dd084621020b023fcffc1f",
    "fee_router_allowlist_required",
    "https://github.com/curvefi/curve-js/blob/master/src/constants/network_constants.ts",
  ),
  swapCandidate(
    "woofi",
    "WOOFi V2 Router",
    "0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7",
    "fee_router_allowlist_required",
    "https://learn.woo.org/woofi-docs/woofi-dev-docs/references/readme/base",
  ),
  swapCandidate(
    "maverick-v1",
    "Maverick V1 Router",
    "0x32aed3bce901da12ca8489788f3a99fce1056e14",
    "fee_router_allowlist_required",
    "https://docs.mav.xyz/technical-reference/contract-addresses/v1-contract-addresses",
  ),
  swapCandidate(
    "aerodrome-slipstream-v3",
    "Aerodrome Slipstream Gauges V3 Router",
    "0x698cb2b6dd822994581fea6ea4fc755d1363a92f",
    "fee_router_allowlist_required",
    "https://github.com/aerodrome-finance/slipstream",
  ),
  swapCandidate(
    "uniswap-universal-router",
    "Uniswap Universal Router v2.1.1",
    "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
    "incompatible_permit2",
    "https://developers.uniswap.org/deployments.json",
  ),
  swapCandidate(
    "pancake-infinity",
    "Pancake Infinity Universal Router",
    "0xd9c500dff816a1da21a48a732d3498bf09dc9aeb",
    "incompatible_permit2",
    "https://github.com/pancakeswap/infinity-universal-router/blob/main/deploy-addresses/base-mainnet.json",
  ),
] as const satisfies readonly BaseSwapCandidate[];

export const BASE_PROTOCOL_ALIASES = Object.freeze({
  aave: "aave-v3",
  aavev3: "aave-v3",
  moonwell: "moonwell",
  well: "moonwell",
  compound: "compound-v3",
  compoundv3: "compound-v3",
  comet: "compound-v3",
  aerodrome: "aerodrome",
  aero: "aerodrome",
  veaero: "aerodrome",
  stkwell: "moonwell-safety-module",
  safetymodule: "moonwell-safety-module",
  moonwellsafetymodule: "moonwell-safety-module",
  seamless: "seamless-staking",
  stkseam: "seamless-staking",
  seamlessstaking: "seamless-staking",
  morpho: "morpho-blue",
  morphoblue: "morpho-blue",
  moonwellvault: "moonwell-vault",
  moonwellflagship: "moonwell-vault",
  seamlessvault: "seamless-vault",
  spark: "spark-vault",
  sparkvault: "spark-vault",
  fluid: "fluid-vault",
  fluidvault: "fluid-vault",
  uniswap: "uniswap",
  pancakeswap: "pancakeswap",
  pancake: "pancakeswap",
  sushiswap: "sushiswap",
  sushi: "sushiswap",
  alienbase: "alienbase",
  baseswap: "baseswap",
  swapbased: "swapbased",
  across: "across",
});

export function normalizeBaseProtocolId(
  input: string | undefined,
): string | undefined {
  if (!input || input === "unknown") return undefined;
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    BASE_PROTOCOL_ALIASES[normalized as keyof typeof BASE_PROTOCOL_ALIASES] ||
    normalized
  );
}

export function getBaseTokenDefinition(
  symbolOrAddress: string,
): BaseTokenDefinition | undefined {
  const normalized = symbolOrAddress.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    const address = normalized.toLowerCase();
    return Object.values(BASE_TOKEN_REGISTRY).find(
      (definition) => definition.address.toLowerCase() === address,
    );
  }
  const key = normalized.toUpperCase();
  return BASE_TOKEN_REGISTRY[key as keyof typeof BASE_TOKEN_REGISTRY];
}
