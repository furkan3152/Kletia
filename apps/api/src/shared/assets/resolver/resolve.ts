/**
 * The entry point: resolveIntentEntities.
 */
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import type { ParsedIntent } from "../../ai/parser.js";
import {
  NETWORKS,
  arbitrumPublicClient,
  basePublicClient,
  type NetworkId,
} from "../../config/networks.js";
import { ARBITRUM_TOKENS } from "../../../networks/arbitrum/contracts.js";
import {
  checkTokenSecurity,
} from "../../../networks/base/security/tokenSecurity.js";
import {
  resolveBasenameEvidence,
} from "../../../networks/base/intent/basenameResolver.js";
import {
  UnsafeAssetReferenceError,
  closestCatalogAssets,
  assetReferenceIdentityKey,
  findCatalogAssetsByReference,
  normalizeAssetReference,
} from "../catalog.js";
import {
  type AssetField,
  type AssetResolverDependencies,
  EntityResolutionError,
  type IntentEntityResolutionResult,
  type RecipientResolutionEvidence,
  type ResolvedAssetEvidence,
} from "./types.js";
import {
  assertActionCompatibility,
  assetFieldPolicy,
  FIXED_ARC_FIELDS,
} from "./policy.js";
import { resolveProtocol } from "./protocols.js";
import {
  discoverBasePortfolioAssetsCached,
  verifyBaseErc20,
  withinDeadline,
} from "./portfolio.js";
import {
  actionUsesRecipient,
  catalogOptions,
  evidenceFromCatalog,
  evidenceFromDynamicAddress,
  portfolioOptions,
  requiredAssetQuestion,
  resolveRecipient,
  workflowAssetClarification,
} from "./evidence.js";

