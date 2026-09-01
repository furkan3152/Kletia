import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileSignature,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import {
  usePublicClient,
  useSendTransaction,
  useSignMessage,
  useSwitchChain,
} from "wagmi";

import {
  isWorkflowAdvanceV2Response,
  isWorkflowLifecycleErrorResponse,
  type WorkflowAdvanceV2Response,
  type WorkflowStepV2,
  type WorkflowV2Response,
} from "../v2/types";
import {
  buildArbitrumAaveApproval,
  buildArbitrumAaveSupply,
  buildArbitrumCctpMint,
  buildArcCctpApproval,
  buildArcCctpBurn,
  StellarTransactionIndeterminateError,
  type BrowserTransactionCall,
} from "../../networks/stellar/runtime/cctp";
import { BACKEND_URL } from "../../shared/config/runtime";
import {
  intentActionButtonClass,
  intentPrimaryButtonClass,
} from "../../shared/components/chat/intentActionStyles";
import {
  fetchWithCommitmentOpeningDisclosure,
  readEgressGuardReport,
} from "../../shared/privacy/egressGuard";

export interface BoundWorkflowV2Handoff {
  readonly executionKind: "workflow_plan_v2";
  readonly workflowPlan: WorkflowV2Response["workflowPlan"];
  readonly workflowToken: string;
  readonly parentPlanHash: `0x${string}`;
  readonly externalExecutionTruthProvenByStellar: false;
}

export interface BoundWorkflowPrivateMaterial {
  readonly amount: string;
  readonly recipient: string;
  readonly amountSalt: `0x${string}`;
  readonly recipientSalt: `0x${string}`;
}

type ManifestAuthorization = {
  readonly family: "evm";
  readonly signer: string;
  readonly signature: string;
};

type SubmittedEvidence = {
  readonly stepId: string;
  readonly transactionHash: string;
  readonly state: "submitted" | "confirmed" | "indeterminate" | "failed" | "recovery_required";
};

function messageFrom(value: unknown, fallback: string): string {
  return value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
    ? String((value as { message: string }).message)
    : fallback;
}

function wallClockMs(): number {
  return Date.now();
}

async function responseBody(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null) as unknown;
  if (response.ok) return body;
  throw Object.assign(new Error(messageFrom(body, "The reviewed executor rejected the request.")), {
    body,
  });
}

function wallet(plan: WorkflowV2Response, id: "arc_wallet" | "arbitrum_sepolia_wallet"): Address {
  const binding = plan.workflowPlan.walletBindings.find((candidate) => candidate.id === id);
  if (!binding || binding.family !== "evm") throw new Error(`The sealed ${id} binding is missing.`);
  return getAddress(binding.address);
}

function latestAmountAtomic(plan: WorkflowV2Response, beforeOrder: number): bigint {
  for (let index = beforeOrder - 2; index >= 0; index -= 1) {
    const amount = plan.workflowPlan.steps[index]?.result?.amountAtomic;
    if (typeof amount === "string" && /^\d+$/u.test(amount)) return BigInt(amount);
  }
  throw new Error("A verified upstream output amount is required before this checkpoint.");
}

function previousAttestation(plan: WorkflowV2Response, beforeOrder: number): {
  readonly message: Hex;
  readonly attestation: Hex;
} {
  const result = [...plan.workflowPlan.steps]
    .slice(0, beforeOrder - 1)
    .reverse()
    .find((step) => step.action === "cctp_attestation" && step.result?.message)
    ?.result;
  if (!result?.message || !result.attestation) {
    throw new Error("A verified Circle attestation is required before minting.");
  }
  return { message: result.message as Hex, attestation: result.attestation as Hex };
}

