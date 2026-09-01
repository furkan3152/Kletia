/**
 * PrivacyBudgetV1 and DisclosureDiffV1 are the enforceable privacy layer for
 * WorkflowPlanV2.
 *
 * A privacy label is not a guarantee.  The budget below is evaluated before a
 * route is ranked and again before every checkpoint.  A cheaper or higher-yield
 * route cannot override a denied disclosure.  The diff is derived from the
 * selected route; it does not claim that an observer forgot information after
 * learning it.
 */

import type {
  PrivacyDisclosure,
  WorkflowPlanV2,
  WorkflowPolicyAnchorMode,
  WorkflowV2Network,
  WorkflowV2RouteKind,
  WorkflowV2Step,
} from "./types.js";

export type PrivacyPhaseV1 =
  | "planning"
  | "quote"
  | "authorization"
  | "execution"
  | "settlement"
  | "recovery";

export type PrivacyFieldV1 =
  | PrivacyDisclosure["field"]
  | "asset"
  | "wallet_identity"
  | "strategy"
  | "risk_preferences"
  | "amount_commitment_opening"
  | "recipient_commitment_opening";

export type PrivacyObserverV1 =
  | "device"
  | "wallet_extension"
  | "kletia_ai"
  | "kletia_api"
  | "circle"
  | "stellar_archive"
  | `rpc:${WorkflowV2Network}`
  | `public_ledger:${WorkflowV2Network}`
  | "protocol:aave_v3";

export interface PrivacyRuleV1 {
  readonly phase: PrivacyPhaseV1;
  readonly field: PrivacyFieldV1;
  /** Closed allowlist. An observer absent from this list is denied. */
  readonly allowedObservers: readonly PrivacyObserverV1[];
  readonly reason: string;
}

export interface PrivacyBudgetV1 {
  readonly schemaVersion: "kletia_privacy_budget_v1";
  readonly preset:
    | "public_execution"
    | "private_planning_public_execution"
    | "deterministic_only_public_execution"
    | "confidential_ledger_required";
  readonly enforcement: "fail_closed";
  readonly rules: readonly PrivacyRuleV1[];
  readonly requiresOnchainConfidentiality: boolean;
  readonly allowsCommitmentOpeningForPublicExecution: boolean;
  readonly limitations: readonly string[];
}

export interface DisclosureFactV1 {
  readonly stepId: "planning" | string;
  readonly phase: PrivacyPhaseV1;
  readonly field: PrivacyFieldV1;
  readonly observer: PrivacyObserverV1;
  readonly reason: string;
  readonly irreversible: boolean;
}

export interface PrivacyBudgetViolationV1 {
  readonly stepId: "planning" | string;
  readonly phase: PrivacyPhaseV1;
  readonly field: PrivacyFieldV1;
  readonly observer: PrivacyObserverV1;
  readonly code:
    | "OBSERVER_NOT_ALLOWED"
    | "COMMITMENT_OPENING_NOT_ALLOWED"
    | "LEDGER_CONFIDENTIALITY_UNAVAILABLE";
  readonly message: string;
}

export interface DisclosureDiffEntryV1 {
  readonly stepId: "planning" | string;
  readonly phase: PrivacyPhaseV1;
  readonly newlyLearned: readonly DisclosureFactV1[];
  readonly alreadyKnown: readonly DisclosureFactV1[];
  readonly summary: string;
}

export interface DisclosureDiffV1 {
  readonly schemaVersion: "kletia_disclosure_diff_v1";
  readonly workflowId: string;
  readonly entries: readonly DisclosureDiffEntryV1[];
  readonly finalKnowledge: readonly DisclosureFactV1[];
  readonly violations: readonly PrivacyBudgetViolationV1[];
  readonly compatible: boolean;
  readonly limitations: readonly string[];
}

const ALL_PHASES: readonly PrivacyPhaseV1[] = [
  "planning",
  "quote",
  "authorization",
  "execution",
  "settlement",
  "recovery",
];

function routeObservers(
  selectedRoute?: WorkflowV2RouteKind,
  policyAnchorMode: WorkflowPolicyAnchorMode = "local_manifest",
): readonly PrivacyObserverV1[] {
  const observers: PrivacyObserverV1[] = [
    "device",
    "wallet_extension",
    "kletia_api",
    "circle",
    "rpc:arc_testnet",
    "rpc:arbitrum_sepolia",
    "public_ledger:arc_testnet",
    "public_ledger:arbitrum_sepolia",
    "protocol:aave_v3",
  ];
  if (
    !selectedRoute ||
    selectedRoute === "stellar_centered_public" ||
    policyAnchorMode === "stellar_public_registry"
  ) {
    observers.push(
      "rpc:stellar_testnet",
      "public_ledger:stellar_testnet",
      "stellar_archive",
    );
  }
  return observers;
}

