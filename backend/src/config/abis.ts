// backend/src/config/abis.ts

// ==========================================
// 🛡️ KLETIA OMNI-ÇEVİRMEN (Master ABI Library)
// GÜVENLİK İLKESİ: Sadece kullanılacak fonksiyonlar eklenmiştir (Verimlilik).
// ==========================================

// ------------------------------------------
// 💱 1. DEX (TAKAS) PROTOKOLLERİ
// ------------------------------------------

// ▶ AERODROME (Velodrome Fork - V2 Tarzı)
export const AERODROME_ROUTER_ABI = [
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            {
                "components": [
                    { "internalType": "address", "name": "from", "type": "address" },
                    { "internalType": "address", "name": "to", "type": "address" },
                    { "internalType": "bool", "name": "stable", "type": "bool" },
                    { "internalType": "address", "name": "factory", "type": "address" }
                ],
                "internalType": "struct IRouter.Route[]",
                "name": "routes",
                "type": "tuple[]"
            }
        ],
        "name": "getAmountsOut",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            {
                "components": [
                    { "internalType": "address", "name": "from", "type": "address" },
                    { "internalType": "address", "name": "to", "type": "address" },
                    { "internalType": "bool", "name": "stable", "type": "bool" },
                    { "internalType": "address", "name": "factory", "type": "address" }
                ],
                "internalType": "struct IRouter.Route[]",
                "name": "routes",
                "type": "tuple[]"
            },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactTokensForTokens",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;

// ▶ UNISWAP V3 & PANCAKESWAP V3 (Modern Konsantre Likidite)
export const UNISWAP_V3_ROUTER_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "tokenIn", "type": "address" },
                    { "internalType": "address", "name": "tokenOut", "type": "address" },
                    { "internalType": "uint24", "name": "fee", "type": "uint24" },
                    { "internalType": "address", "name": "recipient", "type": "address" },
                    { "internalType": "uint256", "name": "deadline", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
                    { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
                ],
                "internalType": "struct ISwapRouter.ExactInputSingleParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "exactInputSingle",
        "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
        "stateMutability": "payable",
        "type": "function"
    }
] as const;

// SADECE BU KISMI DEĞİŞTİR: Yeni Nesil V2 Quoter (Uniswap ve Pancake için ortak kullanılır)
export const UNISWAP_V3_QUOTER_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "tokenIn", "type": "address" },
                    { "internalType": "address", "name": "tokenOut", "type": "address" },
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint24", "name": "fee", "type": "uint24" },
                    { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
                ],
                "internalType": "struct IQuoterV2.QuoteExactInputSingleParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "quoteExactInputSingle",
        "outputs": [
            { "internalType": "uint256", "name": "amountOut", "type": "uint256" },
            { "internalType": "uint160", "name": "sqrtPriceX96After", "type": "uint160" },
            { "internalType": "uint32", "name": "initializedTicksCrossed", "type": "uint32" },
            { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;


// ------------------------------------------
// 🏦 2. DEFI & LENDING (BORÇ VERME/ALMA)
// ------------------------------------------

// ▶ AAVE V3 (Lending Standardı)
export const AAVE_V3_POOL_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "asset", "type": "address" },
            { "internalType": "uint256", "name": "amount", "type": "uint256" },
            { "internalType": "address", "name": "onBehalfOf", "type": "address" },
            { "internalType": "uint16", "name": "referralCode", "type": "uint16" }
        ],
        "name": "supply",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "asset", "type": "address" },
            { "internalType": "uint256", "name": "amount", "type": "uint256" },
            { "internalType": "uint256", "name": "interestRateMode", "type": "uint256" },
            { "internalType": "uint16", "name": "referralCode", "type": "uint16" },
            { "internalType": "address", "name": "onBehalfOf", "type": "address" }
        ],
        "name": "borrow",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;

// ▶ MOONWELL (Compound V2 Fork Tarzı - Base Ağının Gözdesi)
export const MOONWELL_MTOKEN_ABI = [
    {
        "inputs": [{ "internalType": "uint256", "name": "mintAmount", "type": "uint256" }],
        "name": "mint",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "uint256", "name": "borrowAmount", "type": "uint256" }],
        "name": "borrow",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;

// ▶ MORPHO BLUE (Yeni Nesil P2P Lending)
export const MORPHO_BLUE_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "loanToken", "type": "address" },
                    { "internalType": "address", "name": "collateralToken", "type": "address" },
                    { "internalType": "address", "name": "oracle", "type": "address" },
                    { "internalType": "address", "name": "irm", "type": "address" },
                    { "internalType": "uint256", "name": "lltv", "type": "uint256" }
                ],
                "internalType": "struct MarketParams",
                "name": "marketParams",
                "type": "tuple"
            },
            { "internalType": "uint256", "name": "assets", "type": "uint256" },
            { "internalType": "uint256", "name": "shares", "type": "uint256" },
            { "internalType": "address", "name": "onBehalfOf", "type": "address" },
            { "internalType": "bytes", "name": "data", "type": "bytes" }
        ],
        "name": "supply",
        "outputs": [
            { "internalType": "uint256", "name": "assetsSupplied", "type": "uint256" },
            { "internalType": "uint256", "name": "sharesSupplied", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;