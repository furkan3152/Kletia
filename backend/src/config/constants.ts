// backend/src/config/constants.ts
import { getAddress } from 'viem';

export const TOKENS: Record<string, `0x${string}`> = {
    "ETH": getAddress("0x4200000000000000000000000000000000000006"), 
    "WETH": getAddress("0x4200000000000000000000000000000000000006"),
    "USDC": getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    "CBBTC": getAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"), 
    "DAI": getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"),
    "AERO": getAddress("0x940181a94A35A4569E4529A3CDfB74e38FD98631"),
    "DEGEN": getAddress("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"),
    "BRETT": getAddress("0x532f27101965dd16442E59d40670FaF5eBB142E4"),
    "TOSHI": getAddress("0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4"),
    "WSTETH": getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452"),
    "CBETH": getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"),
    "RETH": getAddress("0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c")
};

export const ROUTERS = {
    AERO_V1: getAddress("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
    AERO_FACTORY: getAddress("0x420DD3807E0e1215bb6b445946afbc97112918a5"),
    AERO_SLIPSTREAM: getAddress("0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5"),
    AERO_SLIPSTREAM_QUOTER: getAddress("0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0"),
    UNI_V3: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
    UNI_V3_QUOTER: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
    UNI_V2: getAddress("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"),
    ALIEN_BASE: getAddress("0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7"),
    PANCAKE_V2: getAddress("0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb"),
    SUSHI_V2: getAddress("0x71524B4f93c58fcbF659783284E38825f0622859"),
    PANCAKE_V3: getAddress("0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86"),
    PANCAKE_V3_QUOTER: getAddress("0x77b482D9A4E391d682C857C630B8d869FdeE5c44"),
    BNS_RESOLVER: getAddress("0xC6d566A56A1aFf6508b41f6c90ff131615583BCD"),
    BASESWAP: getAddress("0x327Df1E6de05895d2ab08513aaDD9313Fe505d86"),
    SWAPBASED: getAddress("0xaaa3b1F1bd7Bcc97fd1917c18ADE665C5D31F066"),
    MORPHO_BLUE: getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"),
    AAVE_V3_POOL: getAddress("0xa238dd80c279a74f8c654366657903b1e33f98c5"),
    COMPOUND_V3_USDC: getAddress("0x9c4ec768c28520B5086047a155f44376213a9f58"),
    KLETIA_TOKEN_FACTORY: getAddress("0x69d1cfca1916a310edba69a6becd1702c7ac8d64")
};

// DEX ABI'leri
export const UNI_V2_ROUTER_ABI = [
    { "inputs": [{ "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "address[]", "name": "path", "type": "address[]" }], "name": "getAmountsOut", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "view", "type": "function" }, 
    { "inputs": [{ "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "address[]", "name": "path", "type": "address[]" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "swapExactETHForTokens", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "payable", "type": "function" }, 
    { "inputs": [{ "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "address[]", "name": "path", "type": "address[]" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "swapExactTokensForTokens", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "address[]", "name": "path", "type": "address[]" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "swapExactTokensForETH", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "nonpayable", "type": "function" }
] as const;

export const AERO_ETH_ABI = [{ "inputs": [{ "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "components": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "address", "name": "factory", "type": "address" }], "internalType": "struct IRouter.Route[]", "name": "routes", "type": "tuple[]" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "swapExactETHForTokens", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "payable", "type": "function" }] as const;
export const AERODROME_ROUTER_ABI = [{ "inputs": [{ "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "components": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "address", "name": "factory", "type": "address" }], "internalType": "struct IRouter.Route[]", "name": "routes", "type": "tuple[]" }], "name": "getAmountsOut", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "components": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "bool", "name": "stable", "type": "bool" }, { "internalType": "address", "name": "factory", "type": "address" }], "internalType": "struct IRouter.Route[]", "name": "routes", "type": "tuple[]" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }], "name": "swapExactTokensForTokens", "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }], "stateMutability": "nonpayable", "type": "function" }] as const;
export const SLIPSTREAM_QUOTER_ABI = [{ "inputs": [{ "components": [{ "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "int24", "name": "tickSpacing", "type": "int24" }, { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams", "name": "params", "type": "tuple" }], "name": "quoteExactInputSingle", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }, { "internalType": "uint160", "name": "sqrtPriceX96After", "type": "uint160" }, { "internalType": "uint32", "name": "initializedTicksCrossed", "type": "uint32" }, { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }] as const;
export const SLIPSTREAM_ROUTER_ABI = [{ "inputs": [{ "components": [{ "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "int24", "name": "tickSpacing", "type": "int24" }, { "internalType": "address", "name": "recipient", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" }, { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }], "internalType": "struct ISwapRouter.ExactInputSingleParams", "name": "params", "type": "tuple" }], "name": "exactInputSingle", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }], "stateMutability": "payable", "type": "function" }] as const;
export const V3_ROUTER_02_ABI = [{ "inputs": [{ "components": [{ "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint24", "name": "fee", "type": "uint24" }, { "internalType": "address", "name": "recipient", "type": "address" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" }, { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }], "internalType": "struct IV3SwapRouter.ExactInputSingleParams", "name": "params", "type": "tuple" }], "name": "exactInputSingle", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }], "stateMutability": "payable", "type": "function" }] as const;
export const V3_QUOTER_V2_ABI = [{ "inputs": [{ "components": [{ "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" }, { "internalType": "uint24", "name": "fee", "type": "uint24" }, { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams", "name": "params", "type": "tuple" }], "name": "quoteExactInputSingle", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }, { "internalType": "uint160", "name": "sqrtPriceX96After", "type": "uint160" }, { "internalType": "uint32", "name": "initializedTicksCrossed", "type": "uint32" }, { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }] as const;

export const KLETIA_TOKEN_FACTORY_ABI = [
    { "inputs": [{ "internalType": "string", "name": "name", "type": "string" }, { "internalType": "string", "name": "symbol", "type": "string" }, { "internalType": "uint256", "name": "totalSupply", "type": "uint256" }], "name": "createToken", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "nonpayable", "type": "function" }
] as const;

export const ZORA_ERC721_DROP_ABI = [
    { "inputs": [{ "internalType": "address", "name": "recipient", "type": "address" }, { "internalType": "uint256", "name": "quantity", "type": "uint256" }, { "internalType": "string", "name": "comment", "type": "string" }, { "internalType": "address", "name": "mintReferral", "type": "address" }], "name": "mintWithRewards", "outputs": [], "stateMutability": "payable", "type": "function" }
] as const;