function cctpFeeBps(plan: WorkflowV2Response): number {
  const route = plan.workflowPlan.routeCandidates.find(
    (candidate) => candidate.kind === plan.workflowPlan.selectedRoute,
  );
  if (!route || route.liveEvidence.quoteExpiresAt <= Date.now()) {
    throw new Error("The sealed Circle fee quote expired. Rebind a fresh canonical workflow; no transaction was sent.");
  }
  const leg = route.liveEvidence.cctpLegs.find(
    (candidate) => candidate.sourceDomain === 26 && candidate.destinationDomain === 3,
  );
  if (!leg) throw new Error("The exact Arc to Arbitrum CCTP fee leg is missing.");
  return leg.standardFeeBps;
}

function currentStep(plan: WorkflowV2Response): WorkflowStepV2 | undefined {
  return plan.workflowPlan.steps[plan.workflowPlan.currentStepIndex];
}

const CHECKPOINT_LABELS: Readonly<Record<string, string>> = {
  cctp_approve: "Allow Circle to use Arc USDC",
  cctp_burn: "Send USDC from Arc",
  cctp_attestation: "Verify Circle confirmation",
  cctp_mint: "Receive USDC on Arbitrum Sepolia",
  aave_approve: "Allow Aave to use USDC",
  aave_supply: "Supply USDC to Aave",
  borrow_capacity: "Read safe borrow capacity",
};

function checkpointLabel(step: WorkflowStepV2): string {
  return CHECKPOINT_LABELS[step.action] || step.action.replace(/_/gu, " ");
}

function checkpointStatus(step: WorkflowStepV2): string {
  if (step.status === "indeterminate" && step.action === "cctp_attestation") {
    return "Rechecking automatically";
  }
  return ({
    planned: "Waiting",
    awaiting_signature: "Your approval",
    submitted: "Submitted",
    confirmed: "Verified",
    attesting: "Checking",
    filled: "Completed",
    ready: "Ready",
    failed: "Failed",
    refunded: "Refunded",
    indeterminate: "Unresolved",
    recovery_required: "Recovery required",
  } as Record<string, string>)[step.status] || step.status.replace(/_/gu, " ");
}

function checkpointNetwork(step: WorkflowStepV2): string {
  return ({
    arc_testnet: "Arc Testnet",
    stellar_testnet: "Stellar Testnet",
    arbitrum_sepolia: "Arbitrum Sepolia",
  } as Record<string, string>)[step.network] || step.network.replace(/_/gu, " ");
}

type CheckpointVisualState = "complete" | "active" | "blocked" | "waiting";

function checkpointVisualState(
  step: WorkflowStepV2,
  index: number,
  currentStepIndex: number,
): CheckpointVisualState {
  if (index < currentStepIndex || Boolean(step.result)) return "complete";
  if (["failed", "refunded", "recovery_required"].includes(step.status)) {
    return "blocked";
  }
  return index === currentStepIndex ? "active" : "waiting";
}

function isParentExpiryRecoveryStep(step: WorkflowStepV2 | undefined): boolean {
  return step?.action === "cctp_attestation" ||
    step?.action === "cctp_mint" ||
    step?.action === "borrow_capacity" ||
    step?.action === "stellar_receipt_finalize";
}

