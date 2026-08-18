import { getAddress } from "viem";

export const ARBITRUM_TOKENS = Object.freeze({
  ETH: Object.freeze({ symbol: "ETH", decimals: 18, address: null }),
  WETH: Object.freeze({
    symbol: "WETH",
    decimals: 18,
    address: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  }),
  USDC: Object.freeze({
    symbol: "USDC",
    decimals: 6,
    address: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  }),
  ARB: Object.freeze({
    symbol: "ARB",
    decimals: 18,
    address: getAddress("0x912CE59144191C1204E64559FE8253a0e49E6548"),
  }),
});

export const ARBITRUM_CONTRACTS = Object.freeze({
  uniswapV3Factory: getAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  uniswapV3SwapRouter: getAddress(
    "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  ),
  uniswapV3QuoterV2: getAddress(
    "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  ),
  aaveV3PoolAddressesProvider: getAddress(
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  ),
  aaveV3Pool: getAddress("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
  aaveV3ProtocolDataProvider: getAddress(
    "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
  ),
  aaveV3Oracle: getAddress("0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7"),
  acrossSpokePool: getAddress(
    "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
  ),
  acrossMulticallHandler: getAddress(
    "0x924a9f036260DdD5808007E1AA95f08eD08aA569",
  ),
});

export type ArbitrumTokenSymbol = keyof typeof ARBITRUM_TOKENS;