const PRIVATE_PLANNING_RULES: readonly PrivacyRuleV1[] = [
  {
    phase: "planning",
    field: "amount",
    allowedObservers: ["device"],
    reason: "The exact amount is represented by a salted commitment during semantic planning.",
  },
  {
    phase: "planning",
    field: "recipient",
    allowedObservers: ["device", "kletia_api"],
    reason:
      "The semantic model receives an opaque recipient slot. The deterministic API receives the public execution wallet binding and reports that disclosure explicitly.",
  },
  {
    phase: "planning",
    field: "balance",
    allowedObservers: [
      "device",
      "kletia_api",
      "rpc:arbitrum_sepolia",
      "public_ledger:arbitrum_sepolia",
      "protocol:aave_v3",
    ],
    reason:
      "Aave position and borrow-capacity reads are excluded from the LLM but are public Arbitrum state queried by the deterministic API.",
  },
  {
    phase: "planning",
    field: "wallet_identity",
    allowedObservers: [
      "device",
      "kletia_api",
      "rpc:arbitrum_sepolia",
      "public_ledger:arbitrum_sepolia",
      "protocol:aave_v3",
    ],
    reason:
      "The wallet binding is needed for live public Aave reads and is kept outside the semantic model request.",
  },
  {
    phase: "planning",
    field: "route",
    allowedObservers: ["device", "kletia_ai", "kletia_api"],
    reason: "The model may classify the requested networks and action family.",
  },
  {
    phase: "planning",
    field: "strategy",
    allowedObservers: ["device", "kletia_ai", "kletia_api"],
    reason: "The semantic objective is intentionally disclosed without its private slots.",
  },
  {
    phase: "planning",
    field: "risk_preferences",
    allowedObservers: ["device", "kletia_ai", "kletia_api"],
    reason: "Risk constraints may be classified, while exact positions remain local.",
  },
  {
    phase: "planning",
    field: "policy_commitment",
    allowedObservers: ["device", "kletia_api"],
    reason:
      "The API receives only the browser-generated opaque commitment; its blinding material and preimage remain on the device.",
  },
  {
    phase: "planning",
    field: "privacy_budget_commitment",
    allowedObservers: ["device", "kletia_api"],
    reason:
      "The API receives only the independently domain-separated Privacy Budget commitment, never its raw blind.",
  },
  {
    phase: "planning",
    field: "workflow_linkage",
    allowedObservers: ["device", "kletia_api"],
    reason:
      "The deterministic compiler links the two opaque commitments to one sealed workflow before any public registry call is offered.",
  },
];

function publicExecutionRules(
  selectedRoute?: WorkflowV2RouteKind,
  policyAnchorMode: WorkflowPolicyAnchorMode = "local_manifest",
): readonly PrivacyRuleV1[] {
  const rules: PrivacyRuleV1[] = [];
  const allRouteObservers = routeObservers(selectedRoute, policyAnchorMode);
  const arbitrumPositionObservers: readonly PrivacyObserverV1[] = [
    "device",
    "wallet_extension",
    "kletia_api",
    "rpc:arbitrum_sepolia",
    "public_ledger:arbitrum_sepolia",
    "protocol:aave_v3",
  ];
  for (const phase of ALL_PHASES.filter((entry) => entry !== "planning")) {
    for (const field of [
      "amount",
      "recipient",
      "balance",
      "timing",
      "route",
      "asset",
      "wallet_identity",
      "amount_commitment_opening",
      "recipient_commitment_opening",
      "workflow_linkage",
      "policy_commitment",
      "privacy_budget_commitment",
      "receipt_hash",
    ] as const) {
      const allowedObservers =
        field === "amount_commitment_opening" ||
        field === "recipient_commitment_opening"
          ? (["device", "kletia_api"] as const)
          : field === "balance"
            ? arbitrumPositionObservers
            : allRouteObservers;
      rules.push({
        phase,
        field,
        allowedObservers,
        reason:
          field === "amount_commitment_opening" ||
          field === "recipient_commitment_opening"
            ? "A commitment opening is disclosed only to the deterministic Kletia verifier for the exact public checkpoint; it is never a Circle, protocol, model, or ledger input."
            : "This public-chain phase may reveal the field only to the route-scoped participants needed to prepare, sign, verify or settle the exact step.",
      });
    }
  }
  return rules;
}

