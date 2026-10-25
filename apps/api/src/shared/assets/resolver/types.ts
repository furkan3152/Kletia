/**
 * Entity resolution evidence, clarification and dependency types.
 */
import type { Address, PublicClient } from "viem";
import type { ParsedIntent } from "../../ai/parser.js";
import type { NetworkId } from "../../config/networks.js";
import type {
  BasenameResolutionEvidence,
} from "../../../networks/base/intent/basenameResolver.js";
import type { AssetCatalogEntry, AssetTrustTier } from "../catalog.js";

export type AssetField =
  "tokenIn" | "tokenOut" | "collateralToken" | "borrowToken";

export interface ResolvedAssetEvidence {
  readonly role: AssetField;
  readonly originalReference: string;
  readonly canonicalSymbol: string;
  readonly displayName: string;
  readonly address?: Address;
  readonly decimals: number;
  readonly representation:
    "native" | "erc20" | "native_with_erc20_interface" | "app_kit_symbol";
  readonly matchedBy:
    | "canonical_symbol"
    | "curated_alias"
    | "exact_address"
    | "portfolio_verified_address"
    | "protocol_fixed_asset";
  readonly identityConfidence: number;
  readonly trustScore: number;
  readonly trustTier: AssetTrustTier;
  readonly trustLabel:
    | "canonical"
    | "reviewed"
    | "elevated_risk"
    | "project_contract"
    | "unlisted_verified";
  readonly security: {
    readonly status:
      "manifest_verified" | "registry_reviewed" | "provider_passed";
    readonly provider: "Kletia reviewed registry" | "GoPlus";
    readonly observedAt: string;
    readonly catalogRevision?: string;
    readonly primarySource?: string;
  };
  readonly onchain?: {
    readonly observedAtBlock: string;
    readonly codeHash: `0x${string}`;
    readonly metadataBounded: true;
    readonly balanceAtomic: string;
    readonly balanceVerified: true;
  };
  readonly actionCompatibility: {
    readonly action: string;
    readonly allowed: true;
    readonly executionDecimals: number;
  };
  readonly warnings: readonly string[];
}

export interface RecipientResolutionEvidence {
  readonly role: "recipient";
  readonly originalReference: string;
  readonly resolvedAddress: Address;
  readonly matchedBy: "exact_address" | "basename";
  readonly basename?: string;
  readonly resolver?: Address;
  readonly observedAtBlock?: string;
  readonly observedAt: string;
  readonly expiresAt: number;
  readonly crossNetworkIdentity: boolean;
  readonly warning?: string;
  readonly transferIndex?: number;
}

export interface IntentEntityResolutionEvidence {
  readonly policyVersion: "kletia_entity_resolution_v1";
  readonly requestId: string;
  readonly network: NetworkId;
  readonly chainId: number;
  readonly userAddress: Address;
  readonly action: string;
  readonly decision: "eligible";
  readonly observedAt: string;
  readonly assets: readonly ResolvedAssetEvidence[];
  readonly recipients: readonly RecipientResolutionEvidence[];
  readonly protocol?: {
    readonly original: string;
    readonly canonical: string;
    readonly matchedBy: "curated_alias" | "canonical_id";
  };
  readonly warnings: readonly string[];
  readonly scorePolicy: "informational_only_hard_gates_take_precedence";
}

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly symbol: string;
  readonly address?: Address;
  readonly trustLabel: string;
}

export type WorkflowClarificationField = `workflowSteps.${number}.${AssetField}`;

export interface EntityClarification {
  readonly kind: "asset" | "recipient" | "protocol" | "workflow";
  readonly code: string;
  readonly field?: AssetField | "recipient" | "protocol" | WorkflowClarificationField;
  readonly reference?: string;
  readonly question: string;
  readonly options: readonly ClarificationOption[];
}

export type IntentEntityResolutionResult =
  | {
      readonly status: "resolved";
      readonly intent: ParsedIntent;
      readonly evidence: IntentEntityResolutionEvidence;
    }
  | {
      readonly status: "clarification";
      readonly clarification: EntityClarification;
    };

export class EntityResolutionError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "EntityResolutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface VerifiedPortfolioAsset {
  readonly symbol: string;
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly balance: bigint;
  readonly observedAtBlock: bigint;
  readonly codeHash: `0x${string}`;
  readonly similarity: number;
  readonly exactMatch: boolean;
}

export type ResolvableAsset =
  AssetCatalogEntry | Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">;

export interface AssetResolverDependencies {
  readonly baseClient?: PublicClient;
  readonly discoverPortfolioAssets?: (
    reference: string,
    user: Address,
  ) => Promise<readonly VerifiedPortfolioAsset[]>;
  readonly checkBaseTokenSecurity?: (address: Address) => Promise<boolean>;
  readonly resolveBasename?: (
    name: string,
    network?: NetworkId,
  ) => Promise<BasenameResolutionEvidence | null>;
  readonly now?: () => number;
}
