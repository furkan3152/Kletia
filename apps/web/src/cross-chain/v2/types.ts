export type StellarRouteKind =
  | "direct_cctp"
  | "stellar_centered_public";

export type WorkflowV2Network =
  | "arc_testnet"
  | "stellar_testnet"
  | "arbitrum_sepolia";

export type WorkflowV2Status =
  | "planned"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "attesting"
  | "filled"
  | "ready"
  | "failed"
  | "refunded"
  | "indeterminate"
  | "recovery_required";

export type PrivacyBudgetPresetV1 =
  | "public_execution"
  | "private_planning_public_execution"
  | "deterministic_only_public_execution"
  | "confidential_ledger_required";

export interface PrivacyBudgetV1 {
  schemaVersion: "kletia_privacy_budget_v1";
  preset: PrivacyBudgetPresetV1;
  enforcement: "fail_closed";
  rules: Array<{
    phase: string;
    field: string;
    allowedObservers: string[];
    reason: string;
  }>;
  requiresOnchainConfidentiality: boolean;
  allowsCommitmentOpeningForPublicExecution: boolean;
  limitations: string[];
}

export interface DisclosureDiffV1 {
  schemaVersion: "kletia_disclosure_diff_v1";
  workflowId: string;
  entries: Array<{
    stepId: string;
    phase: string;
    newlyLearned: Array<{
      stepId: string;
      phase: string;
      field: string;
      observer: string;
      reason: string;
      irreversible: boolean;
    }>;
    alreadyKnown: Array<{
      stepId: string;
      phase: string;
      field: string;
      observer: string;
      reason: string;
      irreversible: boolean;
    }>;
    summary: string;
  }>;
  finalKnowledge: Array<{
    stepId: string;
    phase: string;
    field: string;
    observer: string;
    reason: string;
    irreversible: boolean;
  }>;
  violations: Array<{
    stepId: string;
    phase: string;
    field: string;
    observer: string;
    code: string;
    message: string;
  }>;
  compatible: boolean;
  limitations: string[];
}

export interface WorkflowRouteCandidateV2 {
  kind: StellarRouteKind;
  label: string;
  available: boolean;
  unavailableReason?: string;
  networks: WorkflowV2Network[];
  estimatedDurationSeconds: { minimum: number; maximum: number };
  privacyGain: "private_intent_only";
  /** Gross RouteGraphV1 disclosure weight, before the unlinkability credit. */
  disclosureCost: number;
  failureRiskScore: number;
  rankingReason: string;
  score: {
    methodology: "kletia_normalized_route_score_v2";
    lowerIsBetter: true;
    bridgeFeeBps: number;
    latencyPenalty: number;
    failurePenalty: number;
    /** Net disclosure term that actually participates in `total`. */
    disclosurePenalty: number;
    disclosureRawWeight: number;
    ledgerLinkageCredit: number;
    correlationDomainsRequired: number;
    disclosureScale: number;
    apyCredit: number;
    total: number;
    limitations: string[];
  };
  disclosureProfile: {
    schemaVersion: "kletia_route_disclosure_profile_v1";
    rawWeight: number;
    scale: number;
    pairs: Array<{ field: string; observer: string; weight: number }>;
    ledgerObservers: string[];
    correlationDomainsRequired: number;
    ledgerLinkageCredit: number;
    netPenalty: number;
    reasoning: string;
    limitations: string[];
  };
  routeGraph: {
    schemaVersion: "kletia_route_graph_v1";
    edgeIds: string[];
    traversedNodes: string[];
    stepCount: number;
  };
  liveEvidence: {
    observedAt: string;
    quoteExpiresAt: number;
    cctpStandardFeeBps: number;
    cctpHops: 1 | 2;
    cctpLegs: Array<{
      sourceDomain: 26 | 27;
      destinationDomain: 3 | 27;
      standardFeeBps: number;
    }>;
    aaveSupplyApyBps: number;
    sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"];
  };
}

export interface WorkflowStepV2 {
  id: string;
  order: number;
  action: string;
  network: WorkflowV2Network;
  status: WorkflowV2Status;
  target?: string;
  binding?: {
    protocol: string;
    method: string;
    sourceDomain?: number;
    destinationDomain?: number;
    recipientBinding?: string;
    destinationCaller?: string;
    finalityThreshold?: number;
  };
  dependsOn: string[];
  evidenceRequired: string[];
  disclosure: Array<{
    field: string;
    visibleTo: string[];
    reason: string;
  }>;
  result?: {
    kind: "evm_transaction" | "stellar_transaction" | "circle_attestation" | "read_result";
    reference: string;
    observedAt: string;
    blockOrLedger?: string;
    amountAtomic?: string;
    feeAtomic?: string;
    maxFeeAtomic?: string;
    feeQuoteBps?: number;
    feeQuoteObservedAt?: string;
    nonce?: string;
    message?: string;
    attestation?: string;
    safeBorrowCapacityAtomic?: string;
    capacityStatus?: "theoretical_read_only" | "borrowing_disabled";
    targetHealthFactor?: string;
    limitations?: string[];
  };
}