export function createPrivacyBudgetV1(
  preset: PrivacyBudgetV1["preset"] = "deterministic_only_public_execution",
  scope: {
    readonly selectedRoute?: WorkflowV2RouteKind;
    readonly policyAnchorMode?: WorkflowPolicyAnchorMode;
  } = {},
): PrivacyBudgetV1 {
  if (preset === "deterministic_only_public_execution") {
    return {
      schemaVersion: "kletia_privacy_budget_v1",
      preset,
      enforcement: "fail_closed",
      rules: [
        ...PRIVATE_PLANNING_RULES.map((rule) => ({
          ...rule,
          allowedObservers: rule.allowedObservers.filter(
            (observer) => observer !== "kletia_ai",
          ),
        })),
        ...publicExecutionRules(scope.selectedRoute, scope.policyAnchorMode),
      ],
      requiresOnchainConfidentiality: false,
      allowsCommitmentOpeningForPublicExecution: true,
      limitations: [
        "The allowlisted device envelope is parsed from the deterministic registry; no semantic model request is made.",
        "Execution still reveals public-chain amounts, recipients and timing at the declared checkpoint.",
      ],
    };
  }
  if (preset === "confidential_ledger_required") {
    const nonLedgerObservers = routeObservers(
      scope.selectedRoute,
      scope.policyAnchorMode,
    ).filter(
      (observer) => !observer.startsWith("public_ledger:"),
    );
    return {
      schemaVersion: "kletia_privacy_budget_v1",
      preset,
      enforcement: "fail_closed",
      rules: [
        ...PRIVATE_PLANNING_RULES,
        ...publicExecutionRules(
          scope.selectedRoute,
          scope.policyAnchorMode,
        ).map((rule) =>
          rule.field === "amount" || rule.field === "balance"
            ? { ...rule, allowedObservers: nonLedgerObservers }
            : rule,
        ),
      ],
      requiresOnchainConfidentiality: true,
      allowsCommitmentOpeningForPublicExecution: false,
      limitations: [
        "This budget is intentionally incompatible with the current public CCTP and Aave corridor.",
        "A route may satisfy it only after a reviewed confidential verifier and execution surface are pinned and enabled.",
      ],
    };
  }
  if (preset === "public_execution") {
    return {
      schemaVersion: "kletia_privacy_budget_v1",
      preset,
      enforcement: "fail_closed",
      rules: [
        ...publicExecutionRules(scope.selectedRoute, scope.policyAnchorMode),
        ...PRIVATE_PLANNING_RULES.map((rule) => ({
          ...rule,
          allowedObservers: [
            ...routeObservers(scope.selectedRoute, scope.policyAnchorMode),
            "kletia_ai" as const,
          ],
        })),
      ],
      requiresOnchainConfidentiality: false,
      allowsCommitmentOpeningForPublicExecution: true,
      limitations: [
        "This preset permits the broad reviewed observer set; the current composer still minimizes AI input as a defence-in-depth default.",
        "Public ledgers, RPC providers and execution protocols can observe transaction metadata.",
      ],
    };
  }
  if (preset === "private_planning_public_execution") {
    return {
      schemaVersion: "kletia_privacy_budget_v1",
      preset,
      enforcement: "fail_closed",
      rules: [
        ...PRIVATE_PLANNING_RULES,
        ...publicExecutionRules(scope.selectedRoute, scope.policyAnchorMode),
      ],
      requiresOnchainConfidentiality: false,
      allowsCommitmentOpeningForPublicExecution: true,
      limitations: [
        "Private planning is data minimization, not ledger confidentiality or anonymity.",
        "Exact amount and recipient become public when the user authorizes a public-chain execution step.",
        "The disclosure diff records new visibility but cannot make already-public information private again.",
      ],
    };
  }
  throw Object.assign(new Error("The Privacy Budget preset is not registered."), {
    code: "PRIVACY_BUDGET_INVALID",
    statusCode: 400,
  });
}

function phaseForStep(step: WorkflowV2Step): PrivacyPhaseV1 {
  if (step.action === "cctp_attestation") return "settlement";
  if (step.action === "borrow_capacity") return "settlement";
  if (step.action === "stellar_receipt_finalize") return "settlement";
  if (
    step.action === "cctp_approve" ||
    step.action === "aave_approve" ||
    step.action === "stellar_policy_commit"
  ) {
    return "authorization";
  }
  return "execution";
}

