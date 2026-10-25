/**
 * Clarification options and evidence for catalog assets, dynamic
 * addresses and recipients.
 */
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { ParsedIntent } from "../../ai/parser.js";
import { NETWORKS, type NetworkId } from "../../config/networks.js";
import { ARBITRUM_TOKENS } from "../../../networks/arbitrum/contracts.js";
import type {
  BasenameResolutionEvidence,
} from "../../../networks/base/intent/basenameResolver.js";
import {
  ASSET_CATALOG_REVISION,
  normalizeAssetReference,
  type AssetCatalogEntry,
} from "../catalog.js";
import {
  type AssetField,
  type ClarificationOption,
  type EntityClarification,
  EntityResolutionError,
  type RecipientResolutionEvidence,
  type ResolvedAssetEvidence,
  type VerifiedPortfolioAsset,
} from "./types.js";
import { executionDecimals, trustLabel, trustScore } from "./policy.js";

export function catalogOptions(
  _originalPrompt: string,
  role: AssetField,
  candidates: readonly { asset: AssetCatalogEntry; similarity: number }[],
): readonly ClarificationOption[] {
  return candidates.map(({ asset }) => ({
    id: `${role}:${asset.network}:${asset.symbol}`,
    label: `${asset.name} (${asset.symbol})`,
    symbol: asset.symbol,
    address: asset.address,
    trustLabel: trustLabel(asset.trustTier),
  }));
}

export function portfolioOptions(
  _originalPrompt: string,
  role: AssetField,
  candidates: readonly VerifiedPortfolioAsset[],
): readonly ClarificationOption[] {
  return candidates.slice(0, 4).map((asset) => ({
    id: `${role}:base:${asset.address.toLowerCase()}`,
    label: `${asset.name} (${asset.symbol}) · ${asset.address.slice(0, 6)}…${asset.address.slice(-4)}`,
    symbol: asset.symbol,
    address: asset.address,
    trustLabel: "unlisted_verified",
  }));
}

export function requiredAssetQuestion(
  network: NetworkId,
  role: AssetField,
): EntityClarification {
  return {
    kind: "asset",
    code: "ASSET_REQUIRED",
    field: role,
    question:
      `${role} presence missing on ${NETWORKS[network].displayName}.` +
      "You must enter the name, symbol, or contract address of the token you want to use.",
    options: [],
  };
}

export function workflowAssetClarification(
  intent: ParsedIntent,
): EntityClarification | null {
  if (intent.action !== "workflow" || !intent.workflowSteps) return null;
  const stepIndex = intent.workflowSteps.findIndex((step) => {
    const network = step.network ||
      (step.action === "bridge" || step.action === "gas_acquire"
        ? "base"
        : "arbitrum");
    return network === "arbitrum" &&
      ["lend", "withdraw", "borrow", "borrow_capacity", "repay", "yield_compare"]
        .includes(step.action) &&
      String(step.tokenIn || "").trim().toUpperCase() === "ETH";
  });
  if (stepIndex < 0) return null;
  return {
    kind: "workflow",
    code: "WORKFLOW_ASSET_REPRESENTATION_REQUIRED",
    field: `workflowSteps.${stepIndex}.tokenIn`,
    reference: "ETH",
    question:
      "Aave V3 uses ERC-20 reserves rather than native ETH. Which reviewed Arbitrum asset should the workflow supply? Kletia will propagate the selection through the preceding swap and bridge steps instead of guessing.",
    options: [
      {
        id: `workflow:${stepIndex}:WETH`,
        label: "WETH — keep ETH exposure (recommended)",
        symbol: "WETH",
        address: ARBITRUM_TOKENS.WETH.address,
        trustLabel: "canonical",
      },
      {
        id: `workflow:${stepIndex}:USDC`,
        label: "USDC — stablecoin lending",
        symbol: "USDC",
        address: ARBITRUM_TOKENS.USDC.address,
        trustLabel: "canonical",
      },
      {
        id: `workflow:${stepIndex}:ARB`,
        label: "ARB — governance asset lending",
        symbol: "ARB",
        address: ARBITRUM_TOKENS.ARB.address,
        trustLabel: "reviewed",
      },
    ],
  };
}

