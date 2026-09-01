import React from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { getAddress } from "viem";
import { Loader2, Route } from "lucide-react";

import {
  BoundWorkflowV2Executor,
  type BoundWorkflowPrivateMaterial,
} from "../../../cross-chain/v3/BoundWorkflowV2Executor";
import {
  isWorkflowV2Response,
  type WorkflowV2Response,
} from "../../../cross-chain/v2/types";
import { BACKEND_URL } from "../../../shared/config/runtime";
import {
  intentActionButtonClass,
  intentActionInputClass,
  intentPrimaryButtonClass,
} from "../../../shared/components/chat/intentActionStyles";
import {
  beginPrivateIntentObservation,
  commitPrivateField,
  createPrivateSalt,
  forgetPrivateFieldGuards,
  normalizePrivateAmount,
  privateSaltToHex,
  redactPrivatePrompt,
  type PrivateIntentRoutePreference,
} from "../runtime/privateIntent";
import type { StellarWorkspaceIntentResolution } from "../runtime/intentWorkspace";
import "./StellarHub.css";

const SCENARIO_ID =
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply" as const;

const buttonClass = intentActionButtonClass;
const primaryButtonClass = intentPrimaryButtonClass;
const inputClass = intentActionInputClass;

function messageFrom(value: unknown, fallback: string): string {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { message?: unknown }).message === "string"
    ? String((value as { message: string }).message)
    : fallback;
}

async function responseBody(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.ok) return body;
  throw new Error(
    messageFrom(body, "The reviewed Testnet workflow is temporarily unavailable."),
  );
}

