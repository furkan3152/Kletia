import { createHash } from "node:crypto";
import { erc20Abi, formatUnits, getAddress, parseUnits } from "viem";

import { ARBITRUM_SEPOLIA } from "../../networks/arbitrum-sepolia/config.js";
import { readArbitrumSepoliaBorrowCapacity } from "../../networks/arbitrum-sepolia/service.js";
import { ARC_OFFICIAL_ADDRESSES } from "../../networks/arc/officialExtensions.js";
import { arcPublicClient } from "../../shared/config/networks.js";
import { readWorkflowRouteMetrics } from "../v2/quotes.js";
import { bindLiveRouteHydrationV3 } from "./compiler.js";
import { assertSolverAuctionNotOpenedV3 } from "./solverMarket.js";
import { CHAINS_V3 } from "./chains.js";
import type {
  RouteCandidateV3,
  WorkflowEvidenceV3,
  WorkflowPlanV3,
} from "./types.js";

const SALT_PATTERN = /^0x[a-f\d]{64}$/iu;
const MAX_PUBLIC_EXECUTION_USDC_ATOMIC = 1_000_000n * 10n ** 6n;

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

function sha256(domain: string, value: unknown): `0x${string}` {
  return `0x${createHash("sha256")
    .update(domain, "utf8")
    .update("\u001f", "utf8")
    .update(canonical(value), "utf8")
    .digest("hex")}`;
}

function normalizedUsdcAmount(value: unknown): {
  readonly display: string;
  readonly atomic: bigint;
} {
  const raw = String(value ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) {
    throw controlled("WORKFLOW_V3_AMOUNT_OPENING_INVALID", "Enter a positive USDC execution amount.");
  }
  let atomic: bigint;
  try {
    atomic = parseUnits(raw, 6);
  } catch {
    throw controlled(
      "WORKFLOW_V3_AMOUNT_OPENING_INVALID",
      "USDC execution amounts support at most six decimal places.",
    );
  }
  if (atomic <= 0n || atomic > MAX_PUBLIC_EXECUTION_USDC_ATOMIC) {
    throw controlled(
      "WORKFLOW_V3_AMOUNT_OPENING_OUT_OF_RANGE",
      "The public Testnet execution amount must be positive and no greater than 1,000,000 USDC.",
    );
  }
  return { display: formatUnits(atomic, 6), atomic };
}

function assertAmountOpening(input: {
  readonly plan: WorkflowPlanV3;
  readonly amount: string;
  readonly salt: unknown;
}): `0x${string}` {
  const binding = input.plan.intent.privateBindings.find((entry) => entry.field === "amount");
  const salt = String(input.salt ?? "").toLowerCase();
  if (!binding || !SALT_PATTERN.test(salt)) {
    throw controlled(
      "WORKFLOW_V3_AMOUNT_OPENING_INVALID",
      "The protected amount opening is missing or malformed.",
    );
  }
  const digest = createHash("sha256")
    .update([
      "KLETIA_PRIVATE_FIELD_V1",
      "stellar:testnet",
      "amount",
      input.amount,
      salt,
    ].join("\u001f"))
    .digest("hex");
  const commitment = `0x${digest}` as const;
  if (commitment !== binding.commitment.toLowerCase()) {
    throw controlled(
      "WORKFLOW_V3_AMOUNT_COMMITMENT_MISMATCH",
      "The public execution amount did not open the sealed private-field commitment.",
    );
  }
  return commitment;
}

function evmWallet(plan: WorkflowPlanV3, chainId: 5_042_002 | 421_614) {
  const wallet = plan.walletBindings.find(
    (entry) => entry.family === "evm" && entry.chainId === chainId,
  );
  if (!wallet || wallet.family !== "evm") {
    throw controlled(
      "WORKFLOW_V3_EXECUTION_WALLET_MISSING",
      `The exact eip155:${chainId} execution wallet is not sealed in the workflow.`,
    );
  }
  return getAddress(wallet.address);
}

function bufferedMaximumFee(amountAtomic: bigint, feeBps: number): bigint {
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw controlled("WORKFLOW_V3_CCTP_FEE_INVALID", "Circle returned an invalid CCTP fee quote.", 502);
  }
  const hundredthBps = BigInt(Math.round(feeBps * 100));
  const protocolFee = (amountAtomic * hundredthBps + 999_999n) / 1_000_000n;
  return (protocolFee * 120n + 99n) / 100n;
}

