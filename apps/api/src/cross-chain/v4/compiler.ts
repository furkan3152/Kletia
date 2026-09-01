import { randomUUID } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { compileWorkflowPlanV3, workflowPlanV3Hash } from "../v3/compiler.js";
import { assetFor, chainByKey, CHAINS_V3 } from "../v3/chains.js";
import type {
  AddressRef,
  AssetRef,
  IntentLegV3,
  RouteCandidateV3,
  WorkflowPlanV3,
} from "../v3/types.js";
import { sha256V4 } from "./canonical.js";
import { capabilityEdgesV4 } from "./capabilityGraph.js";
import { verifyPolicyProfileV1 } from "./policy.js";
import type {
  IntentIRV4,
  IntentInterpretationV4,
  PolicyProfileV1,
  WorkflowPlanV4,
} from "./types.js";
import {
  assetRegistryRootV4,
  protocolRegistryRootV4,
  recipientRegistryRootV4,
} from "./policyMerkle.js";

const READ_ONLY_OPERATIONS = new Set(["portfolio", "borrow_capacity"]);
const PRIVATE_REFERENCE_PATTERN = /private:\/\/[a-z][a-z\d_-]{2,63}/gu;
const RAW_EVM_ADDRESS_PATTERN = /0x[a-f\d]{40}/iu;
const RAW_STELLAR_ADDRESS_PATTERN = /\b[GC][A-Z2-7]{55}\b/u;
const RAW_AMOUNT_PATTERN = /\b\d+(?:\.\d+)?\s*(?:USDC|USDT|EURC|ETH|WETH|XLM|ARB|BTC|CIRBTC)\b/iu;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function semanticGoal(value: unknown): string {
  const goal = String(value ?? "").normalize("NFKC").trim();
  if (goal.length < 8 || goal.length > 1_500) {
    throw controlled("INTENT_V4_SEMANTIC_GOAL_INVALID", "A redacted semantic goal between 8 and 1500 characters is required.", 400);
  }
  if (RAW_EVM_ADDRESS_PATTERN.test(goal) || RAW_STELLAR_ADDRESS_PATTERN.test(goal) || RAW_AMOUNT_PATTERN.test(goal)) {
    throw controlled(
      "INTENT_V4_PRIVATE_FIELD_EGRESS_BLOCKED",
      "Exact amounts and recipient addresses must be replaced by private:// references before the request leaves the browser.",
    );
  }
  return goal;
}

function financialIntent(legs: readonly IntentLegV3[]): boolean {
  return legs.some((leg) => !READ_ONLY_OPERATIONS.has(leg.operation));
}

function assetPolicyId(asset: AssetRef): string {
  if (asset.family === "evm") {
    return `eip155:${asset.chainId}:${asset.address?.toLowerCase() ?? "native"}`;
  }
  return [
    asset.network === "testnet" ? "stellar:testnet" : "stellar:public",
    asset.code.toUpperCase(),
    asset.issuer ?? "native",
    asset.sac ?? "none",
  ].join(":").toLowerCase();
}

function riskRank(value: "conservative" | "balanced" | "aggressive"): number {
  return value === "conservative" ? 0 : value === "balanced" ? 1 : 2;
}

