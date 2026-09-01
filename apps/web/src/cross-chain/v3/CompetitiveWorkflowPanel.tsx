import React from "react";
import { getNetworkDetails, signTransaction } from "@stellar/freighter-api";
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, LockKeyhole, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { getAddress } from "viem";

import { BACKEND_URL } from "../../shared/config/runtime";
import { fetchWithRouteHydrationDisclosure } from "../../shared/privacy/egressGuard";
import {
  generateDevicePolicyProofV3,
  readStellarTestnetLatestLedger,
  type DevicePolicyProofEnvelopeV3,
} from "./policyProof";
import {
  prepareIntentControlPlaneCommit,
  prepareIntentControlPlaneFinalize,
  prepareReceiptRegistryCommit,
  prepareReceiptRegistryFinalize,
  type BoundControlPlanePlanV3,
  type ControlPlaneLifecycleV1,
} from "../../networks/stellar/runtime/controlPlane";
import {
  StellarTransactionIndeterminateError,
  submitSignedStellarTransaction,
} from "../../networks/stellar/runtime/cctp";
import {
  beginPrivateIntentObservation,
  commitPrivateField,
  createPrivateSalt,
  forgetPrivateFieldGuards,
  privateSaltToHex,
} from "../../networks/stellar/runtime/privateIntent";
import {
  BoundWorkflowV2Executor,
  type BoundWorkflowV2Handoff,
} from "./BoundWorkflowV2Executor";
import { isWorkflowV2Response } from "../v2/types";
import { prepareRouteAuctionOpen } from "../../networks/stellar/runtime/solverMarket";

type WorkflowStepView = {
  readonly id: string;
  readonly operation: string;
  readonly chain: { readonly key: string; readonly caip2: string };
  readonly protocol: string;
  readonly status: string;
  readonly executionReadiness: "ready" | "capability_disabled" | "deployment_required";
  readonly unavailableReason?: string;
  readonly target?: string;
  readonly method?: string;
};

type RouteView = {
  readonly id: string;
  readonly solverRouteHash: `0x${string}`;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly quoteExpiresAt: number;
  readonly hydration?: {
    readonly status: "live_quote_bound";
    readonly amountCommitment: string;
    readonly quoteCommitment: string;
    readonly quoteExpiresAt: number;
    readonly sourceBalanceSufficient: boolean;
    readonly publicAmountDisclosureApproved: true;
  };
  readonly protocols: readonly string[];
  readonly metrics: {
    readonly estimatedOutputAtomic: string | null;
    readonly estimatedDurationSeconds: { readonly min: number; readonly max: number };
    readonly failureRisk: number;
    readonly protocolRisk: number;
    readonly disclosureCost: number;
    readonly amountDependentCostsComplete: boolean;
  };
  readonly steps: readonly WorkflowStepView[];
};

type WorkflowPlanView = {
  readonly version: 3;
  readonly schemaVersion: "kletia_workflow_plan_v3";
  readonly workflowId: string;
  readonly requestId: string;
  readonly lane: "production" | "testnet";
  readonly expiresAt: number;
  readonly walletBindings: readonly ({
    readonly family: "stellar";
    readonly network: "testnet" | "public";
    readonly address: string;
  } | {
    readonly family: "evm";
    readonly chainId: number;
    readonly address: string;
  })[];
  readonly intent: {
    readonly unresolved: readonly {
      readonly field: string;
      readonly question: string;
      readonly options: readonly { readonly label: string; readonly effect: string }[];
    }[];
  };
  readonly controlPlane: {
    readonly status: "ready" | "deployment_required" | "not_required";
    readonly workflowRoot: `0x${string}`;
    readonly required: boolean;
    readonly mode: "local_manifest" | "stellar_intent_control_plane";
    readonly network: "stellar_testnet" | "stellar_mainnet" | null;
    readonly planningPolicyCommitment: `0x${string}`;
    readonly privacyBudgetCommitment: `0x${string}`;
    readonly policyRoot: `0x${string}` | null;
    readonly nullifier: `0x${string}` | null;
    readonly externalExecutionTruthProven: false;
    readonly proofBinding: {
      readonly status: "not_required" | "device_proof_required" | "bound";
      readonly routeId: string | null;
      readonly verifierVersion: number | null;
      readonly protocolRegistryRoot: `0x${string}` | null;
      readonly assetRegistryRoot: `0x${string}` | null;
      readonly recipientPolicyRoot: `0x${string}` | null;
      readonly executionExpiresAtLedger: number | null;
      readonly executionContextCommitment: `0x${string}` | null;
      readonly publicInputsHash: `0x${string}` | null;
      readonly proofSha256: `0x${string}` | null;
      readonly verifiedAtLedger: string | null;
    };
    readonly commitment: {
      readonly status: "not_required" | "device_proof_required" | "awaiting_signature" | "confirmed" | "finalized";
      readonly owner: string | null;
      readonly nonce: string | null;
      readonly transactionHash: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptCloseByLedger: number | null;
      readonly retentionFloorLedger: number | null;
      readonly receiptRoot?: `0x${string}` | null;
      readonly finalizedTransactionHash?: string | null;
      readonly finalizedAtLedger?: string | null;
    };
    readonly receiptRegistry: {
      readonly status: "not_required" | "control_plane_required" | "awaiting_signature" | "confirmed" | "finalized";
      readonly owner: string | null;
      readonly nonce: string | null;
      readonly transactionHash: string | null;
      readonly committedAtLedger: string | null;
      readonly receiptRoot?: `0x${string}` | null;
      readonly finalizedTransactionHash?: string | null;
      readonly finalizedAtLedger?: string | null;
    };
  };
  readonly coordinationMarket: {
    readonly required: boolean;
    readonly status: string;
    readonly reasons: readonly string[];
    readonly winner: {
      readonly solver: string;
      readonly routeId: string;
      readonly netOutputAtomic: string;
      readonly observedAtLedger: string;
    } | null;
    readonly contracts: {
      readonly bondVault: string | null;
      readonly routeAuction: string | null;
    };
    readonly auctionPolicy: {
      readonly maximumBids: number;
      readonly minimumBondAtomic?: string | null;
    };
  };
  readonly privacy: {
    readonly disclosureDiff: readonly {
      readonly stepId: string;
      readonly field: string;
      readonly newlyVisibleTo: readonly string[];
      readonly reason: string;
      readonly userApprovalRequired: boolean;
    }[];
  };
  readonly routes: readonly RouteView[];
  readonly selectedRouteId: string | null;
  readonly currentStepId?: string | null;
  readonly compatibility?: {
    readonly engine: "workflow_v2";
    readonly routeId: string;
    readonly policyRouteHash: `0x${string}`;
    readonly workflowId: string;
    readonly parentPlanHash: `0x${string}`;
    readonly planCoreSha256: `0x${string}`;
    readonly executionEvidenceObservedAt: string;
    readonly executionQuoteExpiresAt: number;
    readonly amountCommitment: `0x${string}`;
    readonly recipientCommitment: `0x${string}`;
    readonly latestPlanCoreSha256: `0x${string}`;
    readonly confirmedCheckpointCount: number;
    readonly totalCheckpointCount: number;
    readonly currentAction: string | null;
    readonly terminalReceiptSha256: `0x${string}` | null;
    readonly updatedAt: string;
    readonly status: "bound" | "in_progress" | "completed" | "failed" | "indeterminate" | "recovery_required" | "refunded";
  };
};

