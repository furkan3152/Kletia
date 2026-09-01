import React from "react";
import { AlertTriangle, CheckCircle2, FileKey2, Loader2, LockKeyhole, Route, ShieldCheck } from "lucide-react";
import { getAddress } from "viem";
import { getNetworkDetails, signTransaction } from "@stellar/freighter-api";
import { Networks, StrKey } from "@stellar/stellar-sdk";

import { BACKEND_URL } from "../../shared/config/runtime";
import {
  commitPrivateField,
  createPrivateSalt,
  normalizePrivateAmount,
  privateSaltToHex,
} from "../../networks/stellar/runtime/privateIntent";
import { fetchWithCanonicalRouteHydrationDisclosure } from "../../shared/privacy/egressGuard";
import { isWorkflowV2Response } from "../v2/types";
import {
  BoundWorkflowV2Executor,
  type BoundWorkflowV2Handoff,
} from "../v3/BoundWorkflowV2Executor";
import { readStellarTestnetLatestLedger } from "../v3/policyProof";
import type { ResolvedIntentReceiptForV3 } from "../v3/CompetitiveWorkflowPanel";
import {
  createUnsignedPolicyProfileV4,
  selectLocalPolicyWitnessV4,
  signPolicyProfileV4,
} from "./policyProfile";
import { generateDevicePolicyProofV4 } from "./policyProof";
import { prepareIntentControlPlaneV2Commit } from "./controlPlaneV2";
import {
  StellarTransactionIndeterminateError,
  submitSignedStellarTransaction,
} from "../../networks/stellar/runtime/cctp";
import type {
  DevicePolicyProofEnvelopeV4,
  LocalPolicyWitnessV4,
  PolicyChallengeV4,
  PolicyOptionsV4,
  PolicyProfileV4,
  WorkflowPlanV4View,
} from "./types";

type CanonicalResultV4 = {
  readonly workflowPlan: WorkflowPlanV4View;
  readonly workflowToken: string;
};

type CanonicalRouteQuoteV4 = {
  readonly routeId: string;
  readonly amountAtomic: string;
  readonly maximumBridgeFeeAtomic: string;
  readonly conservativeDestinationAmountAtomic: string;
  readonly sourceApprovalRequired: boolean;
  readonly supplyApyBps: number;
  readonly quoteExpiresAt: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  if (!record(body)) throw new Error("The canonical workflow response was not structured JSON.");
  if (!response.ok || body.success !== true) {
    throw new Error(typeof body.message === "string" ? body.message : "The canonical workflow request was rejected.");
  }
  return body;
}

function usdcAtomic(value: string): string {
  const normalized = value.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) throw new Error("Enter a positive USDC amount.");
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > 6) throw new Error("EVM USDC supports at most six decimals.");
  const atomic = BigInt(`${whole || "0"}${fraction.padEnd(6, "0")}`);
  if (atomic <= 0n) throw new Error("The protected USDC amount must be greater than zero.");
  return atomic.toString();
}