export interface WorkflowPlanV2 {
  version: 2;
  schemaVersion: "kletia_workflow_plan_v2";
  workflowId: string;
  requestId: string;
  environmentLane: "testnet";
  createdAt: number;
  expiresAt: number;
  recoveryExpiresAt: number;
  authorizationRefreshedAt?: number;
  semanticGoal: string;
  parentWorkflowV3?: {
    schemaVersion: "kletia_workflow_v3_execution_parent_v1";
    workflowId: string;
    workflowRoot: `0x${string}`;
    planHashAtHandoff: `0x${string}`;
    expiresAt: number;
    controlPlaneTransactionHash: string;
    receiptRegistryTransactionHash: string;
    externalExecutionTruthProvenByStellar: false;
  };
  parentWorkflowV4?: {
    schemaVersion: "kletia_workflow_v4_execution_parent_v1";
    workflowId: string;
    workflowRoot: `0x${string}`;
    planHashAtHandoff: `0x${string}`;
    expiresAt: number;
    controlPlaneContractId: string;
    controlPlaneTransactionHash: string;
    controlPlaneNonce: string;
    policyProofPublicInputsHash: `0x${string}`;
    externalExecutionTruthProvenByStellar: false;
  };
  authorizationBoundary: {
    schemaVersion: "kletia_workflow_authorization_boundary_v2";
    planCoreSha256: `0x${string}`;
    manifestMessage: string;
    requiredStepSigners: Array<"arc_wallet" | "stellar_wallet" | "arbitrum_sepolia_wallet">;
    invalidatedBy: string[];
  };
  manifestAuthorization?: {
    family: "evm" | "stellar";
    signer: string;
    signature: string;
    manifestSha256: `0x${string}`;
    verifiedAt: string;
  };
  walletBindings: Array<
    | {
        id: "arc_wallet" | "arbitrum_sepolia_wallet";
        family: "evm";
        network: "arc_testnet" | "arbitrum_sepolia";
        address: `0x${string}`;
      }
    | {
        id: "stellar_wallet";
        family: "stellar";
        network: "stellar_testnet";
        address: string;
      }
  >;
  assets: Array<
    | {
        family: "evm";
        network: "arc_testnet" | "arbitrum_sepolia";
        symbol: "USDC";
        address: `0x${string}`;
        decimals: 6;
      }
    | {
        family: "stellar";
        network: "stellar_testnet";
        symbol: "USDC";
        code: "USDC";
        issuer: string;
        sac: string;
        decimals: 7;
      }
  >;
  selectedRoute: StellarRouteKind;
  routeSelection: {
    mode: "auto" | "explicit";
    selectedScore: number;
    rationale: string;
    amountDependentCostsExcluded: true;
  };
  currentStepIndex: number;
  routeCandidates: WorkflowRouteCandidateV2[];
  steps: WorkflowStepV2[];
  terminalReceipt?: {
    schemaVersion: "kletia_workflow_terminal_receipt_v1";
    receiptSha256: `0x${string}`;
    generatedAt: string;
    checkpointCount: number;
    executorPlanCoreSha256: `0x${string}`;
    externalExecutionTruthProvenByStellar: false;
  };
  privacy: {
    scope: "browser_private_fields_public_ledger";
    semanticPlanner: "openrouter_constrained" | "deterministic_registry";
    privateFieldIsolationRequested: true;
    onchainConfidentiality: "none";
    privateAmountExcludedFromSemanticRequest: true;
    recipientExcludedFromSemanticRequest: true;
    rawPrivateAmountReceivedDuringPlanning: false;
    recipientReceivedAsPublicWalletBinding: true;
    publicAmountOpeningRequired: true;
    amountCommitment: `0x${string}`;
    recipientCommitment: `0x${string}`;
    boundaryMap: {
      schemaVersion: "kletia_privacy_boundary_map_v1";
      planning: WorkflowStepV2["disclosure"];
      checkpoints: Array<{
        stepId: string;
        network: WorkflowV2Network;
        action: string;
        disclosure: WorkflowStepV2["disclosure"];
      }>;
      commitmentOpeningSchedule: Array<{
        field: "amount" | "recipient";
        openingStep: "step-1";
        reason: string;
      }>;
    };
    privacyBudget: PrivacyBudgetV1;
    disclosureDiff: DisclosureDiffV1;
    limitations: string[];
  };
  policies: {
    requiresPerStepWalletApproval: true;
    crossChainAtomicity: "staged_checkpointed_no_global_rollback";
    minimumHealthFactor: "1.5";
    mockDataAllowed: false;
    environmentMixingAllowed: false;
    silentRetryAllowed: false;
  };
}

