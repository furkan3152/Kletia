import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { getAddress, type Address } from "viem";
import { decodeCanonicalBase64Url } from "../../shared/security/canonicalBase64Url.js";
import {
  assertStellarAccount,
  STELLAR_MVP_ENABLED,
  STELLAR_TESTNET,
} from "../../networks/stellar/config.js";
import { ARBITRUM_SEPOLIA } from "../../networks/arbitrum-sepolia/config.js";
import type { PreparedStellarPolicyRegistryCommit } from "../../networks/stellar/policyRegistryState.js";
import type { ParsedWorkflowGoalV2 } from "./parser.js";
import { buildRouteCandidatesFromGraph } from "./routeGraph.js";
import {
  assertPrivacyBudgetCompatible,
  createPrivacyBudgetV1,
  type PrivacyBudgetV1,
} from "./privacyPolicy.js";
import type {
  PrivacyDisclosure,
  WorkflowPlanV2,
  WorkflowPolicyAnchorMode,
  WorkflowPolicyAnchorV2,
  WorkflowRouteCandidateV2,
  WorkflowV2RouteKind,
  WorkflowV2Step,
  WorkflowWalletBinding,
} from "./types.js";

const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_TO_ARBITRUM_SCENARIO_ID =
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
const WORKFLOW_TTL_MS = 24 * 60 * 60 * 1_000;
const WORKFLOW_RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const COMMITMENT_PATTERN = /^0x[a-f0-9]{64}$/u;

function policyAnchorMode(value: unknown): WorkflowPolicyAnchorMode {
  const mode = String(value ?? "local_manifest").trim();
  if (mode === "local_manifest" || mode === "stellar_public_registry") {
    return mode;
  }
  throw controlled(
    "WORKFLOW_POLICY_ANCHOR_INVALID",
    "The requested policy anchor mode is not supported.",
  );
}

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function secret(): string {
  const value = process.env.WORKFLOW_SIGNING_SECRET?.trim();
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV !== "production") return "kletia-development-workflow-v2-secret-only";
  throw controlled("WORKFLOW_CONFIGURATION_REQUIRED", "Workflow signing is not configured.", 503);
}

function evmAddress(value: unknown, field: string): Address {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw controlled("WORKFLOW_WALLET_INVALID", `${field} must be a valid EVM address.`);
  }
}

function privateCommitment(value: unknown, field: string): `0x${string}` {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!COMMITMENT_PATTERN.test(normalized)) {
    throw controlled(
      "PRIVATE_FIELD_COMMITMENT_INVALID",
      `A 32-byte ${field} commitment is required.`,
    );
  }
  return normalized as `0x${string}`;
}

function privacyBudgetPreset(value: unknown): PrivacyBudgetV1["preset"] {
  const preset = String(value ?? "deterministic_only_public_execution").trim();
  if (
    preset === "public_execution" ||
    preset === "private_planning_public_execution" ||
    preset === "deterministic_only_public_execution" ||
    preset === "confidential_ledger_required"
  ) {
    return preset;
  }
  throw controlled(
    "PRIVACY_BUDGET_INVALID",
    "The requested Privacy Budget preset is not supported.",
  );
}

const PUBLIC_CCTP_DISCLOSURE: readonly PrivacyDisclosure[] = [
  {
    field: "amount",
    visibleTo: ["device", "kletia_api", "circle", "rpc", "public_ledger"],
    reason: "CCTP burns and mints public USDC amounts; checkpoint verification can derive them from public receipts.",
  },
  {
    field: "recipient",
    visibleTo: ["device", "kletia_api", "circle", "rpc", "public_ledger"],
    reason: "Destination recipients are encoded in the public CCTP message.",
  },
  {
    field: "timing",
    visibleTo: ["device", "kletia_api", "circle", "rpc", "public_ledger"],
    reason: "Burn, attestation and mint timing remains observable.",
  },
] as const;

const PUBLIC_POLICY_REGISTRY_DISCLOSURE: readonly PrivacyDisclosure[] = [
  {
    field: "wallet_identity",
    visibleTo: ["device", "wallet_extension", "kletia_api", "rpc", "public_ledger"],
    reason: "The registry owner is a public Stellar account and remains durably linkable to the owner nonce.",
  },
  {
    field: "workflow_linkage",
    visibleTo: ["device", "wallet_extension", "kletia_api", "rpc", "public_ledger"],
    reason: "The public owner, nonce, commitments and event timing link this registry record to one Kletia workflow.",
  },
  {
    field: "policy_commitment",
    visibleTo: ["device", "wallet_extension", "kletia_api", "rpc", "public_ledger"],
    reason: "Only the browser-generated opaque commitment is public; the registry does not validate or learn its blinded preimage.",
  },
  {
    field: "privacy_budget_commitment",
    visibleTo: ["device", "wallet_extension", "kletia_api", "rpc", "public_ledger"],
    reason: "The independently domain-separated Privacy Budget commitment is public durable linkage; its raw blind is not sent to the API.",
  },
  {
    field: "timing",
    visibleTo: ["device", "wallet_extension", "kletia_api", "rpc", "public_ledger"],
    reason: "Commit, expiry, receipt-close and finalization ledgers are public and can be correlated with the workflow.",
  },
] as const;


function pushStep(
  steps: WorkflowV2Step[],
  input: Omit<WorkflowV2Step, "id" | "order" | "dependsOn" | "status">,
) {
  const order = steps.length + 1;
  const id = `step-${order}`;
  steps.push({
    ...input,
    id,
    order,
    dependsOn: order === 1 ? [] : [`step-${order - 1}`],
    status: order === 1 ? "awaiting_signature" : "planned",
  });
}