export function StellarCrossChainIntentFlow({
  resolution,
  evmAddress,
  stellarAddress,
  onOpenAdvancedWorkflow,
}: {
  readonly resolution: StellarWorkspaceIntentResolution;
  readonly evmAddress?: string;
  readonly stellarAddress: string;
  readonly onConnectStellar: () => void;
  readonly onOpenAdvancedWorkflow: () => void;
}) {
  const [amount, setAmount] = React.useState(resolution.amount || "");
  const [routePreference, setRoutePreference] =
    React.useState<PrivateIntentRoutePreference>(
      resolution.routePreference === "direct_cctp"
        ? "direct_cctp"
        : "auto",
    );
  const [plan, setPlan] = React.useState<WorkflowV2Response | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const materialRef = React.useRef<BoundWorkflowPrivateMaterial | null>(null);

  React.useEffect(
    () => () => {
      materialRef.current = null;
      forgetPrivateFieldGuards();
    },
    [],
  );

  const clearDraftPlan = () => {
    if (plan) return;
    materialRef.current = null;
    forgetPrivateFieldGuards();
    setError(null);
  };

  const compile = async () => {
    setBusy(true);
    setError(null);
    materialRef.current = null;
    forgetPrivateFieldGuards();
    try {
      if (resolution.scenarioId !== SCENARIO_ID) {
        throw new Error(
          "This request is missing the reviewed Arc, USDC, Arbitrum Sepolia, or Aave binding.",
        );
      }
      if (!evmAddress) {
        throw new Error(
          "Connect the EVM wallet that will sign both Arc and Arbitrum Sepolia checkpoints.",
        );
      }
      if (
        routePreference === "stellar_centered_public" &&
        !StrKey.isValidEd25519PublicKey(stellarAddress)
      ) {
        throw new Error(
          "Connect a Stellar Testnet wallet before selecting the Stellar public corridor.",
        );
      }
      const normalizedAmount = normalizePrivateAmount(amount);
      const normalizedEvmAddress = getAddress(evmAddress);
      const executionRoutePreference = routePreference === "auto"
        ? "direct_cctp"
        : routePreference;
      if (executionRoutePreference === "stellar_centered_public") {
        throw new Error(
          "The simple chat executor cannot sign the Stellar corridor yet. Use the advanced policy workflow instead; no route was compiled.",
        );
      }
      const amountSalt = createPrivateSalt();
      const recipientSalt = createPrivateSalt();
      beginPrivateIntentObservation();
      const [amountCommitment, recipientCommitment] = await Promise.all([
        commitPrivateField("amount", normalizedAmount, amountSalt),
        commitPrivateField("recipient", normalizedEvmAddress, recipientSalt),
      ]);
      const requestId = crypto.randomUUID();
      const redactedPrompt = redactPrivatePrompt({
        prompt: resolution.sourcePrompt,
        scenarioId: SCENARIO_ID,
        routePreference: executionRoutePreference,
        includeBorrowCapacity: resolution.includeBorrowCapacity === true,
      });
      const response = await fetch(`${BACKEND_URL}/api/workflows/v2/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kletia-Chain-Ref": "stellar:testnet",
        },
        body: JSON.stringify({
          requestId,
          prompt: redactedPrompt,
          amountCommitment,
          recipientCommitment,
          routePreference: executionRoutePreference,
          privacyBudgetPreset: "deterministic_only_public_execution",
          policyAnchorMode: "local_manifest",
          walletBindings: {
            arcAddress: normalizedEvmAddress,
            arbitrumSepoliaAddress: normalizedEvmAddress,
            ...(StrKey.isValidEd25519PublicKey(stellarAddress)
              ? { stellarAddress }
              : {}),
          },
        }),
      });
      const body = await responseBody(response);
      const selectedRouteUsesStellar =
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        (body as { workflowPlan?: { selectedRoute?: unknown } }).workflowPlan
          ?.selectedRoute === "stellar_centered_public";
      if (
        !isWorkflowV2Response(body, {
          requestId,
          amountCommitment,
          recipientCommitment,
          arcAddress: normalizedEvmAddress,
          arbitrumSepoliaAddress: normalizedEvmAddress,
          ...(selectedRouteUsesStellar ? { stellarAddress } : {}),
          privacyBudgetPreset: "deterministic_only_public_execution",
        })
      ) {
        throw new Error(
          "The workflow response failed its wallet, route, and privacy bindings.",
        );
      }
      materialRef.current = {
        amount: normalizedAmount,
        recipient: normalizedEvmAddress,
        amountSalt: privateSaltToHex(amountSalt),
        recipientSalt: privateSaltToHex(recipientSalt),
      };
      setAmount(normalizedAmount);
      setPlan(body);
    } catch (caught) {
      materialRef.current = null;
      forgetPrivateFieldGuards();
      setError(
        caught instanceof Error
          ? caught.message
          : "The workflow stopped before any transaction was prepared.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (resolution.scenarioId !== SCENARIO_ID) {
    return (
      <div className="mt-3 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
        {resolution.blockingReason || resolution.nextStep}
      </div>
    );
  }

  if (plan) {
    return (
      <div className="mt-3">
        <BoundWorkflowV2Executor
          mode="standalone_reviewed_v2"
          handoff={{
            executionKind: "workflow_plan_v2",
            workflowPlan: plan.workflowPlan,
            workflowToken: plan.workflowToken,
            parentPlanHash: plan.workflowPlan.authorizationBoundary.planCoreSha256,
            externalExecutionTruthProvenByStellar: false,
          }}
          evmAddress={evmAddress}
          readMaterial={() => materialRef.current}
          onProgress={async () => undefined}
        />
      </div>
    );
  }

  return (
    <div className="mt-3 grid gap-3">
      <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider">
        Private amount · USDC
        <input
          className={inputClass}
          value={amount}
          inputMode="decimal"
          autoComplete="off"
          placeholder="e.g. 5"
          onChange={(event) => {
            clearDraftPlan();
            setAmount(event.target.value);
          }}
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Public route preference">
        {(
          [
            ["auto", "Direct recommended"],
            ["direct_cctp", "Direct CCTP"],
            ["stellar_centered_public", "Open Stellar advanced"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={routePreference === value ? primaryButtonClass : buttonClass}
            onClick={() => {
              if (value === "stellar_centered_public") {
                onOpenAdvancedWorkflow();
                return;
              }
              clearDraftPlan();
              setRoutePreference(value);
            }}
            title={
              value === "stellar_centered_public"
                ? "Open the policy and checkpoint workflow that can prepare every required Stellar signature."
                : undefined
            }
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] font-bold leading-relaxed text-[#4B4657] dark:text-slate-300">
        The amount stays on this device while routes are planned. The direct route does not spend XLM and does not invoke a solver. CCTP and Aave become public only when you approve their wallet checkpoints.
      </p>
      {!evmAddress ? (
        <div className="border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#5B4B12] dark:text-white">
          Connect one EVM wallet above. The same address is bound to Arc and Arbitrum Sepolia.
        </div>
      ) : null}
      {error ? (
        <div className="border-[3px] border-[#1A1A1A] bg-[#FFD9D6] p-3 text-xs font-bold dark:border-[#4B5563] dark:bg-[#4A2025]" role="alert">
          <strong className="block font-black uppercase">Stopped safely</strong>
          {error}
        </div>
      ) : null}
      <button
        type="button"
        className={primaryButtonClass}
        disabled={busy || !amount.trim() || !evmAddress}
        onClick={() => void compile()}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
        {busy ? "Comparing live routes" : "Compile and review"}
      </button>
    </div>
  );
}
