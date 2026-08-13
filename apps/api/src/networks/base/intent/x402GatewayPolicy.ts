import { formatUnits, getAddress, type Address } from "viem";

import { BASE_CONTRACTS, basePublicClient } from "../../../config/networks.js";

export const BASE_X402_USDC = getAddress(
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
);
export const BASE_X402_FACTORY_ADDRESS = BASE_CONTRACTS.x402Factory;
export const BASE_X402_MAX_PRICE_ATOMIC = BigInt(
  process.env.X402_MAX_PRICE_ATOMIC || "100000000",
);

const GATEWAY_READ_ABI = [
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "pricePerCall",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
const FACTORY_READ_ABI = [
  {
    type: "function",
    name: "getOwnerGateways",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

export type VerifiedBaseX402Gateway = {
  payTo: Address;
  price: string;
  priceAtomic: string;
  owner: Address;
};

/**
 * Proves that a dynamic gateway came from the reviewed Base factory and still
 * exposes the expected Base USDC and bounded live price. This is read-only.
 */
export async function verifyBaseX402Gateway(
  gatewayInput: unknown,
): Promise<VerifiedBaseX402Gateway> {
  let gateway: Address;
  try {
    gateway = getAddress(String(gatewayInput || ""));
  } catch {
    throw Object.assign(
      new Error("Gateway must be a valid Base address."),
      {
        code: "INVALID_X402_GATEWAY",
        statusCode: 400,
      },
    );
  }

  const [chainId, bytecode, usdc, price, ownerResult] = await Promise.all([
    basePublicClient.getChainId(),
    basePublicClient.getCode({ address: gateway }),
    basePublicClient.readContract({
      address: gateway,
      abi: GATEWAY_READ_ABI,
      functionName: "usdc",
    }),
    basePublicClient.readContract({
      address: gateway,
      abi: GATEWAY_READ_ABI,
      functionName: "pricePerCall",
    }),
    basePublicClient.readContract({
      address: gateway,
      abi: GATEWAY_READ_ABI,
      functionName: "owner",
    }),
  ]);
  const owner = getAddress(ownerResult);
  const ownerGateways = await basePublicClient.readContract({
    address: BASE_X402_FACTORY_ADDRESS,
    abi: FACTORY_READ_ABI,
    functionName: "getOwnerGateways",
    args: [owner],
  });
  const registeredByFactory = ownerGateways.some(
    (registeredGateway) => getAddress(registeredGateway) === gateway,
  );

  if (chainId !== 8_453) {
    throw Object.assign(
      new Error("x402 gateway verification requires Base Mainnet."),
      { code: "BASE_RPC_CHAIN_MISMATCH", statusCode: 503 },
    );
  }
  if (!bytecode || bytecode === "0x" || !registeredByFactory) {
    throw Object.assign(
      new Error("Gateway is not a verified Kletia X402Factory deployment."),
      { code: "UNVERIFIED_X402_GATEWAY", statusCode: 400 },
    );
  }
  if (getAddress(usdc) !== BASE_X402_USDC) {
    throw Object.assign(
      new Error("Gateway must use only Base Mainnet USDC."),
      { code: "INVALID_X402_ASSET", statusCode: 400 },
    );
  }
  if (price <= 0n || price > BASE_X402_MAX_PRICE_ATOMIC) {
    throw Object.assign(
      new Error("Gateway price is outside the allowed safe range."),
      { code: "INVALID_X402_PRICE", statusCode: 400 },
    );
  }

  return {
    payTo: gateway,
    price: `$${formatUnits(price, 6)}`,
    priceAtomic: price.toString(),
    owner,
  };
}