export async function resolveIntentEntities(
  intent: ParsedIntent,
  context: {
    readonly network: NetworkId;
    readonly userAddress: string;
    readonly originalPrompt: string;
    readonly requestId: string;
  },
  dependencies: AssetResolverDependencies = {},
): Promise<IntentEntityResolutionResult> {
  const { network, originalPrompt } = context;
  const action = String(intent.action || "")
    .trim()
    .toLowerCase();
  const now = (dependencies.now || Date.now)();
  const observedAt = new Date(now).toISOString();
  let user: Address;
  try {
    user = getAddress(context.userAddress);
  } catch {
    throw new EntityResolutionError(
      "INVALID_RESOLUTION_WALLET",
      "Asset resolution wallet is invalid.",
    );
  }

  const client: PublicClient = (dependencies.baseClient ||
    (network === "arbitrum" ? arbitrumPublicClient : basePublicClient)) as PublicClient;
  const portfolioDiscovery =
    dependencies.discoverPortfolioAssets ||
    ((reference: string, owner: Address) =>
      discoverBasePortfolioAssetsCached(reference, owner, client));
  const securityCheck =
    dependencies.checkBaseTokenSecurity ||
    ((address: Address) => checkTokenSecurity(address, "dynamic_execution"));
  const basenameResolver =
    dependencies.resolveBasename || resolveBasenameEvidence;

  const workingIntent: ParsedIntent = { ...intent };
  const workflowClarification = workflowAssetClarification(workingIntent);
  if (workflowClarification) {
    return { status: "clarification", clarification: workflowClarification };
  }
  if (
    action === "liquid_stake" &&
    workingIntent.tokenIn &&
    !workingIntent.tokenOut
  ) {
    workingIntent.tokenOut = workingIntent.tokenIn;
    workingIntent.tokenIn = "ETH";
  }
  if (
    action === "liquid_unstake" &&
    workingIntent.tokenIn &&
    !workingIntent.tokenOut
  ) {
    workingIntent.tokenOut = "ETH";
  }
  if (
    action === "memo_send" &&
    !workingIntent.recipient &&
    workingIntent.tokenOut
  ) {
    workingIntent.recipient = workingIntent.tokenOut;
    workingIntent.tokenOut = undefined;
  }
  const fixedFields = network === "arc" ? FIXED_ARC_FIELDS[action] || {} : {};
  for (const [field, value] of Object.entries(fixedFields)) {
    const role = field as AssetField;
    if (!workingIntent[role]) workingIntent[role] = value;
  }

  const policy = assetFieldPolicy(network, action);
  const allAssetFields: readonly AssetField[] = [
    "tokenIn",
    "tokenOut",
    "collateralToken",
    "borrowToken",
  ];
  const fieldsToResolve = policy
    ? [
        ...new Set([
          ...policy.required,
          ...allAssetFields.filter((field) => {
            if (!workingIntent[field]) return false;
            if (!policy.allowed.includes(field)) {
              throw new EntityResolutionError(
                "ENTITY_ROLE_ACTION_UNSUPPORTED",
                `The ${field} field is not used in the ${NETWORKS[network].displayName} ${action} execution plan; it cannot be silently ignored.`,
              );
            }
            return true;
          }),
        ]),
      ]
    : [];
  const assets: ResolvedAssetEvidence[] = [];
  for (const role of fieldsToResolve) {
    const rawValue = workingIntent[role];
    if (!rawValue) {
      return {
        status: "clarification",
        clarification: requiredAssetQuestion(network, role),
      };
    }

    let reference: string;
    try {
      reference = normalizeAssetReference(rawValue);
    } catch (error) {
      if (error instanceof UnsafeAssetReferenceError) {
        throw new EntityResolutionError(error.code, error.message);
      }
      throw error;
    }
    if (/^0x/iu.test(reference) && !isAddress(reference)) {
      throw new EntityResolutionError(
        "INVALID_TOKEN_ADDRESS",
        "Token reference starting with 0x must be a full and valid EVM contract address.",
      );
    }

    const catalogMatches = findCatalogAssetsByReference(network, reference);
    if (catalogMatches.length === 1) {
      const asset = catalogMatches[0];
      assertActionCompatibility(network, action, role, asset);
      const exactSymbol =
        assetReferenceIdentityKey(reference) ===
        assetReferenceIdentityKey(asset.symbol);
      const addressMatch = isAddress(reference);
      const fixed =
        fixedFields[role] !== undefined &&
        assetReferenceIdentityKey(reference) ===
          assetReferenceIdentityKey(fixedFields[role]);
      const matchedBy: ResolvedAssetEvidence["matchedBy"] = fixed
        ? "protocol_fixed_asset"
        : addressMatch
          ? "exact_address"
          : exactSymbol
            ? "canonical_symbol"
            : "curated_alias";
      workingIntent[role] = asset.symbol;
      assets.push(
        evidenceFromCatalog(
          role,
          reference,
          asset,
          action,
          matchedBy,
          observedAt,
        ),
      );
      continue;
    }

    if (catalogMatches.length > 1) {
      return {
        status: "clarification",
        clarification: {
          kind: "asset",
          code: "ASSET_REFERENCE_AMBIGUOUS",
          field: role,
          reference,
          question: `${reference} matches multiple canonical entities; which one did you mean?`,
          options: catalogOptions(
            originalPrompt,
            role,
            catalogMatches.map((asset) => ({ asset, similarity: 1 })),
          ),
        },
      };
    }

    if (isAddress(reference)) {
      if (network !== "base") {
        throw new EntityResolutionError(
          "NETWORK_ASSET_ADDRESS_UNLISTED",
          network === "arc"
            ? "Arc token contract address does not match USDC, EURC, or KLET identity in the official/Kletia manifest."
            : `Arbitrum token address is not one of the reviewed beta assets: ${ARBITRUM_TOKENS.USDC.address}, ${ARBITRUM_TOKENS.WETH.address}, or ${ARBITRUM_TOKENS.ARB.address}.`,
        );
      }
      const verified = await withinDeadline(
        verifyBaseErc20(reference, user, client),
        Date.now() + 8_000,
        "TOKEN_VERIFICATION_TIMEOUT",
      );
      assertActionCompatibility(network, action, role, verified);
      workingIntent[role] = verified.address;
      assets.push(
        await evidenceFromDynamicAddress(
          role,
          reference,
          verified,
          action,
          observedAt,
          securityCheck,
        ),
      );
      continue;
    }

    if (network === "base") {
      const portfolioCandidates = await portfolioDiscovery(reference, user);
      const exactCandidates = portfolioCandidates.filter(
        ({ exactMatch }) => exactMatch,
      );
      const candidates =
        exactCandidates.length > 0 ? exactCandidates : portfolioCandidates;
      if (candidates.length > 0) {
        return {
          status: "clarification",
          clarification: {
            kind: "asset",
            code:
              candidates.length === 1
                ? "PORTFOLIO_ASSET_CONFIRMATION_REQUIRED"
                : "PORTFOLIO_ASSET_AMBIGUOUS",
            field: role,
            reference,
            question:
              candidates.length === 1
                ? `Did you mean the ${candidates[0].name} (${candidates[0].symbol}) contract? The transaction will not be prepared without address verification.`
                : `${reference} matches multiple tokens in the wallet; you must select by contract address.`,
            options: portfolioOptions(originalPrompt, role, candidates),
          },
        };
      }
    }

    const suggestions = closestCatalogAssets(network, reference);
    return {
      status: "clarification",
      clarification: {
        kind: "asset",
        code:
          suggestions.length > 0
            ? "ASSET_SUGGESTION_CONFIRMATION_REQUIRED"
            : "ASSET_UNKNOWN",
        field: role,
        reference,
        question:
          suggestions.length === 1
            ? `Did you mean the ${suggestions[0].asset.name} (${suggestions[0].asset.symbol}) token?`
            : suggestions.length > 1
              ? `${reference} could not be definitively identified; did you mean one of the following entities?`
              : `${reference} could not be securely resolved on ${NETWORKS[network].displayName}. You must enter the symbol or full contract address.`,
        options: catalogOptions(originalPrompt, role, suggestions),
      },
    };
  }

  const protocol = resolveProtocol(network, action, workingIntent.protocol);
  if (protocol) workingIntent.protocol = protocol.canonical;

  const recipientAction = actionUsesRecipient(action);
  if (workingIntent.recipient && !recipientAction) {
    throw new EntityResolutionError(
      "ENTITY_RECIPIENT_ACTION_UNSUPPORTED",
      `The recipient field is not used in the ${NETWORKS[network].displayName} ${action} execution schema; it cannot be silently ignored.`,
    );
  }
  if (workingIntent.transfers !== undefined && action !== "atomic_payout") {
    throw new EntityResolutionError(
      "ENTITY_TRANSFERS_ACTION_UNSUPPORTED",
      `The transfers field is not used in the ${NETWORKS[network].displayName} ${action} execution schema; it cannot be silently ignored.`,
    );
  }

  const recipients: RecipientResolutionEvidence[] = [];
  if (recipientAction) {
    if (!workingIntent.recipient) {
      return {
        status: "clarification",
        clarification: {
          kind: "recipient",
          code: "RECIPIENT_REQUIRED",
          field: "recipient",
          question:
            "Recipient must be specified as a full EVM address or .base.eth name.",
          options: [],
        },
      };
    }
    const recipient = await resolveRecipient(
      workingIntent.recipient,
      network,
      now,
      basenameResolver,
    );
    workingIntent.recipient = recipient.resolvedAddress;
    if (action === "memo_send") {
      workingIntent.tokenOut = recipient.resolvedAddress;
    }
    recipients.push(recipient);
  }
  if (action === "atomic_payout") {
    if (!workingIntent.transfers?.length) {
      throw new EntityResolutionError(
        "ATOMIC_PAYOUT_RECIPIENTS_REQUIRED",
        "At least one address+amount pair is required for atomic payout.",
      );
    }
    const resolvedTransfers = [];
    const uniqueRecipients = new Set<string>();
    for (const [transferIndex, transfer] of workingIntent.transfers.entries()) {
      const rawRecipient = normalizeAssetReference(transfer.recipient);
      if (!isAddress(rawRecipient)) {
        throw new EntityResolutionError(
          "ATOMIC_PAYOUT_ADDRESS_REQUIRED",
          "Each recipient in atomic batch payout must be a full EVM address; Basename is not supported for batch payouts.",
        );
      }
      const recipient = await resolveRecipient(
        rawRecipient,
        network,
        now,
        basenameResolver,
      );
      const recipientKey = recipient.resolvedAddress.toLowerCase();
      if (uniqueRecipients.has(recipientKey)) {
        throw new EntityResolutionError(
          "ATOMIC_PAYOUT_DUPLICATE_RECIPIENT",
          "The same resolved recipient cannot be used multiple times in atomic payout.",
        );
      }
      uniqueRecipients.add(recipientKey);
      recipients.push({ ...recipient, transferIndex });
      resolvedTransfers.push({
        ...transfer,
        recipient: recipient.resolvedAddress,
      });
    }
    workingIntent.transfers = resolvedTransfers;
  }

  const allWarnings = [
    ...assets.flatMap(({ warnings }) => warnings),
    ...recipients.flatMap(({ warning }) => (warning ? [warning] : [])),
  ];
  return {
    status: "resolved",
    intent: workingIntent,
    evidence: {
      policyVersion: "kletia_entity_resolution_v1",
      requestId: context.requestId,
      network,
      chainId: NETWORKS[network].chainId,
      userAddress: user,
      action,
      decision: "eligible",
      observedAt,
      assets,
      recipients,
      protocol,
      warnings: [...new Set(allWarnings)],
      scorePolicy: "informational_only_hard_gates_take_precedence",
    },
  };
}