export interface WorkflowV2Response {
  success: true;
  status: "success";
  executionKind: "workflow_plan_v2";
  network: "stellar";
  chainRef: "stellar:testnet";
  requestId: string;
  message: string;
  workflowPlan: WorkflowPlanV2;
  workflowToken: string;
}

export interface WorkflowAdvanceV2Response {
  success: true;
  workflowPlan: WorkflowPlanV2;
  workflowToken: string;
  terminal: boolean;
  message: string;
  executionReceipt?: {
    schemaVersion: "kletia_execution_receipt_v1";
    workflowId: string;
    workflowBindingHash: `0x${string}`;
    planCoreSha256: `0x${string}`;
    receiptSha256: `0x${string}`;
    status: "confirmed";
    generatedAt: string;
    crossChainAtomicity: "staged_checkpointed_no_global_rollback";
    privateValuesExcludedFromAiPlanning: true;
    manifestAuthorization: NonNullable<WorkflowPlanV2["manifestAuthorization"]>;
    privacyBudget: PrivacyBudgetV1;
    disclosureDiff: DisclosureDiffV1;
    verificationModel: {
      kind: "evidence_bound_application_receipt_sha256";
      recomputeReceiptHash: true;
      verifyUnderlyingChainEvidence: true;
      kletiaSignaturePresent: false;
      onchainAnchorPresent: false;
      limitation: string;
    };
    checkpoints: Array<{
      stepId: string;
      action: string;
      network: WorkflowV2Network;
      status: WorkflowV2Status;
      target?: string;
      binding?: WorkflowStepV2["binding"];
      evidenceRequired: string[];
      result?: WorkflowStepV2["result"];
    }>;
  };
}

export type WorkflowLifecycleOutcome =
  | "failed"
  | "indeterminate"
  | "recovery_required";

export interface WorkflowLifecycleClassificationV1 {
  schemaVersion: "kletia_workflow_lifecycle_v1";
  status: WorkflowLifecycleOutcome;
  code: string;
  retryable: boolean;
  silentRetryAllowed: false;
  reason: string;
  operatorAction: string;
}