function observersForDisclosure(
  step: WorkflowV2Step,
  disclosure: PrivacyDisclosure,
): readonly PrivacyObserverV1[] {
  const observers = new Set<PrivacyObserverV1>();
  for (const observer of disclosure.visibleTo) {
    if (observer === "rpc") observers.add(`rpc:${step.network}`);
    else if (observer === "public_ledger") {
      observers.add(`public_ledger:${step.network}`);
    } else observers.add(observer);
  }
  if (step.binding?.protocol === "aave_v3") observers.add("protocol:aave_v3");
  if (step.binding?.protocol === "kletia_policy_registry") {
    observers.add("stellar_archive");
  }
  return [...observers];
}

type PrivacyEvaluationPlanV1 = Pick<WorkflowPlanV2, "workflowId" | "steps"> & {
  readonly privacy: Pick<
    WorkflowPlanV2["privacy"],
    | "boundaryMap"
    | "onchainConfidentiality"
    | "publicAmountOpeningRequired"
    | "semanticPlanner"
  >;
  readonly policyAnchor?: Pick<WorkflowPlanV2["policyAnchor"], "mode">;
};

function factsForPlan(plan: PrivacyEvaluationPlanV1): readonly DisclosureFactV1[] {
  const facts: DisclosureFactV1[] = [];
  for (const disclosure of plan.privacy.boundaryMap.planning) {
    for (const observer of disclosure.visibleTo) {
      if (observer === "rpc" || observer === "public_ledger") continue;
      facts.push({
        stepId: "planning",
        phase: "planning",
        field: disclosure.field,
        observer,
        reason: disclosure.reason,
        irreversible: observer !== "device",
      });
    }
  }
  for (const field of ["strategy", "risk_preferences"] as const) {
    for (const observer of
      plan.privacy.semanticPlanner === "deterministic_registry"
        ? (["device", "kletia_api"] as const)
        : (["device", "kletia_ai", "kletia_api"] as const)) {
      facts.push({
        stepId: "planning",
        phase: "planning",
        field,
        observer,
        reason:
          plan.privacy.semanticPlanner === "deterministic_registry"
            ? "The allowlisted strategy is resolved without a semantic-model request."
            : "Locally redacted semantic context may disclose the strategy class, but not exact private values or identities.",
        irreversible: observer !== "device",
      });
    }
  }
  // The compiler reads the destination wallet's public Aave position before it
  // ranks a route. That is not LLM disclosure, but it is still API/RPC/protocol
  // disclosure and therefore must not disappear from the budget model merely
  // because the existing boundary map did not spell it out.
  for (const observer of [
    "kletia_api",
    "rpc:arbitrum_sepolia",
    "public_ledger:arbitrum_sepolia",
    "protocol:aave_v3",
  ] as const) {
    facts.push({
      stepId: "planning",
      phase: "planning",
      field: "wallet_identity",
      observer,
      reason: "The live Aave position read is bound to the destination wallet.",
      irreversible: true,
    });
    facts.push({
      stepId: "planning",
      phase: "planning",
      field: "balance",
      observer,
      reason: "The live Aave account and reserve read exposes public position state.",
      irreversible: true,
    });
  }
  for (const step of plan.steps) {
    const phase = phaseForStep(step);
    for (const disclosure of step.disclosure) {
      for (const observer of observersForDisclosure(step, disclosure)) {
        facts.push({
          stepId: step.id,
          phase,
          field: disclosure.field,
          observer,
          reason: disclosure.reason,
          irreversible: observer !== "device" && observer !== "wallet_extension",
        });
      }
    }
  }
  if (plan.privacy.publicAmountOpeningRequired) {
    const amountOpeningStep =
      plan.privacy.boundaryMap.commitmentOpeningSchedule.find(
        (entry) => entry.field === "amount",
      )?.openingStep ?? "step-1";
    const recipientOpeningStep =
      plan.privacy.boundaryMap.commitmentOpeningSchedule.find(
        (entry) => entry.field === "recipient",
      )?.openingStep ?? "step-1";
    facts.push(
      {
        stepId: amountOpeningStep,
        phase: "authorization",
        field: "amount_commitment_opening",
        observer: "kletia_api",
        reason:
          "The one-shot amount opening binds the local amount commitment to the first public transaction; it is not sent during semantic planning.",
        irreversible: true,
      },
      {
        stepId: recipientOpeningStep,
        phase: "authorization",
        field: "recipient_commitment_opening",
        observer: "kletia_api",
        reason:
          "The one-shot recipient opening binds the local recipient commitment to the already-public execution wallet; it is not sent during semantic planning.",
        irreversible: true,
      },
    );
  }
  return facts;
}