function preservesExecutionParent(
  previous: WorkflowV2Response["workflowPlan"],
  next: WorkflowV2Response["workflowPlan"],
  mode: "canonical_parent" | "standalone_reviewed_v2",
): boolean {
  const left = previous.parentWorkflowV3;
  const right = next.parentWorkflowV3;
  const preservesV3 = Boolean(
    left && right &&
    left.schemaVersion === right.schemaVersion &&
    left.workflowId === right.workflowId &&
    left.workflowRoot === right.workflowRoot &&
    left.planHashAtHandoff === right.planHashAtHandoff &&
    left.expiresAt === right.expiresAt &&
    left.controlPlaneTransactionHash === right.controlPlaneTransactionHash &&
    left.receiptRegistryTransactionHash === right.receiptRegistryTransactionHash &&
    left.externalExecutionTruthProvenByStellar === false &&
    right.externalExecutionTruthProvenByStellar === false,
  );
  const leftV4 = previous.parentWorkflowV4;
  const rightV4 = next.parentWorkflowV4;
  const preservesV4 = Boolean(
    leftV4 && rightV4 &&
    leftV4.schemaVersion === rightV4.schemaVersion &&
    leftV4.workflowId === rightV4.workflowId &&
    leftV4.workflowRoot === rightV4.workflowRoot &&
    leftV4.planHashAtHandoff === rightV4.planHashAtHandoff &&
    leftV4.expiresAt === rightV4.expiresAt &&
    leftV4.controlPlaneContractId === rightV4.controlPlaneContractId &&
    leftV4.controlPlaneTransactionHash === rightV4.controlPlaneTransactionHash &&
    leftV4.controlPlaneNonce === rightV4.controlPlaneNonce &&
    leftV4.policyProofPublicInputsHash === rightV4.policyProofPublicInputsHash &&
    leftV4.externalExecutionTruthProvenByStellar === false &&
    rightV4.externalExecutionTruthProvenByStellar === false,
  );
  if (mode === "standalone_reviewed_v2") {
    return !left && !right && !leftV4 && !rightV4;
  }
  return preservesV3 !== preservesV4 && (preservesV3 || preservesV4);
}

