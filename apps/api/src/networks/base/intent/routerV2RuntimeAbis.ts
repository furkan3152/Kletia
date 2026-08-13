export const KLETIA_INTENT_ROUTER_V2_RUNTIME_ABI = [
  {
    type: "function",
    name: "wrappedNative",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "wrappedNativeCodehash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "adapterConfig",
    stateMutability: "view",
    inputs: [{ name: "adapter", type: "address" }],
    outputs: [
      { name: "configured", type: "bool" },
      { name: "enabled", type: "bool" },
      { name: "target", type: "address" },
      { name: "spender", type: "address" },
      { name: "adapterCodehash", type: "bytes32" },
      { name: "targetCodehash", type: "bytes32" },
      { name: "spenderCodehash", type: "bytes32" },
      {
        name: "adapterConfigurationHash",
        type: "bytes32",
      },
      { name: "configHash", type: "bytes32" },
    ],
  },
] as const;

export const KLETIA_UNISWAP_V2_ADAPTER_RUNTIME_ABI = [
  {
    type: "function",
    name: "actionKind",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "target",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "spender",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "wrappedNative",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "targetCodehash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "factoryCodehash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "wrappedNativeCodehash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "configurationHash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export const KLETIA_UNISWAP_V3_ADAPTER_RUNTIME_ABI = [
  ...KLETIA_UNISWAP_V2_ADAPTER_RUNTIME_ABI,
  {
    type: "function",
    name: "ADAPTER_FORMAT_VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export const UNISWAP_V2_ROUTER02_RUNTIME_ABI = [
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "WETH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const UNISWAP_V3_SWAP_ROUTER02_RUNTIME_ABI = [
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "WETH9",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
