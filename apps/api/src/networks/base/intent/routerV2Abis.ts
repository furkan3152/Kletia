export const KLETIA_INTENT_ROUTER_V2_ABI = [
  {
    type: "function",
    name: "isNonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "intentOwner", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "executeSwap",
    stateMutability: "payable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "adapter", type: "address" },
          { name: "adapterConfigHash", type: "bytes32" },
          { name: "adapterDataHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "issuedAt", type: "uint48" },
          { name: "validAfter", type: "uint48" },
          { name: "deadline", type: "uint48" },
          { name: "executor", type: "address" },
          { name: "maxFeeBps", type: "uint16" },
        ],
      },
      { name: "adapterData", type: "bytes" },
    ],
    outputs: [
      { name: "netAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
    ],
  },
] as const;

export const ERC20_EXACT_APPROVAL_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;