export function BoundWorkflowV2Executor({
  handoff,
  readMaterial,
  evmAddress,
  onProgress,
  mode = "canonical_parent",
}: {
  readonly handoff: BoundWorkflowV2Handoff;
  readonly readMaterial: () => BoundWorkflowPrivateMaterial | null;
  readonly evmAddress?: string;
  readonly onProgress: (workflowTokenV2: string) => Promise<void>;
  readonly mode?: "canonical_parent" | "standalone_reviewed_v2";
}) {
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const arcClient = usePublicClient({ chainId: 5_042_002 });
  const arbitrumClient = usePublicClient({ chainId: 421_614 });
  const [plan, setPlan] = React.useState<WorkflowV2Response>(() => ({
    success: true,
    status: "success",
    executionKind: "workflow_plan_v2",
    network: "stellar",
    chainRef: "stellar:testnet",
    requestId: handoff.workflowPlan.requestId,
    message: "Reviewed V2 financial executor bound to its canonical parent workflow.",
    workflowPlan: handoff.workflowPlan,
    workflowToken: handoff.workflowToken,
  }));
  const [manifestAuthorization, setManifestAuthorization] = React.useState<ManifestAuthorization | null>(null);
  const [openingApproved, setOpeningApproved] = React.useState(false);
  const [submission, setSubmission] = React.useState<SubmittedEvidence | null>(null);
  const [receipt, setReceipt] = React.useState<WorkflowAdvanceV2Response["executionReceipt"]>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const executeRef = React.useRef<() => Promise<void>>(async () => undefined);

  const expected = React.useMemo(() => ({
    requestId: plan.requestId,
    workflowId: plan.workflowPlan.workflowId,
    amountCommitment: plan.workflowPlan.privacy.amountCommitment,
    recipientCommitment: plan.workflowPlan.privacy.recipientCommitment,
    arcAddress: wallet(plan, "arc_wallet"),
    arbitrumSepoliaAddress: wallet(plan, "arbitrum_sepolia_wallet"),
  }), [plan]);

  const signManifest = async () => {
    setBusy(true);
    setError(null);
    try {
      if (
        plan.workflowPlan.expiresAt <= wallClockMs() &&
        !isParentExpiryRecoveryStep(currentStep(plan))
      ) {
        throw new Error("The parent-bound authorization window expired. Compile a fresh workflow.");
      }
      const active = evmAddress ? getAddress(evmAddress) : null;
      if (!active || active !== expected.arcAddress || active !== expected.arbitrumSepoliaAddress) {
        throw new Error("The active EVM wallet does not match both sealed execution wallets.");
      }
      const signature = await signMessageAsync({
        message: plan.workflowPlan.authorizationBoundary.manifestMessage,
      });
      setManifestAuthorization({ family: "evm", signer: active, signature });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manifest signing failed.");
    } finally {
      setBusy(false);
    }
  };

  const advance = async (transactionHash?: string, discloseOpenings = false) => {
    const step = currentStep(plan);
    if (!step) throw new Error("The executor has no current checkpoint.");
    if (!manifestAuthorization) throw new Error("Sign the exact V2 execution manifest first.");
    const material = discloseOpenings ? readMaterial() : null;
    if (discloseOpenings && !material) {
      throw new Error("The device-private commitment opening is no longer available. Compile a fresh workflow.");
    }
    const body = {
      workflowToken: plan.workflowToken,
      requestId: plan.requestId,
      ...(transactionHash ? { txHash: transactionHash } : {}),
      ...(discloseOpenings
        ? {
            amountCommitmentSalt: material!.amountSalt,
            recipientCommitmentSalt: material!.recipientSalt,
          }
        : {}),
      manifestAuthorization,
    };
    const request = discloseOpenings && transactionHash
      ? fetchWithCommitmentOpeningDisclosure({
          url: `${BACKEND_URL}/api/workflows/v2/advance`,
          workflowId: plan.workflowPlan.workflowId,
          stepId: step.id,
          requestId: plan.requestId,
          transactionHash,
          body,
          openings: [
            { binding: "amountCommitmentSalt", value: material!.amountSalt },
            { binding: "recipientCommitmentSalt", value: material!.recipientSalt },
          ],
          headers: { "Content-Type": "application/json" },
        })
      : fetch(`${BACKEND_URL}/api/workflows/v2/advance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    let value: unknown;
    try {
      value = await responseBody(await request);
    } catch (caught) {
      const bodyValue = (caught as { body?: unknown }).body;
      if (
        isWorkflowLifecycleErrorResponse(bodyValue, expected) &&
        preservesExecutionParent(plan.workflowPlan, bodyValue.workflowPlan, mode)
      ) {
        setPlan({
          ...plan,
          message: bodyValue.message,
          workflowPlan: bodyValue.workflowPlan,
          workflowToken: bodyValue.workflowToken,
        });
        await onProgress(bodyValue.workflowToken);
        if (transactionHash) {
          setSubmission({
            stepId: step.id,
            transactionHash,
            state: bodyValue.lifecycle.status,
          });
        }
        throw Object.assign(
          new Error(messageFrom(bodyValue, "The checkpoint entered a sealed recovery state.")),
          { workflowLifecycleHandled: true },
        );
      }
      throw caught;
    }
    if (
      !isWorkflowAdvanceV2Response(value, expected) ||
      !preservesExecutionParent(plan.workflowPlan, value.workflowPlan, mode)
    ) {
      throw new Error("The advanced executor state failed its sealed browser boundary.");
    }
    const authorizationPreserved =
      value.workflowPlan.authorizationBoundary.planCoreSha256 ===
        plan.workflowPlan.authorizationBoundary.planCoreSha256 &&
      Boolean(value.workflowPlan.manifestAuthorization);
    setPlan({
      ...plan,
      message: value.message,
      workflowPlan: value.workflowPlan,
      workflowToken: value.workflowToken,
    });
    await onProgress(value.workflowToken);
    if (!authorizationPreserved) setManifestAuthorization(null);
    if (value.executionReceipt) setReceipt(value.executionReceipt);
  };

  const sendEvmStep = async (
    step: WorkflowStepV2,
    call: BrowserTransactionCall,
    chainId: 5_042_002 | 421_614,
    expectedAccount: Address,
  ): Promise<string> => {
    await switchChainAsync({ chainId });
    if (!evmAddress || getAddress(evmAddress) !== expectedAccount) {
      throw new Error("The active wallet changed before transaction preparation.");
    }
    const client = chainId === 5_042_002 ? arcClient : arbitrumClient;
    if (!client) throw new Error("The selected Testnet RPC client is unavailable.");
    await client.estimateGas({ account: expectedAccount, to: call.target, data: call.calldata, value: call.value });
    const hash = await sendTransactionAsync({
      account: expectedAccount,
      to: call.target,
      data: call.calldata,
      value: call.value,
      chainId,
    });
    setSubmission({ stepId: step.id, transactionHash: hash, state: "submitted" });
    const transactionReceipt = await client.waitForTransactionReceipt({ hash }).catch(() => {
      setSubmission({ stepId: step.id, transactionHash: hash, state: "indeterminate" });
      throw new StellarTransactionIndeterminateError(hash);
    });
    if (transactionReceipt.status !== "success") {
      setSubmission({ stepId: step.id, transactionHash: hash, state: "failed" });
      throw new Error("The transaction reverted. Its hash was recorded and it was not resubmitted.");
    }
    setSubmission({ stepId: step.id, transactionHash: hash, state: "confirmed" });
    return hash;
  };

  const refreshAuthorization = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${BACKEND_URL}/api/workflows/v2/refresh-authorization`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowToken: plan.workflowToken,
          requestId: plan.requestId,
        }),
      });
      const value = await responseBody(response);
      if (
        !isWorkflowAdvanceV2Response(value, expected) ||
        value.terminal ||
        !preservesExecutionParent(plan.workflowPlan, value.workflowPlan, mode)
      ) {
        throw new Error("The refreshed execution authorization failed its sealed browser boundary.");
      }
      setPlan({
        ...plan,
        message: value.message,
        workflowPlan: value.workflowPlan,
        workflowToken: value.workflowToken,
      });
      await onProgress(value.workflowToken);
      setManifestAuthorization(null);
      setSubmission(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Execution quote refresh failed safely.");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    const step = currentStep(plan);
    if (!step || !manifestAuthorization) return;
    setBusy(true);
    setError(null);
    let submittedHash: string | null = null;
    try {
      if (submission && submission.stepId === step.id) {
        throw new Error("This checkpoint already has submission evidence. Recover its exact hash; do not resend it.");
      }
      const parentExpiresAt =
        plan.workflowPlan.parentWorkflowV3?.expiresAt ??
        plan.workflowPlan.parentWorkflowV4?.expiresAt ??
        (mode === "standalone_reviewed_v2"
          ? plan.workflowPlan.expiresAt
          : undefined);
      if (parentExpiresAt !== plan.workflowPlan.expiresAt) {
        throw new Error("The V2 authorization escaped its canonical parent expiry boundary.");
      }
      if (
        plan.workflowPlan.expiresAt <= wallClockMs() &&
        !isParentExpiryRecoveryStep(step)
      ) {
        throw new Error("The parent-bound execution window expired. Compile a fresh workflow.");
      }
      const activeRoute = plan.workflowPlan.routeCandidates.find(
        (candidate) => candidate.kind === plan.workflowPlan.selectedRoute,
      );
      if (
        step.action === "cctp_burn" &&
        (!activeRoute || activeRoute.liveEvidence.quoteExpiresAt <= wallClockMs())
      ) {
        await refreshAuthorization();
        return;
      }
      if (step.action === "cctp_attestation" || step.action === "borrow_capacity") {
        await advance();
        return;
      }
      const arcWallet = wallet(plan, "arc_wallet");
      const arbitrumWallet = wallet(plan, "arbitrum_sepolia_wallet");
      const material = readMaterial();
      if (!material) {
        throw new Error("The device-private execution values were cleared. Compile a fresh workflow.");
      }
      let call: BrowserTransactionCall;
      let chainId: 5_042_002 | 421_614;
      let account: Address;
      if (step.network === "arc_testnet") {
        chainId = 5_042_002;
        account = arcWallet;
        call = step.action === "cctp_approve"
          ? buildArcCctpApproval(material.amount)
          : buildArcCctpBurn({
              amount: material.amount,
              route: "direct_cctp",
              stellarRecipient: "",
              arbitrumRecipient: arbitrumWallet,
              standardFeeBps: cctpFeeBps(plan),
            });
      } else if (step.network === "arbitrum_sepolia") {
        chainId = 421_614;
        account = arbitrumWallet;
        const amountAtomic = latestAmountAtomic(plan, step.order);
        if (step.action === "cctp_mint") {
          const attestation = previousAttestation(plan, step.order);
          call = buildArbitrumCctpMint(attestation.message, attestation.attestation);
        } else if (step.action === "aave_approve") {
          call = buildArbitrumAaveApproval(amountAtomic);
        } else if (step.action === "aave_supply") {
          call = buildArbitrumAaveSupply(amountAtomic, arbitrumWallet);
        } else {
          throw new Error("The current Arbitrum checkpoint has no reviewed executor.");
        }
      } else {
        throw new Error("The bound direct executor cannot sign a Stellar financial step.");
      }
      if (step.target && getAddress(step.target) !== getAddress(call.target)) {
        throw new Error("The locally hydrated call target changed from the sealed executor step.");
      }
      const hash = await sendEvmStep(step, call, chainId, account);
      submittedHash = hash;
      await advance(hash, step.id === "step-1" && step.action === "cctp_approve");
      setSubmission(null);
      if (step.id === "step-1") setOpeningApproved(false);
    } catch (caught) {
      const expectedCircleWait =
        step.action === "cctp_attestation" &&
        (caught as { workflowLifecycleHandled?: unknown }).workflowLifecycleHandled === true;
      if (expectedCircleWait) {
        // Pending attestation is an expected observation state. `advance`
        // already preserved the same burn hash in the sealed plan, and the
        // observer will poll it again without sending another transaction.
        setError(null);
      } else if (caught instanceof StellarTransactionIndeterminateError) {
        setSubmission({
          stepId: step.id,
          transactionHash: caught.transactionHash,
          state: "indeterminate",
        });
      } else if (
        submittedHash &&
        (caught as { workflowLifecycleHandled?: unknown }).workflowLifecycleHandled !== true
      ) {
        setSubmission({
          stepId: step.id,
          transactionHash: submittedHash,
          state: "indeterminate",
        });
      }
      if (!expectedCircleWait) {
        setError(caught instanceof Error ? caught.message : "The financial checkpoint stopped safely.");
      }
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    executeRef.current = execute;
  });

  const recover = async () => {
    const step = currentStep(plan);
    if (!step || !submission || submission.stepId !== step.id) return;
    setBusy(true);
    setError(null);
    try {
      const openingAlreadyDisclosed = readEgressGuardReport().approvedDisclosures.some(
        (entry) =>
          entry.kind === "public_checkpoint_commitment_opening" &&
          entry.workflowId === plan.workflowPlan.workflowId &&
          entry.stepId === step.id &&
          entry.requestId === plan.requestId &&
          entry.transactionHash.toLowerCase() === submission.transactionHash.toLowerCase(),
      );
      await advance(
        submission.transactionHash,
        step.id === "step-1" &&
          step.action === "cctp_approve" &&
          !openingAlreadyDisclosed,
      );
      setSubmission(null);
    } catch (caught) {
      setError(`Status is still unresolved; nothing was resent. ${caught instanceof Error ? caught.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  };

  const step = currentStep(plan);
  const completedCheckpointCount = plan.workflowPlan.steps.filter(
    (candidate, index) =>
      checkpointVisualState(
        candidate,
        index,
        plan.workflowPlan.currentStepIndex,
      ) === "complete",
  ).length;
  const workflowHasStarted = completedCheckpointCount > 0;
  const workflowComplete = Boolean(receipt) || !step;
  const firstOpeningRequired = step?.id === "step-1" && step.action === "cctp_approve";
  const canExecute = Boolean(
    step &&
    manifestAuthorization &&
    (!firstOpeningRequired || openingApproved) &&
    !submission &&
    !receipt,
  );

  React.useEffect(() => {
    const shouldObserveCircle = Boolean(
      step?.action === "cctp_attestation" &&
      (step.status === "attesting" || step.status === "indeterminate") &&
      manifestAuthorization &&
      !receipt &&
      !busy,
    );
    if (!shouldObserveCircle) return undefined;
    const timer = window.setTimeout(() => {
      void executeRef.current();
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [busy, manifestAuthorization, receipt, step?.action, step?.id, step?.status]);

  return (
    <section className="stellar-v3-executor" aria-labelledby="stellar-v3-executor-title">
      <header className="stellar-v3-executor-header">
        <div>
          <p className="stellar-eyebrow">
            {workflowComplete
              ? "Transfer complete"
              : workflowHasStarted
                ? "Continuing existing transfer"
                : mode === "standalone_reviewed_v2"
                  ? "New transfer ready"
                  : "Policy-bound transfer ready"}
          </p>
          <h3 id="stellar-v3-executor-title">
            {workflowComplete
              ? "All checkpoints verified"
              : step
                ? `Step ${plan.workflowPlan.currentStepIndex + 1} of ${plan.workflowPlan.steps.length} · ${checkpointLabel(step)}`
                : "Execution progress"}
          </h3>
        </div>
        <span className="stellar-v3-progress-count">
          {completedCheckpointCount}/{plan.workflowPlan.steps.length}
        </span>
      </header>

      <progress
        className="stellar-v3-progress-bar"
        max={plan.workflowPlan.steps.length}
        value={workflowComplete ? plan.workflowPlan.steps.length : completedCheckpointCount}
        aria-label={`${completedCheckpointCount} of ${plan.workflowPlan.steps.length} checkpoints verified`}
      />

      <div
        className="stellar-v3-current-step"
        data-state={workflowComplete ? "complete" : step?.action === "cctp_attestation" ? "observing" : "action"}
      >
        <strong>
          {!manifestAuthorization
            ? "Review the plan"
            : firstOpeningRequired && !openingApproved
              ? "Confirm public execution"
              : workflowComplete
                ? "Done"
                : step?.action === "cctp_attestation"
                  ? "Waiting for Circle — no new transaction"
                  : workflowHasStarted
                    ? "Continue with the next checkpoint"
                    : "Start the first checkpoint"}
        </strong>
        <p>
          {!manifestAuthorization
            ? "Authorizing this plan does not move funds. Wallet approval is requested separately for each money-moving step."
            : firstOpeningRequired && !openingApproved
              ? "Confirm the exact public amount before Kletia prepares the first Arc wallet action."
              : workflowComplete
                ? "The submitted checkpoints and final receipt were verified."
                : step?.action === "cctp_attestation"
                  ? "The Arc burn is already verified. Kletia is checking that same hash and will open Arbitrum mint only after Circle confirms it."
                  : step
                    ? `${workflowHasStarted ? "Previous checkpoints are verified. " : "This is a new transfer. "}The next wallet review opens on ${checkpointNetwork(step)}.`
                : "Workflow complete"}
        </p>
      </div>

      <ol className="stellar-v3-executor-timeline">
        {plan.workflowPlan.steps.map((candidate, index) => {
          const visualState = checkpointVisualState(
            candidate,
            index,
            plan.workflowPlan.currentStepIndex,
          );
          const Icon = visualState === "complete"
            ? CheckCircle2
            : visualState === "blocked"
              ? ShieldAlert
              : visualState === "active" && candidate.action === "cctp_attestation"
                ? RefreshCw
                : visualState === "active"
                  ? Play
                  : CircleDashed;
          return (
            <li
              key={candidate.id}
              data-current={index === plan.workflowPlan.currentStepIndex ? "true" : "false"}
              data-state={visualState}
            >
              <Icon
                className={visualState === "active" && busy ? "animate-spin" : ""}
                aria-hidden="true"
              />
              <div className="stellar-v3-step-copy">
                <strong>{index + 1}. {checkpointLabel(candidate)}</strong>
                <small>{checkpointNetwork(candidate)}</small>
              </div>
              <span className="stellar-v3-step-status">{checkpointStatus(candidate)}</span>
            </li>
          );
        })}
      </ol>

      {!manifestAuthorization ? (
        <button type="button" className={intentPrimaryButtonClass} disabled={busy} onClick={() => void signManifest()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileSignature aria-hidden="true" />}
          Authorize staged execution
        </button>
      ) : null}

      {firstOpeningRequired && manifestAuthorization && !openingApproved ? (
        <div className="stellar-v3-hydration-consent">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Confirm the public amount once</strong>
            <p>
              CCTP is public. Kletia needs the exact amount to prepare and verify this route; the semantic AI never receives it.
            </p>
            <button type="button" className={intentPrimaryButtonClass} onClick={() => setOpeningApproved(true)}>
              Continue to wallet approval
            </button>
          </div>
        </div>
      ) : null}

      {step &&
      step.action !== "cctp_attestation" &&
      manifestAuthorization &&
      (!firstOpeningRequired || openingApproved) &&
      !receipt ? (
        <button type="button" className={intentPrimaryButtonClass} disabled={busy || !canExecute} onClick={() => void execute()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
          {busy ? "Verifying checkpoint" : step.action === "borrow_capacity"
            ? checkpointLabel(step)
            : `${workflowHasStarted ? "Continue in wallet" : "Start in wallet"} · ${checkpointLabel(step)}`}
        </button>
      ) : null}

      {step?.action === "cctp_attestation" && manifestAuthorization && !receipt ? (
        <div className="stellar-v3-observer" role="status" aria-busy={busy}>
          <RefreshCw className={busy ? "animate-spin" : ""} aria-hidden="true" />
          <div>
            <strong>{busy ? "Checking Circle now" : "Circle check runs automatically"}</strong>
            <p>The existing Arc burn is checked every 10 seconds. No wallet opens and no USDC is sent again.</p>
          </div>
          <button
            type="button"
            className={intentActionButtonClass}
            disabled={busy}
            onClick={() => void execute()}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {busy ? "Checking" : "Check now"}
          </button>
        </div>
      ) : null}

      {submission?.state === "indeterminate" ? (
        <button type="button" className={intentActionButtonClass} disabled={busy} onClick={() => void recover()}>
          <RefreshCw className={busy ? "animate-spin" : ""} aria-hidden="true" />
          Recover exact hash — never resend
        </button>
      ) : null}
      {submission?.state === "recovery_required" ? (
        <div className="stellar-v3-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <p>This checkpoint requires explicit recovery evidence; the same sealed action cannot be advanced or resent.</p>
        </div>
      ) : null}

      {error ? <div className="stellar-v3-error" role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p></div> : null}
      {receipt ? (
        <div className="stellar-v3-live-quote" role="status">
          <CheckCircle2 aria-hidden="true" />
          <div>
            <strong>Execution receipt verified</strong>
            <p>{receipt.checkpoints.length} checkpoints · receipt {receipt.receiptSha256.slice(0, 12)}…{receipt.receiptSha256.slice(-8)}</p>
            <small>Application receipt plus underlying chain evidence; not a global atomicity or Stellar oracle claim.</small>
          </div>
        </div>
      ) : null}
      {step?.result?.safeBorrowCapacityAtomic ? (
        <p>
          Conservative read-only borrow capacity: {formatUnits(BigInt(step.result.safeBorrowCapacityAtomic), 6)} USDC.
        </p>
      ) : null}
    </section>
  );
}