type CompileResponse = {
  readonly success: true;
  readonly workflowPlan: WorkflowPlanView;
  readonly workflowToken: string;
  readonly limitations: readonly string[];
};

type HydrateResponse = {
  readonly success: true;
  readonly workflowPlan: WorkflowPlanView;
  readonly workflowToken: string;
  readonly routeQuote: {
    readonly routeId: string;
    readonly amountAtomic: string;
    readonly maximumBridgeFeeAtomic: string;
    readonly conservativeDestinationAmountAtomic: string;
    readonly sourceAllowanceAtomic: string;
    readonly sourceApprovalRequired: boolean;
    readonly supplyApyBps: number;
    readonly quoteExpiresAt: number;
  };
  readonly limitations: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCompileResponse(value: unknown): value is CompileResponse {
  if (!isRecord(value) || value.success !== true || !isRecord(value.workflowPlan)) return false;
  const plan = value.workflowPlan;
  return (
    plan.version === 3 &&
    plan.schemaVersion === "kletia_workflow_plan_v3" &&
    typeof plan.workflowId === "string" &&
    Array.isArray(plan.routes) &&
    isRecord(plan.controlPlane) &&
    isRecord(plan.coordinationMarket) &&
    isRecord(plan.privacy) &&
    typeof value.workflowToken === "string" &&
    Array.isArray(value.limitations)
  );
}

function normalizeUsdcAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) {
    throw new Error("Enter a positive USDC amount with at most six decimals.");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 6) throw new Error("USDC supports at most six decimals on the EVM corridor.");
  const atomic = BigInt(`${whole || "0"}${fraction.padEnd(6, "0")}`);
  if (atomic <= 0n) throw new Error("The protected amount must be greater than zero.");
  return `${BigInt(whole || "0").toString()}${fraction ? `.${fraction.replace(/0+$/u, "")}` : ""}`.replace(/\.$/u, "");
}