export interface WorkflowLifecycleErrorResponse {
  success: false;
  code: string;
  message: string;
  lifecycle: WorkflowLifecycleClassificationV1;
  workflowToken: string;
  workflowPlan: WorkflowPlanV2;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isCommitment = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[a-f\d]{64}$/u.test(value);

const hexSha256 = (value: string): `0x${string}` =>
  `0x${Array.from(sha256(new TextEncoder().encode(value)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
};

const workflowPlanCore = (plan: Record<string, unknown>): unknown => {
  const routes = Array.isArray(plan.routeCandidates) ? plan.routeCandidates : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const selectedEvidence = routes.find(
    (candidate) => isObject(candidate) && candidate.kind === plan.selectedRoute,
  );
  return canonicalValue({
    schemaVersion: "kletia_workflow_plan_core_v2",
    workflowId: plan.workflowId,
    requestId: plan.requestId,
    environmentLane: plan.environmentLane,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    recoveryExpiresAt: plan.recoveryExpiresAt,
    authorizationRefreshedAt: plan.authorizationRefreshedAt,
    objective: plan.objective,
    semanticGoal: plan.semanticGoal,
    parentWorkflowV3: plan.parentWorkflowV3,
    parentWorkflowV4: plan.parentWorkflowV4,
    policyAnchor: plan.policyAnchor,
    walletBindings: plan.walletBindings,
    assets: plan.assets,
    selectedRoute: plan.selectedRoute,
    routeSelection: plan.routeSelection,
    selectedRouteLiveEvidence: isObject(selectedEvidence)
      ? selectedEvidence.liveEvidence
      : undefined,
    steps: steps.map((entry) => {
      const step = isObject(entry) ? entry : {};
      return {
        id: step.id,
        order: step.order,
        action: step.action,
        network: step.network,
        walletBinding: step.walletBinding,
        dependsOn: step.dependsOn,
        amount: step.amount,
        target: step.target,
        binding: step.binding,
        deadline: step.deadline,
        evidenceRequired: step.evidenceRequired,
        disclosure: step.disclosure,
      };
    }),
    privacy: plan.privacy,
    policies: plan.policies,
  });
};

const validatesAuthorizationBoundary = (plan: Record<string, unknown>): boolean => {
  if (!isObject(plan.authorizationBoundary)) return false;
  const boundary = plan.authorizationBoundary;
  const planCoreSha256 = hexSha256(JSON.stringify(workflowPlanCore(plan)));
  if (
    boundary.schemaVersion !== "kletia_workflow_authorization_boundary_v2" ||
    boundary.planCoreSha256 !== planCoreSha256 ||
    typeof boundary.manifestMessage !== "string" ||
    !Array.isArray(boundary.requiredStepSigners) ||
    !Array.isArray(boundary.invalidatedBy)
  ) {
    return false;
  }
  let manifest: Record<string, unknown>;
  try {
    const decoded = JSON.parse(boundary.manifestMessage) as unknown;
    if (!isObject(decoded)) return false;
    manifest = decoded;
  } catch {
    return false;
  }
  return (
    manifest.domain === "KLETIA_PRIVATE_INTENT_V1" &&
    manifest.schemaVersion === "kletia_workflow_authorization_manifest_v2" &&
    manifest.environmentLane === plan.environmentLane &&
    manifest.workflowId === plan.workflowId &&
    manifest.requestId === plan.requestId &&
    manifest.selectedRoute === plan.selectedRoute &&
    manifest.expiresAt === plan.expiresAt &&
    manifest.planCoreSha256 === planCoreSha256 &&
    isObject(plan.privacy) &&
    manifest.amountCommitment === plan.privacy.amountCommitment &&
    manifest.recipientCommitment === plan.privacy.recipientCommitment &&
    manifest.rawPrivateFieldsIncluded === false
  );
};

/**
 * Re-derives the disclosure term and the score total on the device.
 *
 * The point is not that the server might miscalculate; it is that a route
 * comparison the user is asked to sign should be reproducible from the same
 * published numbers. If the server ever changed the weighting silently, the
 * arithmetic below would stop matching and the plan would be refused.
 */
const validatesRoute = (route: unknown): boolean => {
  if (
    !isObject(route) ||
    !isObject(route.liveEvidence) ||
    !isObject(route.score) ||
    !isObject(route.disclosureProfile) ||
    !isObject(route.routeGraph)
  ) {
    return false;
  }
  const score = route.score;
  const profile = route.disclosureProfile;
  const graph = route.routeGraph;
  const numeric = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  if (
    !numeric(profile.rawWeight) ||
    !numeric(profile.scale) ||
    profile.scale <= 0 ||
    !numeric(profile.ledgerLinkageCredit) ||
    !numeric(profile.netPenalty) ||
    !numeric(score.bridgeFeeBps) ||
    !numeric(score.latencyPenalty) ||
    !numeric(score.failurePenalty) ||
    !numeric(score.disclosurePenalty) ||
    !numeric(score.apyCredit) ||
    !numeric(score.total)
  ) {
    return false;
  }
  const expectedNetPenalty = Number(
    ((profile.rawWeight - profile.ledgerLinkageCredit) / profile.scale).toFixed(4),
  );
  const expectedTotal = Number(
    (
      score.bridgeFeeBps +
      score.latencyPenalty +
      score.failurePenalty +
      score.disclosurePenalty -
      score.apyCredit
    ).toFixed(4),
  );
  return (
    typeof route.liveEvidence.quoteExpiresAt === "number" &&
    Array.isArray(route.liveEvidence.cctpLegs) &&
    score.methodology === "kletia_normalized_route_score_v2" &&
    score.lowerIsBetter === true &&
    Array.isArray(score.limitations) &&
    profile.schemaVersion === "kletia_route_disclosure_profile_v1" &&
    Array.isArray(profile.pairs) &&
    profile.pairs.length > 0 &&
    profile.netPenalty === expectedNetPenalty &&
    profile.ledgerLinkageCredit === 0 &&
    score.disclosurePenalty === profile.netPenalty &&
    score.disclosureRawWeight === profile.rawWeight &&
    score.ledgerLinkageCredit === profile.ledgerLinkageCredit &&
    score.correlationDomainsRequired === profile.correlationDomainsRequired &&
    score.disclosureScale === profile.scale &&
    Math.abs(score.total - expectedTotal) < 0.0002 &&
    graph.schemaVersion === "kletia_route_graph_v1" &&
    Array.isArray(graph.edgeIds) &&
    graph.edgeIds.length > 0 &&
    Array.isArray(graph.traversedNodes) &&
    graph.traversedNodes.length > 0
  );
};

const validatesPrivacyBudget = (value: unknown): value is PrivacyBudgetV1 => {
  if (!isObject(value) || !Array.isArray(value.rules)) return false;
  const preset = value.preset;
  return (
    value.schemaVersion === "kletia_privacy_budget_v1" &&
    (preset === "public_execution" ||
      preset === "private_planning_public_execution" ||
      preset === "deterministic_only_public_execution" ||
      preset === "confidential_ledger_required") &&
    value.enforcement === "fail_closed" &&
    typeof value.requiresOnchainConfidentiality === "boolean" &&
    typeof value.allowsCommitmentOpeningForPublicExecution === "boolean" &&
    Array.isArray(value.limitations) &&
    value.rules.length > 0 &&
    value.rules.every(
      (rule) =>
        isObject(rule) &&
        typeof rule.phase === "string" &&
        typeof rule.field === "string" &&
        Array.isArray(rule.allowedObservers) &&
        rule.allowedObservers.every((observer) => typeof observer === "string") &&
        typeof rule.reason === "string",
    )
  );
};

const validatesDisclosureDiff = (
  value: unknown,
  workflowId: unknown,
): value is DisclosureDiffV1 =>
  isObject(value) &&
  value.schemaVersion === "kletia_disclosure_diff_v1" &&
  value.workflowId === workflowId &&
  value.compatible === true &&
  Array.isArray(value.entries) &&
  value.entries.length > 0 &&
  value.entries.every(
    (entry) =>
      isObject(entry) &&
      typeof entry.stepId === "string" &&
      typeof entry.phase === "string" &&
      Array.isArray(entry.newlyLearned) &&
      Array.isArray(entry.alreadyKnown) &&
      typeof entry.summary === "string",
  ) &&
  Array.isArray(value.finalKnowledge) &&
  Array.isArray(value.violations) &&
  value.violations.length === 0 &&
  Array.isArray(value.limitations);

export function isWorkflowV2Response(
  value: unknown,
  expected: {
    requestId: string;
    amountCommitment: `0x${string}`;
    recipientCommitment: `0x${string}`;
    arcAddress?: string;
    arbitrumSepoliaAddress?: string;
    stellarAddress?: string;
    privacyBudgetPreset?: PrivacyBudgetPresetV1;
    parentWorkflowV3?: {
      workflowId: string;
      workflowRoot: `0x${string}`;
      planHashAtHandoff: `0x${string}`;
      expiresAt: number;
      controlPlaneTransactionHash: string;
      receiptRegistryTransactionHash: string;
    };
    parentWorkflowV4?: {
      workflowId: string;
      workflowRoot: `0x${string}`;
      planHashAtHandoff: `0x${string}`;
      expiresAt: number;
      controlPlaneContractId: string;
      controlPlaneTransactionHash: string;
      controlPlaneNonce: string;
      policyProofPublicInputsHash: `0x${string}`;
    };
  },
): value is WorkflowV2Response {
  if (!isObject(value) || !isObject(value.workflowPlan)) return false;
  const plan = value.workflowPlan;
  const privacy = isObject(plan.privacy) ? plan.privacy : null;
  const policies = isObject(plan.policies) ? plan.policies : null;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const routes = Array.isArray(plan.routeCandidates)
    ? plan.routeCandidates
    : [];
  const wallets = Array.isArray(plan.walletBindings) ? plan.walletBindings : [];
  const assets = Array.isArray(plan.assets) ? plan.assets : [];
  const expectedWallet = (id: string, address: string | undefined) =>
    !address ||
    wallets.some(
      (wallet) =>
        isObject(wallet) &&
        wallet.id === id &&
        typeof wallet.address === "string" &&
        wallet.address.toLowerCase() === address.toLowerCase(),
    );
  const reviewedAssets =
    assets.length === (plan.selectedRoute === "direct_cctp" ? 2 : 3) &&
    (plan.selectedRoute === "direct_cctp" || assets.some(
      (asset) =>
        isObject(asset) &&
        asset.network === "arc_testnet" &&
        String(asset.address).toLowerCase() ===
          "0x3600000000000000000000000000000000000000",
    ) &&
    assets.some(
      (asset) =>
        isObject(asset) &&
        asset.network === "arbitrum_sepolia" &&
        String(asset.address).toLowerCase() ===
          "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    ) &&
    assets.some(
      (asset) =>
        isObject(asset) &&
        asset.network === "stellar_testnet" &&
        asset.issuer ===
          "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" &&
        asset.sac ===
          "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ));
  const currentIndex = Number(plan.currentStepIndex);
  const currentStep = Number.isInteger(currentIndex) ? steps[currentIndex] : null;
  return (
    value.success === true &&
    value.status === "success" &&
    value.executionKind === "workflow_plan_v2" &&
    value.network === "stellar" &&
    value.chainRef === "stellar:testnet" &&
    value.requestId === expected.requestId &&
    typeof value.workflowToken === "string" &&
    value.workflowToken.startsWith("v2.") &&
    plan.version === 2 &&
    plan.schemaVersion === "kletia_workflow_plan_v2" &&
    plan.environmentLane === "testnet" &&
    plan.requestId === expected.requestId &&
    typeof plan.workflowId === "string" &&
    typeof plan.expiresAt === "number" &&
    typeof plan.recoveryExpiresAt === "number" &&
    plan.recoveryExpiresAt > Date.now() &&
    validatesAuthorizationBoundary(plan) &&
    (!expected.parentWorkflowV3 ||
      (isObject(plan.parentWorkflowV3) &&
        plan.parentWorkflowV3.schemaVersion === "kletia_workflow_v3_execution_parent_v1" &&
        plan.parentWorkflowV3.workflowId === expected.parentWorkflowV3.workflowId &&
        plan.parentWorkflowV3.workflowRoot === expected.parentWorkflowV3.workflowRoot &&
        plan.parentWorkflowV3.planHashAtHandoff === expected.parentWorkflowV3.planHashAtHandoff &&
        plan.parentWorkflowV3.expiresAt === expected.parentWorkflowV3.expiresAt &&
        plan.parentWorkflowV3.controlPlaneTransactionHash === expected.parentWorkflowV3.controlPlaneTransactionHash &&
        plan.parentWorkflowV3.receiptRegistryTransactionHash === expected.parentWorkflowV3.receiptRegistryTransactionHash &&
        plan.parentWorkflowV3.externalExecutionTruthProvenByStellar === false)) &&
    (!expected.parentWorkflowV4 ||
      (isObject(plan.parentWorkflowV4) &&
        plan.parentWorkflowV4.schemaVersion === "kletia_workflow_v4_execution_parent_v1" &&
        plan.parentWorkflowV4.workflowId === expected.parentWorkflowV4.workflowId &&
        plan.parentWorkflowV4.workflowRoot === expected.parentWorkflowV4.workflowRoot &&
        plan.parentWorkflowV4.planHashAtHandoff === expected.parentWorkflowV4.planHashAtHandoff &&
        plan.parentWorkflowV4.expiresAt === expected.parentWorkflowV4.expiresAt &&
        plan.parentWorkflowV4.controlPlaneContractId === expected.parentWorkflowV4.controlPlaneContractId &&
        plan.parentWorkflowV4.controlPlaneTransactionHash === expected.parentWorkflowV4.controlPlaneTransactionHash &&
        plan.parentWorkflowV4.controlPlaneNonce === expected.parentWorkflowV4.controlPlaneNonce &&
        plan.parentWorkflowV4.policyProofPublicInputsHash === expected.parentWorkflowV4.policyProofPublicInputsHash &&
        plan.parentWorkflowV4.externalExecutionTruthProvenByStellar === false)) &&
    privacy?.privateAmountExcludedFromSemanticRequest === true &&
    privacy.scope === "browser_private_fields_public_ledger" &&
    (privacy.semanticPlanner === "openrouter_constrained" ||
      privacy.semanticPlanner === "deterministic_registry") &&
    privacy.privateFieldIsolationRequested === true &&
    privacy.onchainConfidentiality === "none" &&
    privacy.recipientExcludedFromSemanticRequest === true &&
    privacy.rawPrivateAmountReceivedDuringPlanning === false &&
    privacy.recipientReceivedAsPublicWalletBinding === true &&
    privacy.publicAmountOpeningRequired === true &&
    isObject(privacy.boundaryMap) &&
    privacy.boundaryMap.schemaVersion === "kletia_privacy_boundary_map_v1" &&
    Array.isArray(privacy.boundaryMap.planning) &&
    Array.isArray(privacy.boundaryMap.checkpoints) &&
    Array.isArray(privacy.boundaryMap.commitmentOpeningSchedule) &&
    validatesPrivacyBudget(privacy.privacyBudget) &&
    (!expected.privacyBudgetPreset ||
      privacy.privacyBudget.preset === expected.privacyBudgetPreset) &&
    validatesDisclosureDiff(privacy.disclosureDiff, plan.workflowId) &&
    privacy.amountCommitment === expected.amountCommitment &&
    privacy.recipientCommitment === expected.recipientCommitment &&
    isCommitment(privacy.amountCommitment) &&
    isCommitment(privacy.recipientCommitment) &&
    policies?.requiresPerStepWalletApproval === true &&
    policies.crossChainAtomicity === "staged_checkpointed_no_global_rollback" &&
    policies.mockDataAllowed === false &&
    policies.environmentMixingAllowed === false &&
    policies.silentRetryAllowed === false &&
    expectedWallet("arc_wallet", expected.arcAddress) &&
    expectedWallet("arbitrum_sepolia_wallet", expected.arbitrumSepoliaAddress) &&
    expectedWallet("stellar_wallet", expected.stellarAddress) &&
    reviewedAssets &&
    Number.isInteger(currentIndex) &&
    currentIndex >= 0 &&
    currentIndex < steps.length &&
    steps.length >= 6 &&
    steps.length <= 20 &&
    steps.every(
      (step, index) =>
        isObject(step) &&
        step.id === `step-${index + 1}` &&
        step.order === index + 1 &&
        typeof step.network === "string" &&
        Array.isArray(step.evidenceRequired),
    ) &&
    routes.length >= 1 &&
    routes.length <= 2 &&
    routes.some(
      (route) => isObject(route) && route.kind === plan.selectedRoute,
    ) &&
    routes.every(validatesRoute) &&
    isObject(currentStep) &&
    (plan.terminalReceipt === undefined ||
      (isObject(plan.terminalReceipt) &&
        plan.terminalReceipt.schemaVersion === "kletia_workflow_terminal_receipt_v1" &&
        isCommitment(plan.terminalReceipt.receiptSha256) &&
        Number.isFinite(Date.parse(String(plan.terminalReceipt.generatedAt))) &&
        plan.terminalReceipt.checkpointCount === steps.length &&
        plan.terminalReceipt.executorPlanCoreSha256 ===
          (isObject(plan.authorizationBoundary)
            ? plan.authorizationBoundary.planCoreSha256
            : undefined) &&
        plan.terminalReceipt.externalExecutionTruthProvenByStellar === false &&
        currentIndex === steps.length - 1 &&
        steps.every((step) => isObject(step) &&
          (step.status === "confirmed" || step.status === "filled"))))
  );
}

export function isWorkflowAdvanceV2Response(
  value: unknown,
  expected: {
    requestId: string;
    workflowId: string;
    amountCommitment: `0x${string}`;
    recipientCommitment: `0x${string}`;
    arcAddress?: string;
    arbitrumSepoliaAddress?: string;
    stellarAddress?: string;
  },
): value is WorkflowAdvanceV2Response {
  if (!isObject(value) || !isObject(value.workflowPlan)) return false;
  const synthetic = {
    ...value,
    status: "success",
    executionKind: "workflow_plan_v2",
    network: "stellar",
    chainRef: "stellar:testnet",
    requestId: expected.requestId,
  };
  const receipt = isObject(value.executionReceipt)
    ? value.executionReceipt
    : null;
  const authorizationBoundary = isObject(value.workflowPlan.authorizationBoundary)
    ? value.workflowPlan.authorizationBoundary
    : null;
  return (
    isWorkflowV2Response(synthetic, {
      requestId: expected.requestId,
      amountCommitment: expected.amountCommitment,
      recipientCommitment: expected.recipientCommitment,
      arcAddress: expected.arcAddress,
      arbitrumSepoliaAddress: expected.arbitrumSepoliaAddress,
      stellarAddress: expected.stellarAddress,
    }) &&
    value.workflowPlan.workflowId === expected.workflowId &&
    typeof value.workflowToken === "string" &&
    typeof value.terminal === "boolean" &&
    (value.terminal === false
      ? receipt === null
      : receipt?.schemaVersion === "kletia_execution_receipt_v1" &&
        receipt.workflowId === expected.workflowId &&
        isCommitment(receipt.workflowBindingHash) &&
        receipt.planCoreSha256 === authorizationBoundary?.planCoreSha256 &&
        isCommitment(receipt.planCoreSha256) &&
        isCommitment(receipt.receiptSha256) &&
        receipt.privateValuesExcludedFromAiPlanning === true &&
        isObject(receipt.manifestAuthorization) &&
        receipt.manifestAuthorization.manifestSha256 ===
          receipt.workflowBindingHash &&
        validatesPrivacyBudget(receipt.privacyBudget) &&
        validatesDisclosureDiff(receipt.disclosureDiff, expected.workflowId) &&
        isObject(receipt.verificationModel) &&
        receipt.verificationModel.kind ===
          "evidence_bound_application_receipt_sha256" &&
        receipt.verificationModel.recomputeReceiptHash === true &&
        receipt.verificationModel.verifyUnderlyingChainEvidence === true &&
        receipt.verificationModel.kletiaSignaturePresent === false &&
        receipt.verificationModel.onchainAnchorPresent === false &&
        Array.isArray(receipt.checkpoints) &&
        isObject(value.workflowPlan.terminalReceipt) &&
        value.workflowPlan.terminalReceipt.receiptSha256 === receipt.receiptSha256 &&
        value.workflowPlan.terminalReceipt.executorPlanCoreSha256 === receipt.planCoreSha256 &&
        value.workflowPlan.terminalReceipt.externalExecutionTruthProvenByStellar === false &&
        receipt.receiptSha256 ===
          hexSha256(
            JSON.stringify(
              canonicalValue({
                schemaVersion: receipt.schemaVersion,
                workflowId: receipt.workflowId,
                workflowBindingHash: receipt.workflowBindingHash,
                planCoreSha256: receipt.planCoreSha256,
                status: receipt.status,
                generatedAt: receipt.generatedAt,
                crossChainAtomicity: receipt.crossChainAtomicity,
                privateValuesExcludedFromAiPlanning:
                  receipt.privateValuesExcludedFromAiPlanning,
                manifestAuthorization: receipt.manifestAuthorization,
                privacyBudget: receipt.privacyBudget,
                disclosureDiff: receipt.disclosureDiff,
                verificationModel: receipt.verificationModel,
                checkpoints: receipt.checkpoints,
              }),
            ),
          ))
  );
}

export function isWorkflowLifecycleErrorResponse(
  value: unknown,
  expected: {
    requestId: string;
    workflowId: string;
    amountCommitment: `0x${string}`;
    recipientCommitment: `0x${string}`;
    arcAddress?: string;
    arbitrumSepoliaAddress?: string;
    stellarAddress?: string;
  },
): value is WorkflowLifecycleErrorResponse {
  if (
    !isObject(value) ||
    value.success !== false ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.workflowToken !== "string" ||
    !isObject(value.workflowPlan) ||
    !isObject(value.lifecycle)
  ) {
    return false;
  }
  const lifecycle = value.lifecycle;
  const status = lifecycle.status;
  const synthetic = {
    success: true,
    status: "success",
    executionKind: "workflow_plan_v2",
    network: "stellar",
    chainRef: "stellar:testnet",
    requestId: expected.requestId,
    message: value.message,
    workflowPlan: value.workflowPlan,
    workflowToken: value.workflowToken,
  };
  const currentIndex = Number(value.workflowPlan.currentStepIndex);
  const currentStep = Number.isInteger(currentIndex)
    ? (value.workflowPlan.steps as unknown[] | undefined)?.[currentIndex]
    : null;
  return (
    lifecycle.schemaVersion === "kletia_workflow_lifecycle_v1" &&
    (status === "failed" ||
      status === "indeterminate" ||
      status === "recovery_required") &&
    typeof lifecycle.code === "string" &&
    typeof lifecycle.retryable === "boolean" &&
    lifecycle.silentRetryAllowed === false &&
    typeof lifecycle.reason === "string" &&
    typeof lifecycle.operatorAction === "string" &&
    isWorkflowV2Response(synthetic, {
      requestId: expected.requestId,
      amountCommitment: expected.amountCommitment,
      recipientCommitment: expected.recipientCommitment,
      arcAddress: expected.arcAddress,
      arbitrumSepoliaAddress: expected.arbitrumSepoliaAddress,
      stellarAddress: expected.stellarAddress,
    }) &&
    value.workflowPlan.workflowId === expected.workflowId &&
    isObject(currentStep) &&
    (currentStep.status === status ||
      ((currentStep.status === "confirmed" || currentStep.status === "filled") &&
        isObject(currentStep.result)))
  );
}
import { sha256 } from "@noble/hashes/sha256";
