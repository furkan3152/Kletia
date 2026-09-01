import React from "react";
import {
  getAddress as getFreighterAddress,
  getNetworkDetails,
  isConnected as isFreighterConnected,
  requestAccess,
  signMessage,
  signTransaction,
} from "@stellar/freighter-api";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import {
  usePublicClient,
  useSendTransaction,
  useSignMessage,
  useSwitchChain,
} from "wagmi";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  Clock3,
  Eye,
  EyeOff,
  FileCheck2,
  Fingerprint,
  Loader2,
  LayoutDashboard,
  ListChecks,
  LockKeyhole,
  Network,
  Radio,
  RefreshCw,
  Route,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wallet,
  XCircle,
} from "lucide-react";

import { BACKEND_URL } from "../../../shared/config/runtime";
import {
  isWorkflowLifecycleErrorResponse,
  isWorkflowV2Response,
  isWorkflowAdvanceV2Response,
  type StellarRouteKind,
  type WorkflowAdvanceV2Response,
  type WorkflowLifecycleClassificationV1,
  type PrivacyBudgetPresetV1,
  type WorkflowStepV2,
  type WorkflowV2Response,
} from "../../../cross-chain/v2/types";
import {
  beginPrivateIntentObservation,
  commitPrivateField,
  createPrivateSalt,
  forgetPrivateFieldGuards,
  normalizePrivateAmount,
  privateSaltToHex,
  privateSaltFromHex,
  createPrivateIntentRouteClarification,
  redactPrivatePrompt,
  redactSemanticContext,
  resolvePrivateIntentSelection,
  type PrivateIntentClarificationOptionV1,
  type PrivateIntentClarificationV1,
  type PrivateIntentScenarioId,
} from "../runtime/privateIntent";
import {
  buildArbitrumAaveApproval,
  buildArbitrumAaveSupply,
  buildArbitrumCctpMint,
  buildArcCctpApproval,
  buildArcCctpBurn,
  prepareStellarCctpApproval,
  prepareStellarCctpBurn,
  prepareStellarMintAndForward,
  submitSignedStellarTransaction,
  StellarTransactionIndeterminateError,
  TESTNET_CCTP,
  type BrowserTransactionCall,
} from "../runtime/cctp";
import {
  prepareStellarPayment,
  prepareStellarSdexPathPayment,
  prepareStellarUsdcTrustline,
  submitSignedStellarClassicTransaction,
  validateStellarPathQuote,
  type StellarPathQuote,
} from "../runtime/classic";
import {
  decryptWorkflowRecoveryBundle,
  encryptWorkflowRecoveryBundle,
} from "../runtime/recovery";
import {
  fetchWithCommitmentOpeningDisclosure,
  readEgressGuardReport,
  type EgressGuardReport,
} from "../../../shared/privacy/egressGuard";
import {
  deriveDisclosureDiffView,
  derivePrivacyBudgetView,
} from "../../../shared/privacy/workflowPrivacyEvidence";
import { ControlPlaneOverview } from "../../../cross-chain/v3/ControlPlaneOverview";
import {
  CompetitiveWorkflowPanel,
  type ResolvedIntentReceiptForV3,
} from "../../../cross-chain/v3/CompetitiveWorkflowPanel";
import { CanonicalWorkflowV4Panel } from "../../../cross-chain/v4/CanonicalWorkflowV4Panel";
import { ShieldedPaymentsPanel } from "./ShieldedPaymentsPanel";
import { PasskeyAccountCard } from "./PasskeyAccountCard";
import {
  resolveStellarWorkspaceIntent,
  type StellarWorkspaceIntentResolution,
} from "../runtime/intentWorkspace";
import "./StellarHub.css";

const DEFAULT_PROMPT =
    "Move my locally protected USDC budget from Arc Testnet to Arbitrum Sepolia using the lowest reviewed cost-risk route, supply the received USDC to Aave V3, and show my theoretical borrow capacity without borrowing.";

const FREIGHTER_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk";

type Readiness = {
  enabled?: boolean;
  status?: string;
  privacy?: {
    privateIntentIsolation?: string;
    rawPrivateFieldsReceivedByAi?: boolean;
    rawPrivateFieldsReceivedByApiDuringPlanning?: boolean;
    settlementVisibility?: string;
    onchainConfidentiality?: string;
  };
  checkpointStore?: {
    configured?: boolean;
    status?: string;
  };
  stellar?: {
    latestLedger?: string;
    reviewedContractsAttested?: boolean;
  };
  routes?: {
    direct_cctp?: { ready?: boolean; reason?: string };
    stellar_centered_public?: { ready?: boolean; reason?: string };
  };
  capabilities?: {
    privatePayments?: {
      readiness?: {
        xlmLifecycle?: "available" | "quarantined";
      };
    };
  };
};

type Portfolio = {
  account: string;
  assets: Array<{
    asset: { symbol: string };
    balance: string;
    authorized: boolean;
  }>;
  observedAt: string;
};

type StellarQuoteResponse = {
  quote?: unknown;
};

const routeLabels: Record<StellarRouteKind, string> = {
  direct_cctp: "Direct CCTP",
  stellar_centered_public: "Stellar Public Settlement Checkpoint",
};

type RoutePreference = "auto" | StellarRouteKind;

type StellarWorkspaceView = "overview" | "wallet" | "plan" | "advanced";
type StellarWalletTool = "portfolio" | "transfer" | "swap" | "trustline" | "private_payment";

const routePreferenceLabels: Record<RoutePreference, string> = {
  auto: "Auto · Reviewed cost, risk and disclosure",
  direct_cctp: "Direct CCTP",
  stellar_centered_public: "Stellar Public Settlement Corridor",
};

const privacyBudgetLabels: Record<PrivacyBudgetPresetV1, string> = {
  public_execution: "Open observer budget · Public execution",
  private_planning_public_execution: "Private planning · Public execution",
  deterministic_only_public_execution:
    "Default privacy · No-AI deterministic planning",
  confidential_ledger_required: "Confidential ledger required",
};

const networkLabels: Record<string, string> = {
  arc_testnet: "Arc",
  stellar_testnet: "Stellar",
  arbitrum_sepolia: "Arbitrum Sepolia",
};

type SurfaceState =
  | "executable"
  | "read_only"
  | "unavailable"
  | "awaiting_signature"
  | "awaiting_attestation"
  | "submitted"
  | "confirmed"
  | "planned"
  | "indeterminate"
  | "failed"
  | "recovery_required";

const surfaceStateLabels: Record<SurfaceState, string> = {
  executable: "Executable",
  read_only: "Read only",
  unavailable: "Unavailable",
  awaiting_signature: "Awaiting signature",
  awaiting_attestation: "Awaiting attestation",
  submitted: "Submitted",
  confirmed: "Confirmed",
  planned: "Planned",
  indeterminate: "Indeterminate",
  failed: "Failed",
  recovery_required: "Recovery required",
};

const surfaceStateTone: Record<SurfaceState, "positive" | "warning" | "danger" | "neutral" | "info"> = {
  executable: "positive",
  read_only: "info",
  unavailable: "danger",
  awaiting_signature: "warning",
  awaiting_attestation: "warning",
  submitted: "warning",
  confirmed: "positive",
  planned: "neutral",
  indeterminate: "danger",
  failed: "danger",
  recovery_required: "danger",
};

function StatusPill({ state }: { state: SurfaceState }) {
  const Icon =
    state === "confirmed" || state === "executable"
      ? CheckCircle2
      : state === "unavailable" || state === "failed"
        ? XCircle
        : state === "indeterminate" || state === "recovery_required"
          ? AlertCircle
          : state === "awaiting_attestation"
            ? Radio
            : state === "awaiting_signature"
              ? Fingerprint
              : state === "read_only"
                ? Eye
                : Clock3;
  return (
    <span className="stellar-status-pill" data-tone={surfaceStateTone[state]}>
      <Icon aria-hidden="true" />
      {surfaceStateLabels[state]}
    </span>
  );
}