export function evidenceFromCatalog(
  role: AssetField,
  originalReference: string,
  asset: AssetCatalogEntry,
  action: string,
  matchedBy: ResolvedAssetEvidence["matchedBy"],
  observedAt: string,
): ResolvedAssetEvidence {
  const warnings: string[] = [];
  if (asset.trustTier === "elevated") {
    warnings.push(
      "This asset carries elevated market/liquidity risk; route simulation is not a security guarantee.",
    );
  }
  if (asset.verification === "registry_reviewed") {
    warnings.push(
      "This token was reviewed in Kletia execution records; however, the asset-specific primary publisher source is not linked in the manifest for the address.",
    );
  }
  if (asset.network === "arc" && asset.symbol === "USDC") {
    warnings.push(
      "Arc USDC atomic precision differs by execution lane: Kletia native-value 18, ERC-20/App Kit 6.",
    );
  }
  return {
    role,
    originalReference,
    canonicalSymbol: asset.symbol,
    displayName: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    representation: asset.representation,
    matchedBy,
    identityConfidence: matchedBy === "curated_alias" ? 98 : 100,
    trustScore: trustScore(asset.trustTier, asset.verification),
    trustTier: asset.trustTier,
    trustLabel: trustLabel(asset.trustTier),
    security: {
      status: asset.verification,
      provider: "Kletia reviewed registry",
      observedAt,
      catalogRevision: ASSET_CATALOG_REVISION,
      primarySource: asset.officialSource,
    },
    actionCompatibility: {
      action,
      allowed: true,
      executionDecimals: executionDecimals(asset.network, action, asset),
    },
    warnings,
  };
}

export async function evidenceFromDynamicAddress(
  role: AssetField,
  originalReference: string,
  asset: Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">,
  action: string,
  observedAt: string,
  securityCheck: (address: Address) => Promise<boolean>,
): Promise<ResolvedAssetEvidence> {
  if ((await securityCheck(asset.address)) !== true) {
    throw new EntityResolutionError(
      "TOKEN_SECURITY_REJECTED",
      "Dynamic token independent security check failed.",
    );
  }
  return {
    role,
    originalReference,
    canonicalSymbol: asset.symbol,
    displayName: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    representation: "erc20",
    matchedBy: "exact_address",
    identityConfidence: 100,
    trustScore: trustScore("portfolio"),
    trustTier: "portfolio",
    trustLabel: trustLabel("portfolio"),
    security: {
      status: "provider_passed",
      provider: "GoPlus",
      observedAt,
    },
    onchain: {
      observedAtBlock: asset.observedAtBlock.toString(),
      codeHash: asset.codeHash,
      metadataBounded: true,
      balanceAtomic: asset.balance.toString(),
      balanceVerified: true,
    },
    actionCompatibility: {
      action,
      allowed: true,
      executionDecimals: asset.decimals,
    },
    warnings: [
      "This contract is not in the Kletia canonical token registry. Identity, ERC-20 interface, wallet balance, and risk provider verified; behavioral/proxy risks may still vary.",
    ],
  };
}

export function actionUsesRecipient(action: string): boolean {
  return new Set([
    "appkit_send",
    "appkit_bridge",
    "memo_send",
    "official_memo_send",
    "transfer",
  ]).has(action);
}

export async function resolveRecipient(
  reference: unknown,
  network: NetworkId,
  now: number,
  basenameResolver: (
    name: string,
    network: NetworkId,
  ) => Promise<BasenameResolutionEvidence | null>,
): Promise<RecipientResolutionEvidence> {
  const raw = normalizeAssetReference(reference);
  if (isAddress(raw)) {
    const address = getAddress(raw);
    if (address === zeroAddress) {
      throw new EntityResolutionError(
        "RECIPIENT_ZERO_ADDRESS",
        "Recipient cannot be the zero address.",
      );
    }
    return {
      role: "recipient",
      originalReference: raw,
      resolvedAddress: address,
      matchedBy: "exact_address",
      observedAt: new Date(now).toISOString(),
      expiresAt: now + 60_000,
      crossNetworkIdentity: false,
    };
  }
  if (!/^[^\s.]+\.base(?:\.eth)?$/iu.test(raw)) {
    throw new EntityResolutionError(
      "RECIPIENT_UNRESOLVED",
      "Recipient must be a full EVM address or a resolvable .base.eth name.",
    );
  }
  // The record for the network the transfer runs on (a Base-only record never pays an Arbitrum or Arc transfer).
  const result = await basenameResolver(raw, network);
  if (!result) {
    throw new EntityResolutionError(
      "BASENAME_UNRESOLVED",
      `No verified Basename address record found for ${raw}.`,
    );
  }
  return {
    role: "recipient",
    originalReference: raw,
    resolvedAddress: result.address,
    matchedBy: "basename",
    basename: result.name,
    resolver: result.resolver,
    observedAtBlock: result.observedAtBlock,
    observedAt: result.observedAt,
    expiresAt: Math.min(result.expiresAt, now + 60_000),
    crossNetworkIdentity: network !== "base",
    warning:
      network !== "base"
        ? `Basename resolved on Base; the ${NETWORKS[network].displayName} transaction will go to its ${NETWORKS[network].displayName} or Ethereum address record. Verify network and 0x recipient before signing.`
        : undefined,
  };
}