export interface WorkflowRouteHydrationDependenciesV3 {
  readonly readRouteMetrics: typeof readWorkflowRouteMetrics;
  readonly readBorrowCapacity: typeof readArbitrumSepoliaBorrowCapacity;
  readonly readArcBalance: (owner: `0x${string}`) => Promise<bigint>;
  readonly readArcAllowance: (owner: `0x${string}`) => Promise<bigint>;
  readonly readArcBlock: () => Promise<bigint>;
  readonly assertAuctionNotOpened: typeof assertSolverAuctionNotOpenedV3;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: WorkflowRouteHydrationDependenciesV3 = {
  readRouteMetrics: readWorkflowRouteMetrics,
  readBorrowCapacity: readArbitrumSepoliaBorrowCapacity,
  readArcBalance: (owner) => arcPublicClient.readContract({
    address: ARC_OFFICIAL_ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  }),
  readArcAllowance: (owner) => arcPublicClient.readContract({
    address: ARC_OFFICIAL_ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, ARC_OFFICIAL_ADDRESSES.CCTP_TOKEN_MESSENGER_V2],
  }),
  readArcBlock: () => arcPublicClient.getBlockNumber(),
  assertAuctionNotOpened: assertSolverAuctionNotOpenedV3,
  now: () => new Date(),
};