function formatUsdcAtomic(value: string): string {
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

function intentBody(input: {
  readonly receipt: ResolvedIntentReceiptForV3;
  readonly evmAddress: string;
  readonly stellarAddress: string;
  readonly amountCommitment: `0x${string}`;
  readonly recipientCommitment: `0x${string}`;
  readonly policyProfile?: PolicyProfileV4;
}) {
  const preferredRouteId = input.receipt.selectedRoute === "direct_cctp"
    ? "arc-arbitrum-direct-cctp"
    : "arc-stellar-arbitrum-cctp";
  return {
    requestId: input.receipt.requestId,
    sourceIntentReceipt: {
      schemaVersion: "kletia_source_intent_receipt_v1",
      engine: "workflow_v2",
      scenarioId: input.receipt.scenarioId,
      workflowId: input.receipt.workflowId,
      requestId: input.receipt.requestId,
      planCoreSha256: input.receipt.planCoreSha256,
      selectedRoute: input.receipt.selectedRoute,
    },
    preferredRouteId,
    semanticGoal: "Move my private://workflow_amount USDC budget through the reviewed Testnet corridor, supply the verified output to Aave, and calculate conservative borrow capacity without borrowing.",
    lane: "testnet",
    coordinationMode: "direct",
    minimumEvidenceLevel: "protocol_verified",
    legs: [
      { operation: "bridge", chain: "arc_testnet", protocol: "circle-cctp-v2", assetIn: "USDC", assetOut: "USDC" },
      { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" },
      { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3-arbitrum-sepolia", assetIn: "USDC" },
    ],
    walletBindings: {
      arc_testnet: input.evmAddress,
      stellar_testnet: input.stellarAddress,
      arbitrum_sepolia: input.evmAddress,
    },
    privateBindings: [
      {
        field: "amount",
        reference: "private://workflow_amount",
        commitment: input.amountCommitment,
        disclosureLevel: "public_execution",
      },
      {
        field: "recipient",
        reference: "private://workflow_recipient",
        commitment: input.recipientCommitment,
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
    ...(input.policyProfile ? { policyProfile: input.policyProfile } : {}),
  };
}

export function CanonicalWorkflowV4Panel({
  stellarAddress,
  evmAddress,
  resolvedIntentReceipt,
}: {
  readonly stellarAddress: string;
  readonly evmAddress?: string;
  readonly resolvedIntentReceipt: ResolvedIntentReceiptForV3 | null;
}) {
  const [busyStage, setBusyStage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [options, setOptions] = React.useState<PolicyOptionsV4 | null>(null);
  const [profile, setProfile] = React.useState<PolicyProfileV4 | null>(null);
  const [result, setResult] = React.useState<CanonicalResultV4 | null>(null);
  const witnessRef = React.useRef<LocalPolicyWitnessV4 | null>(null);
  const policyProofRef = React.useRef<DevicePolicyProofEnvelopeV4 | null>(null);
  const [indeterminateCommitHash, setIndeterminateCommitHash] = React.useState<string | null>(null);
  const [routeQuote, setRouteQuote] = React.useState<CanonicalRouteQuoteV4 | null>(null);
  const [executionHandoff, setExecutionHandoff] = React.useState<BoundWorkflowV2Handoff | null>(null);
  const privateInputRef = React.useRef<{
    readonly amount: string;
    readonly amountAtomic: string;
    readonly amountSalt: `0x${string}`;
    readonly amountCommitment: `0x${string}`;
    readonly recipient: string;
    readonly recipientSalt: `0x${string}`;
    readonly recipientCommitment: `0x${string}`;
  } | null>(null);

  React.useEffect(() => () => {
    witnessRef.current = null;
    privateInputRef.current = null;
    policyProofRef.current = null;
  }, []);

  const prepareAndSign = async () => {
    setBusyStage("Preparing permissions");
    setError(null);
    setOptions(null);
    setProfile(null);
    setResult(null);
    setRouteQuote(null);
    setExecutionHandoff(null);
    witnessRef.current = null;
    privateInputRef.current = null;
    policyProofRef.current = null;
    setIndeterminateCommitHash(null);
    try {
      if (!resolvedIntentReceipt) throw new Error("First resolve and approve the user-facing intent receipt.");
      if (!evmAddress) throw new Error("Connect the EVM wallet used on Arc and Arbitrum Sepolia.");
      if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
        throw new Error("Connect a Stellar Testnet Freighter account for the control plane.");
      }
      const canonicalEvmAddress = getAddress(evmAddress);
      const normalizedAmount = normalizePrivateAmount(resolvedIntentReceipt.protectedAmount);
      const amountAtomic = usdcAtomic(normalizedAmount);
      const amountSalt = createPrivateSalt();
      const recipientSalt = createPrivateSalt();
      const [amountCommitment, recipientCommitment] = await Promise.all([
        commitPrivateField("amount", normalizedAmount, amountSalt),
        commitPrivateField("recipient", canonicalEvmAddress, recipientSalt),
      ]);
      const base = intentBody({
        receipt: resolvedIntentReceipt,
        evmAddress: canonicalEvmAddress,
        stellarAddress,
        amountCommitment,
        recipientCommitment,
      });
      const optionsResponse = await fetch(`${BACKEND_URL}/api/intents/v4/policy-options`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(base),
      });
      const optionsBody = await responseBody(optionsResponse);
      if (!record(optionsBody.policyOptions) || optionsBody.policyOptions.schemaVersion !== "kletia_policy_options_v1") {
        throw new Error("The pre-route policy options failed the browser schema boundary.");
      }
      const nextOptions = optionsBody.policyOptions as unknown as PolicyOptionsV4;
      setBusyStage("Reading Stellar ledger");
      const latestLedger = await readStellarTestnetLatestLedger();
      const unsigned = createUnsignedPolicyProfileV4({
        options: nextOptions,
        stellarAddress,
        minimumAmountAtomic: "1",
        maximumAmountAtomic: amountAtomic,
        executionExpiresAtLedger: latestLedger + 720,
        risk: { tolerance: "conservative", minimumHealthFactor: "1.6", maximumSlippageBps: 100 },
      });
      setBusyStage("Waiting for Freighter policy signature");
      const signedProfile = await signPolicyProfileV4(unsigned.core, stellarAddress);
      const compileResponse = await fetch(`${BACKEND_URL}/api/intents/v4/compile`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, policyProfile: signedProfile }),
      });
      const compileBody = await responseBody(compileResponse);
      if (
        !record(compileBody.workflowPlan) || compileBody.workflowPlan.schemaVersion !== "kletia_workflow_plan_v4" ||
        typeof compileBody.workflowToken !== "string"
      ) {
        throw new Error("The canonical V4 workflow failed the browser schema boundary.");
      }
      witnessRef.current = unsigned.localWitness;
      privateInputRef.current = {
        amount: normalizedAmount,
        amountAtomic,
        amountSalt: privateSaltToHex(amountSalt),
        amountCommitment,
        recipient: canonicalEvmAddress,
        recipientSalt: privateSaltToHex(recipientSalt),
        recipientCommitment,
      };
      setOptions(nextOptions);
      setProfile(signedProfile);
      setResult({
        workflowPlan: compileBody.workflowPlan as unknown as WorkflowPlanV4View,
        workflowToken: compileBody.workflowToken,
      });
    } catch (caught) {
      witnessRef.current = null;
      privateInputRef.current = null;
      setError(caught instanceof Error ? caught.message : "Policy preparation failed.");
    } finally {
      setBusyStage(null);
    }
  };

  const proveAndBind = async () => {
    if (!result || !options || !profile || !witnessRef.current || !privateInputRef.current) return;
    setBusyStage("Loading Policy V2 challenge");
    setError(null);
    try {
      if (!result.workflowPlan.controlPlane.ready) {
        throw new Error(result.workflowPlan.controlPlane.reason || "The exact Stellar V2 control plane is unavailable.");
      }
      const challengeResponse = await fetch(
        `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/policy-challenge`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${result.workflowToken}` } },
      );
      const challengeBody = await responseBody(challengeResponse);
      if (challengeBody.schemaVersion !== "kletia_policy_challenge_v2") {
        throw new Error("The Policy V2 challenge failed the browser schema boundary.");
      }
      const challenge = challengeBody as unknown as PolicyChallengeV4;
      const route = options.routes.find((candidate) => candidate.id === challenge.routeId);
      const recipientMaterial = options.recipientMaterials[0];
      if (!route || !recipientMaterial) throw new Error("The selected route is outside the locally signed policy options.");
      const selectedWitness = selectLocalPolicyWitnessV4({
        witness: witnessRef.current,
        protocolSet: route.protocolSet,
        assetSet: route.assetSet,
        recipientMaterial,
      });
      const proof = await generateDevicePolicyProofV4({
        challenge,
        amountAtomic: privateInputRef.current.amountAtomic,
        witness: selectedWitness,
      }, setBusyStage);
      setBusyStage("Verifying proof against the Stellar Policy V2 runtime");
      const bindResponse = await fetch(
        `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/policy-proof`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${result.workflowToken}`,
          },
          body: JSON.stringify({ policyProof: proof }),
        },
      );
      const bindBody = await responseBody(bindResponse);
      if (!record(bindBody.workflowPlan) || typeof bindBody.workflowToken !== "string") {
        throw new Error("The proof-bound workflow failed the browser schema boundary.");
      }
      setResult({
        workflowPlan: bindBody.workflowPlan as unknown as WorkflowPlanV4View,
        workflowToken: bindBody.workflowToken,
      });
      policyProofRef.current = proof;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Policy V2 proof binding failed.");
    } finally {
      setBusyStage(null);
    }
  };

  const advanceControlPlane = async (transactionHash: string) => {
    if (!result) return;
    const response = await fetch(
      `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/control-plane/advance`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${result.workflowToken}`,
        },
        body: JSON.stringify({ transactionHash }),
      },
    );
    const body = await responseBody(response);
    if (!record(body.workflowPlan) || typeof body.workflowToken !== "string") {
      throw new Error("The V2 commitment evidence failed the browser schema boundary.");
    }
    setResult({
      workflowPlan: body.workflowPlan as unknown as WorkflowPlanV4View,
      workflowToken: body.workflowToken,
    });
    setIndeterminateCommitHash(null);
    policyProofRef.current = null;
  };

  const signControlPlaneCommit = async () => {
    if (!result || !policyProofRef.current) return;
    setBusyStage("Preparing the exact Stellar V2 commitment");
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing the V2 commitment.");
      }
      const prepared = await prepareIntentControlPlaneV2Commit({
        plan: result.workflowPlan,
        proof: policyProofRef.current,
      });
      const signed = await signTransaction(prepared.xdr, {
        networkPassphrase: Networks.TESTNET,
        address: prepared.owner,
      });
      if (signed.error || !signed.signedTxXdr || signed.signerAddress !== prepared.owner) {
        throw new Error(signed.error?.message || "Freighter rejected the exact V2 commitment.");
      }
      setBusyStage("Submitting the owner-authorized Stellar commitment");
      const transactionHash = await submitSignedStellarTransaction(signed.signedTxXdr, prepared.xdr);
      setBusyStage("Verifying invocation, event and persisted V2 record");
      await advanceControlPlane(transactionHash);
    } catch (caught) {
      if (caught instanceof StellarTransactionIndeterminateError) {
        setIndeterminateCommitHash(caught.transactionHash);
        setError("The Stellar result is indeterminate. Recover this exact hash; Kletia will not resubmit it.");
      } else {
        setError(caught instanceof Error ? caught.message : "The V2 commitment failed.");
      }
    } finally {
      setBusyStage(null);
    }
  };

  const recoverControlPlaneCommit = async () => {
    if (!indeterminateCommitHash) return;
    setBusyStage("Recovering the exact Stellar commitment hash");
    setError(null);
    try {
      await advanceControlPlane(indeterminateCommitHash);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "V2 commitment recovery failed.");
    } finally {
      setBusyStage(null);
    }
  };

  const hydrateLiveRoute = async () => {
    if (!result || !privateInputRef.current || result.workflowPlan.selectedRouteId !== "arc-arbitrum-direct-cctp") {
      return;
    }
    setBusyStage("Opening the approved amount for live public quote evidence");
    setError(null);
    try {
      const opening = privateInputRef.current;
      const response = await fetchWithCanonicalRouteHydrationDisclosure({
        url: `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/hydrate`,
        workflowId: result.workflowPlan.workflowId,
        routeId: result.workflowPlan.selectedRouteId,
        requestId: result.workflowPlan.requestId,
        body: {
          amount: opening.amount,
          amountSalt: opening.amountSalt,
          acknowledgePublicExecution: true,
        },
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${result.workflowToken}`,
        },
      });
      const body = await responseBody(response);
      if (!record(body.workflowPlan) || typeof body.workflowToken !== "string" || !record(body.routeQuote)) {
        throw new Error("The canonical live quote failed the browser schema boundary.");
      }
      const quote = body.routeQuote as unknown as CanonicalRouteQuoteV4;
      if (
        quote.routeId !== result.workflowPlan.selectedRouteId ||
        typeof quote.amountAtomic !== "string" ||
        typeof quote.maximumBridgeFeeAtomic !== "string" ||
        typeof quote.conservativeDestinationAmountAtomic !== "string" ||
        typeof quote.sourceApprovalRequired !== "boolean" ||
        typeof quote.supplyApyBps !== "number" ||
        typeof quote.quoteExpiresAt !== "number"
      ) {
        throw new Error("The amount-bound route quote was malformed.");
      }
      setRouteQuote(quote);
      setResult({
        workflowPlan: body.workflowPlan as unknown as WorkflowPlanV4View,
        workflowToken: body.workflowToken,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Canonical live route hydration failed.");
    } finally {
      setBusyStage(null);
    }
  };

  const bindFinancialExecutor = async () => {
    if (!result || !routeQuote || !privateInputRef.current) return;
    setBusyStage("Binding the reviewed financial executor");
    setError(null);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/executor`,
        { method: "POST", headers: { Accept: "application/json", Authorization: `Bearer ${result.workflowToken}` } },
      );
      const body = await responseBody(response);
      if (!record(body.workflowPlan) || typeof body.workflowToken !== "string" || !record(body.executorHandoff)) {
        throw new Error("The canonical executor handoff failed the browser schema boundary.");
      }
      const nextPlan = body.workflowPlan as unknown as WorkflowPlanV4View;
      const handoff = body.executorHandoff as unknown as BoundWorkflowV2Handoff;
      const parent = handoff.workflowPlan.parentWorkflowV4;
      const opening = privateInputRef.current;
      const executionEnvelope = {
        success: true as const,
        status: "success" as const,
        executionKind: "workflow_plan_v2" as const,
        network: "stellar" as const,
        chainRef: "stellar:testnet" as const,
        requestId: handoff.workflowPlan.requestId,
        message: "Reviewed V4 execution handoff.",
        workflowPlan: handoff.workflowPlan,
        workflowToken: handoff.workflowToken,
      };
      if (
        handoff.executionKind !== "workflow_plan_v2" ||
        !handoff.workflowToken.startsWith("v2.") ||
        nextPlan.executionHandoff.status !== "bound" ||
        nextPlan.executionHandoff.executorWorkflowId !== handoff.workflowPlan.workflowId ||
        nextPlan.executionHandoff.parentPlanHashAtHandoff !== handoff.parentPlanHash ||
        parent?.workflowId !== result.workflowPlan.workflowId ||
        parent.controlPlaneContractId !== result.workflowPlan.controlPlane.contractId ||
        parent.controlPlaneTransactionHash !== result.workflowPlan.controlPlane.commitment.transactionHash ||
        parent.controlPlaneNonce !== result.workflowPlan.controlPlane.commitment.nonce ||
        parent.policyProofPublicInputsHash !== result.workflowPlan.policy.proofBinding.publicInputsHash ||
        !isWorkflowV2Response(executionEnvelope, {
          requestId: handoff.workflowPlan.requestId,
          amountCommitment: opening.amountCommitment,
          recipientCommitment: opening.recipientCommitment,
          arcAddress: opening.recipient,
          arbitrumSepoliaAddress: opening.recipient,
          parentWorkflowV4: {
            workflowId: result.workflowPlan.workflowId,
            workflowRoot: parent.workflowRoot,
            planHashAtHandoff: handoff.parentPlanHash,
            expiresAt: parent.expiresAt,
            controlPlaneContractId: parent.controlPlaneContractId,
            controlPlaneTransactionHash: parent.controlPlaneTransactionHash,
            controlPlaneNonce: parent.controlPlaneNonce,
            policyProofPublicInputsHash: parent.policyProofPublicInputsHash,
          },
        }) ||
        handoff.externalExecutionTruthProvenByStellar !== false
      ) {
        throw new Error("The financial executor did not preserve the sealed V4 parent binding.");
      }
      setResult({ workflowPlan: nextPlan, workflowToken: body.workflowToken });
      setExecutionHandoff(handoff);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Canonical financial executor binding failed.");
    } finally {
      setBusyStage(null);
    }
  };

  const syncFinancialExecutor = async (workflowTokenV2: string) => {
    if (!result) throw new Error("The canonical parent workflow is unavailable.");
    const previous = result.workflowPlan.executionHandoff;
    const response = await fetch(
      `${BACKEND_URL}/api/intents/v4/${encodeURIComponent(result.workflowPlan.workflowId)}/executor/sync`,
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
    const body = await responseBody(response);
    if (!record(body.workflowPlan) || typeof body.workflowToken !== "string") {
      throw new Error("The canonical executor sync failed the browser schema boundary.");
    }
    const next = body.workflowPlan as unknown as WorkflowPlanV4View;
    if (
      next.executionHandoff.executorWorkflowId !== previous.executorWorkflowId ||
      next.executionHandoff.parentPlanHashAtHandoff !== previous.parentPlanHashAtHandoff ||
      next.executionHandoff.confirmedCheckpointCount < previous.confirmedCheckpointCount ||
      JSON.stringify(next).includes(workflowTokenV2)
    ) {
      throw new Error("The synchronized progress changed an immutable executor binding.");
    }
    setResult({ workflowPlan: next, workflowToken: body.workflowToken });
  };

  const plan = result?.workflowPlan ?? null;
  return (
    <section className="stellar-panel stellar-v4-panel" aria-labelledby="stellar-v4-title">
      <div className="stellar-panel-header">
        <div>
          <p className="stellar-eyebrow">Canonical financial boundary</p>
          <h2 id="stellar-v4-title">Policy V2 workflow</h2>
        </div>
        <ShieldCheck aria-hidden="true" />
      </div>

      <p className="stellar-v4-intro">
        The Stellar policy is signed before Kletia selects a route. It binds the spend cap,
        route classes, assets, recipient policy, lane, privacy budget and expiry; every later
        financial call still needs its own wallet signature.
      </p>

      <div className="stellar-v4-state-grid">
        <article>
          <FileKey2 aria-hidden="true" />
          <strong>Pre-route policy</strong>
          <span>{profile ? "Signed in Freighter" : "Not signed"}</span>
        </article>
        <article>
          <Route aria-hidden="true" />
          <strong>Canonical route</strong>
          <span>{plan?.selectedRouteId ?? "Not selected"}</span>
        </article>
        <article>
          <LockKeyhole aria-hidden="true" />
          <strong>Policy proof</strong>
          <span>{plan?.policy.proofBinding.status ?? "Not generated"}</span>
        </article>
        <article>
          <ShieldCheck aria-hidden="true" />
          <strong>Stellar commitment</strong>
          <span>{plan?.controlPlane.commitment.status ?? "Not prepared"}</span>
        </article>
      </div>

      {options ? (
        <div className="stellar-v4-routes" aria-label="Policy-authorized route classes">
          {options.routes.map((route) => (
            <article key={route.id} data-selected={plan?.selectedRouteId === route.id ? "true" : "false"}>
              <div>
                <strong>{route.label}</strong>
                <span>{route.protocolSet.join(" + ")}</span>
              </div>
              <span>{route.available ? "Planning ready" : "Capability gated"}</span>
            </article>
          ))}
        </div>
      ) : null}

      {plan ? (
        <div className="stellar-v4-gate" data-ready={plan.controlPlane.ready ? "true" : "false"}>
          {plan.controlPlane.ready ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
          <div>
            <strong>{plan.controlPlane.ready ? "Stellar V2 runtime attested" : "Financial execution remains closed"}</strong>
            <p>{plan.executionGate.reasons.join(" ") || plan.controlPlane.reason}</p>
          </div>
        </div>
      ) : null}

      {routeQuote ? (
        <div className="stellar-v4-quote" role="status">
          <strong>Live public-execution quote bound</strong>
          <span>
            Conservative output {formatUsdcAtomic(routeQuote.conservativeDestinationAmountAtomic)} · maximum CCTP fee {formatUsdcAtomic(routeQuote.maximumBridgeFeeAtomic)}
          </span>
          <span>
            Aave supply APY {(routeQuote.supplyApyBps / 100).toFixed(2)}% · {routeQuote.sourceApprovalRequired ? "Arc USDC approval required" : "existing Arc allowance sufficient"}
          </span>
        </div>
      ) : null}

      {error ? <div className="stellar-error" role="alert">{error}</div> : null}
      {busyStage ? (
        <div className="stellar-v3-loading" role="status">
          <Loader2 className="animate-spin" aria-hidden="true" /> {busyStage}…
        </div>
      ) : null}

      <div className="stellar-v4-actions">
        <button type="button" className="stellar-button" onClick={() => void prepareAndSign()} disabled={Boolean(busyStage)}>
          <FileKey2 aria-hidden="true" /> Review and sign policy
        </button>
        <button
          type="button"
          className="stellar-button"
          data-variant="positive"
          onClick={() => void proveAndBind()}
          disabled={Boolean(busyStage) || !plan?.controlPlane.ready || plan?.policy.proofBinding.status !== "device_proof_required"}
        >
          <LockKeyhole aria-hidden="true" /> Generate and bind Policy V2 proof
        </button>
        <button
          type="button"
          className="stellar-button"
          data-variant="positive"
          onClick={() => void signControlPlaneCommit()}
          disabled={
            Boolean(busyStage) ||
            plan?.controlPlane.commitment.status !== "awaiting_signature"
          }
        >
          <ShieldCheck aria-hidden="true" /> Review and sign Stellar commitment
        </button>
        {indeterminateCommitHash ? (
          <button
            type="button"
            className="stellar-button"
            onClick={() => void recoverControlPlaneCommit()}
            disabled={Boolean(busyStage)}
          >
            <Loader2 aria-hidden="true" /> Recover submitted commitment
          </button>
        ) : null}
        <button
          type="button"
          className="stellar-button"
          onClick={() => void hydrateLiveRoute()}
          disabled={
            Boolean(busyStage) ||
            Boolean(routeQuote) ||
            plan?.selectedRouteId !== "arc-arbitrum-direct-cctp" ||
            plan?.controlPlane.commitment.status !== "confirmed"
          }
        >
          <Route aria-hidden="true" /> Reveal amount and bind live quote
        </button>
        <button
          type="button"
          className="stellar-button"
          data-variant="positive"
          onClick={() => void bindFinancialExecutor()}
          disabled={Boolean(busyStage) || !routeQuote || plan?.executionHandoff.status !== "not_bound"}
        >
          <CheckCircle2 aria-hidden="true" /> Bind reviewed financial executor
        </button>
      </div>
      {executionHandoff ? (
        <BoundWorkflowV2Executor
          handoff={executionHandoff}
          evmAddress={evmAddress}
          readMaterial={() => {
            const material = privateInputRef.current;
            return material ? {
              amount: material.amount,
              recipient: material.recipient,
              amountSalt: material.amountSalt,
              recipientSalt: material.recipientSalt,
            } : null;
          }}
          onProgress={syncFinancialExecutor}
        />
      ) : null}
    </section>
  );
}
