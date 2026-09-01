import { createHash } from "node:crypto";

import {
  readArbitrumSepoliaBorrowCapacity,
  readArbitrumSepoliaPortfolio,
} from "../../networks/arbitrum-sepolia/service.js";
import { readStellarPortfolio } from "../../networks/stellar/service.js";
import type {
  AddressRef,
  WorkflowEvidenceV3,
  WorkflowPlanV3,
  WorkflowStepStatusV3,
  WorkflowStepV3,
} from "./types.js";

type StellarPortfolioResult = Awaited<ReturnType<typeof readStellarPortfolio>>;
type ArbitrumSepoliaPortfolioResult = Awaited<ReturnType<typeof readArbitrumSepoliaPortfolio>>;
type ArbitrumSepoliaBorrowCapacityResult = Awaited<ReturnType<typeof readArbitrumSepoliaBorrowCapacity>>;
type LiveReadResult =
  | StellarPortfolioResult
  | ArbitrumSepoliaPortfolioResult
  | ArbitrumSepoliaBorrowCapacityResult;

export interface WorkflowV3LiveReadDependencies {
  readonly readStellarPortfolio: typeof readStellarPortfolio;
  readonly readArbitrumSepoliaPortfolio: typeof readArbitrumSepoliaPortfolio;
  readonly readArbitrumSepoliaBorrowCapacity: typeof readArbitrumSepoliaBorrowCapacity;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: WorkflowV3LiveReadDependencies = {
  readStellarPortfolio,
  readArbitrumSepoliaPortfolio,
  readArbitrumSepoliaBorrowCapacity,
  now: () => new Date(),
};

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function snapshotHash(value: unknown): string {
  return createHash("sha256")
    .update("KLETIA_WORKFLOW_V3_LIVE_READ\u001f", "utf8")
    .update(canonical(value), "utf8")
    .digest("hex");
}

function walletForStep(plan: WorkflowPlanV3, step: WorkflowStepV3): AddressRef {
  const wallet = plan.walletBindings.find((candidate) =>
    step.chain.family === "evm"
      ? candidate.family === "evm" && candidate.chainId === step.chain.chainId
      : candidate.family === "stellar" && candidate.network === step.chain.network,
  );
  if (!wallet) {
    throw controlled(
      "WORKFLOW_V3_READ_WALLET_MISSING",
      `The ${step.chain.key} live read is not bound to a compatible wallet.`,
    );
  }
  return wallet;
}

function assertDisclosure(
  plan: WorkflowPlanV3,
  provider: string,
  operation: WorkflowStepV3["operation"],
): void {
  const requiredFields = operation === "borrow_capacity"
    ? ["wallet_identity", "balance", "strategy"] as const
    : ["wallet_identity", "balance"] as const;
  const blockedField = requiredFields.find((field) =>
    (plan.privacy.budget.fields[field] ?? plan.privacy.budget.defaultLevel) === "device_only",
  );
  if (blockedField) {
    throw controlled(
      "WORKFLOW_V3_READ_DISCLOSURE_BLOCKED",
      `${blockedField} is device_only; this server-side live read cannot reveal it to a provider.`,
    );
  }
  if (
    !plan.privacy.budget.approvedProviders.includes("kletia_api") ||
    !plan.privacy.budget.approvedProviders.includes(provider)
  ) {
    throw controlled(
      "WORKFLOW_V3_READ_PROVIDER_NOT_APPROVED",
      `The live read requires explicit wallet_identity disclosure to kletia_api and ${provider}.`,
    );
  }
}

function assertReadStep(step: WorkflowStepV3): void {
  if (step.signer !== "none" || step.amountBinding !== "none") {
    throw controlled(
      "WORKFLOW_V3_READ_BINDING_INVALID",
      "A live read cannot require a signer or a financial amount binding.",
    );
  }
  if (step.status !== "ready" && step.status !== "planned") {
    throw controlled(
      "WORKFLOW_V3_READ_STATE_INVALID",
      `The live read cannot advance from ${step.status}.`,
    );
  }
  if (step.operation !== "portfolio" && step.operation !== "borrow_capacity") {
    throw controlled(
      "WORKFLOW_V3_LIVE_READ_UNSUPPORTED",
      "Only explicitly reviewed portfolio and borrow-capacity reads use this executor.",
    );
  }
}

function evidenceFor(input: {
  readonly step: WorkflowStepV3;
  readonly result: LiveReadResult;
  readonly observedAt: string;
}): WorkflowEvidenceV3 {
  const result = input.result as unknown as Record<string, unknown>;
  const blockOrLedger =
    typeof result.observedAtBlock === "string"
      ? `block:${result.observedAtBlock}`
      : typeof result.lastModifiedLedger === "string"
        ? `ledger:${result.lastModifiedLedger}`
        : `snapshot:${snapshotHash(result)}`;
  const level =
    input.step.operation === "borrow_capacity"
      ? "protocol_verified" as const
      : "chain_native_verified" as const;
  return {
    stepId: input.step.id,
    kind: "protocol_read",
    reference: `${input.step.protocol}:${blockOrLedger}:${snapshotHash(result)}`,
    level,
    observedAt: input.observedAt,
    chain: input.step.chain,
    details: {
      schemaVersion: result.schemaVersion,
      mockData: false,
      snapshotCommitment: `0x${snapshotHash(result)}`,
      observedAtBlock:
        typeof result.observedAtBlock === "string" ? result.observedAtBlock : null,
      lastModifiedLedger:
        typeof result.lastModifiedLedger === "string" ? result.lastModifiedLedger : null,
      rawResultPersisted: false,
    },
  };
}

export async function executeWorkflowLiveReadV3(
  plan: WorkflowPlanV3,
  step: WorkflowStepV3,
  dependencies: WorkflowV3LiveReadDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ readonly result: LiveReadResult; readonly evidence: WorkflowEvidenceV3 }> {
  assertReadStep(step);
  const wallet = walletForStep(plan, step);
  let provider: string;
  let result: LiveReadResult;

  if (
    step.chain.key === "stellar_testnet" &&
    step.protocol === "stellar-classic" &&
    step.operation === "portfolio" &&
    step.target === "stellar-horizon-account-resource" &&
    step.method === "read_account" &&
    wallet.family === "stellar" &&
    wallet.network === "testnet"
  ) {
    provider = "stellar_horizon";
    assertDisclosure(plan, provider, step.operation);
    result = await dependencies.readStellarPortfolio(wallet.address);
  } else if (
    step.chain.key === "arbitrum_sepolia" &&
    step.protocol === "aave-v3-arbitrum-sepolia" &&
    step.operation === "portfolio" &&
    step.target?.toLowerCase() === "0x12373b5085e3b42d42c1d4abf3b3cf4df0e0fa01" &&
    step.method === "getUserReserveData" &&
    wallet.family === "evm" &&
    wallet.chainId === 421_614
  ) {
    provider = "arbitrum_sepolia_rpc";
    assertDisclosure(plan, provider, step.operation);
    result = await dependencies.readArbitrumSepoliaPortfolio(wallet.address);
  } else if (
    step.chain.key === "arbitrum_sepolia" &&
    step.protocol === "aave-v3-arbitrum-sepolia" &&
    step.operation === "borrow_capacity" &&
    step.target?.toLowerCase() === "0xbfc91d59fdaa134a4ed45f7b584caf96d7792eff" &&
    step.method === "getUserAccountData" &&
    wallet.family === "evm" &&
    wallet.chainId === 421_614
  ) {
    provider = "arbitrum_sepolia_rpc";
    assertDisclosure(plan, provider, step.operation);
    result = await dependencies.readArbitrumSepoliaBorrowCapacity(wallet.address);
  } else {
    throw controlled(
      "WORKFLOW_V3_LIVE_READ_BINDING_MISMATCH",
      "The current network, protocol, target and method do not match a reviewed live-read adapter.",
    );
  }

  const resultRecord = result as unknown as Record<string, unknown>;
  if (resultRecord.mockData !== false) {
    throw controlled(
      "WORKFLOW_V3_LIVE_READ_MOCK_REJECTED",
      "The live-read adapter did not return an explicit mockData=false boundary.",
      502,
    );
  }
  return {
    result,
    evidence: evidenceFor({
      step,
      result,
      observedAt: dependencies.now().toISOString(),
    }),
  };
}

function nextStatus(step: WorkflowStepV3, completed: ReadonlySet<string>): WorkflowStepStatusV3 {
  if (step.status === "confirmed" || step.status === "failed" || step.status === "refunded") {
    return step.status;
  }
  if (step.executionReadiness !== "ready") return "blocked";
  if (!step.dependsOn.every((dependency) => completed.has(dependency))) return "planned";
  return step.signer === "none" ? "ready" : "awaiting_signature";
}

export function applyWorkflowLiveReadV3(
  plan: WorkflowPlanV3,
  stepId: string,
): WorkflowPlanV3 {
  const selectedRoute = plan.routes.find((route) => route.id === plan.selectedRouteId);
  const currentStep = selectedRoute?.steps.find((step) => step.id === stepId);
  if (!selectedRoute || !currentStep || plan.currentStepId !== stepId) {
    throw controlled(
      "WORKFLOW_V3_STEP_IDENTITY_MISMATCH",
      "The live-read result did not match the selected current workflow step.",
    );
  }
  assertReadStep(currentStep);
  const completed = new Set(
    selectedRoute.steps
      .filter((step) => step.status === "confirmed" || step.id === stepId)
      .map((step) => step.id),
  );
  const routes = plan.routes.map((route) => {
    if (route.id !== selectedRoute.id) return route;
    return {
      ...route,
      steps: route.steps.map((step) =>
        step.id === stepId
          ? { ...step, status: "confirmed" as const }
          : { ...step, status: nextStatus(step, completed) },
      ),
    };
  });
  const updatedRoute = routes.find((route) => route.id === selectedRoute.id)!;
  const next = updatedRoute.steps.find(
    (step) => step.status === "ready" || step.status === "awaiting_signature",
  );
  return {
    ...plan,
    routes,
    currentStepId: next?.id ?? null,
  };
}
