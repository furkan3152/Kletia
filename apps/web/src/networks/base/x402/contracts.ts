import { getAddress, parseAbi } from "viem";

/** Base Mainnet USDC used by the x402 exact-payment flow. */
export const BASE_USDC_ADDRESS = getAddress(
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
);

/** Deployed Kletia x402 gateway factory on Base Mainnet. */
export const X402_FACTORY_ADDRESS = getAddress(
  "0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46",
);

export const x402FactoryAbi = parseAbi([
  "event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice)",
  "function allGateways(uint256) view returns (address)",
  "function allGatewaysLength() view returns (uint256)",
  "function createGateway(address usdc, uint256 initialPrice) returns (address gateway)",
  "function getGatewaysByOwner(address, uint256) view returns (address)",
  "function getOwnerGateways(address owner) view returns (address[])",
]);

export const x402GatewayAbi = parseAbi([
  "event PaymentReceived(address indexed payer, uint256 amount, string endpoint)",
  "event PriceUpdated(uint256 newPrice)",
  "function owner() view returns (address)",
  "function pay(string endpoint)",
  "function pricePerCall() view returns (uint256)",
  "function usdc() view returns (address)",
  "function setPrice(uint256 newPrice)",
  "function withdraw(address to)",
]);