function assertPolicyApplies(
  profile: PolicyProfileV1,
  plan: WorkflowPlanV3,
): void {
  if (profile.core.lane !== plan.lane) {
    throw controlled("POLICY_LANE_MISMATCH", "The signed policy lane does not match the compiled workflow.");
  }
  const chainKeys = new Set(plan.intent.legs.map((leg) => leg.chain.key));
  chainKeys.add(plan.lane === "testnet" ? "stellar_testnet" : "stellar_mainnet");
  for (const chain of chainKeys) {
    if (!profile.core.allowedChains.includes(chain)) {
      throw controlled("POLICY_CHAIN_BLOCKED", `The signed policy does not allow ${chain}.`);
    }
  }
  for (const leg of plan.intent.legs) {
    if (leg.protocol && !profile.core.allowedProtocols.includes(leg.protocol)) {
      throw controlled("POLICY_PROTOCOL_BLOCKED", `The signed policy does not allow ${leg.protocol}.`);
    }
    for (const asset of [leg.assetIn, leg.assetOut]) {
      if (asset && !profile.core.allowedAssets.includes(assetPolicyId(asset))) {
        throw controlled("POLICY_ASSET_BLOCKED", `The signed policy does not allow ${asset.symbol} on ${leg.chain.key}.`);
      }
    }
  }
  if (
    plan.intent.risk.maximumSlippageBps > profile.core.risk.maximumSlippageBps ||
    Number(plan.intent.risk.minimumHealthFactor) < Number(profile.core.risk.minimumHealthFactor) ||
    riskRank(plan.intent.risk.tolerance) > riskRank(profile.core.risk.tolerance)
  ) {
    throw controlled("POLICY_RISK_BLOCKED", "The requested route risk is weaker than the signed policy permits.");
  }
  const expectedPrivacyCommitment = sha256V4("KLETIA_PRIVACY_BUDGET_V4", plan.intent.privacyBudget);
  if (profile.core.privacyBudgetCommitment !== expectedPrivacyCommitment) {
    throw controlled("POLICY_PRIVACY_BUDGET_MISMATCH", "The signed policy does not bind this privacy budget.");
  }
  const stellarWallet = plan.walletBindings.find((wallet) =>
    wallet.family === "stellar" &&
    wallet.network === (plan.lane === "testnet" ? "testnet" : "public"),
  );
  if (!stellarWallet || stellarWallet.address !== profile.core.owner.address) {
    throw controlled("POLICY_CONTROL_PLANE_WALLET_MISMATCH", "The signed policy owner must match the workflow's Stellar control-plane wallet.");
  }
  if (
    protocolRegistryRootV4(profile.core.allowedRouteProtocolSets) !== profile.core.protocolRegistryRoot ||
    assetRegistryRootV4(profile.core.allowedRouteAssetSets) !== profile.core.assetRegistryRoot ||
    recipientRegistryRootV4([recipientPolicyMaterialV4(plan)]) !== profile.core.recipientPolicyRoot
  ) {
    throw controlled(
      "POLICY_REGISTRY_ROOT_MISMATCH",
      "The signed Policy V2 registry roots do not match the visible route, asset and recipient permissions.",
    );
  }
}

export function routeProtocolSetV4(route: RouteCandidateV3): readonly string[] {
  return Object.freeze([...new Set(route.protocols)].sort());
}

export function routeAssetSetV4(
  legs: readonly IntentLegV3[],
  route: RouteCandidateV3,
): readonly string[] {
  const assets = legs.flatMap((leg) => [leg.assetIn, leg.assetOut])
    .filter((asset): asset is AssetRef => Boolean(asset));
  if (route.protocols.includes("circle-cctp-v2")) {
    for (const key of route.chains) {
      const chain = chainByKey(key);
      const usdc = chain ? assetFor(chain, "USDC") : null;
      if (usdc) assets.push(usdc);
    }
  }
  return Object.freeze([...new Set(assets.map(assetPolicyId))].sort());
}

export function recipientPolicyMaterialV4(plan: WorkflowPlanV3) {
  const privateRecipient = plan.intent.privateBindings.find((binding) => binding.field === "recipient");
  if (privateRecipient) {
    return Object.freeze({
      mode: "private_recipient_commitment" as const,
      commitment: privateRecipient.commitment,
    });
  }
  const finalChain = plan.intent.legs.at(-1)?.chain;
  const wallet = finalChain && plan.walletBindings.find((binding) =>
    binding.family === finalChain.family &&
    (binding.family === "evm"
      ? finalChain.family === "evm" && binding.chainId === finalChain.chainId
      : finalChain.family === "stellar" && binding.network === finalChain.network),
  );
  if (!wallet) {
    throw controlled(
      "POLICY_RECIPIENT_BINDING_MISSING",
      "A private recipient commitment or exact destination execution wallet is required for the policy registry.",
    );
  }
  return Object.freeze({ mode: "execution_wallet" as const, wallet });
}

function uniqueCanonicalSets(values: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const byIdentity = new Map<string, readonly string[]>();
  for (const value of values) {
    const set = Object.freeze([...new Set(value.map((entry) => entry.toLowerCase()))].sort());
    byIdentity.set(set.join("\u001f"), set);
  }
  return Object.freeze([...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value));
}

/**
 * Enumerates policy-safe route classes before a user signs a policy. It does
 * not select a route, hydrate a quote, or make any execution payload signable.
 */