function PrivateIntentClarificationCard({
  clarification,
  selectedScenarioId,
  routePreference,
  directRouteReady,
  stellarRouteReady,
  onSelect,
  onEditGoal,
}: {
  clarification: PrivateIntentClarificationV1;
  selectedScenarioId: PrivateIntentScenarioId | null;
  routePreference: RoutePreference;
  directRouteReady: boolean;
  stellarRouteReady: boolean;
  onSelect: (option: PrivateIntentClarificationOptionV1) => void;
  onEditGoal: () => void;
}) {
  const routeReady = (option: PrivateIntentClarificationOptionV1): boolean => {
    if (option.kind !== "route") return directRouteReady || stellarRouteReady;
    if (option.routePreference === "direct_cctp") return directRouteReady;
    if (option.routePreference === "stellar_centered_public") {
      return stellarRouteReady;
    }
    return option.routePreference === "auto"
      ? directRouteReady || stellarRouteReady
      : false;
  };

  return (
    <section
      className="stellar-clarification"
      aria-labelledby="stellar-intent-clarification-title"
    >
      <div className="stellar-clarification-heading">
        <AlertTriangle aria-hidden="true" />
        <div>
          <p className="stellar-eyebrow">Device-side decision · no prompt mutation</p>
          <h3 id="stellar-intent-clarification-title">
            {clarification.question}
          </h3>
          <p>{clarification.whyAsked}</p>
        </div>
      </div>

      <div className="stellar-decision-grid">
        {clarification.options.map((option) => {
          const ready = routeReady(option);
          const selectable = option.selectable && ready;
          const selected =
            option.kind === "scenario"
              ? selectedScenarioId === option.scenarioId
              : option.routePreference === routePreference;
          const state: SurfaceState = !option.selectable
            ? option.executionReadiness === "shadow_only"
              ? "read_only"
              : "unavailable"
            : ready
              ? "executable"
              : "unavailable";
          return (
            <button
              key={option.id}
              type="button"
              className="stellar-decision-button"
              aria-pressed={selected}
              aria-disabled={!selectable}
              disabled={!selectable}
              onClick={() => onSelect(option)}
            >
              <span className="stellar-route-title">
                {option.label}
                <StatusPill state={state} />
              </span>
              {option.keywordEvidence.length > 0 ? (
                <span className="stellar-keyword-evidence">
                  Evidence: {option.keywordEvidence.join(" · ")}
                </span>
              ) : null}
              <span className="stellar-decision-effects">
                <span>
                  <strong>Public</strong>
                  {option.publicEffect}
                </span>
                <span>
                  <strong>Confidential</strong>
                  {option.confidentialEffect}
                </span>
                <span>
                  <strong>Runtime</strong>
                  {option.runtimeEffect}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <button type="button" onClick={onEditGoal} className="stellar-button">
        Edit the local goal
      </button>
    </section>
  );
}

function workflowStepState(input: {
  action: string;
  result?: unknown;
  status: WorkflowStepV2["status"];
  order: number;
  currentStepIndex: number;
  manifestSigned: boolean;
  indeterminate: boolean;
}): SurfaceState {
  if (input.status === "failed") return "failed";
  if (input.status === "recovery_required") return "recovery_required";
  if (input.status === "indeterminate") return "indeterminate";
  if (input.status === "submitted") return "submitted";
  if (input.indeterminate && input.order === input.currentStepIndex + 1) {
    return "indeterminate";
  }
  if (input.result) return "confirmed";
  if (input.order < input.currentStepIndex + 1) return "confirmed";
  if (input.order > input.currentStepIndex + 1) return "planned";
  if (input.action === "cctp_attestation") return "awaiting_attestation";
  if (input.action === "borrow_capacity") return "read_only";
  return input.manifestSigned ? "awaiting_signature" : "planned";
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The request could not be completed.";

class FreighterResponseTimeoutError extends Error {
  constructor() {
    super("Freighter did not answer before the wallet request expired.");
    this.name = "FreighterResponseTimeoutError";
  }
}

async function waitForFreighterResponse<T>(
  request: Promise<T>,
  timeoutMs = 6_000,
): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new FreighterResponseTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

const freighterChromeHelp = (): string =>
  `Freighter did not answer Kletia from this Chrome profile. Open chrome://extensions, enable Freighter, allow site access for ${window.location.origin}, then refresh this page. Also unlock Freighter before retrying.`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

class ApiResponseError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback: string) {
    const message =
      isObject(body) && typeof body.message === "string"
        ? body.message
        : fallback;
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.body = body;
  }
}

class WorkflowLifecycleHandledError extends Error {
  readonly lifecycle: WorkflowLifecycleClassificationV1;

  constructor(message: string, lifecycle: WorkflowLifecycleClassificationV1) {
    super(message);
    this.name = "WorkflowLifecycleHandledError";
    this.lifecycle = lifecycle;
  }
}

type ExecutionReceipt = NonNullable<
  WorkflowAdvanceV2Response["executionReceipt"]
>;

type LocalSubmissionState =
  | "submitted"
  | "confirmed"
  | "indeterminate"
  | "failed"
  | "recovery_required";

interface LocalSubmissionEvidence {
  readonly stepId: string;
  readonly network: string;
  readonly transactionHash: string;
  readonly state: LocalSubmissionState;
  readonly observedAt: string;
}

const financiallySubmittedStates = new Set<LocalSubmissionState>([
  "submitted",
  "confirmed",
  "indeterminate",
  "recovery_required",
]);

const isFinancialStep = (step: WorkflowStepV2 | undefined): boolean =>
  Boolean(
    step &&
      step.action !== "cctp_attestation" &&
      step.action !== "borrow_capacity",
  );

function sealedWallet(
  plan: WorkflowV2Response,
  id: "arc_wallet" | "stellar_wallet" | "arbitrum_sepolia_wallet",
): string {
  const binding = plan.workflowPlan.walletBindings.find((entry) => entry.id === id);
  if (!binding) throw new Error(`The sealed ${id} binding is missing.`);
  return binding.address;
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new ApiResponseError(
      response.status,
      body,
      "The capability is not ready on this deployment.",
    );
  }
  return body;
}

export function StellarHub({
  evmAddress,
  initialIntent,
  initialStellarAddress,
  onStellarAddressChange,
  onIntentConsumed,
}: {
  evmAddress?: `0x${string}`;
  initialIntent?: string;
  initialStellarAddress?: string;
  onStellarAddressChange?: (address: string) => void;
  onIntentConsumed?: () => void;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync: signEvmMessage } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const arcClient = usePublicClient({ chainId: 5_042_002 });
  const arbitrumSepoliaClient = usePublicClient({ chainId: 421_614 });
  const [stellarAddress, setStellarAddress] = React.useState(
    () => initialStellarAddress || "",
  );
  const [workspaceView, setWorkspaceView] =
    React.useState<StellarWorkspaceView>("overview");
  const [activeWalletTool, setActiveWalletTool] =
    React.useState<StellarWalletTool>("portfolio");
  const [stellarIntentResolution, setStellarIntentResolution] =
    React.useState<StellarWorkspaceIntentResolution | null>(null);
  const [amount, setAmount] = React.useState("5");
  const [prompt, setPrompt] = React.useState(
    () => initialIntent?.trim() || DEFAULT_PROMPT,
  );
  const [routePreference, setRoutePreference] =
    React.useState<RoutePreference>("auto");
  const [selectedScenarioId, setSelectedScenarioId] =
    React.useState<PrivateIntentScenarioId | null>(null);
  const [structuredSelectionConfirmed, setStructuredSelectionConfirmed] =
    React.useState(false);
  const [intentClarification, setIntentClarification] =
    React.useState<PrivateIntentClarificationV1 | null>(null);
  const [privacyBudgetPreset, setPrivacyBudgetPreset] =
    React.useState<PrivacyBudgetPresetV1>(
      "deterministic_only_public_execution",
    );
  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  const [portfolio, setPortfolio] = React.useState<Portfolio | null>(null);
  const [stellarSwapSource, setStellarSwapSource] = React.useState<"XLM" | "USDC">("XLM");
  const [stellarSwapMode, setStellarSwapMode] = React.useState<"strict_send" | "strict_receive">("strict_send");
  const [stellarSwapAmount, setStellarSwapAmount] = React.useState("1");
  const [stellarQuote, setStellarQuote] = React.useState<StellarPathQuote | null>(null);
  const [stellarQuoteRequested, setStellarQuoteRequested] = React.useState(false);
  const [stellarTransferSymbol, setStellarTransferSymbol] = React.useState<"XLM" | "USDC">("USDC");
  const [stellarTransferAmount, setStellarTransferAmount] = React.useState("1");
  const [stellarTransferRecipient, setStellarTransferRecipient] = React.useState("");
  const [recoveryPassword, setRecoveryPassword] = React.useState("");
  const [recoveryStatus, setRecoveryStatus] = React.useState<string | null>(null);
  const [stellarToolBusy, setStellarToolBusy] = React.useState(false);
  const [plan, setPlan] = React.useState<WorkflowV2Response | null>(null);
  const [resolvedIntentReceipt, setResolvedIntentReceipt] =
    React.useState<ResolvedIntentReceiptForV3 | null>(null);
  const [manifestSigned, setManifestSigned] = React.useState(false);
  const [manifestAuthorization, setManifestAuthorization] = React.useState<{
    family: "evm" | "stellar";
    signer: string;
    signature: string;
  } | null>(null);
  const [executionReceipt, setExecutionReceipt] =
    React.useState<ExecutionReceipt | null>(null);
  const [lifecycle, setLifecycle] =
    React.useState<WorkflowLifecycleClassificationV1 | null>(null);
  const [submissionEvidence, setSubmissionEvidence] = React.useState<
    Record<string, LocalSubmissionEvidence>
  >({});
  const [publicOpeningApproved, setPublicOpeningApproved] = React.useState(false);
  const [egressReport, setEgressReport] = React.useState<EgressGuardReport>(() =>
    readEgressGuardReport(),
  );
  const [indeterminateHash, setIndeterminateHash] = React.useState<string | null>(null);
  const [executing, setExecuting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const privateMaterialRef = React.useRef<{
    amount: string;
    recipient: string;
    amountSalt: Uint8Array;
    recipientSalt: Uint8Array;
  } | null>(null);

  const applyStellarWorkspaceIntent = React.useCallback((rawIntent: string) => {
    const resolution = resolveStellarWorkspaceIntent(rawIntent);
    setStellarIntentResolution(resolution);
    setError(null);

    if (resolution.kind === "transfer") {
      setWorkspaceView("wallet");
      setActiveWalletTool("transfer");
      if (resolution.amount) setStellarTransferAmount(resolution.amount);
      if (resolution.assetIn === "XLM" || resolution.assetIn === "USDC") {
        setStellarTransferSymbol(resolution.assetIn);
      }
      if (resolution.recipient) setStellarTransferRecipient(resolution.recipient);
      return;
    }

    if (resolution.kind === "swap") {
      setWorkspaceView("wallet");
      setActiveWalletTool("swap");
      if (resolution.amount) setStellarSwapAmount(resolution.amount);
      if (resolution.assetIn === "XLM" || resolution.assetIn === "USDC") {
        setStellarSwapSource(resolution.assetIn);
      }
      setStellarSwapMode(resolution.strictReceive ? "strict_receive" : "strict_send");
      setStellarQuote(null);
      setStellarQuoteRequested(false);
      return;
    }

    if (resolution.kind === "trustline") {
      setWorkspaceView("wallet");
      setActiveWalletTool("trustline");
      return;
    }

    if (resolution.kind === "private_payment") {
      setWorkspaceView("wallet");
      setActiveWalletTool("private_payment");
      return;
    }

    if (resolution.kind === "cross_chain") {
      setWorkspaceView("plan");
      setPrompt(rawIntent);
      if (resolution.amount) setAmount(resolution.amount);
      setRoutePreference(resolution.routePreference ?? "auto");
      return;
    }

    setWorkspaceView("overview");
    setActiveWalletTool("portfolio");
  }, []);

  const refreshPrivacyEvidence = React.useCallback(() => {
    setEgressReport(readEgressGuardReport());
  }, []);

  const recordSubmission = React.useCallback(
    (step: WorkflowStepV2, transactionHash: string, state: LocalSubmissionState) => {
      setSubmissionEvidence((existing) => ({
        ...existing,
        [step.id]: {
          stepId: step.id,
          network: step.network,
          transactionHash,
          state,
          observedAt: new Date().toISOString(),
        },
      }));
    },
    [],
  );

  React.useEffect(() => {
    if (!initialIntent?.trim()) return;
    const intent = initialIntent.trim();
    const frame = window.requestAnimationFrame(() => {
      applyStellarWorkspaceIntent(intent);
      onIntentConsumed?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyStellarWorkspaceIntent, initialIntent, onIntentConsumed]);

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${BACKEND_URL}/api/workflows/v2/readiness`, {
      headers: { "X-Kletia-Chain-Ref": "stellar:testnet" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("WorkflowPlanV2 is not ready.");
        return response.json();
      })
      .then((body: Readiness) => {
        if (!cancelled) setReadiness(body);
      })
      .catch(() => {
        if (!cancelled) setReadiness({ enabled: false, status: "unavailable" });
      });
    return () => {
      cancelled = true;
      privateMaterialRef.current = null;
      forgetPrivateFieldGuards();
    };
  }, []);

  React.useEffect(() => {
    if (!plan) return;
    const arcBinding = plan.workflowPlan.walletBindings.find(
      (entry) => entry.id === "arc_wallet",
    );
    const arbitrumBinding = plan.workflowPlan.walletBindings.find(
      (entry) => entry.id === "arbitrum_sepolia_wallet",
    );
    const stellarBinding = plan.workflowPlan.walletBindings.find(
      (entry) => entry.id === "stellar_wallet",
    );
    const evmChanged =
      !evmAddress ||
      !arcBinding ||
      !arbitrumBinding ||
      arcBinding.address.toLowerCase() !== evmAddress.toLowerCase() ||
      arbitrumBinding.address.toLowerCase() !== evmAddress.toLowerCase();
    const stellarChanged =
      plan.workflowPlan.selectedRoute !== "direct_cctp" &&
      (!stellarBinding || stellarBinding.address !== stellarAddress);
    if (!evmChanged && !stellarChanged) return;
    const invalidation = window.setTimeout(() => {
      setPlan(null);
      setManifestAuthorization(null);
      setManifestSigned(false);
      setExecutionReceipt(null);
      setLifecycle(null);
      setSubmissionEvidence({});
      setPublicOpeningApproved(false);
      setIndeterminateHash(null);
      privateMaterialRef.current = null;
      forgetPrivateFieldGuards();
      refreshPrivacyEvidence();
      setError(
        "The connected wallet changed, so the sealed workflow was invalidated. Compile a new plan.",
      );
    }, 0);
    return () => window.clearTimeout(invalidation);
  }, [evmAddress, plan, refreshPrivacyEvidence, stellarAddress]);

  const connectFreighter = async () => {
    setBusy(true);
    setError(null);
    try {
      const connection = await isFreighterConnected().catch(() => ({
        isConnected: false,
      }));
      let access: Awaited<ReturnType<typeof requestAccess>>;
      try {
        // requestAccess is the authoritative connection action. Running it even
        // after an inconclusive availability probe also handles a freshly
        // enabled content script without requiring a second click.
        access = await waitForFreighterResponse(requestAccess());
      } catch (caught) {
        if (
          caught instanceof FreighterResponseTimeoutError ||
          !connection.isConnected
        ) {
          throw new Error(freighterChromeHelp(), { cause: caught });
        }
        throw caught;
      }
      if (access.error || !StrKey.isValidEd25519PublicKey(access.address)) {
        throw new Error(
          access.error?.message ||
            "Freighter opened but did not return a Stellar account. Unlock it, select or create an account, and approve Kletia.",
        );
      }
      const network = await waitForFreighterResponse(getNetworkDetails());
      if (
        network.error ||
        network.networkPassphrase !== Networks.TESTNET
      ) {
        throw new Error("Switch Freighter to Stellar Testnet before continuing.");
      }
      setStellarAddress(access.address);
      onStellarAddressChange?.(access.address);
      const body = (await readJson(
        await fetch(
          `${BACKEND_URL}/api/stellar/portfolio/${encodeURIComponent(access.address)}`,
          { headers: { "X-Kletia-Chain-Ref": "stellar:testnet" } },
        ),
      )) as { portfolio?: Portfolio };
      setPortfolio(body.portfolio || null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const refreshPortfolio = React.useCallback(async () => {
    if (!StrKey.isValidEd25519PublicKey(stellarAddress)) return;
    const body = (await readJson(
      await fetch(
        `${BACKEND_URL}/api/stellar/portfolio/${encodeURIComponent(stellarAddress)}`,
        { headers: { "X-Kletia-Chain-Ref": "stellar:testnet" } },
      ),
    )) as { portfolio?: Portfolio };
    setPortfolio(body.portfolio || null);
  }, [stellarAddress]);

  const compareStellarRoutes = async () => {
    setStellarToolBusy(true);
    setError(null);
    setStellarQuote(null);
    setStellarQuoteRequested(true);
    try {
      const body = (await readJson(
        await fetch(`${BACKEND_URL}/api/stellar/quote`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kletia-Chain-Ref": "stellar:testnet",
          },
          body: JSON.stringify({
            mode: stellarSwapMode,
            assetIn: stellarSwapSource,
            assetOut: stellarSwapSource === "XLM" ? "USDC" : "XLM",
            amount: stellarSwapAmount,
          }),
        }),
      )) as StellarQuoteResponse;
      setStellarQuote(validateStellarPathQuote(body.quote));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStellarToolBusy(false);
    }
  };

  const executeSdexRoute = async () => {
    if (!stellarQuote) return;
    setStellarToolBusy(true);
    setError(null);
    try {
      const network = await getNetworkDetails();
      if (network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      }
      const unsignedXdr = await prepareStellarSdexPathPayment({
        sourceAccount: stellarAddress,
        quote: stellarQuote,
      });
      const signed = await signTransaction(unsignedXdr, {
        networkPassphrase: Networks.TESTNET,
        address: stellarAddress,
      });
      if (signed.error || !signed.signedTxXdr || signed.signerAddress !== stellarAddress) {
        throw new Error(signed.error?.message || "Freighter rejected the SDEX transaction.");
      }
      await submitSignedStellarClassicTransaction(
        signed.signedTxXdr,
        unsignedXdr,
      );
      setStellarQuote(null);
      await refreshPortfolio();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStellarToolBusy(false);
    }
  };

  const executeStellarTransfer = async () => {
    setStellarToolBusy(true);
    setError(null);
    try {
      if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
        throw new Error("Connect Freighter before preparing a transfer.");
      }
      const network = await getNetworkDetails();
      if (network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      }
      const unsignedXdr = await prepareStellarPayment({
        sourceAccount: stellarAddress,
        destination: stellarTransferRecipient.trim(),
        symbol: stellarTransferSymbol,
        amount: stellarTransferAmount,
      });
      const signed = await signTransaction(unsignedXdr, {
        networkPassphrase: Networks.TESTNET,
        address: stellarAddress,
      });
      if (signed.error || !signed.signedTxXdr || signed.signerAddress !== stellarAddress) {
        throw new Error(signed.error?.message || "Freighter rejected the transfer.");
      }
      await submitSignedStellarClassicTransaction(
        signed.signedTxXdr,
        unsignedXdr,
      );
      await refreshPortfolio();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStellarToolBusy(false);
    }
  };

  const createUsdcTrustline = async () => {
    setStellarToolBusy(true);
    setError(null);
    try {
      if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
        throw new Error("Connect Freighter before preparing a trustline.");
      }
      const network = await getNetworkDetails();
      if (network.networkPassphrase !== Networks.TESTNET) {
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      }
      const unsignedXdr = await prepareStellarUsdcTrustline({
        sourceAccount: stellarAddress,
      });
      const signed = await signTransaction(unsignedXdr, {
        networkPassphrase: Networks.TESTNET,
        address: stellarAddress,
      });
      if (signed.error || !signed.signedTxXdr || signed.signerAddress !== stellarAddress) {
        throw new Error(signed.error?.message || "Freighter rejected the trustline transaction.");
      }
      await submitSignedStellarClassicTransaction(signed.signedTxXdr, unsignedXdr);
      await refreshPortfolio();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStellarToolBusy(false);
    }
  };

  const preparePlan = async () => {
    setBusy(true);
    setError(null);
    try {
      if (
        plan &&
        !executionReceipt &&
        Object.values(submissionEvidence).some((entry) =>
          ["submitted", "confirmed", "indeterminate", "recovery_required"].includes(
            entry.state,
          ),
        )
      ) {
        throw new Error(
          "This workflow already has financial submission evidence. Recover or finish it before compiling a replacement plan.",
        );
      }
      const intentResolution = resolvePrivateIntentSelection({
        prompt,
        ...(selectedScenarioId ? { scenarioId: selectedScenarioId } : {}),
        routePreference,
      });
      if (intentResolution.status === "clarification") {
        setIntentClarification(intentResolution.clarification);
        return;
      }
      const compiledScenarioId = intentResolution.scenarioId;
      const compiledRoutePreference = intentResolution.routePreference;
      setSelectedScenarioId(compiledScenarioId);
      setRoutePreference(compiledRoutePreference);
      setIntentClarification(null);
      beginPrivateIntentObservation();
      setPlan(null);
      setManifestSigned(false);
      setManifestAuthorization(null);
      setExecutionReceipt(null);
      setLifecycle(null);
      setSubmissionEvidence({});
      setPublicOpeningApproved(false);
      setIndeterminateHash(null);
      if (!evmAddress) {
        throw new Error("Connect one EVM wallet for the Arc and Arbitrum Sepolia checkpoints.");
      }
      const normalizedEvmAddress = getAddress(evmAddress);
      if (
        compiledRoutePreference === "stellar_centered_public" &&
        !StrKey.isValidEd25519PublicKey(stellarAddress)
      ) {
        throw new Error("Connect a valid Freighter Stellar Testnet account.");
      }
      const normalizedAmount = normalizePrivateAmount(amount);
      const amountSalt = createPrivateSalt();
      const recipientSalt = createPrivateSalt();
      // This roadmap exits the Stellar treasury back to the user's bound EVM
      // wallet. A private transfer to a different Stellar recipient is a
      // separate lifecycle because the sender cannot later withdraw the
      // recipient's funds.
      const privateRecipient = normalizedEvmAddress;
      const [amountCommitment, recipientCommitment] = await Promise.all([
        commitPrivateField("amount", normalizedAmount, amountSalt),
        commitPrivateField("recipient", privateRecipient, recipientSalt),
      ]);
      refreshPrivacyEvidence();
      const redactedPrompt = redactPrivatePrompt({
        prompt,
        scenarioId: compiledScenarioId,
        routePreference: compiledRoutePreference,
        includeBorrowCapacity: true,
      });
      const semanticContext =
        privacyBudgetPreset === "deterministic_only_public_execution" ||
        structuredSelectionConfirmed
          ? undefined
          : redactSemanticContext(prompt);
      const requestId = crypto.randomUUID();
      privateMaterialRef.current = {
        amount: normalizedAmount,
        recipient: privateRecipient,
        amountSalt,
        recipientSalt,
      };
      const planResponse = await fetch(`${BACKEND_URL}/api/intent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kletia-Network": "stellar",
            "X-Kletia-Chain-Ref": "stellar:testnet",
          },
          body: JSON.stringify({
            network: "stellar",
            chainRef: "stellar:testnet",
            requestId,
            prompt: redactedPrompt,
            ...(semanticContext ? { semanticContext } : {}),
            amountCommitment,
            recipientCommitment,
            routePreference: compiledRoutePreference,
            privacyBudgetPreset,
            walletBindings: {
              arcAddress: normalizedEvmAddress,
              ...(StrKey.isValidEd25519PublicKey(stellarAddress)
                ? { stellarAddress }
                : {}),
              arbitrumSepoliaAddress: normalizedEvmAddress,
            },
          }),
        });
      if (planResponse.status === 409) {
        const questionBody = (await planResponse.json().catch(() => null)) as {
          requiresInput?: unknown;
          question?: unknown;
        } | null;
        if (
          questionBody?.requiresInput === true &&
          typeof questionBody.question === "string"
        ) {
          privateMaterialRef.current = null;
          forgetPrivateFieldGuards();
          refreshPrivacyEvidence();
          setIntentClarification(
            createPrivateIntentRouteClarification({
              scenarioId: compiledScenarioId,
              whyAsked:
                "The constrained semantic confirmation did not accept one complete route. Bind a reviewed route as structured device state; Kletia will not append an instruction to the free-form goal.",
            }),
          );
          return;
        }
      }
      const body = await readJson(planResponse);
      const selectedRouteUsesStellar =
        isObject(body) &&
        isObject(body.workflowPlan) &&
        body.workflowPlan.selectedRoute === "stellar_centered_public";
      if (
        selectedRouteUsesStellar &&
        !StrKey.isValidEd25519PublicKey(stellarAddress)
      ) {
        throw new Error(
          "Auto selected the Stellar public route, but no valid Freighter account is connected. Connect Freighter or choose Direct CCTP.",
        );
      }
      if (
        !isWorkflowV2Response(body, {
          requestId,
          amountCommitment,
          recipientCommitment,
          arcAddress: normalizedEvmAddress,
          arbitrumSepoliaAddress: normalizedEvmAddress,
          ...(selectedRouteUsesStellar &&
          StrKey.isValidEd25519PublicKey(stellarAddress)
            ? { stellarAddress }
            : {}),
          privacyBudgetPreset,
        })
      ) {
        throw new Error("The workflow response failed its Testnet and privacy bindings.");
      }
      setPlan(body);
      setResolvedIntentReceipt({
        schemaVersion: "kletia_resolved_intent_receipt_v1",
        workflowId: body.workflowPlan.workflowId,
        requestId: body.requestId,
        planCoreSha256: body.workflowPlan.authorizationBoundary.planCoreSha256,
        workflowToken: body.workflowToken,
        scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
        selectedRoute: body.workflowPlan.selectedRoute,
        protectedAmount: normalizedAmount,
      });
      refreshPrivacyEvidence();
    } catch (caught) {
      privateMaterialRef.current = null;
      refreshPrivacyEvidence();
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const applyIntentClarification = (
    option: PrivateIntentClarificationOptionV1,
  ) => {
    if (!option.selectable) return;
    setSelectedScenarioId(option.scenarioId);
    if (option.routePreference) {
      setRoutePreference(option.routePreference);
    }
    // The structured selection makes the natural-language copy unnecessary for
    // semantic confirmation. The API receives only the allowlisted envelope.
    setStructuredSelectionConfirmed(true);
    setIntentClarification(null);
    setError(null);
  };

  const exportRecoveryBundle = async () => {
    const material = privateMaterialRef.current;
    if (!plan || !material) {
      setError("Create a workflow before exporting recovery data.");
      return;
    }
    setBusy(true);
    setError(null);
    setRecoveryStatus(null);
    try {
      const encrypted = await encryptWorkflowRecoveryBundle(
        {
          schemaVersion: "kletia_workflow_authorization_payload_v1",
          exportedAt: new Date().toISOString(),
          plan,
          manifestAuthorization,
          lifecycle,
          submissionEvidence,
          privateMaterial: {
            amount: material.amount,
            recipient: material.recipient,
            amountSalt: privateSaltToHex(material.amountSalt),
            recipientSalt: privateSaltToHex(material.recipientSalt),
          },
        },
        recoveryPassword,
      );
      const url = URL.createObjectURL(
        new Blob([encrypted], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `kletia-recovery-${plan.workflowPlan.workflowId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setRecoveryStatus("Encrypted recovery bundle exported. Keep the file and password separate.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const importRecoveryBundle = async (file: File) => {
    setBusy(true);
    setError(null);
    setRecoveryStatus(null);
    try {
      if (!evmAddress) {
        throw new Error("Connect the EVM wallet bound to the workflow before recovery.");
      }
      const decrypted = await decryptWorkflowRecoveryBundle(
        await file.text(),
        recoveryPassword,
      );
      if (
        !isObject(decrypted) ||
        decrypted.schemaVersion !== "kletia_workflow_authorization_payload_v1" ||
        !isObject(decrypted.privateMaterial) ||
        !isObject(decrypted.plan)
      ) {
        throw new Error("The decrypted workflow recovery payload is invalid.");
      }
      const restoredMaterial = decrypted.privateMaterial;
      const restoredPlan = decrypted.plan;
      if (!isObject(restoredPlan.workflowPlan)) {
        throw new Error("The decrypted workflow plan is invalid.");
      }
      const restoredWorkflowPlan = restoredPlan.workflowPlan;
      if (!isObject(restoredWorkflowPlan.privacy)) {
        throw new Error("The decrypted privacy binding is invalid.");
      }
      const restoredPrivacy = restoredWorkflowPlan.privacy;
      if (
        typeof restoredPlan.requestId !== "string" ||
        typeof restoredPrivacy.amountCommitment !== "string" ||
        typeof restoredPrivacy.recipientCommitment !== "string" ||
        typeof restoredMaterial.amount !== "string" ||
        typeof restoredMaterial.recipient !== "string" ||
        typeof restoredMaterial.amountSalt !== "string" ||
        typeof restoredMaterial.recipientSalt !== "string"
      ) {
        throw new Error("The recovery payload is missing sealed private fields.");
      }
      const amountSalt = privateSaltFromHex(restoredMaterial.amountSalt);
      const recipientSalt = privateSaltFromHex(restoredMaterial.recipientSalt);
      const normalizedAmount = normalizePrivateAmount(restoredMaterial.amount);
      beginPrivateIntentObservation();
      const [amountCommitment, recipientCommitment] = await Promise.all([
        commitPrivateField("amount", normalizedAmount, amountSalt),
        commitPrivateField("recipient", restoredMaterial.recipient, recipientSalt),
      ]);
      const expectsStellar = restoredWorkflowPlan.selectedRoute !== "direct_cctp";
      if (
        expectsStellar &&
        !StrKey.isValidEd25519PublicKey(stellarAddress)
      ) {
        throw new Error("Connect the Stellar account bound to this workflow before recovery.");
      }
      if (
        !isWorkflowV2Response(restoredPlan, {
          requestId: restoredPlan.requestId,
          amountCommitment,
          recipientCommitment,
          arcAddress: evmAddress,
          arbitrumSepoliaAddress: evmAddress,
          ...(expectsStellar ? { stellarAddress } : {}),
        })
      ) {
        throw new Error("The recovered plan failed its wallet, lane, asset or commitment boundary.");
      }
      let restoredAuthorization: typeof manifestAuthorization = null;
      if (decrypted.manifestAuthorization !== null && decrypted.manifestAuthorization !== undefined) {
        const authorization = decrypted.manifestAuthorization;
        if (
          !isObject(authorization) ||
          (authorization.family !== "evm" && authorization.family !== "stellar") ||
          typeof authorization.signer !== "string" ||
          typeof authorization.signature !== "string"
        ) {
          throw new Error("The recovered manifest authorization is invalid.");
        }
        const expectedSigner = authorization.family === "evm" ? evmAddress : stellarAddress;
        if (authorization.signer.toLowerCase() !== expectedSigner.toLowerCase()) {
          throw new Error("The recovered manifest signer does not match the active wallet.");
        }
        restoredAuthorization = {
          family: authorization.family,
          signer: authorization.signer,
          signature: authorization.signature,
        };
      }
      const restoredSubmissions: Record<string, LocalSubmissionEvidence> = {};
      for (const step of restoredPlan.workflowPlan.steps) {
        const reference = step.result?.reference;
        if (
          isFinancialStep(step) &&
          reference &&
          financiallySubmittedStates.has(step.status as LocalSubmissionState)
        ) {
          restoredSubmissions[step.id] = {
            stepId: step.id,
            network: step.network,
            transactionHash: reference,
            state: step.status as LocalSubmissionState,
            observedAt: step.result?.observedAt || new Date().toISOString(),
          };
        }
      }
      if (decrypted.submissionEvidence !== undefined) {
        if (!isObject(decrypted.submissionEvidence)) {
          throw new Error("The recovered submission evidence is invalid.");
        }
        for (const [stepId, rawEvidence] of Object.entries(
          decrypted.submissionEvidence,
        )) {
          const step = restoredPlan.workflowPlan.steps.find(
            (candidate) => candidate.id === stepId,
          );
          if (
            !step ||
            !isFinancialStep(step) ||
            !isObject(rawEvidence) ||
            rawEvidence.stepId !== step.id ||
            rawEvidence.network !== step.network ||
            typeof rawEvidence.transactionHash !== "string" ||
            typeof rawEvidence.observedAt !== "string" ||
            typeof rawEvidence.state !== "string" ||
            !["submitted", "confirmed", "indeterminate", "failed", "recovery_required"].includes(
              rawEvidence.state,
            ) ||
            (step.network === "stellar_testnet"
              ? !/^[a-f\d]{64}$/iu.test(rawEvidence.transactionHash)
              : !/^0x[a-f\d]{64}$/iu.test(rawEvidence.transactionHash))
          ) {
            throw new Error(
              "Recovered submission evidence does not match the sealed workflow step.",
            );
          }
          restoredSubmissions[step.id] = {
            stepId: step.id,
            network: step.network,
            transactionHash: rawEvidence.transactionHash,
            state: rawEvidence.state as LocalSubmissionState,
            observedAt: rawEvidence.observedAt,
          };
        }
      }
      let restoredLifecycle: WorkflowLifecycleClassificationV1 | null = null;
      if (decrypted.lifecycle !== undefined && decrypted.lifecycle !== null) {
        const rawLifecycle = decrypted.lifecycle;
        if (
          !isObject(rawLifecycle) ||
          rawLifecycle.schemaVersion !== "kletia_workflow_lifecycle_v1" ||
          !["failed", "indeterminate", "recovery_required"].includes(
            String(rawLifecycle.status),
          ) ||
          typeof rawLifecycle.code !== "string" ||
          typeof rawLifecycle.retryable !== "boolean" ||
          rawLifecycle.silentRetryAllowed !== false ||
          typeof rawLifecycle.reason !== "string" ||
          typeof rawLifecycle.operatorAction !== "string"
        ) {
          throw new Error("The recovered lifecycle classification is invalid.");
        }
        restoredLifecycle = rawLifecycle as unknown as WorkflowLifecycleClassificationV1;
      }
      privateMaterialRef.current = {
        amount: normalizedAmount,
        recipient: restoredMaterial.recipient,
        amountSalt,
        recipientSalt,
      };
      setAmount(normalizedAmount);
      setPlan(restoredPlan);
      setResolvedIntentReceipt({
        schemaVersion: "kletia_resolved_intent_receipt_v1",
        workflowId: restoredPlan.workflowPlan.workflowId,
        requestId: restoredPlan.requestId,
        planCoreSha256:
          restoredPlan.workflowPlan.authorizationBoundary.planCoreSha256,
        workflowToken: restoredPlan.workflowToken,
        scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
        selectedRoute: restoredPlan.workflowPlan.selectedRoute,
        protectedAmount: normalizedAmount,
      });
      setManifestAuthorization(restoredAuthorization);
      setManifestSigned(Boolean(restoredAuthorization));
      setExecutionReceipt(null);
      setLifecycle(restoredLifecycle);
      setSubmissionEvidence(restoredSubmissions);
      setPublicOpeningApproved(false);
      const currentRestoredStep =
        restoredPlan.workflowPlan.steps[restoredPlan.workflowPlan.currentStepIndex];
      const currentRestoredEvidence = currentRestoredStep
        ? restoredSubmissions[currentRestoredStep.id]
        : undefined;
      setIndeterminateHash(
        currentRestoredEvidence &&
          (currentRestoredEvidence.state === "indeterminate" ||
            currentRestoredEvidence.state === "recovery_required")
          ? currentRestoredEvidence.transactionHash
          : null,
      );
      refreshPrivacyEvidence();
      setRecoveryStatus(
        "Local recovery completed and all commitments matched. This recovery step made no API request; any earlier approved public-checkpoint openings remain in the workflow disclosure record.",
      );
    } catch (caught) {
      privateMaterialRef.current = null;
      refreshPrivacyEvidence();
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const signPlanManifest = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      if (plan.workflowPlan.expiresAt <= Date.now()) {
        throw new Error("The authorization window expired. Refresh the plan before signing.");
      }
      const message = plan.workflowPlan.authorizationBoundary.manifestMessage;
      const sealedArcWallet = getAddress(sealedWallet(plan, "arc_wallet"));
      const sealedArbitrumWallet = getAddress(
        sealedWallet(plan, "arbitrum_sepolia_wallet"),
      );
      if (
        !evmAddress ||
        getAddress(evmAddress) !== sealedArcWallet ||
        getAddress(evmAddress) !== sealedArbitrumWallet
      ) {
        throw new Error("The active EVM wallet no longer matches the sealed workflow.");
      }
      if (plan.workflowPlan.selectedRoute === "direct_cctp") {
        const signature = await signEvmMessage({ message });
        setManifestAuthorization({
          family: "evm",
          signer: evmAddress || "",
          signature,
        });
        setManifestSigned(true);
        return;
      }
      if (stellarAddress !== sealedWallet(plan, "stellar_wallet")) {
        throw new Error("The active Stellar wallet no longer matches the sealed workflow.");
      }
      const signed = await signMessage(message, {
        networkPassphrase: Networks.TESTNET,
        address: stellarAddress,
      });
      if (signed.error || !signed.signedMessage) {
        throw new Error(signed.error?.message || "Manifest signature was rejected.");
      }
      if (signed.signerAddress !== stellarAddress) {
        throw new Error("Freighter manifest signer changed during approval.");
      }
      setManifestAuthorization({
        family: "stellar",
        signer: signed.signerAddress,
        signature:
          typeof signed.signedMessage === "string"
            ? signed.signedMessage
            : btoa(String.fromCharCode(...signed.signedMessage)),
      });
      setManifestSigned(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const latestAmountAtomic = (beforeOrder: number): bigint => {
    if (!plan) throw new Error("Workflow plan is missing.");
    for (let index = beforeOrder - 2; index >= 0; index -= 1) {
      const value = plan.workflowPlan.steps[index]?.result?.amountAtomic;
      if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
    }
    throw new Error("A verified upstream amount is required before this step.");
  };

  const previousAttestation = (beforeOrder: number) => {
    if (!plan) throw new Error("Workflow plan is missing.");
    const result = [...plan.workflowPlan.steps]
      .slice(0, beforeOrder - 1)
      .reverse()
      .find((step) => step.action === "cctp_attestation" && step.result?.message)
      ?.result;
    if (!result?.message || !result.attestation) {
      throw new Error("A verified Circle attestation is required.");
    }
    return { message: result.message as Hex, attestation: result.attestation as Hex };
  };

  const cctpLegFee = (sourceDomain: 26 | 27, destinationDomain: 3 | 27) => {
    if (!plan) throw new Error("Workflow plan is missing.");
    const route = plan.workflowPlan.routeCandidates.find(
      (candidate) => candidate.kind === plan.workflowPlan.selectedRoute,
    );
    if (!route || route.liveEvidence.quoteExpiresAt <= Date.now()) {
      throw new Error("The Circle fee quote expired. Advance or rebuild the workflow to refresh it.");
    }
    const leg = route?.liveEvidence.cctpLegs.find(
      (candidate) =>
        candidate.sourceDomain === sourceDomain &&
        candidate.destinationDomain === destinationDomain,
    );
    if (!leg) throw new Error("The exact Circle fee leg is missing from the sealed route.");
    return leg.standardFeeBps;
  };

  const advanceWorkflow = async (
    txHash?: string,
    includeAmountCommitmentSalt = false,
  ) => {
    if (!plan) throw new Error("Workflow plan is missing.");
    const material = privateMaterialRef.current;
    const current = plan.workflowPlan.steps[plan.workflowPlan.currentStepIndex];
    if (!current) throw new Error("The sealed workflow has no current checkpoint.");
    if (includeAmountCommitmentSalt && !publicOpeningApproved) {
      throw new Error(
        "Approve the one-time public checkpoint disclosure before opening the commitments.",
      );
    }
    if (includeAmountCommitmentSalt && (!material || !txHash)) {
      throw new Error(
        "A commitment opening requires the exact local material and public transaction hash.",
      );
    }
    const requestBody = {
      workflowToken: plan.workflowToken,
      requestId: plan.requestId,
      ...(txHash ? { txHash } : {}),
      ...(includeAmountCommitmentSalt && material
        ? {
            amountCommitmentSalt: privateSaltToHex(material.amountSalt),
            recipientCommitmentSalt: privateSaltToHex(material.recipientSalt),
          }
        : {}),
      ...(manifestAuthorization ? { manifestAuthorization } : {}),
    };
    const responsePromise = includeAmountCommitmentSalt && material && txHash
      ? fetchWithCommitmentOpeningDisclosure({
          url: `${BACKEND_URL}/api/workflows/v2/advance`,
          workflowId: plan.workflowPlan.workflowId,
          stepId: current.id,
          requestId: plan.requestId,
          transactionHash: txHash,
          body: requestBody,
          openings: [
            {
              binding: "amountCommitmentSalt",
              value: privateSaltToHex(material.amountSalt),
            },
            {
              binding: "recipientCommitmentSalt",
              value: privateSaltToHex(material.recipientSalt),
            },
          ],
          headers: { "Content-Type": "application/json" },
        })
      : fetch(`${BACKEND_URL}/api/workflows/v2/advance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });
    if (includeAmountCommitmentSalt) {
      setPublicOpeningApproved(false);
      refreshPrivacyEvidence();
    }
    let body: unknown;
    try {
      body = await readJson(await responsePromise);
    } catch (caught) {
      if (
        caught instanceof ApiResponseError &&
        isWorkflowLifecycleErrorResponse(caught.body, {
          requestId: plan.requestId,
          workflowId: plan.workflowPlan.workflowId,
          amountCommitment: plan.workflowPlan.privacy.amountCommitment,
          recipientCommitment: plan.workflowPlan.privacy.recipientCommitment,
          arcAddress: evmAddress,
          arbitrumSepoliaAddress: evmAddress,
          ...(plan.workflowPlan.selectedRoute === "direct_cctp"
            ? {}
            : { stellarAddress }),
        })
      ) {
        const failure = caught.body;
        setPlan({
          success: true,
          status: "success",
          executionKind: "workflow_plan_v2",
          network: "stellar",
          chainRef: "stellar:testnet",
          requestId: plan.requestId,
          message: failure.message,
          workflowPlan: failure.workflowPlan,
          workflowToken: failure.workflowToken,
        });
        setLifecycle(failure.lifecycle);
        if (txHash) {
          setSubmissionEvidence((existing) => ({
            ...existing,
            [current.id]: {
              stepId: current.id,
              network: current.network,
              transactionHash: txHash,
              state: failure.lifecycle.status,
              observedAt: new Date().toISOString(),
            },
          }));
          if (failure.lifecycle.status === "indeterminate") {
            setIndeterminateHash(txHash);
          }
        }
        refreshPrivacyEvidence();
        throw new WorkflowLifecycleHandledError(
          `${failure.message} ${failure.lifecycle.operatorAction}`.trim(),
          failure.lifecycle,
        );
      }
      refreshPrivacyEvidence();
      throw caught;
    }
    if (
      !isWorkflowAdvanceV2Response(body, {
        requestId: plan.requestId,
        workflowId: plan.workflowPlan.workflowId,
        amountCommitment: plan.workflowPlan.privacy.amountCommitment,
        recipientCommitment: plan.workflowPlan.privacy.recipientCommitment,
        arcAddress: evmAddress,
        arbitrumSepoliaAddress: evmAddress,
        ...(plan.workflowPlan.selectedRoute === "direct_cctp"
          ? {}
          : { stellarAddress }),
      })
    ) {
      throw new Error("Advanced workflow failed its sealed response boundary.");
    }
    const nextPlan: WorkflowV2Response = {
      success: true,
      status: "success",
      executionKind: "workflow_plan_v2",
      network: "stellar",
      chainRef: "stellar:testnet",
      requestId: plan.requestId,
      message: body.message,
      workflowPlan: body.workflowPlan,
      workflowToken: body.workflowToken,
    };
    const authorizationPreserved =
      body.workflowPlan.authorizationBoundary.planCoreSha256 ===
        plan.workflowPlan.authorizationBoundary.planCoreSha256 &&
      Boolean(body.workflowPlan.manifestAuthorization);
    setPlan(nextPlan);
    setLifecycle(null);
    if (txHash) {
      setSubmissionEvidence((existing) => ({
        ...existing,
        [current.id]: {
          stepId: current.id,
          network: current.network,
          transactionHash: txHash,
          state: "confirmed",
          observedAt: new Date().toISOString(),
        },
      }));
    }
    if (!authorizationPreserved) {
      setManifestAuthorization(null);
      setManifestSigned(false);
      setRecoveryStatus(
        "The sealed plan core changed (for example, a refreshed live fee quote). Review and sign the updated manifest before continuing.",
      );
    }
    if (body.executionReceipt) {
      setExecutionReceipt(body.executionReceipt);
    }
    refreshPrivacyEvidence();
  };

  const refreshWorkflowAuthorization = async () => {
    if (!plan) throw new Error("Workflow plan is missing.");
    const response = await fetch(
      `${BACKEND_URL}/api/workflows/v2/refresh-authorization`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowToken: plan.workflowToken,
          requestId: plan.requestId,
        }),
      },
    );
    const body = await readJson(response);
    if (
      !isWorkflowAdvanceV2Response(body, {
        requestId: plan.requestId,
        workflowId: plan.workflowPlan.workflowId,
        amountCommitment: plan.workflowPlan.privacy.amountCommitment,
        recipientCommitment: plan.workflowPlan.privacy.recipientCommitment,
        arcAddress: evmAddress,
        arbitrumSepoliaAddress: evmAddress,
        ...(plan.workflowPlan.selectedRoute === "direct_cctp"
          ? {}
          : { stellarAddress }),
      }) ||
      body.terminal
    ) {
      throw new Error("Refreshed workflow failed its sealed response boundary.");
    }
    setPlan({
      success: true,
      status: "success",
      executionKind: "workflow_plan_v2",
      network: "stellar",
      chainRef: "stellar:testnet",
      requestId: plan.requestId,
      message: body.message,
      workflowPlan: body.workflowPlan,
      workflowToken: body.workflowToken,
    });
    setManifestAuthorization(null);
    setManifestSigned(false);
    setRecoveryStatus(body.message);
  };

  const sendEvmStep = async (
    step: WorkflowStepV2,
    call: BrowserTransactionCall,
    chainId: 5_042_002 | 421_614,
    expectedAccount: Address,
  ): Promise<string> => {
    await switchChainAsync({ chainId });
    if (!evmAddress || getAddress(evmAddress) !== expectedAccount) {
      throw new Error("The active EVM wallet changed before transaction preparation.");
    }
    const client = chainId === 5_042_002 ? arcClient : arbitrumSepoliaClient;
    if (!client) throw new Error("The selected Testnet RPC client is unavailable.");
    await client.estimateGas({
      account: expectedAccount,
      to: call.target,
      data: call.calldata,
      value: call.value,
    });
    const hash = await sendTransactionAsync({
      account: expectedAccount,
      to: call.target,
      data: call.calldata,
      value: call.value,
      chainId,
    });
    recordSubmission(step, hash, "submitted");
    const receipt = await client.waitForTransactionReceipt({ hash }).catch(() => {
      recordSubmission(step, hash, "indeterminate");
      throw new StellarTransactionIndeterminateError(hash);
    });
    if (receipt.status !== "success") {
      recordSubmission(step, hash, "failed");
      throw new Error("The Testnet transaction reverted. Its hash was recorded and it was not resubmitted.");
    }
    recordSubmission(step, hash, "confirmed");
    return hash;
  };

  const executeCurrentStep = async () => {
    if (!plan || !manifestSigned || !evmAddress) return;
    const current = plan.workflowPlan.steps[plan.workflowPlan.currentStepIndex];
    const material = privateMaterialRef.current;
    let submittedHash: string | null = null;
    setExecuting(true);
    setError(null);
    try {
      if (!current || !material) {
        throw new Error(
          "Private workflow material is no longer available; create a new plan.",
        );
      }
      const existingSubmission = submissionEvidence[current.id];
      if (
        isFinancialStep(current) &&
        (Boolean(current.result) ||
          financiallySubmittedStates.has(current.status as LocalSubmissionState) ||
          (existingSubmission
            ? financiallySubmittedStates.has(existingSubmission.state)
            : false))
      ) {
        throw new Error(
          "This financial checkpoint already has submission evidence. Use status recovery; Kletia will not ask the wallet to send it again.",
        );
      }
      if (
        current.status === "failed" ||
        current.status === "recovery_required"
      ) {
        throw new Error(
          "This checkpoint is in a terminal recovery state. Review the lifecycle instructions before compiling a replacement workflow.",
        );
      }
      const sealedArcWallet = getAddress(sealedWallet(plan, "arc_wallet"));
      const sealedArbitrumWallet = getAddress(
        sealedWallet(plan, "arbitrum_sepolia_wallet"),
      );
      if (
        getAddress(evmAddress) !== sealedArcWallet ||
        getAddress(evmAddress) !== sealedArbitrumWallet
      ) {
        throw new Error("The active EVM wallet no longer matches the sealed workflow.");
      }
      const sealedStellarWallet =
        plan.workflowPlan.selectedRoute === "direct_cctp"
          ? ""
          : sealedWallet(plan, "stellar_wallet");
      if (sealedStellarWallet) {
        const activeFreighter = await getFreighterAddress();
        if (
          activeFreighter.error ||
          activeFreighter.address !== sealedStellarWallet ||
          stellarAddress !== sealedStellarWallet
        ) {
          throw new Error("The active Freighter account no longer matches the sealed workflow.");
        }
      }
      if (current.target && current.action !== "cctp_attestation") {
        const expectedTarget = current.target;
        if (current.network !== "stellar_testnet" && !/^0x[a-f\d]{40}$/iu.test(expectedTarget)) {
          throw new Error("The sealed EVM target is invalid.");
        }
      }
      if (indeterminateHash) {
        throw new Error("A submitted transaction has an indeterminate result. Recover its status before any new submission.");
      }
      const selectedRoute = plan.workflowPlan.routeCandidates.find(
        (candidate) => candidate.kind === plan.workflowPlan.selectedRoute,
      );
      const pendingBurnQuoteExpired =
        current.action === "cctp_burn" &&
        (!selectedRoute || selectedRoute.liveEvidence.quoteExpiresAt <= Date.now());
      if (
        (plan.workflowPlan.expiresAt <= Date.now() &&
          current.action !== "cctp_attestation") ||
        pendingBurnQuoteExpired
      ) {
        await refreshWorkflowAuthorization();
        return;
      }
      if (current.action === "cctp_attestation" || current.action === "borrow_capacity") {
        await advanceWorkflow();
        return;
      }
      let hash: string;
      if (current.network === "arc_testnet") {
        const call =
          current.action === "cctp_approve"
            ? buildArcCctpApproval(material.amount)
            : buildArcCctpBurn({
                amount: material.amount,
                route: plan.workflowPlan.selectedRoute,
                stellarRecipient: sealedStellarWallet,
                arbitrumRecipient: sealedArbitrumWallet,
                standardFeeBps: cctpLegFee(
                  26,
                  plan.workflowPlan.selectedRoute === "direct_cctp" ? 3 : 27,
                ),
              });
        if (current.target && getAddress(call.target) !== getAddress(current.target)) {
          throw new Error("The prepared Arc call target does not match the sealed step.");
        }
        hash = await sendEvmStep(current, call, 5_042_002, sealedArcWallet);
        submittedHash = hash;
        await advanceWorkflow(hash, current.action === "cctp_approve");
        return;
      }
      if (current.network === "stellar_testnet") {
        const expectedStellarBinding =
          current.action === "cctp_mint"
            ? {
                target: TESTNET_CCTP.stellar.forwarder,
                method: "mint_and_forward",
                sourceDomain: 26,
                destinationDomain: 27,
              }
            : current.action === "cctp_approve"
              ? {
                  target: TESTNET_CCTP.stellar.usdcSac,
                  method: "approve",
                  sourceDomain: 27,
                  destinationDomain: 3,
                }
              : current.action === "cctp_burn"
                ? {
                    target: TESTNET_CCTP.stellar.tokenMessengerMinter,
                    method: "deposit_for_burn",
                    sourceDomain: 27,
                    destinationDomain: 3,
                  }
                : null;
        if (
          !expectedStellarBinding ||
          current.target !== expectedStellarBinding.target ||
          current.binding?.protocol !== "cctp_v2" ||
          current.binding.method !== expectedStellarBinding.method ||
          current.binding.sourceDomain !== expectedStellarBinding.sourceDomain ||
          current.binding.destinationDomain !==
            expectedStellarBinding.destinationDomain
        ) {
          throw new Error(
            "The sealed Stellar contract or CCTP domain binding does not match the reviewed runtime registry.",
          );
        }
        const amount = formatUnits(latestAmountAtomic(current.order), 6);
        let unsignedXdr: string;
        if (current.action === "cctp_mint") {
          const attestation = previousAttestation(current.order);
          unsignedXdr = await prepareStellarMintAndForward({
            source: sealedStellarWallet,
            ...attestation,
          });
        } else if (current.action === "cctp_approve") {
          unsignedXdr = await prepareStellarCctpApproval({
            source: sealedStellarWallet,
            amount,
          });
        } else if (current.action === "cctp_burn") {
          unsignedXdr = await prepareStellarCctpBurn({
            source: sealedStellarWallet,
            amount,
            arbitrumRecipient: sealedArbitrumWallet,
            standardFeeBps: cctpLegFee(27, 3),
          });
        } else {
          throw new Error("This Stellar action is not executable in the current beta.");
        }
        const signed = await signTransaction(unsignedXdr, {
          networkPassphrase: Networks.TESTNET,
          address: sealedStellarWallet,
        });
        if (
          signed.error ||
          !signed.signedTxXdr ||
          signed.signerAddress !== sealedStellarWallet
        ) {
          throw new Error(signed.error?.message || "Freighter rejected the transaction.");
        }
        hash = await submitSignedStellarTransaction(
          signed.signedTxXdr,
          unsignedXdr,
        );
        submittedHash = hash;
        recordSubmission(current, hash, "confirmed");
        await advanceWorkflow(hash);
        return;
      }
      const amountAtomic = latestAmountAtomic(current.order);
      let call: BrowserTransactionCall;
      if (current.action === "cctp_mint") {
        call = buildArbitrumCctpMint(
          previousAttestation(current.order).message,
          previousAttestation(current.order).attestation,
        );
      } else if (current.action === "aave_approve") {
        call = buildArbitrumAaveApproval(amountAtomic);
      } else if (current.action === "aave_supply") {
        call = buildArbitrumAaveSupply(amountAtomic, sealedArbitrumWallet);
      } else {
        throw new Error("This Arbitrum Sepolia action is not executable in the current beta.");
      }
      if (current.target && getAddress(call.target) !== getAddress(current.target)) {
        throw new Error("The prepared Arbitrum call target does not match the sealed step.");
      }
      hash = await sendEvmStep(current, call, 421_614, sealedArbitrumWallet);
      submittedHash = hash;
      await advanceWorkflow(hash);
    } catch (caught) {
      if (caught instanceof StellarTransactionIndeterminateError) {
        setIndeterminateHash(caught.transactionHash);
        if (current) {
          recordSubmission(current, caught.transactionHash, "indeterminate");
        }
      } else if (caught instanceof WorkflowLifecycleHandledError) {
        if (
          current &&
          submittedHash &&
          (caught.lifecycle.status === "indeterminate" ||
            caught.lifecycle.status === "recovery_required")
        ) {
          setIndeterminateHash(submittedHash);
          recordSubmission(current, submittedHash, caught.lifecycle.status);
        }
      } else if (current && submittedHash) {
        // The financial transaction exists, but the workflow API did not produce
        // a sealed classification. Treat the synchronization as indeterminate;
        // the only safe next action is a status query for this exact hash.
        setIndeterminateHash(submittedHash);
        recordSubmission(current, submittedHash, "indeterminate");
      }
      setError(errorMessage(caught));
    } finally {
      setExecuting(false);
    }
  };

  const recoverIndeterminateStep = async () => {
    if (!indeterminateHash || !plan) return;
    const current = plan.workflowPlan.steps[plan.workflowPlan.currentStepIndex];
    if (!current) return;
    setExecuting(true);
    setError(null);
    try {
      const openingAlreadyDisclosed = egressReport.approvedDisclosures.some(
        (entry) =>
          entry.kind === "public_checkpoint_commitment_opening" &&
          entry.workflowId === plan.workflowPlan.workflowId &&
          entry.stepId === current.id &&
          entry.requestId === plan.requestId &&
          entry.transactionHash.toLowerCase() === indeterminateHash.toLowerCase(),
      );
      await advanceWorkflow(
        indeterminateHash,
        current.id === "step-1" &&
          current.action === "cctp_approve" &&
          !openingAlreadyDisclosed,
      );
      setIndeterminateHash(null);
    } catch (caught) {
      setError(`Status recovery did not confirm the checkpoint yet. No transaction was resent. ${errorMessage(caught)}`);
    } finally {
      setExecuting(false);
    }
  };

  const hasUsdcTrustline = Boolean(
    portfolio?.assets.some(
      (entry) => entry.asset.symbol === "USDC" && entry.authorized,
    ),
  );
  const currentStep = plan?.workflowPlan.steps[plan.workflowPlan.currentStepIndex];
  const currentSubmission = currentStep
    ? submissionEvidence[currentStep.id]
    : undefined;
  const currentFinancialSubmissionLocked = Boolean(
    isFinancialStep(currentStep) &&
      (currentStep?.result ||
        financiallySubmittedStates.has(
          currentStep?.status as LocalSubmissionState,
        ) ||
        (currentSubmission &&
          financiallySubmittedStates.has(currentSubmission.state))),
  );
  const currentTerminalLifecycle = Boolean(
    currentStep &&
      (currentStep.status === "failed" ||
        currentStep.status === "recovery_required"),
  );
  const currentOpeningAlreadyDisclosed = Boolean(
    plan &&
      currentStep &&
      egressReport.approvedDisclosures.some(
        (entry) =>
          entry.kind === "public_checkpoint_commitment_opening" &&
          entry.workflowId === plan.workflowPlan.workflowId &&
          entry.stepId === currentStep.id &&
          entry.requestId === plan.requestId,
      ),
  );
  const currentRequiresOpeningApproval = Boolean(
    currentStep?.id === "step-1" &&
      currentStep.action === "cctp_approve" &&
      !currentOpeningAlreadyDisclosed,
  );
  const workflowHasUnresolvedSubmission = Object.values(submissionEvidence).some(
    (entry) =>
      entry.state === "submitted" ||
      entry.state === "indeterminate" ||
      entry.state === "recovery_required",
  );
  const privacyBudget = React.useMemo(
    () => (plan ? derivePrivacyBudgetView(plan.workflowPlan, egressReport) : null),
    [egressReport, plan],
  );
  const disclosureDiff = React.useMemo(
    () => (plan ? deriveDisclosureDiffView(plan.workflowPlan, egressReport) : null),
    [egressReport, plan],
  );
  const currentActionLabel =
    currentStep?.action === "cctp_attestation"
      ? "Check Circle attestation"
      : currentStep?.action === "borrow_capacity"
        ? "Read theoretical borrow capacity"
        : "Review and sign current checkpoint";
  const directWorkflowReady =
    readiness?.routes?.direct_cctp?.ready ?? readiness?.status === "ready";
  const stellarWorkflowReady =
    readiness?.routes?.stellar_centered_public?.ready === true;
  const publicWorkflowReady =
    routePreference === "direct_cctp"
      ? directWorkflowReady
      : routePreference === "stellar_centered_public"
        ? stellarWorkflowReady
        : directWorkflowReady || stellarWorkflowReady;

  return (
    <main className="stellar-hub">
      <div className="stellar-shell">
        <section className="stellar-hero" aria-labelledby="stellar-dashboard-title">
          <div className="stellar-hero-copy">
            <div className="stellar-kicker-row">
              <span className="stellar-kicker">Kletia Omni-Engine</span>
              <span className="stellar-kicker">Testnet</span>
            </div>
            <h1 id="stellar-dashboard-title">Stellar Dashboard</h1>
            <p>
              Send, swap, protect selected details, and follow multichain
              checkpoints from the same intent-first workspace used across
              Kletia.
            </p>
            <div className="stellar-status-row" aria-label="Stellar network status">
              <span className="stellar-kicker">Classic + Soroban</span>
              <span className="stellar-kicker">
                {readiness?.status === "ready" ? "Live services ready" : "Checking live services"}
              </span>
            </div>
          </div>

          <div className="stellar-capability-board">
            <p className="stellar-eyebrow">Active account</p>
            <strong className="stellar-hero-account-state">
              {stellarAddress
                ? "Freighter connected"
                : evmAddress
                  ? "EVM wallet linked"
                  : "Not connected"}
            </strong>
            <p className="stellar-hero-balance">
              {portfolio
                ? portfolio.assets
                    .slice(0, 2)
                    .map((entry) => `${entry.balance} ${entry.asset.symbol}`)
                    .join(" · ")
                : "Live balances appear after account access."}
            </p>
            <button
              type="button"
              className="stellar-button"
              data-variant="primary"
              onClick={() => setWorkspaceView("wallet")}
            >
              <Wallet aria-hidden="true" />
              Open wallet actions
            </button>
          </div>
        </section>

        <nav className="stellar-workspace-nav" aria-label="Stellar workspace">
          {(
            [
              ["overview", "Overview", LayoutDashboard],
              ["wallet", "Wallet & actions", Wallet],
              ["plan", "Plan & track", ListChecks],
              ["advanced", "Advanced", Settings2],
            ] as const
          ).map(([view, label, Icon]) => (
            <button
              key={view}
              type="button"
              aria-current={workspaceView === view ? "page" : undefined}
              onClick={() => setWorkspaceView(view)}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        {stellarIntentResolution ? (
          <section
            className="stellar-intent-result"
            data-state={stellarIntentResolution.kind === "unknown" ? "needs_input" : "ready"}
            aria-live="polite"
          >
            <div>
              {stellarIntentResolution.kind === "unknown" ? (
                <AlertTriangle aria-hidden="true" />
              ) : (
                <CheckCircle2 aria-hidden="true" />
              )}
              <span>
                <strong>{stellarIntentResolution.title}</strong>
                <small>{stellarIntentResolution.summary}</small>
              </span>
            </div>
            <p>{stellarIntentResolution.nextStep}</p>
          </section>
        ) : null}

        {error ? (
          <section
            className="stellar-error stellar-global-error"
            role="alert"
            aria-live="assertive"
          >
            <strong>Action stopped safely</strong>
            <p>{error}</p>
            <div className="stellar-error-actions">
              {error.includes("Freighter") ? (
                <>
                  <a
                    href={FREIGHTER_EXTENSION_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="stellar-button"
                    data-variant="primary"
                  >
                    Open official Freighter
                  </a>
                  <button
                    type="button"
                    onClick={() => void connectFreighter()}
                    disabled={busy}
                    className="stellar-button"
                  >
                    {busy ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw aria-hidden="true" />
                    )}
                    Retry connection
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setError(null)}
                className="stellar-button"
              >
                Dismiss and review
              </button>
            </div>
          </section>
        ) : null}

        {workspaceView === "overview" || workspaceView === "wallet" ? (
          <PasskeyAccountCard evmAddress={evmAddress} />
        ) : null}

        {workspaceView === "overview" ? (
          <div className="stellar-overview">
            <section className="stellar-overview-metrics" aria-label="Stellar summary">
              <article>
                <span>Classic compatibility</span>
                <strong>{stellarAddress ? "Freighter connected" : "Optional"}</strong>
                <p>
                  {stellarAddress
                    ? `${stellarAddress.slice(0, 6)}…${stellarAddress.slice(-6)}`
                    : "Use Freighter only for Classic SDEX, trustlines, memo payments and existing G-account workflows."}
                </p>
                <button
                  type="button"
                  onClick={() => void connectFreighter()}
                  disabled={busy}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
                  {stellarAddress ? "Refresh Freighter" : "Connect optional Freighter"}
                </button>
              </article>
              <article>
                <span>Live balances</span>
                <strong className="stellar-balance-summary">
                  {portfolio
                    ? portfolio.assets
                        .map((entry) => `${entry.balance} ${entry.asset.symbol}`)
                        .join(" · ")
                    : "Connect to load"}
                </strong>
                <p>Read directly from Stellar Testnet. No mock balances.</p>
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceView("wallet");
                    setActiveWalletTool("portfolio");
                  }}
                >
                  View wallet
                  <ChevronRight aria-hidden="true" />
                </button>
              </article>
              <article>
                <span>Privacy, plainly</span>
                <strong>Optional, not magical</strong>
                <p>
                  Private XLM/EURC payments are separate. Ordinary Stellar,
                  CCTP, Base, and Arbitrum activity stays public.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceView("wallet");
                    setActiveWalletTool("private_payment");
                  }}
                >
                  Open private payments
                  <ChevronRight aria-hidden="true" />
                </button>
              </article>
            </section>

            <section className="stellar-purpose" aria-labelledby="stellar-purpose-title">
              <div className="stellar-section-heading">
                <div>
                  <p className="stellar-eyebrow">One network, three useful jobs</p>
                  <h2 id="stellar-purpose-title">What Stellar does in Kletia</h2>
                </div>
                <Sparkles aria-hidden="true" />
              </div>
              <div className="stellar-purpose-list">
                <article>
                  <Send aria-hidden="true" />
                  <div>
                    <strong>Pay and swap</strong>
                    <p>Send XLM or USDC and compare live SDEX paths with one intent.</p>
                  </div>
                  <button
                    type="button"
                    aria-label="Open Stellar wallet actions"
                    onClick={() => setWorkspaceView("wallet")}
                  >
                    <ArrowRight aria-hidden="true" />
                  </button>
                </article>
                <article>
                  <ShieldCheck aria-hidden="true" />
                  <div>
                    <strong>Protect selected details</strong>
                    <p>Keep planning fields off the AI, or use the separate private payment pool.</p>
                  </div>
                  <button
                    type="button"
                    aria-label="Open private Stellar payments"
                    onClick={() => {
                      setWorkspaceView("wallet");
                      setActiveWalletTool("private_payment");
                    }}
                  >
                    <ArrowRight aria-hidden="true" />
                  </button>
                </article>
                <article>
                  <Network aria-hidden="true" />
                  <div>
                    <strong>Coordinate complex plans</strong>
                    <p>Record policy and checkpoints while execution remains on the correct network.</p>
                  </div>
                  <button
                    type="button"
                    aria-label="Open multichain planning"
                    onClick={() => setWorkspaceView("plan")}
                  >
                    <ArrowRight aria-hidden="true" />
                  </button>
                </article>
              </div>
            </section>
          </div>
        ) : null}

        {workspaceView === "advanced" ? (
          <section className="stellar-panel stellar-advanced-summary" aria-labelledby="stellar-advanced-title">
            <div className="stellar-panel-header">
              <div>
                <p className="stellar-eyebrow">Technical controls</p>
                <h2 id="stellar-advanced-title">Advanced infrastructure</h2>
              </div>
              <Settings2 aria-hidden="true" />
            </div>
            <p className="stellar-advanced-intro">
              These controls explain policy proofs, disclosure, solver coordination,
              and recovery. Normal payments and swaps do not require this screen.
            </p>
            <div className="stellar-capability-list" aria-live="polite">
              <div className="stellar-capability-item">
                <div><strong>Public multichain workflow</strong><small>CCTP and Aave checkpoints</small></div>
                <StatusPill state={publicWorkflowReady ? "executable" : "unavailable"} />
              </div>
              <div className="stellar-capability-item">
                <div><strong>Planning isolation</strong><small>Browser egress guard with measured limits</small></div>
                <StatusPill state={egressReport.violations.length > 0 ? "unavailable" : "read_only"} />
              </div>
              <div className="stellar-capability-item">
                <div><strong>Shielded payment pool</strong><small>XLM/EURC Testnet alpha, separate from public execution</small></div>
                <StatusPill state={readiness?.capabilities?.privatePayments?.readiness?.xlmLifecycle === "available" ? "executable" : "unavailable"} />
              </div>
            </div>
          </section>
        ) : null}

        {workspaceView === "advanced" ? <ControlPlaneOverview /> : null}
        {workspaceView === "advanced" ? (
          <CanonicalWorkflowV4Panel
            key={
              resolvedIntentReceipt
                ? `v4:${resolvedIntentReceipt.workflowId}:${resolvedIntentReceipt.planCoreSha256}`
                : "unresolved-v4-intent"
            }
            stellarAddress={stellarAddress}
            evmAddress={evmAddress}
            resolvedIntentReceipt={
              plan && resolvedIntentReceipt?.workflowId === plan.workflowPlan.workflowId
                ? {
                    ...resolvedIntentReceipt,
                    planCoreSha256: plan.workflowPlan.authorizationBoundary.planCoreSha256,
                    workflowToken: plan.workflowToken,
                    selectedRoute: plan.workflowPlan.selectedRoute,
                  }
                : null
            }
          />
        ) : null}

        {workspaceView === "wallet" ? (
          <section className="stellar-action-picker" aria-labelledby="stellar-action-picker-title">
            <div className="stellar-section-heading">
              <div>
                <p className="stellar-eyebrow">Manual access when you want it</p>
                <h2 id="stellar-action-picker-title">Wallet & actions</h2>
              </div>
              <Wallet aria-hidden="true" />
            </div>
            <div role="group" aria-label="Choose a Stellar action">
              {(
                [
                  ["portfolio", "Balances", LayoutDashboard],
                  ["transfer", "Send", Send],
                  ["swap", "Swap", ArrowLeftRight],
                  ["trustline", "Add USDC asset", ShieldCheck],
                  ["private_payment", "Private pay", Sparkles],
                ] as const
              ).map(([tool, label, Icon]) => (
                <button
                  key={tool}
                  type="button"
                  aria-pressed={activeWalletTool === tool}
                  onClick={() => setActiveWalletTool(tool)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {workspaceView === "wallet" && activeWalletTool === "private_payment" ? (
          <ShieldedPaymentsPanel
            key={stellarAddress || "stellar-wallet-disconnected"}
            stellarAddress={stellarAddress}
          />
        ) : null}

        <div
          className="stellar-grid"
          data-view={workspaceView}
          hidden={workspaceView === "overview"}
        >
          <section
            className="stellar-panel"
            aria-labelledby="intent-composer-title"
            hidden={workspaceView !== "plan"}
          >
            <div className="stellar-panel-header">
              <div>
                <p className="stellar-eyebrow">Multichain plan</p>
                <h2 id="intent-composer-title">Review what you want to happen</h2>
              </div>
              <EyeOff aria-hidden="true" />
            </div>

            <div className="stellar-form" aria-busy={busy}>
              <label className="stellar-label" htmlFor="stellar-semantic-goal">
                Goal
                <textarea
                  id="stellar-semantic-goal"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setSelectedScenarioId(null);
                    setStructuredSelectionConfirmed(false);
                    setIntentClarification(null);
                  }}
                  rows={5}
                  className="stellar-textarea"
                />
                <span className="stellar-field-help">
                  Kletia reads this goal locally first and asks before preparing any
                  money-moving step.
                </span>
              </label>

              <div className="stellar-field-grid">
                <label className="stellar-label" htmlFor="stellar-private-budget">
                  Local USDC budget
                  <span className="stellar-input-group">
                    <input
                      id="stellar-private-budget"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      className="stellar-input"
                    />
                    <span className="stellar-input-suffix">USDC</span>
                  </span>
                  <span className="stellar-field-help">
                    Hidden from the language model during planning. Public execution
                    still reveals the amount onchain.
                  </span>
                </label>
                <label className="stellar-label" htmlFor="stellar-final-recipient">
                  Destination wallet
                  <input
                    id="stellar-final-recipient"
                    value={evmAddress || ""}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    className="stellar-input"
                    placeholder="Connect an EVM wallet"
                  />
                  <span className="stellar-field-help">
                    Used to build the exact reviewed transaction; excluded from the
                    AI request.
                  </span>
                </label>
              </div>

              {intentClarification ? (
                <PrivateIntentClarificationCard
                  clarification={intentClarification}
                  selectedScenarioId={selectedScenarioId}
                  routePreference={routePreference}
                  directRouteReady={directWorkflowReady}
                  stellarRouteReady={stellarWorkflowReady}
                  onSelect={applyIntentClarification}
                  onEditGoal={() => {
                    setIntentClarification(null);
                    setSelectedScenarioId(null);
                    setStructuredSelectionConfirmed(false);
                    requestAnimationFrame(() =>
                      document.getElementById("stellar-semantic-goal")?.focus(),
                    );
                  }}
                />
              ) : null}

              <details className="stellar-plan-settings">
                <summary>
                  <span>
                    <strong>Route, risk and privacy settings</strong>
                    <small>Automatic safe defaults are selected</small>
                  </span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <div className="stellar-plan-settings-body">
              <fieldset>
                <legend className="stellar-legend">Route</legend>
                <div className="stellar-route-grid">
                  {(["auto", ...Object.keys(routeLabels)] as RoutePreference[]).map((kind) => {
                    const routeReady =
                      kind === "direct_cctp"
                        ? directWorkflowReady
                        : kind === "stellar_centered_public"
                          ? stellarWorkflowReady
                          : directWorkflowReady || stellarWorkflowReady;
                    const state: SurfaceState = routeReady
                      ? "executable"
                      : "unavailable";
                    const description =
                      kind === "auto"
                        ? "Ranks only live, reviewed candidates. A public Stellar hop is never added merely for branding."
                        : kind === "direct_cctp"
                        ? "Arc directly to Arbitrum Sepolia. Lowest step count; no Stellar checkpoint."
                        : "Two public CCTP legs with a user-requested Stellar settlement checkpoint. This is public, not confidential.";
                    return (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={routePreference === kind}
                        onClick={() => {
                          setRoutePreference(kind);
                          setIntentClarification(null);
                        }}
                        className="stellar-route-button"
                      >
                        <span className="stellar-route-title">
                          {routePreferenceLabels[kind]}
                          <StatusPill state={state} />
                        </span>
                        <span className="stellar-route-copy">{description}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    className="stellar-route-button"
                  >
                    <span className="stellar-route-title">
                      Private cross-chain execution
                      <StatusPill state="unavailable" />
                    </span>
                    <span className="stellar-route-copy">
                      Shielded Stellar payments are available below, but CCTP exits and destination DeFi remain public. Kletia does not mislabel that boundary as a private bridge or private Aave route.
                    </span>
                  </button>
                </div>
                <div className="stellar-notice">
                  <strong>Cross-chain privacy scope: browser-private planning, public settlement.</strong>
                  The API reports <code>{readiness?.privacy?.onchainConfidentiality || "not_in_public_workflow_runtime"}</code> for
                  this workflow compiler. The separate shielded-payments surface
                  provides real in-pool privacy, but no private bridge route is
                  compiled by this runtime.
                </div>
              </fieldset>

              <fieldset>
                <legend className="stellar-legend">Privacy Budget</legend>
                <div className="stellar-route-grid">
                  {(
                    [
                      "deterministic_only_public_execution",
                      "private_planning_public_execution",
                      "public_execution",
                      "confidential_ledger_required",
                    ] as PrivacyBudgetPresetV1[]
                  ).map((preset) => {
                    const confidential =
                      preset === "confidential_ledger_required";
                    const description =
                      preset === "private_planning_public_execution"
                        ? "Exact amount stays on this device during AI planning. It is opened only for the exact public checkpoint you approve."
                        : preset === "deterministic_only_public_execution"
                          ? "No semantic model call is made. The device-generated envelope is resolved only through the closed scenario registry."
                        : preset === "public_execution"
                          ? "Permits the broad reviewed observer set, while Kletia still minimizes AI input. Public ledgers remain fully visible."
                          : "Requires hidden ledger amounts. Unavailable until a reviewed confidential verifier and execution surface are pinned.";
                    return (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={privacyBudgetPreset === preset}
                        aria-disabled={confidential}
                        disabled={confidential}
                        onClick={() => setPrivacyBudgetPreset(preset)}
                        className="stellar-route-button"
                      >
                        <span className="stellar-route-title">
                          {privacyBudgetLabels[preset]}
                          <StatusPill
                            state={confidential ? "unavailable" : "executable"}
                          />
                        </span>
                        <span className="stellar-route-copy">{description}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="stellar-field-help">
                  The selected observer allowlist is sealed into the plan core.
                  Changing it invalidates the manifest signature, and a route
                  that exceeds it is rejected before economic ranking.
                </p>
              </fieldset>
                </div>
              </details>

              <div className="stellar-button-grid">
                <button
                  type="button"
                  onClick={() => void connectFreighter()}
                  disabled={busy}
                  className="stellar-button"
                >
                  <Wallet aria-hidden="true" />
                  {stellarAddress ? "Freighter connected" : "Connect Freighter"}
                </button>
                <button
                  type="button"
                  onClick={() => void preparePlan()}
                  disabled={
                    busy ||
                    !publicWorkflowReady ||
                    Boolean(intentClarification) ||
                    (workflowHasUnresolvedSubmission && !executionReceipt)
                  }
                  className="stellar-button"
                  data-variant="primary"
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Route aria-hidden="true" />}
                  {busy ? "Checking live routes" : "Build my plan"}
                </button>
              </div>

              {!plan ? (
                <div className="stellar-empty">
                  <FileCheck2 aria-hidden="true" />
                  <strong>No workflow compiled</strong>
                  <span>
                    Connect the required wallets and build a plan. Kletia will use
                    current network readiness and live route evidence.
                  </span>
                </div>
              ) : (
                <>
                  {currentRequiresOpeningApproval ? (
                    <label className="stellar-disclosure-consent">
                      <input
                        type="checkbox"
                        checked={publicOpeningApproved}
                        onChange={(event) =>
                          setPublicOpeningApproved(event.target.checked)
                        }
                        disabled={executing}
                      />
                      <span>
                        <strong>Approve one-time public checkpoint opening</strong>
                        <small>
                          After this transaction has a public hash, disclose only the two commitment salts to the Kletia API for this exact workflow, step, request, and hash. Observer: Kletia API. Reason: public transaction binding. Irreversible: yes. The raw amount is still blocked from egress.
                        </small>
                      </span>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void executeCurrentStep()}
                    disabled={
                      executing ||
                      !manifestSigned ||
                      Boolean(indeterminateHash) ||
                      currentFinancialSubmissionLocked ||
                      currentTerminalLifecycle ||
                      (currentRequiresOpeningApproval && !publicOpeningApproved)
                    }
                    className="stellar-button"
                    data-variant="positive"
                  >
                    {executing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                    {executing ? "Verifying checkpoint" : currentActionLabel}
                  </button>
                </>
              )}

              {lifecycle ? (
                <div
                  className="stellar-lifecycle"
                  data-state={lifecycle.status}
                  role={lifecycle.status === "failed" ? "alert" : "status"}
                  aria-live="polite"
                >
                  <div className="stellar-step-heading">
                    <strong>Workflow lifecycle</strong>
                    <StatusPill state={lifecycle.status} />
                  </div>
                  <dl className="stellar-evidence-list">
                    <dt>Classification</dt>
                    <dd>{lifecycle.code}</dd>
                    <dt>Reason</dt>
                    <dd>{lifecycle.reason}</dd>
                    <dt>Operator action</dt>
                    <dd>{lifecycle.operatorAction}</dd>
                    <dt>Automatic retry</dt>
                    <dd>Forbidden</dd>
                  </dl>
                </div>
              ) : null}

              {indeterminateHash ? (
                <div className="stellar-error" role="alert">
                  <div className="stellar-status-row">
                    <StatusPill state="indeterminate" />
                  </div>
                  <p className="stellar-wallet-binding">{indeterminateHash}</p>
                  <p>
                    The transaction was submitted, but its final state is unknown.
                    Recovery queries this exact hash and never resends the payment.
                  </p>
                  <button
                    type="button"
                    onClick={() => void recoverIndeterminateStep()}
                    disabled={
                      executing ||
                      (currentRequiresOpeningApproval && !publicOpeningApproved)
                    }
                    className="stellar-button"
                  >
                    <RefreshCw aria-hidden="true" />
                    Recover existing status
                  </button>
                </div>
              ) : null}

              <details className="stellar-recovery-details">
                <summary>Recovery and encrypted export</summary>
                <div className="stellar-notice">
                <strong>Encrypted workflow recovery</strong>
                <p>
                  Exact local fields are never saved to localStorage. The encrypted
                  scrypt + AES-GCM bundle restores this workflow plan only; it is not
                  wallet or onchain balance recovery.
                </p>
                <label className="stellar-label" htmlFor="stellar-recovery-password">
                  Recovery password
                  <input
                    id="stellar-recovery-password"
                    type="password"
                    value={recoveryPassword}
                    onChange={(event) => setRecoveryPassword(event.target.value)}
                    autoComplete="new-password"
                    placeholder="At least 12 characters"
                    className="stellar-input"
                  />
                </label>
                <div className="stellar-button-grid">
                  <button
                    type="button"
                    onClick={() => void exportRecoveryBundle()}
                    disabled={busy || !plan}
                    className="stellar-button"
                    data-variant="warning"
                  >
                    Export encrypted bundle
                  </button>
                  <label className="stellar-file-button" aria-disabled={busy}>
                    Import recovery bundle
                    <input
                      type="file"
                      accept="application/json,.json"
                      className="sr-only"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void importRecoveryBundle(file);
                      }}
                    />
                  </label>
                </div>
                {recoveryStatus ? (
                  <p className="stellar-notice" data-tone="positive" role="status">
                    {recoveryStatus}
                  </p>
                ) : null}
                </div>
              </details>

              <div className="stellar-wallet-binding">
                <strong>Stellar:</strong> {stellarAddress || "not connected"}<br />
                <strong>EVM corridor:</strong> {evmAddress || "not connected"}
              </div>
            </div>
          </section>

          <aside className="stellar-stack" aria-label="Stellar tools and privacy status">
            <section
              className="stellar-panel"
              aria-labelledby="privacy-boundary-title"
              hidden={workspaceView !== "advanced"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Disclosure map</p>
                  <h3 id="privacy-boundary-title">Who sees what</h3>
                </div>
                <ShieldCheck aria-hidden="true" />
              </div>
              <div className="stellar-boundary-list">
                <div className="stellar-boundary-row">
                  <LockKeyhole aria-hidden="true" />
                  <div><strong>Browser</strong><span>Exact amount, salts, and freeform input before local reduction.</span></div>
                </div>
                <div className="stellar-boundary-row">
                  <EyeOff aria-hidden="true" />
                  <div><strong>AI planner</strong><span>Allowlisted envelope plus locally redacted intent wording in assisted mode; nothing in deterministic-only mode. No exact amount, recipient, salt, address, or calldata.</span></div>
                </div>
                <div className="stellar-boundary-row">
                  <Server aria-hidden="true" />
                  <div><strong>Deterministic API</strong><span>Commitments and public wallet bindings during compile; one-time salt opening only after explicit approval at the exact first public checkpoint.</span></div>
                </div>
                <div className="stellar-boundary-row">
                  <Network aria-hidden="true" />
                  <div><strong>Public ledgers</strong><span>CCTP amounts, wallets, timing, Stellar checkpoint, and Aave position are visible.</span></div>
                </div>
                <div className="stellar-boundary-row">
                  <AlertTriangle aria-hidden="true" />
                  <div><strong>Settlement visibility</strong><span>Public by design in this runtime. No hidden transfer, balance, or bridge claim is made.</span></div>
                </div>
              </div>
            </section>

            <section
              className="stellar-panel"
              aria-labelledby="privacy-budget-title"
              hidden={workspaceView !== "advanced"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Observed browser boundary</p>
                  <h3 id="privacy-budget-title">Privacy Budget</h3>
                </div>
                <ShieldCheck aria-hidden="true" />
              </div>
              {privacyBudget ? (
                <div className="stellar-evidence-stack" aria-live="polite">
                  <div className="stellar-step-heading">
                    <strong>{privacyBudget.selectedRoute.replace(/_/gu, " ")}</strong>
                    <StatusPill
                      state={
                        privacyBudget.status === "violated"
                          ? "unavailable"
                          : privacyBudget.status === "partial"
                            ? "awaiting_signature"
                            : privacyBudget.status === "measured"
                              ? "read_only"
                              : "planned"
                      }
                    />
                  </div>
                  <dl className="stellar-evidence-list">
                    <dt>Egress report</dt>
                    <dd>{egressReport.schemaVersion}</dd>
                    <dt>Signed preset</dt>
                    <dd>{privacyBudget.preset.replace(/_/gu, " ")}</dd>
                    <dt>Enforcement</dt>
                    <dd>{privacyBudget.enforcement.replace(/_/gu, " ")}</dd>
                    <dt>Policy rules</dt>
                    <dd>{privacyBudget.ruleCount}</dd>
                    <dt>Route compatible</dt>
                    <dd>{privacyBudget.compatible ? "yes" : "no"}</dd>
                    <dt>Declared raw weight</dt>
                    <dd>{privacyBudget.declaredRawWeight}</dd>
                    <dt>Declared net penalty</dt>
                    <dd>{privacyBudget.declaredNetPenalty.toFixed(4)}</dd>
                    <dt>Guard coverage</dt>
                    <dd>{egressReport.coverage.replace(/_/gu, " ")}</dd>
                    <dt>Inspected operations</dt>
                    <dd>{privacyBudget.inspectedOperations}</dd>
                    <dt>Blocked violations</dt>
                    <dd>{privacyBudget.blockedViolations}</dd>
                  </dl>
                  <div className="stellar-evidence-group">
                    <strong>Declared public fields</strong>
                    <p>{privacyBudget.publicFields.join(", ") || "None declared"}</p>
                  </div>
                  <div className="stellar-evidence-group">
                    <strong>Observers</strong>
                    <p>{privacyBudget.observers.join(", ") || "None declared"}</p>
                  </div>
                  <div className="stellar-notice" data-tone={egressReport.coverage === "partial_low_entropy" ? "warning" : undefined}>
                    {egressReport.coverage === "partial_low_entropy"
                      ? `Partial measurement: ${egressReport.unguardableFields.join(", ")} contains a low-entropy value that cannot be safely blocked by substring matching. No complete zero-egress claim is made.`
                      : egressReport.zeroPrivateFieldEgress
                        ? "Complete observed coverage with zero blocked private-field egress violations in this workflow session. This is not a proof about unexercised code paths."
                        : "The guard is inactive or recorded a blocked violation; no zero-egress claim is made."}
                  </div>
                  {egressReport.approvedDisclosures.length > 0 ? (
                    <div className="stellar-evidence-group">
                      <strong>Approved irreversible disclosures</strong>
                      <ul className="stellar-evidence-items">
                        {egressReport.approvedDisclosures.map((entry) => (
                          <li key={`${entry.kind}:${entry.stepId}:${entry.transactionHash ?? "quote"}:${entry.binding}`}>
                            <code>{entry.binding}</code> → Kletia API · {entry.reason}
                            <span>{entry.stepId} · {entry.transactionHash ?? "pre-execution quote"}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {egressReport.violations.length > 0 ? (
                    <div className="stellar-evidence-group">
                      <strong>Blocked egress violations</strong>
                      <ul className="stellar-evidence-items">
                        {egressReport.violations.map((entry, index) => (
                          <li key={`${entry.observedAt}:${entry.location}:${index}`}>
                            {entry.field} · {entry.surface} · {entry.location}
                            <span>{entry.observedAt}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className="stellar-step-meta">{privacyBudget.limitations[0]}</p>
                </div>
              ) : (
                <div className="stellar-empty">
                  <Eye aria-hidden="true" />
                  <strong>No measured workflow</strong>
                  <span>Compile a sealed workflow to derive the route declaration and browser observation coverage.</span>
                </div>
              )}
            </section>

            <section
              className="stellar-panel"
              aria-labelledby="disclosure-diff-title"
              hidden={workspaceView !== "advanced"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Checkpoint knowledge delta</p>
                  <h3 id="disclosure-diff-title">Disclosure Diff</h3>
                </div>
                <Eye aria-hidden="true" />
              </div>
              {disclosureDiff ? (
                <div className="stellar-evidence-stack">
                  <p className="stellar-step-meta">
                    {routeLabels[disclosureDiff.selectedRoute]} compared with {disclosureDiff.comparedRoute ? routeLabels[disclosureDiff.comparedRoute] : "no alternative"}.
                  </p>
                  <dl className="stellar-evidence-list">
                    <dt>Raw-weight delta</dt>
                    <dd>{disclosureDiff.rawWeightDelta ?? "n/a"}</dd>
                    <dt>Net-penalty delta</dt>
                    <dd>{disclosureDiff.netPenaltyDelta ?? "n/a"}</dd>
                    <dt>Irreversible openings</dt>
                    <dd>{disclosureDiff.irreversibleDisclosureCount}</dd>
                  </dl>
                  <div className="stellar-disclosure-columns">
                    <div className="stellar-evidence-group">
                      <strong>Added field → observer pairs</strong>
                      <ul className="stellar-evidence-items">
                        {(disclosureDiff.addedPairs.length > 0
                          ? disclosureDiff.addedPairs
                          : ["None"]).map((pair) => <li key={`added:${pair}`}>{pair}</li>)}
                      </ul>
                    </div>
                    <div className="stellar-evidence-group">
                      <strong>Avoided field → observer pairs</strong>
                      <ul className="stellar-evidence-items">
                        {(disclosureDiff.avoidedPairs.length > 0
                          ? disclosureDiff.avoidedPairs
                          : ["None"]).map((pair) => <li key={`avoided:${pair}`}>{pair}</li>)}
                      </ul>
                    </div>
                  </div>
                  <div className="stellar-evidence-group">
                    <strong>Who learns what at each step</strong>
                    <ol className="stellar-evidence-items">
                      {disclosureDiff.entries.map((entry) => (
                        <li key={`diff:${entry.stepId}`}>
                          <code>{entry.stepId}</code> · {entry.phase.replace(/_/gu, " ")} · {entry.summary}
                          {entry.newlyLearned.length > 0 ? (
                            <span>
                              {entry.newlyLearned
                                .map(
                                  (fact) =>
                                    `${fact.field} → ${fact.observer}${
                                      fact.irreversible ? " (irreversible)" : ""
                                    }`,
                                )
                                .join(" · ")}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <p className="stellar-step-meta">{disclosureDiff.limitations[0]}</p>
                </div>
              ) : (
                <div className="stellar-empty">
                  <Route aria-hidden="true" />
                  <strong>No route diff yet</strong>
                  <span>Compile a workflow to compare declared observer sets. This is not an unlinkability proof.</span>
                </div>
              )}
            </section>

            <section
              className="stellar-panel"
              aria-labelledby="stellar-assets-title"
              hidden={workspaceView !== "wallet"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Live Horizon state</p>
                  <h3 id="stellar-assets-title">Reviewed assets</h3>
                </div>
                <CircleDollarSign aria-hidden="true" />
              </div>
              {busy && stellarAddress && !portfolio ? (
                <div className="stellar-asset-grid" aria-label="Loading balances">
                  <div className="stellar-skeleton" />
                  <div className="stellar-skeleton" />
                </div>
              ) : portfolio ? (
                <div className="stellar-asset-grid">
                  {portfolio.assets.map((entry) => (
                    <div key={entry.asset.symbol} className="stellar-asset-card">
                      <strong>{entry.asset.symbol}</strong>
                      <code>{entry.balance}</code>
                      <StatusPill state={entry.authorized ? "read_only" : "unavailable"} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stellar-empty">
                  <Wallet aria-hidden="true" />
                  <strong>No Stellar account connected</strong>
                  <span>Your EVM connection is kept for Arc/Base/Arbitrum steps. Connect Freighter separately to read and sign on Stellar Testnet.</span>
                  <button
                    type="button"
                    onClick={() => void connectFreighter()}
                    disabled={busy}
                    className="stellar-button"
                    data-variant="primary"
                  >
                    {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
                    Connect Freighter
                  </button>
                </div>
              )}
              {activeWalletTool === "trustline" && portfolio && hasUsdcTrustline ? (
                <div className="stellar-notice" data-tone="positive" role="status">
                  <strong>Reviewed USDC is enabled</strong>
                  <p>This account already has the exact Circle Testnet USDC trustline.</p>
                </div>
              ) : null}
              {stellarAddress && portfolio && !hasUsdcTrustline ? (
                <div className="stellar-notice" data-tone="warning">
                  <p>
                    This account cannot receive reviewed Circle Testnet USDC until it adds the exact issuer trustline.
                  </p>
                  <button
                    type="button"
                    onClick={() => void createUsdcTrustline()}
                    disabled={stellarToolBusy}
                    className="stellar-button"
                    data-variant="positive"
                  >
                    {stellarToolBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    Review and sign USDC trustline
                  </button>
                </div>
              ) : null}
            </section>

            <section
              className="stellar-panel"
              aria-labelledby="stellar-transfer-title"
              hidden={workspaceView !== "wallet" || activeWalletTool !== "transfer"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Classic payment</p>
                  <h3 id="stellar-transfer-title">Stellar transfer</h3>
                </div>
                <Wallet aria-hidden="true" />
              </div>
              <div className="stellar-compact-form" aria-busy={stellarToolBusy}>
                <div className="stellar-segmented" role="group" aria-label="Transfer asset">
                  {(["XLM", "USDC"] as const).map((symbol) => (
                    <button
                      key={symbol}
                      type="button"
                      aria-pressed={stellarTransferSymbol === symbol}
                      onClick={() => setStellarTransferSymbol(symbol)}
                      className="stellar-button"
                      data-variant={stellarTransferSymbol === symbol ? "primary" : undefined}
                    >
                      {symbol}
                    </button>
                  ))}
                </div>
                <label className="stellar-label" htmlFor="stellar-transfer-amount">
                  Amount
                  <input
                    id="stellar-transfer-amount"
                    value={stellarTransferAmount}
                    onChange={(event) => setStellarTransferAmount(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    className="stellar-input"
                  />
                </label>
                <label className="stellar-label" htmlFor="stellar-transfer-recipient">
                  Destination G-address
                  <input
                    id="stellar-transfer-recipient"
                    value={stellarTransferRecipient}
                    onChange={(event) => setStellarTransferRecipient(event.target.value.trim())}
                    placeholder="G…"
                    spellCheck={false}
                    autoComplete="off"
                    className="stellar-input"
                  />
                </label>
                <p className="stellar-field-help">
                  The browser verifies the Testnet account and exact Circle issuer
                  trustline before Freighter signs.
                </p>
                <button
                  type="button"
                  onClick={() => void executeStellarTransfer()}
                  disabled={stellarToolBusy || !stellarAddress}
                  className="stellar-button"
                  data-variant="positive"
                >
                  {stellarToolBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
                  Review and sign transfer
                </button>
              </div>
            </section>

            <section
              className="stellar-panel"
              aria-labelledby="stellar-aggregator-title"
              hidden={workspaceView !== "wallet" || activeWalletTool !== "swap"}
            >
              <div className="stellar-panel-header">
                <div>
                  <p className="stellar-eyebrow">Live path comparison</p>
                  <h3 id="stellar-aggregator-title">Stellar route aggregator</h3>
                </div>
                <Route aria-hidden="true" />
              </div>
              <div className="stellar-compact-form" aria-busy={stellarToolBusy}>
                <div className="stellar-segmented">
                  <button
                    type="button"
                    onClick={() => {
                      setStellarSwapSource((current) => current === "XLM" ? "USDC" : "XLM");
                      setStellarQuote(null);
                      setStellarQuoteRequested(false);
                    }}
                    className="stellar-button"
                  >
                    {stellarSwapSource} → {stellarSwapSource === "XLM" ? "USDC" : "XLM"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStellarSwapMode((current) => current === "strict_send" ? "strict_receive" : "strict_send");
                      setStellarQuote(null);
                      setStellarQuoteRequested(false);
                    }}
                    className="stellar-button"
                  >
                    {stellarSwapMode.replace(/_/gu, " ")}
                  </button>
                </div>
                <label className="stellar-label" htmlFor="stellar-path-amount">
                  {stellarSwapMode === "strict_send" ? "Exact send amount" : "Exact receive amount"}
                  <input
                    id="stellar-path-amount"
                    value={stellarSwapAmount}
                    onChange={(event) => {
                      setStellarSwapAmount(event.target.value);
                      setStellarQuote(null);
                      setStellarQuoteRequested(false);
                    }}
                    inputMode="decimal"
                    autoComplete="off"
                    className="stellar-input"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void compareStellarRoutes()}
                  disabled={stellarToolBusy}
                  className="stellar-button"
                  data-variant="primary"
                >
                  {stellarToolBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Route aria-hidden="true" />}
                  {stellarToolBusy ? "Reading live routes" : "Compare live routes · no wallet needed"}
                </button>

                {stellarToolBusy && !stellarQuote ? (
                  <div className="stellar-quote" aria-label="Loading route quote">
                    <div className="stellar-skeleton" />
                    <div className="stellar-skeleton" />
                  </div>
                ) : stellarQuote ? (
                  <div className="stellar-quote">
                    <div className="stellar-quote-metric">
                      <span>Executable SDEX</span>
                      <code>{stellarQuote.selectedRoute.sourceAmount} → {stellarQuote.selectedRoute.destinationAmount}</code>
                    </div>
                    <div className="stellar-quote-metric">
                      <span>Aquarius comparison</span>
                      <code>
                        {stellarQuote.aquarius?.comparisonStatus?.replace(/_/gu, " ") || "unavailable"}
                        {stellarQuote.aquarius?.quotedAmountAtomic
                          ? ` · ${formatUnits(BigInt(stellarQuote.aquarius.quotedAmountAtomic), 7)}`
                          : ""}
                      </code>
                    </div>
                    <div className="stellar-notice">
                      Aquarius is comparison-only and never executable here. The
                      signed operation is the exact Horizon SDEX route with a 0.50%
                      bound.
                    </div>
                    <div className="stellar-notice" data-tone="warning">
                      {stellarQuote.executionPolicy.warning}
                      {stellarQuote.selectedRoute.intermediateAssetIdentities.length > 0
                        ? ` Exact path: ${stellarQuote.selectedRoute.intermediateAssetIdentities.join(" → ")}`
                        : ""}
                    </div>
                    {stellarSwapSource === "XLM" && !hasUsdcTrustline ? (
                      <div className="stellar-error" role="alert">
                        A reviewed Circle USDC trustline is required before receiving USDC.
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void executeSdexRoute()}
                      disabled={
                        stellarToolBusy ||
                        !stellarAddress ||
                        (stellarSwapSource === "XLM" && !hasUsdcTrustline)
                      }
                      className="stellar-button"
                      data-variant="positive"
                    >
                      <Fingerprint aria-hidden="true" />
                      {stellarAddress ? "Sign exact SDEX route" : "Connect Freighter to sign"}
                    </button>
                  </div>
                ) : (
                  <div className="stellar-empty">
                    <Circle aria-hidden="true" />
                    <strong>
                      {stellarQuoteRequested ? "No executable route returned" : "Ready for a live quote"}
                    </strong>
                    <span>
                      {stellarQuoteRequested
                        ? "Review the error above or change the amount and bounds. No route is fabricated."
                        : "Compare without a wallet. Freighter is requested only if you choose to sign the exact route."}
                    </span>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>

        {workspaceView === "advanced" ? (
          <CompetitiveWorkflowPanel
            key={
              plan && resolvedIntentReceipt?.workflowId === plan.workflowPlan.workflowId
                ? `${resolvedIntentReceipt.workflowId}:${plan.workflowPlan.authorizationBoundary.planCoreSha256}`
                : "unresolved-v3-intent"
            }
            stellarAddress={stellarAddress}
            evmAddress={evmAddress}
            resolvedIntentReceipt={
              plan && resolvedIntentReceipt?.workflowId === plan.workflowPlan.workflowId
                ? {
                    ...resolvedIntentReceipt,
                    planCoreSha256:
                      plan.workflowPlan.authorizationBoundary.planCoreSha256,
                    workflowToken: plan.workflowToken,
                    selectedRoute: plan.workflowPlan.selectedRoute,
                  }
                : null
            }
          />
        ) : null}

        <section
          className="stellar-panel stellar-workflow"
          aria-labelledby="workflow-roadmap-title"
          hidden={workspaceView !== "plan"}
        >
          <div className="stellar-panel-header">
            <div>
              <p className="stellar-eyebrow">Checkpoint roadmap</p>
              <h2 id="workflow-roadmap-title">
                {plan ? routeLabels[plan.workflowPlan.selectedRoute] : "No active workflow"}
              </h2>
            </div>
            {plan ? (
              <div className="stellar-workflow-header-actions">
                <StatusPill
                  state={
                    executionReceipt
                      ? "confirmed"
                      : lifecycle
                        ? lifecycle.status
                        : currentSubmission &&
                            financiallySubmittedStates.has(currentSubmission.state)
                          ? currentSubmission.state
                          : indeterminateHash
                            ? "indeterminate"
                            : manifestSigned
                              ? "awaiting_signature"
                              : "planned"
                  }
                />
                <button
                  type="button"
                  onClick={() => void signPlanManifest()}
                  disabled={
                    busy ||
                    manifestSigned ||
                    currentFinancialSubmissionLocked ||
                    Boolean(lifecycle)
                  }
                  className="stellar-button"
                  data-variant="warning"
                >
                  <Fingerprint aria-hidden="true" />
                  {manifestSigned ? "Manifest signed" : "Review and sign manifest"}
                </button>
              </div>
            ) : (
              <StatusPill state="planned" />
            )}
          </div>

          {!plan ? (
            <div className="stellar-empty">
              <Network aria-hidden="true" />
              <strong>Roadmap appears after compilation</strong>
              <span>
                Each bridge, attestation, mint, approval, supply, and read-only
                result will be shown as a separate evidence-bound checkpoint.
              </span>
            </div>
          ) : (
            <>
              <div className="stellar-candidate-grid" aria-label="Route comparison">
                {plan.workflowPlan.routeCandidates.map((candidate) => {
                  const candidateState: SurfaceState = candidate.available
                    ? candidate.kind === plan.workflowPlan.selectedRoute
                      ? "executable"
                      : "read_only"
                    : "unavailable";
                  return (
                    <article
                      key={candidate.kind}
                      className="stellar-candidate"
                      data-selected={candidate.kind === plan.workflowPlan.selectedRoute}
                    >
                      <div className="stellar-candidate-heading">
                        <h3>{candidate.label}</h3>
                        <StatusPill state={candidateState} />
                      </div>
                      <dl>
                        <dt>Score</dt><dd>{candidate.score.total.toFixed(4)}</dd>
                        <dt>Disclosure</dt>
                        <dd>
                          {candidate.score.disclosurePenalty.toFixed(4)} (raw{" "}
                          {candidate.score.disclosureRawWeight}
                          {candidate.score.ledgerLinkageCredit > 0
                            ? `, −${candidate.score.ledgerLinkageCredit} reviewed policy credit`
                            : ""}
                          )
                        </dd>
                        <dt>Correlation domains</dt>
                        <dd>{candidate.score.correlationDomainsRequired}</dd>
                        <dt>Risk</dt><dd>{candidate.failureRiskScore}/100</dd>
                        <dt>Window</dt><dd>{candidate.estimatedDurationSeconds.minimum}–{candidate.estimatedDurationSeconds.maximum}s</dd>
                        <dt>CCTP</dt><dd>{candidate.liveEvidence.cctpStandardFeeBps} bps / {candidate.liveEvidence.cctpHops} hop</dd>
                        <dt>Aave APY</dt><dd>{(candidate.liveEvidence.aaveSupplyApyBps / 100).toFixed(2)}%</dd>
                        <dt>Graph path</dt>
                        <dd>{candidate.routeGraph.edgeIds.join(" → ")}</dd>
                      </dl>
                      <p>{candidate.rankingReason}</p>
                      {/* Keep the server's complete disclosure caveat visible. */}
                      <p className="stellar-step-meta">
                        {candidate.disclosureProfile.reasoning}
                      </p>
                      {!candidate.available ? (
                        <div className="stellar-error">
                          {candidate.unavailableReason || "This route is not executable."}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>

              <div className="stellar-timeline" aria-label="Workflow checkpoint timeline">
                {plan.workflowPlan.steps.map((step) => {
                  const stepState = workflowStepState({
                    action: step.action,
                    result: step.result,
                    status: step.status,
                    order: step.order,
                    currentStepIndex: plan.workflowPlan.currentStepIndex,
                    manifestSigned,
                    indeterminate: Boolean(indeterminateHash),
                  });
                  return (
                    <article key={step.id} className="stellar-timeline-step">
                      <span className="stellar-step-index" aria-hidden="true">{step.order}</span>
                      <div className="stellar-step-body">
                        <div className="stellar-step-heading">
                          <strong>{step.action.replace(/_/gu, " ")}</strong>
                          <StatusPill state={stepState} />
                        </div>
                        <p className="stellar-step-meta">
                          {networkLabels[step.network]} · evidence: {step.evidenceRequired.join(", ")}
                        </p>
                        {step.result ? (
                          <dl className="stellar-checkpoint-evidence">
                            <dt>Result</dt>
                            <dd>{step.result.kind.replace(/_/gu, " ")}</dd>
                            <dt>Reference</dt>
                            <dd>{step.result.reference}</dd>
                            <dt>Observed</dt>
                            <dd>{step.result.observedAt}</dd>
                            {step.result.blockOrLedger ? (
                              <><dt>Block / ledger</dt><dd>{step.result.blockOrLedger}</dd></>
                            ) : null}
                            {step.result.nonce ? (
                              <><dt>CCTP nonce</dt><dd>{step.result.nonce}</dd></>
                            ) : null}
                            {step.result.amountAtomic ? (
                              <><dt>Amount atomic</dt><dd>{step.result.amountAtomic}</dd></>
                            ) : null}
                          </dl>
                        ) : submissionEvidence[step.id] ? (
                          <dl className="stellar-checkpoint-evidence">
                            <dt>Local state</dt>
                            <dd>{submissionEvidence[step.id].state}</dd>
                            <dt>Transaction</dt>
                            <dd>{submissionEvidence[step.id].transactionHash}</dd>
                            <dt>Observed</dt>
                            <dd>{submissionEvidence[step.id].observedAt}</dd>
                          </dl>
                        ) : null}
                        {step.result?.safeBorrowCapacityAtomic && /^\d+$/u.test(step.result.safeBorrowCapacityAtomic) ? (
                          <div className="stellar-capacity">
                            <strong>{formatUnits(BigInt(step.result.safeBorrowCapacityAtomic), 6)} USDC theoretical capacity</strong>
                            <span>
                              {step.result.capacityStatus?.replace(/_/gu, " ")} · target health factor {step.result.targetHealthFactor}
                            </span>
                            {step.result.limitations?.map((limitation) => (
                              <p key={limitation}>• {limitation}</p>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="stellar-notice" data-tone="warning">
                <strong>Financial signatures remain per checkpoint.</strong> Cross-chain
                execution has no global rollback. The next step is prepared only after
                exact chain, wallet, calldata, and onchain evidence match the sealed plan.
              </div>

              {executionReceipt ? (
                <div className="stellar-receipt" role="status" aria-live="polite">
                  <div className="stellar-status-row"><StatusPill state="confirmed" /></div>
                  <strong>ExecutionReceiptV1 confirmed</strong>
                  <dl className="stellar-evidence-list">
                    <dt>Workflow binding</dt>
                    <dd>{executionReceipt.workflowBindingHash}</dd>
                    <dt>Plan core</dt>
                    <dd>{executionReceipt.planCoreSha256}</dd>
                    <dt>Receipt hash</dt>
                    <dd>{executionReceipt.receiptSha256}</dd>
                    <dt>Generated</dt>
                    <dd>{executionReceipt.generatedAt}</dd>
                    <dt>Atomicity</dt>
                    <dd>{executionReceipt.crossChainAtomicity.replace(/_/gu, " ")}</dd>
                    <dt>Private planning values</dt>
                    <dd>{executionReceipt.privateValuesExcludedFromAiPlanning ? "Excluded" : "Not verified"}</dd>
                  </dl>
                  <div className="stellar-receipt-checkpoints">
                    {executionReceipt.checkpoints.map((checkpoint) => (
                      <article key={checkpoint.stepId}>
                        <strong>{checkpoint.stepId} · {checkpoint.action.replace(/_/gu, " ")}</strong>
                        <span>{networkLabels[checkpoint.network]}</span>
                        <code>{checkpoint.result?.reference || "No public reference"}</code>
                        <small>{checkpoint.result?.observedAt || "No observation timestamp"}</small>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
