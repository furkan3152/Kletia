// Fixture data for the admin panel's model tests and the screenshot run: a
// small catalog shaped like @kletia/core's admin catalog, records, a Safe
// proposal and fee rows. Addresses are the real pinned ones where the catalog
// pins them, so names in the address book read like the real panel.
export const ADMIN_EVM = "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A";
export const ADMIN_SOLANA = "D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm";
export const COSIGNER = "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E";
export const GOVERNANCE_SAFE = "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D";
export const GUARDIAN_SAFE = "0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc";
export const TREASURY_SAFE = "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC";

const ROUTER_INPUTS = [
  { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
  { name: "initialGuardian", type: "address", source: { kind: "role", role: "guardian" }, label: "Guardian" },
  { name: "wrappedNative_", type: "address", source: { kind: "network-constant", key: "wrappedNative" }, label: "Wrapped native token" },
  { name: "initialTreasury", type: "address", source: { kind: "role", role: "treasury" }, label: "Treasury" },
  { name: "initialFeeBps", type: "uint16", source: { kind: "literal", value: "10", editable: true, min: "0", max: "100" }, label: "Fee (basis points)" },
];

export const CONTRACTS = {
  "intent-router-v2": {
    id: "intent-router-v2",
    name: "KletiaIntentRouterV2",
    artifactId: "base/KletiaIntentRouterV2",
    lifecycle: "current",
    ownerModel: "ownable2step",
    ownerSource: "constructor-role",
    constructorInputs: ROUTER_INPUTS,
    feeModel: { kind: "pushed", event: "SwapExecuted", amountField: "feeAmount", tokenField: "tokenOut", recipient: "treasury" },
    reads: ["guardian", "treasury", "feeBps", "paused"],
    actions: [
      { id: "router.pause", fn: "pause", label: "Pause", caller: "guardian-or-owner", risk: "routine" },
      { id: "router.setFeeBps", fn: "setFeeBps", label: "Set fee", caller: "owner", risk: "sensitive" },
      { id: "router.transferOwnership", fn: "transferOwnership", label: "Transfer ownership", caller: "owner", risk: "dangerous" },
    ],
    notes: "",
  },
  "uniswap-v2-adapter": {
    id: "uniswap-v2-adapter",
    name: "UniswapV2CompatibleAdapter",
    artifactId: "base/UniswapV2CompatibleAdapter",
    lifecycle: "current",
    ownerModel: "none",
    ownerSource: "none",
    constructorInputs: [
      { name: "router_", type: "address", source: { kind: "network-constant", key: "uniswapV2Router" }, label: "Uniswap V2 Router02" },
      { name: "factory_", type: "address", source: { kind: "network-constant", key: "uniswapV2Factory" }, label: "Uniswap V2 factory" },
      { name: "wrappedNative_", type: "address", source: { kind: "network-constant", key: "wrappedNative" }, label: "Wrapped native token" },
    ],
    feeModel: { kind: "none" },
    reads: [],
    actions: [],
    notes: "",
  },
  "uniswap-v3-adapter": {
    id: "uniswap-v3-adapter", name: "UniswapV3SwapRouter02Adapter", artifactId: "base/UniswapV3SwapRouter02Adapter", lifecycle: "quarantined",
    ownerModel: "none", ownerSource: "none", constructorInputs: [], feeModel: { kind: "none" }, reads: [], actions: [], notes: "",
  },
  "launch-factory-v2": {
    id: "launch-factory-v2",
    name: "KletiaLaunchFactoryV2",
    artifactId: "base/KletiaLaunchFactoryV2",
    lifecycle: "current",
    ownerModel: "ownable2step",
    ownerSource: "constructor-role",
    constructorInputs: [
      { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
      { name: "initialTreasury", type: "address", source: { kind: "role", role: "treasury" }, label: "Treasury" },
    ],
    feeModel: { kind: "pushed", event: "TokenDeployed", amountField: "deploymentFee", tokenField: null, recipient: "treasury" },
    reads: ["treasury", "deploymentFee"],
    actions: [],
    notes: "",
  },
  "x402-gateway": {
    id: "x402-gateway", name: "X402Gateway", artifactId: "base/X402Gateway", lifecycle: "supporting", ownerModel: "ownable", ownerSource: "deployer",
    constructorInputs: [], feeModel: { kind: "accrued", token: "usdc", claimFunction: "withdraw" }, reads: ["usdc", "pricePerCall"],
    actions: [
      { id: "gateway.withdraw", fn: "withdraw", label: "Withdraw", caller: "owner", risk: "routine" },
      { id: "gateway.transferOwnership", fn: "transferOwnership", label: "Transfer ownership", caller: "owner", risk: "dangerous" },
    ],
    notes: "",
  },
  "arc-klet-token": {
    id: "arc-klet-token", name: "KletiaToken", artifactId: "arc/KletiaToken", lifecycle: "current", ownerModel: "ownable", ownerSource: "deployer",
    constructorInputs: [
      { name: "name", type: "string", source: { kind: "literal", value: "Kletia", editable: true }, label: "Token name" },
      { name: "creator", type: "address", source: { kind: "session-address" }, label: "Creator" },
    ],
    feeModel: { kind: "none" }, reads: [], actions: [], notes: "",
  },
  "arc-vault-v2": {
    id: "arc-vault-v2", name: "KletiaArcVaultV2", artifactId: "arc/KletiaArcVaultV2", lifecycle: "current", ownerModel: "ownable2step", ownerSource: "constructor-role",
    constructorInputs: [
      { name: "initialApyBps", type: "uint256", source: { kind: "literal", value: "500", editable: true, max: "5000" }, label: "APY (basis points)" },
    ],
    feeModel: { kind: "owner-funded", fundFunction: "fundVault" }, reads: [], actions: [], notes: "",
  },
};

const target = (network, contractId, order, extra = {}) => ({
  id: extra.instance ? `${network}:${contractId}:${extra.instance}` : `${network}:${contractId}`,
  network,
  contractId,
  status: "deployable",
  reason: "",
  order,
  dependsOn: [],
  postDeploy: [],
  testnet: network === "arc" || network === "arbitrum-sepolia",
  ...extra,
});

export const TARGETS = [
  target("arbitrum", "uniswap-v2-adapter", 1, { instance: "uniswap" }),
  target("arbitrum", "intent-router-v2", 2),
  target("arbitrum", "launch-factory-v2", 3, { dependsOn: ["arbitrum:intent-router-v2"] }),
  target("base", "intent-router-v2", 1, { status: "pinned" }),
  target("base", "uniswap-v3-adapter", 2, { status: "quarantined", reason: "EXPERIMENTAL_NOT_RELEASED: production deploy forbidden (DEPLOYMENT.md)." }),
  target("base", "x402-gateway", 3, { status: "legacy", instance: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B" }),
  target("arc", "intent-router-v2", 1, { status: "not-applicable", reason: "Arc has no wrapped native token or Uniswap V2." }),
  target("arc", "arc-klet-token", 2, { status: "pinned" }),
  target("arc", "arc-vault-v2", 3),
];

export const PINNED = [
  { network: "base", contractId: "intent-router-v2", address: "0xf9BaA05c71c2078A43f6831Eca88220b42932413", lifecycle: "current", owner: GOVERNANCE_SAFE, source: "contracts/base/deployments/base-mainnet-v2.json" },
  { network: "base", contractId: "x402-gateway", instance: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B", address: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B", owner: ADMIN_EVM, lifecycle: "supporting", source: "contracts/base/deployments/base-mainnet-v2.json" },
  { network: "arc", contractId: "arc-klet-token", address: "0xAe77D247c26258397653a020995E957Bc88E039A", lifecycle: "current", source: "contracts/arc/deployments/arc-testnet.json" },
];

export const CONSTANTS = {
  base: {
    network: "base",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    defaultRoles: { owner: GOVERNANCE_SAFE, guardian: GUARDIAN_SAFE, treasury: TREASURY_SAFE },
    safeOwners: { [GOVERNANCE_SAFE]: [ADMIN_EVM, COSIGNER] },
  },
  arbitrum: {
    network: "arbitrum",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswapV2Factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
  },
  ethereum: { network: "ethereum" },
  optimism: { network: "optimism" },
  polygon: { network: "polygon" },
  arc: { network: "arc", arcForwarder: "0x7dE7A249673F2235A91E484CfCE49D00867B67Ec", arcKlet: "0xAe77D247c26258397653a020995E957Bc88E039A" },
  "arbitrum-sepolia": { network: "arbitrum-sepolia", wrappedNative: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" },
};

export const CATALOG = { schemaVersion: "kletia_admin_v1", contracts: CONTRACTS, targets: TARGETS, pinned: PINNED, constants: CONSTANTS };

export function record(overrides = {}) {
  return {
    id: "dep_000000000000000000000001",
    targetId: "arbitrum:uniswap-v2-adapter:uniswap",
    network: "arbitrum",
    chainId: 42161,
    contractId: "uniswap-v2-adapter",
    instance: "uniswap",
    address: "0x1111111111111111111111111111111111111111",
    txHash: `0x${"ab".repeat(32)}`,
    block: "300000000",
    deployer: ADMIN_EVM,
    constructorArgs: {},
    ownerKind: "none",
    expectedOwner: null,
    artifactId: "base/UniswapV2CompatibleAdapter",
    artifactMaskedRuntimeHash: `0x${"11".repeat(32)}`,
    onchainCodehash: `0x${"22".repeat(32)}`,
    checks: [{ id: "chain", ok: true, detail: "Chain 42161." }],
    status: "verified",
    wired: false,
    notes: "",
    createdBy: ADMIN_EVM,
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  };
}

export const PROFILE_ARBITRUM = {
  network: "arbitrum",
  owner: ADMIN_EVM,
  guardian: COSIGNER,
  treasury: TREASURY_SAFE,
  eoaOwnerAcknowledged: true,
  updatedBy: ADMIN_EVM,
  updatedAt: "2026-10-15T09:00:00.000Z",
};

/** A minimal artifact: a constructor with the router's inputs and two functions. */
export const ROUTER_ABI = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "initialOwner", type: "address" },
      { name: "initialGuardian", type: "address" },
      { name: "wrappedNative_", type: "address" },
      { name: "initialTreasury", type: "address" },
      { name: "initialFeeBps", type: "uint16" },
    ],
  },
  { type: "function", name: "setFeeBps", stateMutability: "nonpayable", inputs: [{ name: "newFeeBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "configureAdapter", stateMutability: "nonpayable", inputs: [{ name: "adapter", type: "address" }, { name: "enabled", type: "bool" }], outputs: [] },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "renounceOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "invalidateUnorderedNonces", stateMutability: "nonpayable", inputs: [{ name: "wordPos", type: "uint256" }, { name: "mask", type: "uint256" }], outputs: [] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
];

export const GATEWAY_ABI = [
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "renounceOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

export const SAFE_EXEC_ABI = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
];