export function derivePolicyOptionsV4(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw controlled("INTENT_V4_BODY_INVALID", "A structured V4 policy-options request is required.", 400);
  }
  const input = body as Record<string, unknown>;
  const goal = semanticGoal(input.semanticGoal);
  const v3Input: Record<string, unknown> = { ...input, semanticGoal: goal };
  delete v3Input.policyProfile;
  delete v3Input.schemaVersion;
  const plan = compileWorkflowPlanV3(v3Input, {
    liveControlPlaneReady: false,
    liveSolverMarketReady: false,
  });
  const routeProtocolSets = uniqueCanonicalSets(plan.routes.map(routeProtocolSetV4));
  const routeAssetSets = uniqueCanonicalSets(plan.routes.map((route) => routeAssetSetV4(plan.intent.legs, route)));
  const allowedProtocols = Object.freeze([...new Set(routeProtocolSets.flat())].sort());
  const allowedAssets = Object.freeze([...new Set(routeAssetSets.flat())].sort());
  const allowedChains = Object.freeze([...new Set([
    ...plan.intent.legs.map((leg) => leg.chain.key),
    plan.lane === "testnet" ? "stellar_testnet" : "stellar_mainnet",
  ])].sort());
  return Object.freeze({
    schemaVersion: "kletia_policy_options_v1" as const,
    lane: plan.lane,
    allowedChains,
    allowedProtocols,
    allowedAssets,
    allowedRouteProtocolSets: routeProtocolSets,
    allowedRouteAssetSets: routeAssetSets,
    recipientMaterials: Object.freeze([recipientPolicyMaterialV4(plan)]),
    privacyBudget: plan.intent.privacyBudget,
    privacyBudgetCommitment: sha256V4("KLETIA_PRIVACY_BUDGET_V4", plan.intent.privacyBudget),
    routes: Object.freeze(plan.routes.map((route) => Object.freeze({
      id: route.id,
      label: route.label,
      protocolSet: routeProtocolSetV4(route),
      assetSet: routeAssetSetV4(plan.intent.legs, route),
      available: route.available,
      ...(route.unavailableReason ? { unavailableReason: route.unavailableReason } : {}),
    }))),
    limitations: Object.freeze([
      "Policy options enumerate candidate route classes; no route has been selected or quoted.",
      "Execution remains unavailable until the signed profile, exact Policy V2 proof, Stellar control-plane commitment and per-step wallet signatures pass.",
    ]),
  });
}

function routeAllowedByPolicy(
  route: RouteCandidateV3,
  profile: PolicyProfileV1,
  legs: readonly IntentLegV3[],
): boolean {
  const protocolSet = routeProtocolSetV4(route);
  const assetSet = routeAssetSetV4(legs, route);
  return route.chains.every((chain) => profile.core.allowedChains.includes(chain)) &&
    route.protocols.every((protocol) => profile.core.allowedProtocols.includes(protocol)) &&
    profile.core.allowedRouteProtocolSets.some((allowed) =>
      allowed.length === protocolSet.length && allowed.every((entry, index) => entry === protocolSet[index])) &&
    profile.core.allowedRouteAssetSets.some((allowed) =>
      allowed.length === assetSet.length && allowed.every((entry, index) => entry === assetSet[index]));
}

function questionsFor(input: Record<string, unknown>): IntentIRV4["unresolved"] {
  const questions: Array<IntentIRV4["unresolved"][number]> = [];
  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    questions.push({
      field: "route_graph",
      question: "Which network and financial action should Kletia compile?",
      options: [
        { id: "single_network", label: "Single network", effect: "Use one selected network and its reviewed local protocols." },
        { id: "cross_chain", label: "Cross-chain", effect: "Compare only lane-compatible checkpointed bridge routes." },
      ],
    });
  }
  if (!input.policyProfile) {
    questions.push({
      field: "policy_profile",
      question: "Review and sign the Stellar policy profile before Kletia selects a financial route.",
      options: [
        { id: "review_policy", label: "Review policy", effect: "Bind networks, protocols, assets, risk and privacy limits before route selection." },
        { id: "read_only", label: "Read only", effect: "Continue with portfolio and quote discovery without enabling financial execution." },
      ],
    });
  }
  return questions;
}

export function interpretIntentV4(body: unknown): IntentInterpretationV4 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw controlled("INTENT_V4_BODY_INVALID", "A structured, browser-redacted V4 request is required.", 400);
  }
  const input = body as Record<string, unknown>;
  const goal = semanticGoal(input.semanticGoal);
  const lane = input.lane === "production" || input.lane === "testnet" ? input.lane : null;
  const privateReferences = [...goal.matchAll(PRIVATE_REFERENCE_PATTERN)].map((match) => match[0]);
  return {
    schemaVersion: "kletia_intent_interpretation_v4",
    requestId: typeof input.requestId === "string" && /^[0-9a-f-]{36}$/iu.test(input.requestId)
      ? input.requestId
      : randomUUID(),
    semanticGoal: goal,
    lane,
    legs: [],
    privateReferences: Object.freeze([...new Set(privateReferences)]),
    questions: questionsFor(input),
    rawPrivateFieldsReceivedByApi: false,
    deterministicCompilerRequired: true,
  };
}