function buildSteps(
  route: WorkflowV2RouteKind,
  commitment: `0x${string}`,
  expiresAt: number,
  includeBorrowCapacity: boolean,
  policyAnchor: WorkflowPolicyAnchorV2,
): readonly WorkflowV2Step[] {
  const steps: WorkflowV2Step[] = [];
  const privateAmount = { source: "private_commitment" as const, commitment };
  const previous = { source: "previous_output" as const };
  const none = { source: "none" as const };
  if (policyAnchor.mode === "stellar_public_registry") {
    pushStep(steps, {
      action: "stellar_policy_commit",
      network: "stellar_testnet",
      walletBinding: "stellar_wallet",
      amount: none,
      target: policyAnchor.contractId,
      binding: {
        protocol: "kletia_policy_registry",
        method: "commit",
        policyRegistryCall: {
          schemaVersion: "kletia_policy_registry_call_v1",
          operation: "commit",
          owner: policyAnchor.owner,
          nonce: policyAnchor.nonce,
          policyCommitment: policyAnchor.policyCommitment,
          privacyBudgetCommitment: policyAnchor.privacyBudgetCommitment,
          executionExpiresAtLedger: policyAnchor.executionExpiresAtLedger,
          receiptCloseByLedger: policyAnchor.receiptCloseByLedger,
          retentionFloorLedger: policyAnchor.retentionFloorLedger,
          expectedWasmSha256: policyAnchor.expectedWasmSha256,
          stateObservedAtLedger: policyAnchor.stateObservedAtLedger,
          recordingSimulationLatestLedger:
            policyAnchor.recordingSimulationLatestLedger,
          invocationSha256: policyAnchor.commitInvocationSha256,
          enforcingSimulationRequiredBeforeSigning: true,
        },
      },
      evidenceRequired: [
        "exact_owner_authorized_invocation",
        "policy_committed_event",
        "stored_record_match",
        "next_nonce_consumed",
        "effective_status_active",
      ],
      disclosure: PUBLIC_POLICY_REGISTRY_DISCLOSURE,
    });
  }
  pushStep(steps, {
    action: "cctp_approve",
    network: "arc_testnet",
    walletBinding: "arc_wallet",
    amount: privateAmount,
    target: ARC_USDC,
    deadline: expiresAt,
    binding: {
      protocol: "cctp_v2",
      method: "approve",
      sourceDomain: 26,
      destinationDomain: route === "direct_cctp" ? 3 : 27,
      recipientBinding:
        route === "direct_cctp"
          ? "arbitrum_sepolia_wallet"
          : "stellar_forwarder",
    },
    evidenceRequired: ["receipt_status", "approval_owner", "approval_spender", "approval_amount"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  pushStep(steps, {
    action: "cctp_burn",
    network: "arc_testnet",
    walletBinding: "arc_wallet",
    amount: privateAmount,
    target: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    binding: {
      protocol: "cctp_v2",
      method:
        route === "direct_cctp"
          ? "depositForBurn"
          : "depositForBurnWithHook",
      sourceDomain: 26,
      destinationDomain: route === "direct_cctp" ? 3 : 27,
      recipientBinding:
        route === "direct_cctp"
          ? "arbitrum_sepolia_wallet"
          : "stellar_forwarder",
      destinationCaller:
        route === "direct_cctp" ? "open" : "stellar_forwarder",
      finalityThreshold: 2_000,
    },
    deadline: expiresAt,
    evidenceRequired: ["receipt_status", "message_sent", "deposit_for_burn", "nonce", "destination_domain"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  pushStep(steps, {
    action: "cctp_attestation",
    network: "arc_testnet",
    walletBinding: "circle_attestation",
    amount: previous,
    binding: {
      protocol: "cctp_v2",
      method: "getAttestation",
      sourceDomain: 26,
      destinationDomain: route === "direct_cctp" ? 3 : 27,
    },
    evidenceRequired: ["circle_attestation", "message_hash", "source_domain_26"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  if (route !== "direct_cctp") {
    pushStep(steps, {
      action: "cctp_mint",
      network: "stellar_testnet",
      walletBinding: "stellar_wallet",
      amount: previous,
      target: STELLAR_TESTNET.cctp.forwarder,
      binding: {
        protocol: "cctp_v2",
        method: "mint_and_forward",
        sourceDomain: 26,
        destinationDomain: 27,
        recipientBinding: "stellar_wallet",
      },
      deadline: expiresAt,
      evidenceRequired: ["stellar_transaction", "destination_domain_27", "sealed_contract_event_presence"],
      disclosure: PUBLIC_CCTP_DISCLOSURE,
    });
  }
  if (route !== "direct_cctp") {
    pushStep(steps, {
      action: "cctp_approve",
      network: "stellar_testnet",
      walletBinding: "stellar_wallet",
      amount: previous,
      target: STELLAR_TESTNET.usdc.sac,
      deadline: expiresAt,
      binding: {
        protocol: "cctp_v2",
        method: "approve",
        sourceDomain: 27,
        destinationDomain: 3,
      },
      evidenceRequired: ["stellar_transaction", "approval_owner", "approval_spender", "approval_amount"],
      disclosure: PUBLIC_CCTP_DISCLOSURE,
    });
    pushStep(steps, {
      action: "cctp_burn",
      network: "stellar_testnet",
      walletBinding: "stellar_wallet",
      amount: previous,
      target: STELLAR_TESTNET.cctp.tokenMessengerMinter,
      binding: {
        protocol: "cctp_v2",
        method: "deposit_for_burn",
        sourceDomain: 27,
        destinationDomain: 3,
        recipientBinding: "arbitrum_sepolia_wallet",
        destinationCaller: "open",
        finalityThreshold: 2_000,
      },
      deadline: expiresAt,
      evidenceRequired: ["stellar_transaction", "message_sent", "destination_domain_3"],
      disclosure: PUBLIC_CCTP_DISCLOSURE,
    });
    pushStep(steps, {
      action: "cctp_attestation",
      network: "stellar_testnet",
      walletBinding: "circle_attestation",
      amount: previous,
      binding: {
        protocol: "cctp_v2",
        method: "getAttestation",
        sourceDomain: 27,
        destinationDomain: 3,
      },
      evidenceRequired: ["circle_attestation", "message_hash", "source_domain_27"],
      disclosure: PUBLIC_CCTP_DISCLOSURE,
    });
  }
  pushStep(steps, {
    action: "cctp_mint",
    network: "arbitrum_sepolia",
    walletBinding: "arbitrum_sepolia_wallet",
    amount: previous,
    target: ARBITRUM_SEPOLIA.cctp.messageTransmitterV2,
    binding: {
      protocol: "cctp_v2",
      method: "receiveMessage",
      destinationDomain: 3,
      recipientBinding: "arbitrum_sepolia_wallet",
    },
    deadline: expiresAt,
    evidenceRequired: ["receipt_status", "usdc_mint_transfer", "destination_domain_3"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  pushStep(steps, {
    action: "aave_approve",
    network: "arbitrum_sepolia",
    walletBinding: "arbitrum_sepolia_wallet",
    amount: previous,
    target: ARBITRUM_SEPOLIA.usdc,
    binding: { protocol: "aave_v3", method: "approve" },
    deadline: expiresAt,
    evidenceRequired: ["receipt_status", "approval_owner", "approval_spender", "approval_amount"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  pushStep(steps, {
    action: "aave_supply",
    network: "arbitrum_sepolia",
    walletBinding: "arbitrum_sepolia_wallet",
    amount: previous,
    target: ARBITRUM_SEPOLIA.aave.pool,
    binding: { protocol: "aave_v3", method: "supply" },
    deadline: expiresAt,
    evidenceRequired: ["receipt_status", "aave_supply_event"],
    disclosure: PUBLIC_CCTP_DISCLOSURE,
  });
  if (includeBorrowCapacity) {
    pushStep(steps, {
      action: "borrow_capacity",
      network: "arbitrum_sepolia",
      walletBinding: "arbitrum_sepolia_wallet",
      amount: none,
      target: ARBITRUM_SEPOLIA.aave.pool,
      binding: { protocol: "aave_v3", method: "getUserAccountData" },
      evidenceRequired: ["live_aave_account_data", "reserve_liquidity", "borrowing_enabled", "target_health_factor_gte_1_5"],
      disclosure: [
        {
          field: "balance",
          visibleTo: ["device", "kletia_api", "rpc", "public_ledger"],
          reason: "Aave positions and theoretical risk-buffered borrow capacity are derived from public Arbitrum state.",
        },
      ],
    });
  }
  return steps;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function workflowPlanCore(plan: Omit<WorkflowPlanV2, "authorizationBoundary"> | WorkflowPlanV2) {
  const selectedEvidence = plan.routeCandidates.find(
    (candidate) => candidate.kind === plan.selectedRoute,
  )?.liveEvidence;
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
    selectedRouteLiveEvidence: selectedEvidence,
    steps: plan.steps.map((step) => ({
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
    })),
    privacy: plan.privacy,
    policies: plan.policies,
  });
}

export function computeWorkflowPlanCoreSha256(
  plan: Omit<WorkflowPlanV2, "authorizationBoundary"> | WorkflowPlanV2,
): `0x${string}` {
  return `0x${createHash("sha256")
    .update(JSON.stringify(workflowPlanCore(plan)))
    .digest("hex")}`;
}

function manifestMessage(input: {
  plan: Omit<WorkflowPlanV2, "authorizationBoundary"> | WorkflowPlanV2;
  planCoreSha256: `0x${string}`;
}): string {
  return JSON.stringify(canonicalValue({
    domain: "KLETIA_PRIVATE_INTENT_V1",
    schemaVersion: "kletia_workflow_authorization_manifest_v2",
    environmentLane: input.plan.environmentLane,
    workflowId: input.plan.workflowId,
    requestId: input.plan.requestId,
    selectedRoute: input.plan.selectedRoute,
    expiresAt: input.plan.expiresAt,
    planCoreSha256: input.planCoreSha256,
    amountCommitment: input.plan.privacy.amountCommitment,
    recipientCommitment: input.plan.privacy.recipientCommitment,
    rawPrivateFieldsIncluded: false,
  }));
}

export function rebindWorkflowPlanAuthorization(
  plan: Omit<WorkflowPlanV2, "authorizationBoundary"> | WorkflowPlanV2,
): WorkflowPlanV2 {
  const planCoreSha256 = computeWorkflowPlanCoreSha256(plan);
  const previous = "authorizationBoundary" in plan
    ? plan.authorizationBoundary
    : undefined;
  const unchanged = previous?.planCoreSha256 === planCoreSha256;
  const requiredStepSigners = [...new Set(
    plan.steps
      .map((step) => step.walletBinding)
      .filter((binding): binding is WorkflowWalletBinding["id"] =>
        binding !== "circle_attestation"),
  )];
  return {
    ...plan,
    ...(unchanged && plan.manifestAuthorization
      ? { manifestAuthorization: plan.manifestAuthorization }
      : { manifestAuthorization: undefined }),
    authorizationBoundary: {
      schemaVersion: "kletia_workflow_authorization_boundary_v2",
      planCoreSha256,
      manifestMessage: manifestMessage({ plan, planCoreSha256 }),
      requiredStepSigners,
      invalidatedBy: [
        "wallet_change",
        "asset_change",
        "route_change",
        "target_or_method_change",
        "deadline_change",
        "fee_quote_change",
        "privacy_policy_change",
      ],
    },
  } as WorkflowPlanV2;
}

export function renewWorkflowPlanAuthorization(
  plan: WorkflowPlanV2,
  routeCandidates: WorkflowPlanV2["routeCandidates"] = plan.routeCandidates,
): WorkflowPlanV2 {
  const authorizationRefreshedAt = Date.now();
  const expiresAt = Math.min(
    authorizationRefreshedAt + WORKFLOW_TTL_MS,
    plan.parentWorkflowV3?.expiresAt ?? Number.POSITIVE_INFINITY,
    plan.parentWorkflowV4?.expiresAt ?? Number.POSITIVE_INFINITY,
  );
  if (expiresAt <= authorizationRefreshedAt) {
    throw controlled(
      "WORKFLOW_V3_PARENT_EXPIRED",
      "The parent canonical policy window expired and cannot be refreshed.",
      409,
    );
  }
  const steps = plan.steps.map((step, index) =>
    index >= plan.currentStepIndex && step.deadline !== undefined
      ? { ...step, deadline: expiresAt }
      : step,
  );
  return rebindWorkflowPlanAuthorization({
    ...plan,
    manifestAuthorization: undefined,
    authorizationRefreshedAt,
    expiresAt,
    routeCandidates,
    steps,
  });
}

export function compileWorkflowPlanV2(input: {
  requestId: string;
  goal: ParsedWorkflowGoalV2;
  amountCommitment: unknown;
  recipientCommitment: unknown;
  routePreference?: unknown;
  privacyBudgetPreset?: unknown;
  policyAnchorMode?: unknown;
  policyRegistryCommit?: PreparedStellarPolicyRegistryCommit;
  arcAddress: unknown;
  stellarAddress?: unknown;
  arbitrumSepoliaAddress: unknown;
  routeMetrics: {
    direct: WorkflowRouteCandidateV2["liveEvidence"];
    stellar?: WorkflowRouteCandidateV2["liveEvidence"];
    stellarUnavailableReason?: string;
  };
}): WorkflowPlanV2 {
  // The step builder below only knows the Arc → Arbitrum corridor. Every other
  // registered scenario is either `shadow_only` or `integration_incomplete`, so it must
  // be refused here rather than compiled into steps that do not exist. This is
  // the boundary that keeps the grammar honest: registering a scenario expands
  // what can be *expressed*, never what can be silently signed.
  if (input.goal.scenario.id !== ARC_TO_ARBITRUM_SCENARIO_ID) {
    throw controlled(
      "WORKFLOW_SCENARIO_NOT_COMPILABLE",
      `${input.goal.scenario.label} is registered in the intent grammar but has no signable runtime path yet.`,
      409,
    );
  }
  const commitment = privateCommitment(input.amountCommitment, "private amount");
  const recipientCommitment = privateCommitment(
    input.recipientCommitment,
    "private recipient",
  );
  const requestedPrivacyPreset = privacyBudgetPreset(
    input.privacyBudgetPreset,
  );
  const requestedPolicyAnchorMode = policyAnchorMode(input.policyAnchorMode);
  if (
    (requestedPolicyAnchorMode === "stellar_public_registry") !==
    Boolean(input.policyRegistryCommit)
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_BINDING_MISSING",
      "The public registry mode requires one live state-bound commit preparation; local manifests must not carry a registry call.",
      503,
    );
  }
  const requestedPrivacyBudget = createPrivacyBudgetV1(
    requestedPrivacyPreset,
    { policyAnchorMode: requestedPolicyAnchorMode },
  );
  // No reviewed confidential verifier is available in the current runtime.
  // Refuse a ledger-confidential budget before economic ranking rather than
  // silently selecting a public route and showing it as "private".
  if (requestedPrivacyBudget.requiresOnchainConfidentiality) {
    throw controlled(
      "PRIVACY_BUDGET_UNSATISFIABLE",
      "Ledger confidentiality was requested, but every currently executable cross-chain candidate settles on public ledgers. Choose private planning with public execution or wait for the reviewed confidential runtime.",
      409,
    );
  }
  const requestedRaw = String(input.routePreference ?? "auto");
  if (![
    "auto",
    "direct_cctp",
    "stellar_centered_public",
  ].includes(requestedRaw)) {
    throw controlled("WORKFLOW_ROUTE_INVALID", "The requested route policy is invalid.");
  }
  const requested = requestedRaw as "auto" | WorkflowV2RouteKind;
  if (
    requestedPolicyAnchorMode === "stellar_public_registry" &&
    requested !== "stellar_centered_public"
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_ROUTE_REQUIRED",
      "The optional Stellar public registry is available only on an explicitly selected Stellar-centered route. Direct CCTP plans remain anchor-free.",
      409,
    );
  }
  const envelopeAllowsStellarCorridor =
    input.goal.toggles.stellarPolicyCenter === true;
  if (
    input.goal.stellarPolicyCenter !== envelopeAllowsStellarCorridor ||
    envelopeAllowsStellarCorridor !== (requested !== "direct_cctp")
  ) {
    throw controlled(
      "WORKFLOW_ROUTE_POLICY_MISMATCH",
      "The device-sealed Stellar corridor permission does not match the requested route policy. Direct CCTP must forbid the Stellar corridor; auto and explicit Stellar routing must permit it.",
      409,
    );
  }
  if (requested === "stellar_centered_public" && !input.routeMetrics.stellar) {
    throw controlled(
      "WORKFLOW_ROUTE_UNAVAILABLE",
      input.routeMetrics.stellarUnavailableReason ||
        "The Stellar-centered public route has no fresh, reviewed live evidence.",
      503,
    );
  }
  // RouteGraphV1 derives the candidate set from declared edges. An explicit
  // direct route is intentionally scoped to direct evidence so unavailable
  // Stellar fee endpoints cannot take an unrelated Arc → Arbitrum plan offline.
  const routeCandidates = buildRouteCandidatesFromGraph(
    input.routeMetrics,
    requested === "direct_cctp" || !input.routeMetrics.stellar
      ? "direct_only"
      : "all",
    requestedPrivacyPreset === "deterministic_only_public_execution"
      ? "deterministic_registry"
      : "openrouter_constrained",
  );
  const eligible = routeCandidates.filter((route) => route.available);
  const selectedRoute = requested === "auto"
    ? [...eligible].sort((left, right) => left.score.total - right.score.total)[0]?.kind
    : requested;
  if (!selectedRoute) {
    throw controlled(
      "WORKFLOW_ROUTE_UNAVAILABLE",
      "No reviewed route satisfies the requested privacy policy.",
      503,
    );
  }
  const selected = routeCandidates.find((route) => route.kind === selectedRoute);
  if (!selected?.available) {
    throw controlled(
      "WORKFLOW_ROUTE_UNAVAILABLE",
      selected?.unavailableReason || "The selected workflow route is unavailable.",
      503,
    );
  }
  // The user chooses the privacy preset before route ranking. Once one route
  // wins, the immutable budget is narrowed to that route's actual networks and
  // participants. This prevents a direct Arc → Arbitrum plan from silently
  // carrying unused permission for Stellar observers, and prevents any
  // execution phase from disclosing data to the semantic model.
  const privacyBudget = createPrivacyBudgetV1(requestedPrivacyPreset, {
    selectedRoute,
    policyAnchorMode: requestedPolicyAnchorMode,
  });
  // The direct Arc → Arbitrum corridor does not touch Stellar. Keep the
  // Stellar capability flag route-scoped so an intentionally disabled or
  // unavailable Stellar beta cannot take an otherwise healthy direct route
  // offline.
  if (
    (selectedRoute !== "direct_cctp" ||
      requestedPolicyAnchorMode === "stellar_public_registry") &&
    !STELLAR_MVP_ENABLED
  ) {
    throw controlled(
      "STELLAR_MVP_DISABLED",
      "Stellar Public Testnet Beta is disabled on this deployment.",
      503,
    );
  }
  const arcAddress = evmAddress(input.arcAddress, "Arc wallet");
  const arbitrumAddress = evmAddress(
    input.arbitrumSepoliaAddress,
    "Arbitrum Sepolia wallet",
  );
  const walletBindings: WorkflowWalletBinding[] = [
    { id: "arc_wallet", family: "evm", network: "arc_testnet", address: arcAddress },
    {
      id: "arbitrum_sepolia_wallet",
      family: "evm",
      network: "arbitrum_sepolia",
      address: arbitrumAddress,
    },
  ];
  if (
    selectedRoute !== "direct_cctp" ||
    requestedPolicyAnchorMode === "stellar_public_registry"
  ) {
    walletBindings.push({
      id: "stellar_wallet",
      family: "stellar",
      network: "stellar_testnet",
      address: assertStellarAccount(input.stellarAddress),
    });
  }
  const createdAt = Date.now();
  const expiresAt = createdAt + WORKFLOW_TTL_MS;
  const recoveryExpiresAt = createdAt + WORKFLOW_RECOVERY_TTL_MS;
  const policyAnchor: WorkflowPolicyAnchorV2 = input.policyRegistryCommit
    ? {
        schemaVersion: "kletia_workflow_policy_anchor_v1",
        mode: "stellar_public_registry",
        onchainAnchor: true,
        network: "stellar_testnet",
        contractId: input.policyRegistryCommit.contractId,
        owner: input.policyRegistryCommit.owner,
        nonce: input.policyRegistryCommit.nonce,
        policyCommitment: input.policyRegistryCommit.policyCommitment,
        privacyBudgetCommitment:
          input.policyRegistryCommit.privacyBudgetCommitment,
        commitmentSchemes: {
          policy: "KLETIA_POLICY_COMMITMENT_V1",
          policyEnvelope: "KLETIA_POLICY_ENVELOPE_V1",
          privacyBudget: "KLETIA_PRIVACY_BUDGET_COMMITMENT_V1",
          browserGeneratedBlindedPreimages: true,
          rawBlindReceivedByApi: false,
          mutableQuotesAndCheckpointStatusExcluded: true,
        },
        executionExpiresAtLedger:
          input.policyRegistryCommit.executionExpiresAtLedger,
        receiptCloseByLedger:
          input.policyRegistryCommit.receiptCloseByLedger,
        retentionFloorLedger:
          input.policyRegistryCommit.retentionFloorLedger,
        stateObservedAtLedger: input.policyRegistryCommit.stateObservedAtLedger,
        recordingSimulationLatestLedger:
          input.policyRegistryCommit.recordingSimulationLatestLedger,
        commitInvocationSha256:
          input.policyRegistryCommit.invocationSha256,
        expectedWasmSha256: input.policyRegistryCommit.expectedWasmSha256,
        finalization: {
          status: "pending_execution_receipt",
          ownerAcknowledgementRequired: true,
        },
        limitations: [
          "The public registry stores opaque owner-authorized commitments and durable workflow linkage; it does not provide confidentiality.",
          "A finalized receipt hash is an owner acknowledgement, not independent proof of Stellar, EVM, CCTP, Aave, solver or AI truth.",
          "Recording simulation is a preparation check; the wallet must enforce the exact authorization tree before signing.",
        ],
      }
    : {
        schemaVersion: "kletia_workflow_policy_anchor_v1",
        mode: "local_manifest",
        onchainAnchor: false,
        limitations: [
          "The signed manifest is kept in the sealed application workflow and is not written to an onchain registry.",
        ],
      };
  const steps = buildSteps(
    selectedRoute,
    commitment,
    expiresAt,
    input.goal.includeBorrowCapacity,
    policyAnchor,
  );
  const openingStep = steps.find(
    (step) =>
      step.action === "cctp_approve" && step.network === "arc_testnet",
  )?.id;
  if (!openingStep) {
    throw controlled(
      "WORKFLOW_OPENING_STEP_MISSING",
      "The public amount opening checkpoint is missing from the compiled route.",
      503,
    );
  }
  const planningDisclosure: readonly PrivacyDisclosure[] = [
    {
      field: "amount",
      visibleTo: ["device"],
      reason: "The exact amount remains in the browser during semantic planning; only a salted commitment crosses the API boundary.",
    },
    {
      field: "recipient",
      visibleTo: ["device", "kletia_api"],
      reason: "The final Arbitrum wallet is a public execution binding received by the deterministic API compiler, but it is excluded from the LLM semantic request.",
    },
    {
      field: "route",
      visibleTo:
        privacyBudget.preset === "deterministic_only_public_execution"
          ? ["device", "kletia_api"]
          : ["device", "kletia_ai", "kletia_api"],
      reason:
        privacyBudget.preset === "deterministic_only_public_execution"
          ? "The selected network and protocol semantics are resolved from the allowlisted registry without a model request."
          : "The selected network and protocol semantics are deliberately disclosed as an allowlisted envelope so the constrained semantic model can confirm them.",
    },
    ...(policyAnchor.mode === "stellar_public_registry"
      ? [
          {
            field: "wallet_identity" as const,
            visibleTo: ["device", "kletia_api"] as const,
            reason:
              "The deterministic compiler receives the public Stellar owner needed to read its exact registry nonce; the semantic model does not receive it.",
          },
          {
            field: "policy_commitment" as const,
            visibleTo: ["device", "kletia_api"] as const,
            reason:
              "Only the browser-generated domain-separated commitment reaches the API; the policy preimage and raw blind remain local.",
          },
          {
            field: "privacy_budget_commitment" as const,
            visibleTo: ["device", "kletia_api"] as const,
            reason:
              "Only the independently blinded Privacy Budget commitment reaches the deterministic compiler.",
          },
          {
            field: "workflow_linkage" as const,
            visibleTo: ["device", "kletia_api"] as const,
            reason:
              "The API binds the public owner, exact nonce and opaque commitments into this workflow core.",
          },
        ]
      : []),
  ];
  const planBase = {
    version: 2,
    schemaVersion: "kletia_workflow_plan_v2",
    workflowId: randomUUID(),
    requestId: input.requestId,
    environmentLane: "testnet",
    createdAt,
    expiresAt,
    recoveryExpiresAt,
    objective: "risk_adjusted_net_return_with_disclosure",
    semanticGoal: input.goal.semanticGoal,
    policyAnchor,
    walletBindings,
    assets: [
      { family: "evm", network: "arc_testnet", symbol: "USDC", address: ARC_USDC, decimals: 6 },
      ...(selectedRoute === "direct_cctp"
        ? []
        : [{
            family: "stellar" as const,
            network: "stellar_testnet" as const,
            symbol: "USDC" as const,
            code: "USDC" as const,
            issuer: STELLAR_TESTNET.usdc.issuer,
            sac: STELLAR_TESTNET.usdc.sac,
            decimals: 7 as const,
          }]),
      {
        family: "evm",
        network: "arbitrum_sepolia",
        symbol: "USDC",
        address: ARBITRUM_SEPOLIA.usdc,
        decimals: 6,
      },
    ],
    routeCandidates,
    selectedRoute,
    routeSelection: {
      mode: requested === "auto" ? "auto" as const : "explicit" as const,
      selectedScore: selected.score.total,
      rationale: requested === "auto"
        ? `Selected the lowest available amount-independent policy score (${selected.score.total}); browser-side gas and amount-dependent net return still require pre-signature hydration.`
        : `User explicitly selected ${selected.label}; its amount-independent policy score is ${selected.score.total}, while browser-side gas and net return still require pre-signature hydration.`,
      amountDependentCostsExcluded: true as const,
    },
    currentStepIndex: 0,
    steps,
    privacy: {
      scope: "browser_private_fields_public_ledger" as const,
      semanticPlanner:
        privacyBudget.preset === "deterministic_only_public_execution"
          ? "deterministic_registry" as const
          : "openrouter_constrained" as const,
      privateFieldIsolationRequested: true as const,
      onchainConfidentiality: "none" as const,
      privateAmountExcludedFromSemanticRequest: true as const,
      recipientExcludedFromSemanticRequest: true as const,
      rawPrivateAmountReceivedDuringPlanning: false as const,
      recipientReceivedAsPublicWalletBinding: true as const,
      publicAmountOpeningRequired: true as const,
      amountCommitment: commitment,
      recipientCommitment,
      boundaryMap: {
        schemaVersion: "kletia_privacy_boundary_map_v1" as const,
        planning: planningDisclosure,
        checkpoints: steps.map((step) => ({
          stepId: step.id,
          network: step.network,
          action: step.action,
          disclosure: step.disclosure,
        })),
        commitmentOpeningSchedule: [
          {
            field: "amount" as const,
            openingStep,
            reason: "The API opens the amount commitment against the first public approval receipt; the LLM never receives the opening.",
          },
          {
            field: "recipient" as const,
            openingStep,
            reason: "The salt opens the commitment against the already-public final wallet binding; this is an integrity check, not recipient privacy.",
          },
        ] as const,
      },
      limitations: [
        "Private-field isolation keeps exact planning values out of the LLM request; it is not onchain anonymity or confidential settlement.",
        "CCTP deposit and withdrawal amounts, wallet addresses and timing are public.",
        "The cross-chain execution tranche exits to the bound Arbitrum wallet; a distinct confidential recipient is not part of this route.",
        "Cross-chain execution is checkpointed and is not globally atomic.",
      ],
    },
    policies: {
      requiresPerStepWalletApproval: true,
      crossChainAtomicity: "staged_checkpointed_no_global_rollback",
      minimumHealthFactor: "1.5",
      mockDataAllowed: false,
      environmentMixingAllowed: false,
      silentRetryAllowed: false,
    },
  } satisfies Omit<WorkflowPlanV2, "authorizationBoundary" | "privacy"> & {
    readonly privacy: Omit<
      WorkflowPlanV2["privacy"],
      "privacyBudget" | "disclosureDiff"
    >;
  };
  const disclosureDiff = assertPrivacyBudgetCompatible(planBase, privacyBudget);
  const plan = {
    ...planBase,
    privacy: {
      ...planBase.privacy,
      privacyBudget,
      disclosureDiff,
    },
  } satisfies Omit<WorkflowPlanV2, "authorizationBoundary">;
  return rebindWorkflowPlanAuthorization(plan);
}

export function sealWorkflowPlanV2(plan: WorkflowPlanV2): string {
  // Privacy Budget rules and Disclosure Diff entries are deterministic
  // projections of the sealed route and preset. Keeping duplicate projections
  // inside every handoff token would push a multi-step plan beyond common HTTP
  // body limits. The token therefore carries the authenticated preset and plan
  // inputs; `openWorkflowPlanV2` re-derives both projections and then verifies
  // the original plan-core hash before accepting the token.
  const compactPlan = {
    ...plan,
    privacy: {
      ...plan.privacy,
      privacyBudget: {
        schemaVersion: plan.privacy.privacyBudget.schemaVersion,
        preset: plan.privacy.privacyBudget.preset,
      },
      disclosureDiff: undefined,
    },
  };
  const payload = Buffer.from(JSON.stringify(compactPlan), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret()).update(`v2.${payload}`).digest("base64url");
  return `v2.${payload}.${signature}`;
}

export function buildPrivateIntentManifestV1(plan: WorkflowPlanV2): string {
  const expectedHash = computeWorkflowPlanCoreSha256(plan);
  if (
    plan.authorizationBoundary?.planCoreSha256 !== expectedHash ||
    plan.authorizationBoundary.manifestMessage !==
      manifestMessage({ plan, planCoreSha256: expectedHash })
  ) {
    throw controlled(
      "WORKFLOW_AUTHORIZATION_BOUNDARY_INVALID",
      "The workflow authorization boundary does not match the immutable plan core.",
      409,
    );
  }
  return plan.authorizationBoundary.manifestMessage;
}

export function openWorkflowPlanV2(token: unknown): WorkflowPlanV2 {
  if (typeof token !== "string" || token.length < 100 || token.length > 64_000) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 token is invalid.");
  }
  const [version, payload, supplied, extra] = token.split(".");
  if (version !== "v2" || !payload || !supplied || extra) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 token is invalid.");
  }
  const expected = createHmac("sha256", secret()).update(`v2.${payload}`).digest();
  let actual: Buffer;
  try {
    actual = decodeCanonicalBase64Url(supplied);
  } catch {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 token signature is invalid.", 409);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 token signature is invalid.");
  }
  let decoded: Record<string, unknown>;
  try {
    const value = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    decoded = value as Record<string, unknown>;
  } catch {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 payload is invalid.");
  }
  const decodedPrivacy = decoded.privacy;
  if (!decodedPrivacy || typeof decodedPrivacy !== "object" || Array.isArray(decodedPrivacy)) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 privacy payload is invalid.");
  }
  const compactBudget = (decodedPrivacy as Record<string, unknown>).privacyBudget;
  if (!compactBudget || typeof compactBudget !== "object" || Array.isArray(compactBudget)) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 Privacy Budget is invalid.");
  }
  const decodedRoute = decoded.selectedRoute;
  if (
    decodedRoute !== "direct_cctp" &&
    decodedRoute !== "stellar_centered_public"
  ) {
    throw controlled(
      "WORKFLOW_V2_TOKEN_INVALID",
      "Workflow V2 route binding is invalid.",
    );
  }
  const decodedPolicyAnchor = decoded.policyAnchor;
  if (
    !decodedPolicyAnchor ||
    typeof decodedPolicyAnchor !== "object" ||
    Array.isArray(decodedPolicyAnchor)
  ) {
    throw controlled(
      "WORKFLOW_V2_TOKEN_INVALID",
      "Workflow V2 policy anchor is invalid.",
    );
  }
  const decodedPolicyAnchorMode = policyAnchorMode(
    (decodedPolicyAnchor as Record<string, unknown>).mode,
  );
  const budget = createPrivacyBudgetV1(
    privacyBudgetPreset((compactBudget as Record<string, unknown>).preset),
    {
      selectedRoute: decodedRoute,
      policyAnchorMode: decodedPolicyAnchorMode,
    },
  );
  const hydrationBase = {
    ...decoded,
    privacy: {
      ...(decodedPrivacy as Record<string, unknown>),
      privacyBudget: budget,
    },
  } as unknown as WorkflowPlanV2;
  const disclosureDiff = assertPrivacyBudgetCompatible(hydrationBase, budget);
  const plan = {
    ...hydrationBase,
    privacy: {
      ...hydrationBase.privacy,
      privacyBudget: budget,
      disclosureDiff,
    },
  } satisfies WorkflowPlanV2;
  if (
    plan.version !== 2 ||
    plan.schemaVersion !== "kletia_workflow_plan_v2" ||
    plan.environmentLane !== "testnet" ||
    plan.policies?.environmentMixingAllowed !== false ||
    plan.policies?.silentRetryAllowed !== false ||
    plan.policyAnchor?.schemaVersion !==
      "kletia_workflow_policy_anchor_v1" ||
    plan.policyAnchor.mode !== decodedPolicyAnchorMode ||
    plan.authorizationBoundary?.schemaVersion !== "kletia_workflow_authorization_boundary_v2" ||
    plan.authorizationBoundary.planCoreSha256 !== computeWorkflowPlanCoreSha256(plan) ||
    plan.authorizationBoundary.manifestMessage !== buildPrivateIntentManifestV1(plan) ||
    plan.recoveryExpiresAt <= Date.now() ||
    plan.recoveryExpiresAt - plan.createdAt > WORKFLOW_RECOVERY_TTL_MS ||
    plan.expiresAt - (plan.authorizationRefreshedAt ?? plan.createdAt) > WORKFLOW_TTL_MS ||
    (plan.parentWorkflowV3 !== undefined &&
      (
        plan.parentWorkflowV3.schemaVersion !== "kletia_workflow_v3_execution_parent_v1" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          plan.parentWorkflowV3.workflowId,
        ) ||
        !/^0x[a-f\d]{64}$/iu.test(plan.parentWorkflowV3.workflowRoot) ||
        !/^0x[a-f\d]{64}$/iu.test(plan.parentWorkflowV3.planHashAtHandoff) ||
        !/^[a-f\d]{64}$/iu.test(plan.parentWorkflowV3.controlPlaneTransactionHash) ||
        !/^[a-f\d]{64}$/iu.test(plan.parentWorkflowV3.receiptRegistryTransactionHash) ||
        plan.parentWorkflowV3.externalExecutionTruthProvenByStellar !== false ||
        plan.parentWorkflowV3.expiresAt !== plan.expiresAt
      )) ||
    (plan.parentWorkflowV4 !== undefined &&
      (
        plan.parentWorkflowV4.schemaVersion !== "kletia_workflow_v4_execution_parent_v1" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          plan.parentWorkflowV4.workflowId,
        ) ||
        !/^0x[a-f\d]{64}$/iu.test(plan.parentWorkflowV4.workflowRoot) ||
        !/^0x[a-f\d]{64}$/iu.test(plan.parentWorkflowV4.planHashAtHandoff) ||
        !StrKey.isValidContract(plan.parentWorkflowV4.controlPlaneContractId) ||
        !/^[a-f\d]{64}$/iu.test(plan.parentWorkflowV4.controlPlaneTransactionHash) ||
        !/^\d+$/u.test(plan.parentWorkflowV4.controlPlaneNonce) ||
        !/^0x[a-f\d]{64}$/iu.test(plan.parentWorkflowV4.policyProofPublicInputsHash) ||
        plan.parentWorkflowV4.externalExecutionTruthProvenByStellar !== false ||
        plan.parentWorkflowV4.expiresAt !== plan.expiresAt
      )) ||
    (plan.parentWorkflowV3 !== undefined && plan.parentWorkflowV4 !== undefined) ||
    !Array.isArray(plan.steps) ||
    (plan.terminalReceipt !== undefined &&
      (
        plan.terminalReceipt.schemaVersion !== "kletia_workflow_terminal_receipt_v1" ||
        !/^0x[a-f\d]{64}$/iu.test(plan.terminalReceipt.receiptSha256) ||
        !Number.isFinite(Date.parse(plan.terminalReceipt.generatedAt)) ||
        plan.terminalReceipt.checkpointCount !== plan.steps.length ||
        plan.terminalReceipt.executorPlanCoreSha256 !==
          plan.authorizationBoundary.planCoreSha256 ||
        plan.terminalReceipt.externalExecutionTruthProvenByStellar !== false ||
        plan.currentStepIndex !== plan.steps.length - 1 ||
        plan.steps.some((step) =>
          step.status !== "confirmed" && step.status !== "filled"
        )
      )) ||
    plan.steps.length < 6 ||
    plan.steps.length > 20 ||
    !plan.steps.every(
      (step, index) =>
        step.id === `step-${index + 1}` &&
        step.order === index + 1 &&
        (index === 0
          ? step.dependsOn.length === 0
          : step.dependsOn.length === 1 && step.dependsOn[0] === `step-${index}`),
    )
  ) {
    throw controlled("WORKFLOW_V2_TOKEN_INVALID", "Workflow V2 boundaries are invalid.");
  }
  return plan;
}
