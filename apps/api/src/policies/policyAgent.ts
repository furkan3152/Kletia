import { randomBytes } from "node:crypto";
import { getAddress, keccak256, parseUnits, stringToHex, type Address, type Hex } from "viem";
import type { ParsedIntent } from "../ai/parser.js";
import { NETWORKS, type NetworkId } from "../config/networks.js";

const MAX_POLICY_HOURS = 24 * 30;
const ALLOWED_NETWORKS = new Set<NetworkId>(["base", "arbitrum"]);
const ALLOWED_PROTOCOLS = new Set(["across", "uniswap-v3", "aave-v3", "base-x402"]);
const ALLOWED_ASSETS = new Set(["ETH", "WETH", "USDC", "ARB"]);

function controlled(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function boundedList(value: unknown, allowed: ReadonlySet<string>, normalize: (value: string) => string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw controlled("POLICY_SCOPE_INVALID", "Policy scope must contain between one and eight entries.");
  }
  const normalized = [...new Set(value.map((item) => normalize(String(item).trim())))];
  if (normalized.some((item) => !allowed.has(item))) {
    throw controlled("POLICY_SCOPE_UNSUPPORTED", "Policy contains an unsupported network, protocol, or asset.");
  }
  return normalized;
}

export function buildPolicyAgent(
  intent: ParsedIntent,
  ownerInput: string,
  network: Exclude<NetworkId, "arc">,
) {
  const owner = getAddress(ownerInput);
  const input = intent.policyAgent;
  if (!input) throw controlled("POLICY_REQUIRED", "Policy agent constraints are required.");
  const name = input.name.trim();
  const objective = input.objective.trim();
  if (name.length < 2 || name.length > 64 || objective.length < 8 || objective.length > 280) {
    throw controlled("POLICY_TEXT_INVALID", "Policy name or objective is outside the safe length boundary.");
  }
  const allowedNetworks = boundedList(input.allowedNetworks, ALLOWED_NETWORKS, (value) => value.toLowerCase()) as NetworkId[];
  const allowedProtocols = boundedList(input.allowedProtocols, ALLOWED_PROTOCOLS, (value) => value.toLowerCase());
  const allowedAssets = boundedList(input.allowedAssets, ALLOWED_ASSETS, (value) => value.toUpperCase());
  const maxSpendAtomic = parseUnits(input.maxSpendUsdc, 6);
  if (maxSpendAtomic <= 0n) throw controlled("POLICY_SPEND_INVALID", "Policy spend cap must be positive.");
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > MAX_POLICY_HOURS) {
    throw controlled("POLICY_EXPIRY_INVALID", "Policy expiry must be between 1 hour and 30 days.");
  }
  const now = Math.floor(Date.now() / 1_000);
  const policyId = keccak256(stringToHex(`${owner}:${now}:${randomBytes(16).toString("hex")}`));
  const expiresAt = now + input.expiresInHours * 3_600;
  const policy = {
    version: 1 as const,
    policyId,
    owner,
    name,
    objective,
    allowedNetworks,
    allowedProtocols,
    allowedAssets,
    maxSpendUsdcAtomic: maxSpendAtomic.toString(),
    riskTolerance: input.riskTolerance,
    createdAt: now,
    expiresAt,
    authority: "planning_only_no_transaction_authority" as const,
    requiresPerStepWalletApproval: true as const,
  };
  return {
    status: "success",
    action: "policy_agent",
    winnerMessage: "A non-custodial planning policy is ready for EIP-712 wallet signature. It cannot approve or move funds.",
    policyAgent: policy,
    typedData: {
      domain: { name: "Kletia Policy Agent", version: "1", chainId: NETWORKS[network].chainId },
      primaryType: "PolicyAgentV1" as const,
      types: {
        PolicyAgentV1: [
          { name: "policyId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "objective", type: "string" },
          { name: "allowedNetworks", type: "string[]" },
          { name: "allowedProtocols", type: "string[]" },
          { name: "allowedAssets", type: "string[]" },
          { name: "maxSpendUsdcAtomic", type: "uint256" },
          { name: "riskTolerance", type: "string" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      message: {
        policyId: policyId as Hex,
        owner: owner as Address,
        objective,
        allowedNetworks,
        allowedProtocols,
        allowedAssets,
        maxSpendUsdcAtomic: maxSpendAtomic,
        riskTolerance: input.riskTolerance,
        expiresAt: BigInt(expiresAt),
      },
    },
  };
}