export async function compileWorkflowPlanV4(
  body: unknown,
  options: {
    readonly liveControlPlaneReady?: boolean;
    readonly controlPlaneContractId?: string | null;
  } = {},
): Promise<WorkflowPlanV4> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw controlled("INTENT_V4_BODY_INVALID", "A structured V4 intent body is required.", 400);
  }
  const input = body as Record<string, unknown>;
  const goal = semanticGoal(input.semanticGoal);
  const v3Input: Record<string, unknown> = { ...input, semanticGoal: goal };
  delete v3Input.policyProfile;
  delete v3Input.schemaVersion;
  const compatibilityPlan = compileWorkflowPlanV3(v3Input, {
    liveControlPlaneReady: options.liveControlPlaneReady,
    liveSolverMarketReady: false,
  });
  const isFinancial = financialIntent(compatibilityPlan.intent.legs);
  const profile = isFinancial ? await verifyPolicyProfileV1(input.policyProfile) : null;
  if (profile) assertPolicyApplies(profile, compatibilityPlan);
  const policyFilteredRoutes = (profile
    ? compatibilityPlan.routes.filter((route) => routeAllowedByPolicy(route, profile, compatibilityPlan.intent.legs))
    : compatibilityPlan.routes).map((route) => {
      const financialSteps = route.steps.filter((step) =>
        step.operation !== "control_plane_commit" &&
        step.operation !== "receipt_registry_commit" &&
        step.operation !== "receipt_registry_finalize" &&
        step.operation !== "control_plane_finalize");
      return {
        ...route,
        steps: financialSteps.map((step, index) => ({
          ...step,
          order: index + 1,
          dependsOn: index === 0 ? [] : [financialSteps[index - 1]!.id],
          status: step.executionReadiness === "ready"
            ? index === 0
              ? step.signer === "none" ? "ready" as const : "awaiting_signature" as const
              : "planned" as const
            : "blocked" as const,
        })),
      };
    });
  const selectedRoute = compatibilityPlan.intent.unresolved.length > 0
    ? null
    : policyFilteredRoutes.find((route) => route.id === compatibilityPlan.intent.preferredRouteId) ??
      policyFilteredRoutes.find((route) => route.available) ??
      policyFilteredRoutes[0] ??
      null;
  const controlPlaneNetwork = compatibilityPlan.lane === "testnet" ? "stellar_testnet" : "stellar_mainnet";
  const controlPlaneContractId = String(options.controlPlaneContractId ?? "").trim();
  const controlPlaneReady =
    options.liveControlPlaneReady === true &&
    StrKey.isValidContract(controlPlaneContractId);
  const reasons: string[] = [];
  let status: WorkflowPlanV4["executionGate"]["status"] = "read_only";
  if (compatibilityPlan.intent.unresolved.length > 0) {
    status = "clarification_required";
    reasons.push("Required intent fields remain unresolved.");
  } else if (isFinancial && !profile) {
    status = "policy_required";
    reasons.push("A verified Stellar PolicyProfileV1 is mandatory before financial route selection.");
  } else if (isFinancial && !controlPlaneReady) {
    status = "control_plane_unavailable";
    reasons.push(`The ${controlPlaneNetwork} control plane is not live-attested; financial execution fails closed.`);
  } else if (isFinancial) {
    status = "policy_proof_required";
    reasons.push("The device must prove the exact selected route satisfies the pre-authorized Policy V2 roots and amount bounds.");
  }
  const intent: IntentIRV4 = {
    schemaVersion: "kletia_intent_ir_v4",
    requestId: compatibilityPlan.requestId,
    semanticGoal: goal,
    lane: compatibilityPlan.lane,
    legs: compatibilityPlan.intent.legs,
    privateBindings: compatibilityPlan.intent.privateBindings,
    privacyBudget: compatibilityPlan.intent.privacyBudget,
    policyProfile: profile,
    unresolved: compatibilityPlan.intent.unresolved,
  };
  const v4CompatibilityPlan = {
    ...compatibilityPlan,
    routes: policyFilteredRoutes,
    selectedRouteId: selectedRoute?.id ?? null,
    currentStepId: selectedRoute?.steps[0]?.id ?? null,
  };
  return {
    version: 4,
    schemaVersion: "kletia_workflow_plan_v4",
    workflowId: compatibilityPlan.workflowId,
    requestId: compatibilityPlan.requestId,
    createdAt: compatibilityPlan.createdAt,
    expiresAt: Math.min(compatibilityPlan.expiresAt, profile?.core.expiresAt ?? compatibilityPlan.expiresAt),
    lane: compatibilityPlan.lane,
    intent,
    walletBindings: compatibilityPlan.walletBindings,
    policy: {
      required: isFinancial,
      verified: profile !== null,
      profileHash: profile?.profileHash ?? null,
      authorizationScheme: profile?.authorization.scheme ?? null,
      constraintsAppliedBeforeRouteSelection: true,
      proofBinding: {
        status: isFinancial ? "device_proof_required" : "not_required",
        routeId: null,
        verifierVersion: null,
        publicInputsHash: null,
        proofSha256: null,
        nullifier: null,
        executionContextCommitment: null,
        verifiedAtLedger: null,
      },
    },
    controlPlane: {
      requiredForEveryFinancialIntent: true,
      network: controlPlaneNetwork,
      failClosedWhenUnavailable: true,
      readOnlyMayContinueWhenUnavailable: true,
      ready: controlPlaneReady,
      contractId: controlPlaneReady ? controlPlaneContractId : null,
      reason: controlPlaneReady ? null : "Live Stellar control-plane readiness did not pass for this lane.",
      externalExecutionTruthProvenByStellar: false,
      commitment: {
        status: isFinancial ? "awaiting_policy_proof" : "not_required",
        transactionHash: null,
        nonce: null,
        committedAtLedger: null,
        receiptCloseByLedger: null,
        retentionFloorLedger: null,
      },
    },
    capabilityEdges: capabilityEdgesV4(),
    routes: policyFilteredRoutes,
    selectedRouteId: selectedRoute?.id ?? null,
    currentStepId: selectedRoute?.steps[0]?.id ?? null,
    executionHandoff: {
      status: "not_bound",
      executor: null,
      executorWorkflowId: null,
      parentPlanHashAtHandoff: null,
      executorPlanCoreSha256: null,
      executorExpiresAt: null,
      boundAt: null,
      progressStatus: "not_started",
      confirmedCheckpointCount: 0,
      totalCheckpointCount: 0,
      currentAction: null,
      terminalReceiptSha256: null,
      lastSyncedAt: null,
    },
    privacy: {
      budget: compatibilityPlan.privacy.budget,
      disclosureDiff: policyFilteredRoutes.flatMap((route) => route.steps.flatMap((step) => step.disclosure)),
      rawPrivateFieldsReceivedByAi: false,
      rawPrivateFieldsReceivedByApi: false,
      publicLedgerDisclosureStillApplies: true,
    },
    evidencePolicy: {
      minimumLevel: compatibilityPlan.intent.coordination.minimumEvidenceLevel,
      transactionHashAloneIsSuccess: false,
      indeterminateMayRetryAutomatically: false,
    },
    executionGate: {
      // Compilation and Policy V2 binding are separate transitions. The
      // compiler never emits a signable financial payload by itself.
      signable: false,
      status,
      reasons,
    },
    compatibility: {
      engine: "workflow_v3",
      planHash: workflowPlanV3Hash(v4CompatibilityPlan),
      plan: v4CompatibilityPlan,
      v3ExecutionTokenExposed: false,
    },
  };
}

export function workflowPlanV4Hash(plan: WorkflowPlanV4): `0x${string}` {
  return sha256V4("KLETIA_WORKFLOW_PLAN_V4", plan);
}

export function policyAssetIdV4(asset: AssetRef): string {
  return assetPolicyId(asset);
}

export function isStellarControlPlaneWalletV4(
  value: AddressRef,
  lane: "production" | "testnet",
): boolean {
  return value.family === "stellar" &&
    value.network === (lane === "testnet" ? "testnet" : "public") &&
    StrKey.isValidEd25519PublicKey(value.address);
}

export function requiredControlPlaneChainV4(lane: "production" | "testnet") {
  return lane === "testnet" ? CHAINS_V3.stellar_testnet : CHAINS_V3.stellar_mainnet;
}