export async function hydrateWorkflowRouteV3(
  plan: WorkflowPlanV3,
  input: {
    readonly routeId?: unknown;
    readonly amount?: unknown;
    readonly amountSalt?: unknown;
    readonly acknowledgePublicExecution?: unknown;
  },
  dependencies: WorkflowRouteHydrationDependenciesV3 = DEFAULT_DEPENDENCIES,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
  readonly quote: {
    readonly routeId: string;
    readonly amountAtomic: string;
    readonly maximumBridgeFeeAtomic: string;
    readonly conservativeDestinationAmountAtomic: string;
    readonly sourceAllowanceAtomic: string;
    readonly sourceApprovalRequired: boolean;
    readonly standardFeeBps: number;
    readonly supplyApyBps: number;
    readonly quoteExpiresAt: number;
  };
}> {
  if (plan.lane !== "testnet" || plan.expiresAt <= Date.now()) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATION_UNAVAILABLE",
      "Only an unexpired Testnet workflow can receive a live execution quote.",
    );
  }
  if (input.acknowledgePublicExecution !== true) {
    throw controlled(
      "WORKFLOW_V3_PUBLIC_AMOUNT_DISCLOSURE_REQUIRED",
      "Hydration reveals the execution amount to Kletia API, Arc RPC, Circle and public ledgers. Explicit approval is required.",
    );
  }
  const amountBudgetLevel = plan.privacy.budget.fields.amount ?? plan.privacy.budget.defaultLevel;
  const amountBinding = plan.intent.privateBindings.find((entry) => entry.field === "amount");
  if (
    amountBudgetLevel !== "public_execution" ||
    amountBinding?.disclosureLevel !== "public_execution"
  ) {
    throw controlled(
      "WORKFLOW_V3_PRIVACY_BUDGET_CONFLICT",
      "This sealed workflow does not permit the amount to be disclosed for public execution. Compile a new workflow with an explicit public-execution ceiling.",
    );
  }
  const routeId = String(input.routeId ?? "");
  if (routeId !== "arc-arbitrum-direct-cctp") {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATOR_UNAVAILABLE",
      "The first exact V3 executor is limited to the direct Arc Testnet to Arbitrum Sepolia CCTP route. The Stellar two-hop route remains fail-closed.",
    );
  }
  const route = plan.routes.find((candidate) => candidate.id === routeId);
  if (!route || !route.protocols.includes("circle-cctp-v2")) {
    throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The requested direct CCTP route is not sealed in this workflow.");
  }
  if (plan.coordinationMarket.required) {
    await dependencies.assertAuctionNotOpened(plan);
  }
  const amount = normalizedUsdcAmount(input.amount);
  const amountCommitment = assertAmountOpening({
    plan,
    amount: amount.display,
    salt: input.amountSalt,
  });
  const sourceWallet = evmWallet(plan, 5_042_002);
  const destinationWallet = evmWallet(plan, 421_614);
  const [borrowCapacity, balance, allowance, blockNumber] = await Promise.all([
    dependencies.readBorrowCapacity(destinationWallet),
    dependencies.readArcBalance(sourceWallet),
    dependencies.readArcAllowance(sourceWallet),
    dependencies.readArcBlock(),
  ]);
  const routeMetrics = await dependencies.readRouteMetrics(
    borrowCapacity.supplyApyBps,
    "direct_only",
  );
  const feeBps = routeMetrics.direct.cctpLegs[0]?.standardFeeBps;
  if (feeBps === undefined || routeMetrics.direct.quoteExpiresAt <= Date.now()) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_QUOTE_STALE",
      "The exact Circle fee leg is missing or expired.",
    );
  }
  const maximumFee = bufferedMaximumFee(amount.atomic, feeBps);
  if (maximumFee >= amount.atomic) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_FEE_EXCEEDS_AMOUNT",
      "The buffered CCTP fee consumes the protected amount.",
    );
  }
  const conservativeOutput = amount.atomic - maximumFee;
  const observedAt = dependencies.now().toISOString();
  const quoteMaterial = {
    workflowId: plan.workflowId,
    routeId,
    amountCommitment,
    sourceChain: CHAINS_V3.arc_testnet.caip2,
    destinationChain: CHAINS_V3.arbitrum_sepolia.caip2,
    sourceWallet,
    destinationWallet,
    sourceAsset: ARC_OFFICIAL_ADDRESSES.USDC,
    destinationAsset: ARBITRUM_SEPOLIA.usdc,
    tokenMessenger: ARC_OFFICIAL_ADDRESSES.CCTP_TOKEN_MESSENGER_V2,
    messageTransmitter: ARBITRUM_SEPOLIA.cctp.messageTransmitterV2,
    sourceDomain: 26,
    destinationDomain: 3,
    finalityThreshold: 2_000,
    standardFeeBps: feeBps,
    maximumFeeAtomic: maximumFee.toString(),
    conservativeOutputAtomic: conservativeOutput.toString(),
    supplyApyBps: borrowCapacity.supplyApyBps,
    observedAtBlock: blockNumber.toString(),
    quoteExpiresAt: routeMetrics.direct.quoteExpiresAt,
  };
  const quoteCommitment = sha256("KLETIA_WORKFLOW_V3_ROUTE_QUOTE_V1", quoteMaterial);
  const hydration: NonNullable<RouteCandidateV3["hydration"]> = {
    schemaVersion: "kletia_route_hydration_v1",
    status: "live_quote_bound",
    amountCommitment,
    quoteCommitment,
    observedAt,
    observedAtBlock: blockNumber.toString(),
    quoteExpiresAt: routeMetrics.direct.quoteExpiresAt,
    sourceBalanceSufficient: balance >= amount.atomic,
    publicAmountDisclosureApproved: true,
    standardFeeBps: feeBps,
    sources: ["arc_rpc", "circle_iris_sandbox", "aave_v3_arbitrum_sepolia"],
  };
  const metrics: RouteCandidateV3["metrics"] = {
    ...route.metrics,
    estimatedOutputAtomic: conservativeOutput.toString(),
    gasCostUsd: null,
    bridgeFeeUsd: formatUnits(maximumFee, 6),
    slippageBps: 0,
    estimatedApyBps: borrowCapacity.supplyApyBps,
    amountDependentCostsComplete: true,
  };
  const nextPlan = bindLiveRouteHydrationV3({ plan, routeId, hydration, metrics });
  return {
    plan: nextPlan,
    evidence: {
      stepId: `route-hydration:${routeId}:${quoteCommitment.slice(2, 18)}`,
      kind: "route_quote",
      reference: quoteCommitment,
      level: "protocol_verified",
      observedAt,
      chain: CHAINS_V3.arc_testnet,
      details: {
        routeId,
        amountCommitment,
        quoteCommitment,
        publicAmountDisclosureApproved: true,
        maximumBridgeFeeAtomic: maximumFee.toString(),
        conservativeDestinationAmountAtomic: conservativeOutput.toString(),
        sourceBalanceSufficient: balance >= amount.atomic,
        sourceAllowanceSufficient: allowance >= amount.atomic,
        observedAtBlock: blockNumber.toString(),
        quoteExpiresAt: routeMetrics.direct.quoteExpiresAt,
        plaintextAmountFieldPersisted: false,
        economicScaleDerivableFromPublicQuote: true,
        mockData: false,
      },
    },
    quote: {
      routeId,
      amountAtomic: amount.atomic.toString(),
      maximumBridgeFeeAtomic: maximumFee.toString(),
      conservativeDestinationAmountAtomic: conservativeOutput.toString(),
      sourceAllowanceAtomic: allowance.toString(),
      sourceApprovalRequired: allowance < amount.atomic,
      standardFeeBps: feeBps,
      supplyApyBps: borrowCapacity.supplyApyBps,
      quoteExpiresAt: routeMetrics.direct.quoteExpiresAt,
    },
  };
}