function formatUsdcAtomic(value: string): string {
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

async function readResponse(response: Response): Promise<unknown> {
  const value = await response.json().catch(() => null);
  if (response.ok) return value;
  const message = isRecord(value) && typeof value.message === "string"
    ? value.message
    : "The V3 compiler rejected the request.";
  throw new Error(message);
}

function compactId(value: string | null): string {
  if (!value) return "not configured";
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export interface ResolvedIntentReceiptForV3 {
  readonly schemaVersion: "kletia_resolved_intent_receipt_v1";
  readonly workflowId: string;
  readonly requestId: string;
  readonly planCoreSha256: `0x${string}`;
  readonly workflowToken: string;
  readonly scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";
  readonly selectedRoute: "direct_cctp" | "stellar_centered_public";
  readonly protectedAmount: string;
}

export function CompetitiveWorkflowPanel({
  stellarAddress,
  evmAddress,
  resolvedIntentReceipt,
}: {
  readonly stellarAddress: string;
  readonly evmAddress?: string;
  readonly resolvedIntentReceipt: ResolvedIntentReceiptForV3 | null;
}) {
  const [result, setResult] = React.useState<CompileResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [hydratingRouteId, setHydratingRouteId] = React.useState<string | null>(null);
  const [proving, setProving] = React.useState(false);
  const [controlPlaneBusy, setControlPlaneBusy] = React.useState(false);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [auctionBusy, setAuctionBusy] = React.useState(false);
  const [auctionTransactionHash, setAuctionTransactionHash] = React.useState<string | null>(null);
  const [competitiveSolverPreference, setCompetitiveSolverPreference] = React.useState<boolean | null>(null);
  const [referenceSolverOnline, setReferenceSolverOnline] = React.useState(false);
  const [indeterminateControlPlaneHash, setIndeterminateControlPlaneHash] = React.useState<string | null>(null);
  const [indeterminateReceiptRegistryHash, setIndeterminateReceiptRegistryHash] = React.useState<string | null>(null);
  const [indeterminateReceiptFinalizeHash, setIndeterminateReceiptFinalizeHash] = React.useState<string | null>(null);
  const [indeterminateControlPlaneFinalizeHash, setIndeterminateControlPlaneFinalizeHash] = React.useState<string | null>(null);
  const [routeQuote, setRouteQuote] = React.useState<HydrateResponse["routeQuote"] | null>(null);
  const [executionHandoff, setExecutionHandoff] = React.useState<BoundWorkflowV2Handoff | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [compiledWallets, setCompiledWallets] = React.useState<{
    readonly evm: string;
    readonly stellar: string;
  } | null>(null);
  const amountOpeningRef = React.useRef<{
    readonly amount: string;
    readonly commitment: `0x${string}`;
    readonly salt: `0x${string}`;
    readonly recipient: string;
    readonly recipientCommitment: `0x${string}`;
    readonly recipientSalt: `0x${string}`;
  } | null>(null);
  const protectedAmount = Number(resolvedIntentReceipt?.protectedAmount || "0");
  const solverAmountValid = Number.isFinite(protectedAmount) && protectedAmount > 0;
  const solverAmountRecommended = solverAmountValid && protectedAmount >= 25;
  const useCompetitiveSolver =
    referenceSolverOnline &&
    solverAmountValid &&
    (competitiveSolverPreference ?? solverAmountRecommended);
  const policyProofRef = React.useRef<DevicePolicyProofEnvelopeV3 | null>(null);
  const readExecutorMaterial = React.useCallback(() => {
    const opening = amountOpeningRef.current;
    return opening
      ? {
          amount: opening.amount,
          recipient: opening.recipient,
          amountSalt: opening.salt,
          recipientSalt: opening.recipientSalt,
        }
      : null;
  }, []);

  React.useEffect(() => () => {
    amountOpeningRef.current = null;
    policyProofRef.current = null;
    forgetPrivateFieldGuards();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/intents/v3/capabilities`, {
          headers: { Accept: "application/json" },
        });
        const body = await readResponse(response);
        const market = isRecord(body) && isRecord(body.solverMarket)
          ? body.solverMarket
          : null;
        const worker = market && isRecord(market.referenceSolver)
          ? market.referenceSolver
          : null;
        if (!cancelled) setReferenceSolverOnline(worker?.online === true);
      } catch {
        if (!cancelled) setReferenceSolverOnline(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const compile = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setRouteQuote(null);
    setExecutionHandoff(null);
    amountOpeningRef.current = null;
    policyProofRef.current = null;
    setIndeterminateControlPlaneHash(null);
    setIndeterminateReceiptRegistryHash(null);
    setIndeterminateReceiptFinalizeHash(null);
    setIndeterminateControlPlaneFinalizeHash(null);
    setAuctionTransactionHash(null);
    setCompiledWallets(null);
    try {
      if (!resolvedIntentReceipt) {
        throw new Error("Resolve the natural-language goal and compile its sealed intent receipt first.");
      }
      if (resolvedIntentReceipt.selectedRoute !== "direct_cctp") {
        throw new Error(
          "The exact V3 financial executor currently supports only the reviewed direct CCTP route. The selected Stellar two-hop receipt remains available in Workflow V2 and is not silently replaced.",
        );
      }
      if (!evmAddress) throw new Error("Connect the EVM wallet used by Arc and Arbitrum Sepolia.");
      if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
        throw new Error("Connect a Stellar Testnet Freighter account for the control plane.");
      }
      const boundEvmAddress = getAddress(evmAddress);
      const normalizedAmount = normalizeUsdcAmount(resolvedIntentReceipt.protectedAmount);
      beginPrivateIntentObservation();
      const amountSalt = createPrivateSalt();
      const recipientSalt = createPrivateSalt();
      const [amountCommitment, recipientCommitment] = await Promise.all([
        commitPrivateField("amount", normalizedAmount, amountSalt),
        commitPrivateField("recipient", boundEvmAddress, recipientSalt),
      ]);
      amountOpeningRef.current = {
        amount: normalizedAmount,
        commitment: amountCommitment,
        salt: privateSaltToHex(amountSalt),
        recipient: boundEvmAddress,
        recipientCommitment,
        recipientSalt: privateSaltToHex(recipientSalt),
      };
      const response = await fetch(`${BACKEND_URL}/api/intents/v3/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          requestId: resolvedIntentReceipt.requestId,
          sourceWorkflowTokenV2: resolvedIntentReceipt.workflowToken,
          sourceIntentReceipt: {
            schemaVersion: "kletia_source_intent_receipt_v1",
            engine: "workflow_v2",
            scenarioId: resolvedIntentReceipt.scenarioId,
            workflowId: resolvedIntentReceipt.workflowId,
            requestId: resolvedIntentReceipt.requestId,
            planCoreSha256: resolvedIntentReceipt.planCoreSha256,
            selectedRoute: resolvedIntentReceipt.selectedRoute,
          },
          preferredRouteId: "arc-arbitrum-direct-cctp",
          semanticGoal: "Move my protected USDC budget from Arc Testnet to Arbitrum Sepolia, supply it to reviewed Aave, and calculate conservative borrow capacity without borrowing.",
          coordinationMode: useCompetitiveSolver ? "competitive" : "direct",
          minimumEvidenceLevel: "protocol_verified",
          legs: [
            { operation: "bridge", chain: "arc_testnet", protocol: "circle-cctp-v2", assetIn: "USDC", assetOut: "USDC" },
            { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
            { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
          ],
          walletBindings: {
            arc_testnet: boundEvmAddress,
            stellar_testnet: stellarAddress,
            arbitrum_sepolia: boundEvmAddress,
          },
          privateBindings: [
            {
              field: "amount",
              reference: "private://workflow_amount",
              commitment: amountCommitment,
              disclosureLevel: "public_execution",
            },
            {
              field: "recipient",
              reference: "private://workflow_recipient",
              commitment: recipientCommitment,
              disclosureLevel: "public_execution",
            },
          ],
          privacyBudget: {
            defaultLevel: "device_only",
            fields: {
              amount: "public_execution",
              recipient: "public_execution",
              route: "public_execution",
              timing: "public_execution",
              wallet_identity: "selected_provider",
              balance: "selected_provider",
              strategy: "selected_provider",
            },
            approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc", "stellar_rpc"],
            aiMode: "deterministic_only",
            ledgerMode: "public",
          },
          risk: { tolerance: "conservative", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
        }),
      });
      const body = await readResponse(response);
      if (!isCompileResponse(body)) throw new Error("The V3 response failed its browser schema boundary.");
      setCompiledWallets({
        evm: boundEvmAddress,
        stellar: stellarAddress,
      });
      setResult(body);
    } catch (caught) {
      amountOpeningRef.current = null;
      forgetPrivateFieldGuards();
      setCompiledWallets(null);
      setError(caught instanceof Error ? caught.message : "Workflow V3 compilation failed.");
    } finally {
      setBusy(false);
    }
  };

  const hydrateRoute = async (routeId: string) => {
    if (!result) return;
    const opening = amountOpeningRef.current;
    if (!opening) {
      setError("The protected amount opening is no longer available in this browser. Compile a new workflow.");
      return;
    }
    setHydratingRouteId(routeId);
    setError(null);
    try {
      const response = await fetchWithRouteHydrationDisclosure({
        url: `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/routes/${encodeURIComponent(routeId)}/hydrate`,
        workflowId: result.workflowPlan.workflowId,
        routeId,
        requestId: result.workflowPlan.requestId,
        body: {
          amount: opening.amount,
          amountSalt: opening.salt,
          acknowledgePublicExecution: true,
        },
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${result.workflowToken}`,
        },
      });
      const body = await readResponse(response);
      if (
        !isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) ||
        typeof body.workflowToken !== "string" || !isRecord(body.routeQuote) ||
        !Array.isArray(body.limitations)
      ) {
        throw new Error("The route-hydration response failed its browser boundary.");
      }
      const nextResult = {
        ...result,
        workflowPlan: body.workflowPlan,
        workflowToken: body.workflowToken,
        limitations: body.limitations,
      };
      if (!isCompileResponse(nextResult)) {
        throw new Error("The hydrated workflow failed its browser schema boundary.");
      }
      const quote = body.routeQuote as unknown as HydrateResponse["routeQuote"];
      if (
        quote.routeId !== routeId || typeof quote.amountAtomic !== "string" ||
        typeof quote.maximumBridgeFeeAtomic !== "string" ||
        typeof quote.conservativeDestinationAmountAtomic !== "string" ||
        typeof quote.sourceAllowanceAtomic !== "string" ||
        typeof quote.sourceApprovalRequired !== "boolean" ||
        typeof quote.supplyApyBps !== "number" || typeof quote.quoteExpiresAt !== "number"
      ) {
        throw new Error("The live route quote failed its browser schema boundary.");
      }
      setRouteQuote(quote);
      setResult(nextResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Live route hydration failed.");
    } finally {
      setHydratingRouteId(null);
    }
  };

  const syncWinner = React.useCallback(async (silent = false) => {
    if (!result) return;
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/solver-market/sync`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${result.workflowToken}`,
          },
        },
      );
      const body = await readResponse(response);
      if (!isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) || typeof body.workflowToken !== "string") {
        throw new Error("The solver-market synchronization response failed its browser boundary.");
      }
      const next = { ...result, workflowPlan: body.workflowPlan, workflowToken: body.workflowToken };
      if (!isCompileResponse(next)) throw new Error("The synchronized workflow failed its browser schema boundary.");
      setResult(next);
    } catch (caught) {
      if (!silent) {
        setError(caught instanceof Error ? caught.message : "Solver-market synchronization failed.");
      }
    } finally {
      setSyncing(false);
    }
  }, [result]);

  React.useEffect(() => {
    if (
      !auctionTransactionHash ||
      !result ||
      result.workflowPlan.coordinationMarket.status === "winner_selected"
    ) {
      return;
    }
    const interval = window.setInterval(() => void syncWinner(true), 7_000);
    return () => window.clearInterval(interval);
  }, [auctionTransactionHash, result, syncWinner]);

  const openSolverAuction = async () => {
    if (!result || !compiledWallets || !routeQuote) return;
    const plan = result.workflowPlan;
    const minimumBondAtomic = plan.coordinationMarket.auctionPolicy.minimumBondAtomic;
    if (
      plan.coordinationMarket.status !== "auction_open_required" ||
      !minimumBondAtomic ||
      !/^\d+$/u.test(minimumBondAtomic)
    ) {
      setError("The live solver bond requirement is unavailable.");
      return;
    }
    setAuctionBusy(true);
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch your Stellar wallet to Testnet before opening route competition.");
      }
      const latestLedger = await readStellarTestnetLatestLedger();
      const minimumOutput = BigInt(routeQuote.conservativeDestinationAmountAtomic);
      const maximumSolverFee = minimumOutput / 1_000n > 0n
        ? minimumOutput / 1_000n
        : 1n;
      const prepared = await prepareRouteAuctionOpen({
        plan: plan as unknown as Parameters<typeof prepareRouteAuctionOpen>[0]["plan"],
        owner: compiledWallets.stellar,
        minimumOutputAtomic: minimumOutput.toString(),
        maximumSolverFeeAtomic: maximumSolverFee.toString(),
        maximumDurationSeconds: 600,
        minimumBondAtomic,
        // The reviewed Circle/Aave route quote is deliberately short-lived.
        // Keep commit and reveal inside the quote window; the longer settlement
        // deadline remains available for later execution evidence and recovery
        // without pretending the opening quote is still fresh.
        commitDeadlineLedger: latestLedger + 12,
        revealDeadlineLedger: latestLedger + 24,
        settlementDeadlineLedger: latestLedger + 60,
      });
      const signed = await signTransaction(prepared.xdr, {
        networkPassphrase: Networks.TESTNET,
        address: compiledWallets.stellar,
      });
      if (
        signed.error ||
        !signed.signedTxXdr ||
        signed.signerAddress !== compiledWallets.stellar
      ) {
        throw new Error(signed.error?.message || "The Stellar wallet rejected route competition.");
      }
      const transactionHash = await submitSignedStellarTransaction(
        signed.signedTxXdr,
        prepared.xdr,
      );
      setAuctionTransactionHash(transactionHash);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Route competition could not be opened.");
    } finally {
      setAuctionBusy(false);
    }
  };

  const advanceStellarCommit = async (transactionHash: string) => {
    if (!result) throw new Error("The sealed workflow is unavailable.");
    const response = await fetch(
      `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/advance`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowToken: result.workflowToken,
          transactionHash,
        }),
      },
    );
    const body = await readResponse(response);
    if (
      !isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) ||
      typeof body.workflowToken !== "string" || !isRecord(body.result)
    ) {
      throw new Error("The control-plane evidence response failed its browser boundary.");
    }
    const next = { ...result, workflowPlan: body.workflowPlan, workflowToken: body.workflowToken };
    if (!isCompileResponse(next)) {
      throw new Error("The control-plane-committed workflow failed its browser schema boundary.");
    }
    setResult(next);
    if (next.workflowPlan.controlPlane.commitment.status === "confirmed") {
      setIndeterminateControlPlaneHash(null);
    }
    if (next.workflowPlan.controlPlane.receiptRegistry.status === "confirmed") {
      setIndeterminateReceiptRegistryHash(null);
    }
    if (next.workflowPlan.controlPlane.receiptRegistry.status === "finalized") {
      setIndeterminateReceiptFinalizeHash(null);
    }
    if (next.workflowPlan.controlPlane.commitment.status === "finalized") {
      setIndeterminateControlPlaneFinalizeHash(null);
    }
  };

  const signAndCommitControlPlane = async () => {
    if (!result || !compiledWallets) return;
    const plan = result.workflowPlan;
    const proof = policyProofRef.current;
    const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
    const step = route?.steps.find((candidate) => candidate.operation === "control_plane_commit");
    if (
      !proof || !route || !step?.target || plan.controlPlane.proofBinding.status !== "bound" ||
      plan.controlPlane.commitment.status !== "awaiting_signature" ||
      plan.controlPlane.policyRoot === null || plan.controlPlane.nullifier === null
    ) {
      setError("The proof-bound control-plane call is not ready. Generate a fresh device proof.");
      return;
    }
    setControlPlaneBusy(true);
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing the policy commitment.");
      }
      const prepared = await prepareIntentControlPlaneCommit({
        plan: plan as BoundControlPlanePlanV3,
        proof,
        contractId: step.target,
      });
      const signed = await signTransaction(prepared.xdr, {
        networkPassphrase: Networks.TESTNET,
        address: compiledWallets.stellar,
      });
      if (
        signed.error || !signed.signedTxXdr ||
        signed.signerAddress !== compiledWallets.stellar
      ) {
        throw new Error(signed.error?.message || "Freighter rejected the control-plane transaction.");
      }
      const transactionHash = await submitSignedStellarTransaction(
        signed.signedTxXdr,
        prepared.xdr,
      );
      await advanceStellarCommit(transactionHash);
      policyProofRef.current = null;
    } catch (caught) {
      if (caught instanceof StellarTransactionIndeterminateError) {
        setIndeterminateControlPlaneHash(caught.transactionHash);
        setError("The Stellar result is indeterminate. Kletia will recover this hash without resubmitting the transaction.");
      } else {
        setError(caught instanceof Error ? caught.message : "The control-plane commit failed.");
      }
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const recoverControlPlaneCommit = async () => {
    if (!indeterminateControlPlaneHash) return;
    setControlPlaneBusy(true);
    setError(null);
    try {
      await advanceStellarCommit(indeterminateControlPlaneHash);
      policyProofRef.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Control-plane status recovery failed.");
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const signAndCommitReceiptRegistry = async () => {
    if (!result || !compiledWallets) return;
    const plan = result.workflowPlan;
    const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
    const step = route?.steps.find((candidate) => candidate.operation === "receipt_registry_commit");
    const commitment = plan.controlPlane.commitment;
    const executionExpiresAtLedger = plan.controlPlane.proofBinding.executionExpiresAtLedger;
    if (
      !route || !step?.target || plan.controlPlane.proofBinding.status !== "bound" ||
      commitment.status !== "confirmed" ||
      plan.controlPlane.receiptRegistry.status !== "awaiting_signature" ||
      executionExpiresAtLedger === null || commitment.receiptCloseByLedger === null ||
      commitment.retentionFloorLedger === null
    ) {
      setError("The receipt registry cannot be committed before the exact control-plane lifecycle is confirmed.");
      return;
    }
    setControlPlaneBusy(true);
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing the receipt-registry commitment.");
      }
      const lifecycle: ControlPlaneLifecycleV1 = {
        executionExpiresAtLedger,
        receiptCloseByLedger: commitment.receiptCloseByLedger,
        retentionFloorLedger: commitment.retentionFloorLedger,
        derivedAtLedger: Number(commitment.committedAtLedger),
      };
      if (!Number.isSafeInteger(lifecycle.derivedAtLedger) || lifecycle.derivedAtLedger <= 0) {
        throw new Error("The confirmed control-plane ledger is invalid.");
      }
      const prepared = await prepareReceiptRegistryCommit({
        plan: plan as BoundControlPlanePlanV3,
        contractId: step.target,
        lifecycle,
      });
      const signed = await signTransaction(prepared.xdr, {
        networkPassphrase: Networks.TESTNET,
        address: compiledWallets.stellar,
      });
      if (
        signed.error || !signed.signedTxXdr ||
        signed.signerAddress !== compiledWallets.stellar
      ) {
        throw new Error(signed.error?.message || "Freighter rejected the receipt-registry transaction.");
      }
      const transactionHash = await submitSignedStellarTransaction(
        signed.signedTxXdr,
        prepared.xdr,
      );
      await advanceStellarCommit(transactionHash);
    } catch (caught) {
      if (caught instanceof StellarTransactionIndeterminateError) {
        setIndeterminateReceiptRegistryHash(caught.transactionHash);
        setError("The receipt-registry result is indeterminate. Recover this hash without resubmitting.");
      } else {
        setError(caught instanceof Error ? caught.message : "The receipt-registry commit failed.");
      }
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const recoverReceiptRegistryCommit = async () => {
    if (!indeterminateReceiptRegistryHash) return;
    setControlPlaneBusy(true);
    setError(null);
    try {
      await advanceStellarCommit(indeterminateReceiptRegistryHash);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Receipt-registry status recovery failed.");
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const signAndFinalizeReceiptRoot = async (
    operation: "receipt_registry_finalize" | "control_plane_finalize",
  ) => {
    if (!result || !compiledWallets) return;
    const plan = result.workflowPlan;
    const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
    const step = route?.steps.find((candidate) => candidate.operation === operation);
    const receiptRoot = plan.compatibility?.terminalReceiptSha256;
    const lifecycle = operation === "receipt_registry_finalize"
      ? plan.controlPlane.receiptRegistry
      : plan.controlPlane.commitment;
    if (
      !step?.target || plan.currentStepId !== step.id ||
      plan.compatibility?.status !== "completed" || !receiptRoot ||
      lifecycle.status !== "confirmed" || !lifecycle.nonce ||
      (operation === "control_plane_finalize" &&
        plan.controlPlane.receiptRegistry.status !== "finalized")
    ) {
      setError("The exact terminal receipt root is not ready for this Stellar finalization step.");
      return;
    }
    setControlPlaneBusy(true);
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before finalizing the receipt root.");
      }
      const prepared = operation === "receipt_registry_finalize"
        ? await prepareReceiptRegistryFinalize({
            plan: plan as BoundControlPlanePlanV3,
            contractId: step.target,
            nonce: lifecycle.nonce,
            receiptRoot,
          })
        : await prepareIntentControlPlaneFinalize({
            plan: plan as BoundControlPlanePlanV3,
            contractId: step.target,
            nonce: lifecycle.nonce,
            receiptRoot,
          });
      const signed = await signTransaction(prepared.xdr, {
        networkPassphrase: Networks.TESTNET,
        address: compiledWallets.stellar,
      });
      if (signed.error || !signed.signedTxXdr || signed.signerAddress !== compiledWallets.stellar) {
        throw new Error(signed.error?.message || "Freighter rejected receipt-root finalization.");
      }
      const transactionHash = await submitSignedStellarTransaction(
        signed.signedTxXdr,
        prepared.xdr,
      );
      await advanceStellarCommit(transactionHash);
    } catch (caught) {
      if (caught instanceof StellarTransactionIndeterminateError) {
        if (operation === "receipt_registry_finalize") {
          setIndeterminateReceiptFinalizeHash(caught.transactionHash);
        } else {
          setIndeterminateControlPlaneFinalizeHash(caught.transactionHash);
        }
        setError("Receipt finalization is indeterminate. Recover the exact hash; do not sign or resend it again.");
      } else {
        setError(caught instanceof Error ? caught.message : "Receipt-root finalization failed safely.");
      }
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const recoverReceiptRootFinalization = async (transactionHash: string) => {
    setControlPlaneBusy(true);
    setError(null);
    try {
      await advanceStellarCommit(transactionHash);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Receipt-root status recovery failed.");
    } finally {
      setControlPlaneBusy(false);
    }
  };

  const proveAndBindPolicy = async () => {
    if (!result || !compiledWallets || !routeQuote) return;
    const route = result.workflowPlan.routes.find(
      (candidate) => candidate.id === result.workflowPlan.selectedRouteId,
    );
    if (!route?.hydration) {
      setError("A live amount-bound route quote is required before policy proof generation.");
      return;
    }
    setProving(true);
    setError(null);
    try {
      const latestLedger = await readStellarTestnetLatestLedger();
      const policyProof = await generateDevicePolicyProofV3({
        workflowRoot: result.workflowPlan.controlPlane.workflowRoot,
        routeId: route.id,
        solverRouteHash: route.solverRouteHash,
        amountAtomic: routeQuote.amountAtomic,
        recipient: compiledWallets.evm,
        executionExpiresAtLedger: latestLedger + 720,
      });
      const response = await fetch(
        `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/policy-proof`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${result.workflowToken}`,
          },
          body: JSON.stringify({ policyProof }),
        },
      );
      const body = await readResponse(response);
      if (
        !isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) ||
        typeof body.workflowToken !== "string" || !isRecord(body.policyProofEvidence)
      ) {
        throw new Error("The policy-proof binding response failed its browser boundary.");
      }
      const next = { ...result, workflowPlan: body.workflowPlan, workflowToken: body.workflowToken };
      if (!isCompileResponse(next)) {
        throw new Error("The proof-bound workflow failed its browser schema boundary.");
      }
      setResult(next);
      policyProofRef.current = policyProof;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Device policy proof binding failed.");
    } finally {
      setProving(false);
    }
  };

  const bindFinancialExecutor = async () => {
    if (!result) return;
    setHandoffBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/execution-handoff`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${result.workflowToken}`,
          },
        },
      );
      const body = await readResponse(response);
      if (
        !isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) ||
        typeof body.workflowToken !== "string" || !isRecord(body.executionHandoff)
      ) {
        throw new Error("The reviewed-executor handoff failed its browser boundary.");
      }
      const handoff = body.executionHandoff as unknown as BoundWorkflowV2Handoff;
      const next = { ...result, workflowPlan: body.workflowPlan, workflowToken: body.workflowToken };
      if (!isCompileResponse(next)) {
        throw new Error("The executor-bound workflow failed its browser schema boundary.");
      }
      const compatibility = next.workflowPlan.compatibility;
      const opening = amountOpeningRef.current;
      const controlPlaneTransactionHash = next.workflowPlan.controlPlane.commitment.transactionHash;
      const receiptRegistryTransactionHash = next.workflowPlan.controlPlane.receiptRegistry.transactionHash;
      const route = next.workflowPlan.routes.find((candidate) => candidate.id === compatibility?.routeId);
      const executorRoute = handoff.workflowPlan.routeCandidates.find(
        (candidate) => candidate.kind === handoff.workflowPlan.selectedRoute,
      );
      const executionEnvelope = {
        success: true as const,
        status: "success" as const,
        executionKind: "workflow_plan_v2" as const,
        network: "stellar" as const,
        chainRef: "stellar:testnet" as const,
        requestId: handoff.workflowPlan.requestId,
        message: "Reviewed V3 execution handoff.",
        workflowPlan: handoff.workflowPlan,
        workflowToken: handoff.workflowToken,
      };
      if (
        !opening ||
        !compatibility ||
        !route ||
        handoff.executionKind !== "workflow_plan_v2" ||
        typeof handoff.workflowToken !== "string" ||
        !handoff.workflowToken.startsWith("v2.") ||
        handoff.workflowPlan.parentWorkflowV3?.workflowId !== result.workflowPlan.workflowId ||
        handoff.parentPlanHash !== compatibility.parentPlanHash ||
        compatibility.policyRouteHash !== route.solverRouteHash ||
        compatibility.planCoreSha256 !== handoff.workflowPlan.authorizationBoundary.planCoreSha256 ||
        compatibility.executionQuoteExpiresAt <= Date.now() ||
        !Number.isFinite(Date.parse(compatibility.executionEvidenceObservedAt)) ||
        executorRoute?.liveEvidence.quoteExpiresAt !== compatibility.executionQuoteExpiresAt ||
        executorRoute?.liveEvidence.observedAt !== compatibility.executionEvidenceObservedAt ||
        !controlPlaneTransactionHash ||
        !receiptRegistryTransactionHash ||
        !isWorkflowV2Response(executionEnvelope, {
          requestId: handoff.workflowPlan.requestId,
          amountCommitment: opening.commitment,
          recipientCommitment: opening.recipientCommitment,
          arcAddress: opening.recipient,
          arbitrumSepoliaAddress: opening.recipient,
          parentWorkflowV3: {
            workflowId: result.workflowPlan.workflowId,
            workflowRoot: result.workflowPlan.controlPlane.workflowRoot,
            planHashAtHandoff: handoff.parentPlanHash,
            expiresAt: result.workflowPlan.expiresAt,
            controlPlaneTransactionHash,
            receiptRegistryTransactionHash,
          },
        }) ||
        handoff.externalExecutionTruthProvenByStellar !== false
      ) {
        throw new Error("The financial executor did not preserve the sealed V3 parent binding.");
      }
      setResult(next);
      setExecutionHandoff(handoff);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Financial executor binding failed.");
    } finally {
      setHandoffBusy(false);
    }
  };

  const syncFinancialExecutor = async (workflowTokenV2: string) => {
    if (!result) throw new Error("The parent V3 workflow is unavailable.");
    const previousCompatibility = result.workflowPlan.compatibility;
    if (!previousCompatibility || previousCompatibility.engine !== "workflow_v2") {
      throw new Error("The V3 workflow has no reviewed executor binding.");
    }
    const response = await fetch(
      `${BACKEND_URL}/api/workflows/v3/${encodeURIComponent(result.workflowPlan.workflowId)}/execution-sync`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${result.workflowToken}`,
        },
        body: JSON.stringify({ workflowTokenV2 }),
      },
    );
    const body = await readResponse(response);
    if (
      !isRecord(body) || body.success !== true || !isRecord(body.workflowPlan) ||
      typeof body.workflowToken !== "string"
    ) {
      throw new Error("The durable executor sync failed its browser boundary.");
    }
    const next = { ...result, workflowPlan: body.workflowPlan, workflowToken: body.workflowToken };
    if (!isCompileResponse(next) || !next.workflowPlan.compatibility) {
      throw new Error("The synchronized V3 workflow failed its browser schema boundary.");
    }
    const compatibility = next.workflowPlan.compatibility;
    if (
      compatibility.workflowId !== previousCompatibility.workflowId ||
      compatibility.parentPlanHash !== previousCompatibility.parentPlanHash ||
      compatibility.policyRouteHash !== previousCompatibility.policyRouteHash ||
      compatibility.amountCommitment !== previousCompatibility.amountCommitment ||
      compatibility.recipientCommitment !== previousCompatibility.recipientCommitment ||
      compatibility.confirmedCheckpointCount < previousCompatibility.confirmedCheckpointCount ||
      JSON.stringify(next.workflowPlan).includes(workflowTokenV2)
    ) {
      throw new Error("The synchronized progress changed an immutable executor binding.");
    }
    setResult(next);
  };

  const walletBindingChanged = Boolean(
    result &&
    compiledWallets &&
    (
      !evmAddress ||
      compiledWallets.evm.toLowerCase() !== evmAddress.toLowerCase() ||
      compiledWallets.stellar !== stellarAddress
    ),
  );
  const plan = walletBindingChanged ? null : result?.workflowPlan ?? null;
  const solverDisclosure = plan?.privacy.disclosureDiff.filter((entry) => entry.stepId === "solver-market-auction") ?? [];
  const executableRoutes = plan?.routes.filter((route) => route.available) ?? [];
  const resolvedRouteSupported = resolvedIntentReceipt?.selectedRoute === "direct_cctp";
  const canOpenAuction = Boolean(
    referenceSolverOnline &&
    plan?.coordinationMarket.status === "auction_open_required" &&
    executableRoutes.some((route) => route.metrics.amountDependentCostsComplete && route.metrics.estimatedOutputAtomic !== null),
  );

  return (
    <section className="stellar-panel stellar-v3-workflow" aria-labelledby="stellar-v3-workflow-title">
      <div className="stellar-panel-header">
        <div>
          <p className="stellar-eyebrow">Multichain intent</p>
          <h2 id="stellar-v3-workflow-title">Move, supply, and track</h2>
        </div>
        <Scale aria-hidden="true" />
      </div>

      <p className="stellar-v3-workflow-intro">
        Kletia turns the goal into wallet-approved checkpoints. Nothing moves until you review and sign each step.
      </p>

      <div className="stellar-v3-workflow-summary" aria-live="polite">
        <span><strong>Budget</strong>{resolvedIntentReceipt ? `${resolvedIntentReceipt.protectedAmount} USDC` : "waiting for amount"}</span>
        <span><strong>Route</strong>{resolvedIntentReceipt?.selectedRoute.replace(/_/gu, " ") ?? "waiting for goal"}</span>
        <span><strong>Approvals</strong>one wallet review per money-moving step</span>
      </div>

      <div className="stellar-v3-auction-state">
        <div>
          <Scale aria-hidden="true" />
          <div>
            <strong>{useCompetitiveSolver ? "Competing solvers on" : "Direct route"}</strong>
            <p>
              {useCompetitiveSolver
                ? "A live bonded Testnet solver can submit an onchain offer. This usually adds about one minute."
                : !referenceSolverOnline
                    ? "The Testnet solver is offline, so Kletia keeps the reviewed direct route."
                    : !solverAmountValid
                      ? "Enter a positive amount before choosing solver coordination."
                      : !solverAmountRecommended
                        ? "Direct routing is the default below 25 USDC. You can still enable the bonded solver for an explicit Testnet comparison."
                    : "Use the reviewed direct route with fewer coordination steps."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="stellar-button"
          disabled={busy || !referenceSolverOnline || !solverAmountValid}
          onClick={() => setCompetitiveSolverPreference(!useCompetitiveSolver)}
        >
          {useCompetitiveSolver
            ? "Use direct route"
            : solverAmountRecommended
              ? "Use competing solvers"
              : "Test with competing solvers"}
        </button>
      </div>

      <button
        type="button"
        className="stellar-button"
        data-variant="primary"
        disabled={busy || !resolvedIntentReceipt || !resolvedRouteSupported}
        onClick={() => void compile()}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
        {busy ? "Building plan" : "Build reviewed plan"}
      </button>

      {!resolvedIntentReceipt ? (
        <div className="stellar-v3-error" role="status">
          <AlertTriangle aria-hidden="true" />
          <div><strong>Intent receipt required</strong><p>Use the composer, answer any clarification card, then compile the sealed workflow. V3 no longer runs from a hardcoded example.</p></div>
        </div>
      ) : !resolvedRouteSupported ? (
        <div className="stellar-v3-error" role="status">
          <AlertTriangle aria-hidden="true" />
          <div><strong>Receipt preserved, executor unavailable</strong><p>The selected two-hop Stellar route is not rewritten as direct CCTP. Continue with its V2 roadmap or create a new direct-route intent.</p></div>
        </div>
      ) : null}

      {error ? (
        <div className="stellar-v3-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div><strong>Stopped safely</strong><p>{error}</p></div>
        </div>
      ) : null}

      {walletBindingChanged ? (
        <div className="stellar-v3-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Wallet binding changed</strong>
            <p>The sealed V3 workflow is hidden and cannot be synchronized. Compile a new plan for the connected wallets.</p>
          </div>
        </div>
      ) : null}

      {plan ? (
        <div className="stellar-v3-workflow-result">
          <div className="stellar-v3-workflow-summary">
            <span><strong>Plan</strong>{plan.selectedRouteId ? "route selected" : "comparing routes"}</span>
            <span><strong>Competition</strong>{plan.coordinationMarket.required ? plan.coordinationMarket.status.replace(/_/gu, " ") : "not needed"}</span>
            <span><strong>Next</strong>{plan.controlPlane.proofBinding.status === "device_proof_required" ? "confirm your limits" : "review the highlighted action"}</span>
          </div>

          <details className="stellar-v3-limitations">
            <summary>Plan identifiers and verification state</summary>
            <p>Workflow {compactId(plan.workflowId)}</p>
            <p>Control plane {plan.controlPlane.status.replace(/_/gu, " ")}</p>
            <p>Selected route {plan.selectedRouteId ?? "waiting for selection"}</p>
          </details>

          {plan.controlPlane.proofBinding.status === "device_proof_required" && plan.selectedRouteId ? (
            <div className="stellar-v3-proof-boundary">
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Confirm your spending limits</strong>
                <p>
                  Your browser checks that this route stays inside the amount, recipient, network, and expiry limits you approved.
                </p>
                <button
                  type="button"
                  className="stellar-button"
                  disabled={proving || !routeQuote}
                  onClick={() => void proveAndBindPolicy()}
                >
                  {proving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                  {proving ? "Checking limits" : "Confirm limits"}
                </button>
                {!routeQuote ? <small>Get a fresh route quote first.</small> : null}
              </div>
            </div>
          ) : null}

          {plan.controlPlane.proofBinding.status === "bound" ? (
            <div className="stellar-v3-live-quote" role="status">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <strong>Limits confirmed</strong>
                <p>
                  The plan matches your approved policy. Bridge and Aave results are still checked separately after each wallet action.
                </p>
                {plan.controlPlane.commitment.status === "awaiting_signature" ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void signAndCommitControlPlane()}
                  >
                    {controlPlaneBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    {controlPlaneBusy ? "Confirming Stellar policy" : "Review and sign Stellar policy commitment"}
                  </button>
                ) : null}
                {indeterminateControlPlaneHash ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void recoverControlPlaneCommit()}
                  >
                    <RefreshCw className={controlPlaneBusy ? "animate-spin" : ""} aria-hidden="true" />
                    Recover submitted transaction — do not resend
                  </button>
                ) : null}
                {plan.controlPlane.commitment.status === "confirmed" ? (
                  <small>
                    Stellar commitment confirmed at ledger {plan.controlPlane.commitment.committedAtLedger ?? "unknown"} · nonce {plan.controlPlane.commitment.nonce ?? "unknown"}.
                    Foreign-chain execution is still pending and separately verified.
                  </small>
                ) : null}
                {plan.controlPlane.receiptRegistry.status === "awaiting_signature" ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void signAndCommitReceiptRegistry()}
                  >
                    {controlPlaneBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    {controlPlaneBusy ? "Confirming receipt registry" : "Sign receipt-registry commitment"}
                  </button>
                ) : null}
                {indeterminateReceiptRegistryHash ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void recoverReceiptRegistryCommit()}
                  >
                    <RefreshCw className={controlPlaneBusy ? "animate-spin" : ""} aria-hidden="true" />
                    Recover receipt-registry transaction — do not resend
                  </button>
                ) : null}
                {plan.controlPlane.receiptRegistry.status === "confirmed" ? (
                  <div>
                    <small>
                      Receipt registry confirmed at ledger {plan.controlPlane.receiptRegistry.committedAtLedger ?? "unknown"} · nonce {plan.controlPlane.receiptRegistry.nonce ?? "unknown"}.
                    </small>
                    {!plan.compatibility ? (
                      <button
                        type="button"
                        className="stellar-button"
                        disabled={handoffBusy}
                        onClick={() => void bindFinancialExecutor()}
                      >
                        {handoffBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                        {handoffBusy ? "Binding reviewed executor" : "Bind reviewed CCTP → Aave executor"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {plan.compatibility && executionHandoff && plan.compatibility.status !== "completed" ? (
            <div className="stellar-v3-live-quote" role="status">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <strong>Reviewed financial executor bound</strong>
                <p>
                  WorkflowPlanV2 {compactId(executionHandoff.workflowPlan.workflowId)} is hash-bound to this
                  V3 policy lifecycle and expires with it. Its bearer token remains only in this browser session;
                  Stellar has not proven any CCTP or Aave result.
                </p>
                <small>
                  {executionHandoff.workflowPlan.steps.length} checkpoint(s) · every financial step still needs
                  a fresh manifest review and wallet signature.
                </small>
              </div>
            </div>
          ) : null}

          {plan.compatibility && executionHandoff && plan.compatibility.status !== "completed" ? (
            <BoundWorkflowV2Executor
              key={`${executionHandoff.workflowPlan.workflowId}:${executionHandoff.workflowPlan.authorizationBoundary.planCoreSha256}`}
              handoff={executionHandoff}
              evmAddress={evmAddress}
              readMaterial={readExecutorMaterial}
              onProgress={syncFinancialExecutor}
            />
          ) : null}

          {plan.compatibility?.status === "completed" ? (
            <div className="stellar-v3-live-quote" role="status">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <strong>Financial workflow complete</strong>
                <p>
                  {plan.compatibility.confirmedCheckpointCount} independently verified executor checkpoints are
                  bound to receipt {plan.compatibility.terminalReceiptSha256?.slice(0, 12)}…
                </p>
                <small>
                  The receipt root is ready for separate Stellar owner finalization. It does not make Stellar an
                  oracle for Circle, Arc, Arbitrum Sepolia or Aave.
                </small>
                {plan.controlPlane.receiptRegistry.status === "confirmed" ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void signAndFinalizeReceiptRoot("receipt_registry_finalize")}
                  >
                    {controlPlaneBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    Review and finalize receipt registry
                  </button>
                ) : null}
                {indeterminateReceiptFinalizeHash ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void recoverReceiptRootFinalization(indeterminateReceiptFinalizeHash)}
                  >
                    <RefreshCw className={controlPlaneBusy ? "animate-spin" : ""} aria-hidden="true" />
                    Recover registry finalization — never resend
                  </button>
                ) : null}
                {plan.controlPlane.receiptRegistry.status === "finalized" &&
                plan.controlPlane.commitment.status === "confirmed" ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void signAndFinalizeReceiptRoot("control_plane_finalize")}
                  >
                    {controlPlaneBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    Review and close Stellar control plane
                  </button>
                ) : null}
                {indeterminateControlPlaneFinalizeHash ? (
                  <button
                    type="button"
                    className="stellar-button"
                    disabled={controlPlaneBusy}
                    onClick={() => void recoverReceiptRootFinalization(indeterminateControlPlaneFinalizeHash)}
                  >
                    <RefreshCw className={controlPlaneBusy ? "animate-spin" : ""} aria-hidden="true" />
                    Recover control-plane finalization — never resend
                  </button>
                ) : null}
                {plan.controlPlane.receiptRegistry.status === "finalized" &&
                plan.controlPlane.commitment.status === "finalized" ? (
                  <small>Both Stellar lifecycle records are closed against the same application receipt root.</small>
                ) : null}
              </div>
            </div>
          ) : null}

          {plan.intent.unresolved.length > 0 ? (
            <div className="stellar-v3-question" role="status">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>Clarification required</strong>
                {plan.intent.unresolved.map((item) => <p key={item.field}>{item.question}</p>)}
              </div>
            </div>
          ) : null}

          <div className="stellar-v3-route-results">
            {plan.routes.map((route) => (
              <article key={route.id} data-ready={route.available ? "true" : "false"}>
                <div className="stellar-v3-route-heading">
                  <div><strong>{route.label}</strong></div>
                  <span className="stellar-v3-status" data-state={route.available ? "ready" : "blocked"}>
                    {route.available ? <CheckCircle2 aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
                    {route.available ? "Fresh candidate" : "Fail closed"}
                  </span>
                </div>
                <p>{route.available ? "All current capability gates passed." : route.unavailableReason}</p>
                <div className="stellar-v3-route-metrics">
                  {route.metrics.estimatedOutputAtomic !== null ? (
                    <span>Net output {formatUsdcAtomic(route.metrics.estimatedOutputAtomic)}</span>
                  ) : null}
                  <span>Duration {route.metrics.estimatedDurationSeconds.min}–{route.metrics.estimatedDurationSeconds.max}s</span>
                </div>
                <details className="stellar-v3-limitations">
                  <summary>Route details</summary>
                  <p>Protocols: {route.protocols.join(" · ")}</p>
                  <p>Risk checks: route {route.metrics.failureRisk} · protocol {route.metrics.protocolRisk}</p>
                  <p>Disclosure score: {route.metrics.disclosureCost}</p>
                  <ol>
                    {route.steps.map((step) => (
                      <li key={step.id} data-ready={step.executionReadiness === "ready" ? "true" : "false"}>
                        <span>{step.operation.replace(/_/gu, " ")}</span>
                        <small>{step.chain.key.replace(/_/gu, " ")} · {step.protocol}</small>
                        {step.unavailableReason ? <p>{step.unavailableReason}</p> : null}
                      </li>
                    ))}
                  </ol>
                </details>
                {route.id === "arc-arbitrum-direct-cctp" && !route.hydration ? (
                  <div className="stellar-v3-hydration-consent">
                    <AlertTriangle aria-hidden="true" />
                    <div>
                      <strong>Fresh amount needed</strong>
                      <p>
                        The amount is used for a live quote and is never sent to the AI. Signed execution remains public.
                      </p>
                      <button
                        type="button"
                        className="stellar-button"
                        disabled={hydratingRouteId !== null}
                        onClick={() => void hydrateRoute(route.id)}
                      >
                        {hydratingRouteId === route.id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                        {hydratingRouteId === route.id ? "Reading live quote" : "Get fresh quote"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {route.hydration && routeQuote?.routeId === route.id ? (
                  <div className="stellar-v3-live-quote" role="status">
                    <CheckCircle2 aria-hidden="true" />
                    <div>
                      <strong>Fresh route ready</strong>
                      <p>
                        Expected destination amount {formatUsdcAtomic(routeQuote.conservativeDestinationAmountAtomic)} USDC.
                      </p>
                      <p>{routeQuote.sourceApprovalRequired ? "Arc approval will be reviewed separately." : "No new Arc approval is needed."}</p>
                      <details className="stellar-v3-limitations">
                        <summary>Quote details</summary>
                        <p>Maximum CCTP fee {formatUsdcAtomic(routeQuote.maximumBridgeFeeAtomic)} USDC</p>
                        <p>Aave supply APY {(routeQuote.supplyApyBps / 100).toFixed(2)}%</p>
                      </details>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          {plan.coordinationMarket.required ? (
            <div className="stellar-v3-auction-state">
              <div>
                <ShieldCheck aria-hidden="true" />
                <div>
                  <strong>Find the best bonded offer</strong>
                  <p>Solvers compete on net output, fee, and timing. Your wallet opens the Testnet competition; solvers fund their own bids.</p>
                  {auctionTransactionHash ? <small>Competition is live. Kletia will update this card automatically.</small> : null}
                </div>
              </div>
              {canOpenAuction && !auctionTransactionHash ? (
                <button type="button" className="stellar-button" disabled={auctionBusy} onClick={() => void openSolverAuction()}>
                  {auctionBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Scale aria-hidden="true" />}
                  {auctionBusy ? "Opening competition" : "Start solver competition"}
                </button>
              ) : null}
              {!auctionTransactionHash && !canOpenAuction ? (
                <button type="button" className="stellar-button" disabled={syncing || plan.coordinationMarket.status === "deployment_required"} onClick={() => void syncWinner()}>
                  {syncing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {syncing ? "Checking offers" : "Check selected offer"}
                </button>
              ) : null}
              {!canOpenAuction && !auctionTransactionHash ? (
                <p className="stellar-v3-auction-blocker">
                  Get a fresh route quote first. Competition never starts from a placeholder amount or stale route.
                </p>
              ) : null}
              <details className="stellar-v3-limitations">
                <summary>Solver contract details</summary>
                <p>{plan.coordinationMarket.reasons.join(" ")}</p>
                <code>Vault {compactId(plan.coordinationMarket.contracts.bondVault)} · Auction {compactId(plan.coordinationMarket.contracts.routeAuction)}</code>
              </details>
            </div>
          ) : null}

          {solverDisclosure.length > 0 ? (
            <details className="stellar-v3-disclosure-list">
              <summary>What becomes public during competition</summary>
              {solverDisclosure.map((entry) => (
                <div key={`${entry.field}:${entry.reason}`}>
                  <span>{entry.field.replace(/_/gu, " ")}</span>
                  <p>{entry.reason}</p>
                  <small>New observers: {entry.newlyVisibleTo.join(", ")}{entry.userApprovalRequired ? " · approval required" : ""}</small>
                </div>
              ))}
            </details>
          ) : null}

          <details className="stellar-v3-limitations">
            <summary>Exact runtime boundaries</summary>
            {(result?.limitations ?? []).map((limitation) => <p key={limitation}>{limitation}</p>)}
          </details>
        </div>
      ) : null}
    </section>
  );
}
