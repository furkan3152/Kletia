import { parseAbi } from "viem";

export const UNISWAP_V3_QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

export const UNISWAP_V3_SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export {
  AAVE_V3_ADDRESSES_PROVIDER_ABI,
  AAVE_V3_DATA_PROVIDER_ABI,
  AAVE_V3_ORACLE_ABI,
  AAVE_V3_POOL_ABI,
} from "../../shared/protocols/aave/abis.js";