function ruleFor(
  budget: PrivacyBudgetV1,
  fact: DisclosureFactV1,
): PrivacyRuleV1 | undefined {
  return budget.rules.find(
    (rule) => rule.phase === fact.phase && rule.field === fact.field,
  );
}

export function buildDisclosureDiffV1(
  plan: PrivacyEvaluationPlanV1,
  budget: PrivacyBudgetV1,
): DisclosureDiffV1 {
  const facts = factsForPlan(plan);
  const violations: PrivacyBudgetViolationV1[] = [];
  if (budget.requiresOnchainConfidentiality && plan.privacy.onchainConfidentiality === "none") {
    violations.push({
      stepId: "planning",
      phase: "planning",
      field: "amount",
      observer: "public_ledger:stellar_testnet",
      code: "LEDGER_CONFIDENTIALITY_UNAVAILABLE",
      message:
        "The requested budget requires ledger confidentiality, but this plan explicitly settles on public ledgers.",
    });
  }
  for (const fact of facts) {
    const rule = ruleFor(budget, fact);
    const isCommitmentOpening =
      fact.field === "amount_commitment_opening" ||
      fact.field === "recipient_commitment_opening";
    if (
      (isCommitmentOpening &&
        !budget.allowsCommitmentOpeningForPublicExecution) ||
      !rule ||
      !rule.allowedObservers.includes(fact.observer)
    ) {
      violations.push({
        stepId: fact.stepId,
        phase: fact.phase,
        field: fact.field,
        observer: fact.observer,
        code:
          isCommitmentOpening
            ? "COMMITMENT_OPENING_NOT_ALLOWED"
            : "OBSERVER_NOT_ALLOWED",
        message: `${fact.observer} would learn ${fact.field} during ${fact.phase}, outside the signed Privacy Budget.`,
      });
    }
  }
  const knowledge = new Set<string>();
  const finalKnowledge: DisclosureFactV1[] = [];
  const orderedStepIds = ["planning", ...plan.steps.map((step) => step.id)];
  const entries = orderedStepIds.map((stepId): DisclosureDiffEntryV1 => {
    const atStep = facts.filter((fact) => fact.stepId === stepId);
    const newlyLearned: DisclosureFactV1[] = [];
    const alreadyKnown: DisclosureFactV1[] = [];
    for (const fact of atStep) {
      const key = `${fact.field}|${fact.observer}`;
      if (knowledge.has(key)) alreadyKnown.push(fact);
      else {
        knowledge.add(key);
        newlyLearned.push(fact);
        finalKnowledge.push(fact);
      }
    }
    const phase = atStep[0]?.phase ?? (stepId === "planning" ? "planning" : "execution");
    return {
      stepId,
      phase,
      newlyLearned,
      alreadyKnown,
      summary:
        newlyLearned.length === 0
          ? "This step does not introduce a new observer-field disclosure."
          : `${newlyLearned.length} new observer-field disclosure${newlyLearned.length === 1 ? "" : "s"} becomes visible at this step.`,
    };
  });

  return {
    schemaVersion: "kletia_disclosure_diff_v1",
    workflowId: plan.workflowId,
    entries,
    finalKnowledge,
    violations,
    compatible: violations.length === 0,
    limitations: [
      "The diff models declared software and ledger boundaries; it is not a proof that an undeclared third party learned nothing.",
      "Public amount, address and timing correlation is irreversible once a transaction is broadcast.",
      "A public Stellar checkpoint receives no unlinkability credit without a reviewed confidentiality or mixing primitive.",
    ],
  };
}

export function assertPrivacyBudgetCompatible(
  plan: PrivacyEvaluationPlanV1,
  budget: PrivacyBudgetV1,
): DisclosureDiffV1 {
  const diff = buildDisclosureDiffV1(plan, budget);
  if (!diff.compatible) {
    const first = diff.violations[0];
    throw Object.assign(
      new Error(first?.message ?? "The route violates the signed Privacy Budget."),
      {
        code: "PRIVACY_BUDGET_VIOLATION",
        statusCode: 409,
        privacyBudget: budget,
        disclosureDiff: diff,
      },
    );
  }
  return diff;
}
