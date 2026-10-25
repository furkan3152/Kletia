/**
 * Pinned Base addresses and the ABIs the portfolio viewer reads.
 */
import { getAddress } from "viem";
import {
  AAVE_V3_BASE,
  BASE_STAKING_CONTRACTS,
  BASE_TOKEN_REGISTRY,
} from "../../protocols.js";

export const AAVE_POOL = AAVE_V3_BASE.pool;
export const VE_AERO = BASE_STAKING_CONTRACTS.veAero;
export const WSTETH = BASE_TOKEN_REGISTRY.WSTETH.address;
export const CBETH = BASE_TOKEN_REGISTRY.CBETH.address;
export const RETH = BASE_TOKEN_REGISTRY.RETH.address;
export const BNS_NFT = getAddress("0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a");
export const WETH_ADDRESS = BASE_TOKEN_REGISTRY.WETH.address;

export const AAVE_ACCOUNT_ABI = [
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { internalType: "uint256", name: "totalCollateralBase", type: "uint256" },
      { internalType: "uint256", name: "totalDebtBase", type: "uint256" },
      {
        internalType: "uint256",
        name: "availableBorrowsBase",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "currentLiquidationThreshold",
        type: "uint256",
      },
      { internalType: "uint256", name: "ltv", type: "uint256" },
      { internalType: "uint256", name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const VE_AERO_ABI = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "tokenOfOwnerByIndex",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "locked",
    outputs: [
      { internalType: "int128", name: "amount", type: "int128" },
      { internalType: "uint256", name: "end", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "balanceOfNFT",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const COMET_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const MOONWELL_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceStored",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOfUnderlying",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
