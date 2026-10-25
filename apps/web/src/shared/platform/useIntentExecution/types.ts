/**
 * Public types of useIntentExecution: status, errors, options, gates and
 * the returned execution handle.
 */
import type { PolicyErrorDetails, PreviewGateContext } from "@kletia/sdk";
import type {
  AccountId,
  ContractReview,
  IntentGraph,
  IntentPreview,
  IntentRequest,
  Journey,
  JourneyConsequence,
  PreviewIssue,
} from "@kletia/core";
import type { BindingProblem } from "../intentBinding";
import type { PlatformError } from "../kletiaClient";
import type { ConnectedIntentSigners } from "../useIntentSigners";

export type IntentExecutionStatus =
  /** Nothing planned yet. */
  | "idle"
  /** Creating the persisted intent with the connected accounts. */
  | "planning"
  /** Persisted plan ready; waiting for the user to confirm. */
  | "review"
  /** Preparing, signing, submitting or waiting for settlement. */
  | "executing"
  /** Stopped without a terminal status (needs the user before continuing). */
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** What the browser is doing for a step before the API reports it. */
export type LocalStepPhase = "preparing" | "signing" | "confirming";

export interface IntentExecutionError {
  readonly code: string;
  readonly message: string;
  readonly stepId: string | null;
  readonly retryable: boolean;
  /** Present when the API returned the error. */
  readonly platform: PlatformError | null;
  /** The API's guidance, e.g. supported example phrases on INTENT_UNSUPPORTED. */
  readonly hints?: readonly string[];
  /**
   * The API's structured context (`error.details`), e.g. the candidate
   * networks of SOURCE_REQUIRED; null or absent when the API (or the SDK in
   * use) did not provide one.
   */
  readonly details?: Readonly<Record<string, unknown>> | null;
}

/** An intent request whose accounts default to the connected wallets. */
export type IntentRequestInput = Omit<IntentRequest, "accounts"> & {
  readonly accounts?: readonly AccountId[];
};

export interface UseIntentExecutionOptions {
  /** sessionStorage key used to resume after a reload; `null` disables it. */
  readonly sessionKey?: string | null;
  /** Merged into every created intent's metadata (e.g. `{ surface: "studio" }`). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Settlement poll interval passed to `executeIntent` (default 4000 ms). */
  readonly pollIntervalMs?: number;
  /**
   * A signing lock shared with other executions on the page. Called before a
   * run prepares anything; `false` refuses the run (it pauses with
   * `signingLockedReason`). Absent: no lock.
   */
  readonly acquireSigning?: () => boolean;
  /** Gives the lock back when the run that took it ends (finished, paused, failed, cancelled or unmounted). */
  readonly releaseSigning?: () => void;
  /** Why a refused run paused (default: another execution is signing). */
  readonly signingLockedReason?: string;
  /**
   * A journey option suggested a separate new intent as a sentence
   * (`plan-new`, e.g. "bring it back to solana"): the host puts it where the
   * user can review it. Nothing is planned or signed on its own.
   */
  readonly onFollowUp?: (text: string) => void;
}

/** A pause before a wallet prompt that needs the user's decision. */
export type ExecutionGate =
  | {
      readonly kind: "fare";
      readonly stepId: string;
      readonly stepTitle: string;
      /** The fare to approve now. */
      readonly preview: IntentPreview;
      /** The fare the user approved before (printed struck through when it got worse). */
      readonly previous: IntentPreview | null;
      /** What got worse (`PREVIEW_CHANGED` changes). */
      readonly changes: readonly PreviewIssue[];
      readonly reason: PreviewGateContext["reason"];
    }
  | {
      readonly kind: "review";
      readonly stepId: string;
      readonly stepTitle: string;
      readonly stepIndex: number;
      /** The review of exactly the prepared transactions. */
      readonly review: ContractReview;
      /** The plan-time review, when the step had one. */
      readonly planned: ContractReview | null;
    };

/** One key per decision: a new fare or another step's review is a new gate (and remounts its panel). */
export function gateKey(gate: ExecutionGate): string {
  return gate.kind === "fare" ? `fare:${gate.stepId}:${gate.preview.digest}` : `review:${gate.stepId}`;
}

/** The owner's Rule Book holds the intent until an approver approves it. */
export interface PolicyHold {
  readonly code: string;
  readonly message: string;
  readonly policy: PolicyErrorDetails;
}

export interface ResumeOptions {
  /**
   * The user confirmed that a step whose signature was requested before a
   * reload may be signed again (they checked their wallet activity).
   */
  readonly confirmResign?: boolean;
  /**
   * The fare the user just approved for this intent in a review this hook
   * did not render (an intent made elsewhere, e.g. by an intent link or an
   * integrator). It counts as approved, so it is not asked for again before
   * the first signature; its digest still goes to prepare, and a fare that
   * changed is shown again before anything is signed. Ignored when it
   * belongs to another intent.
   */
  readonly approvedPreview?: IntentPreview | null;
}

export interface IntentExecution extends ConnectedIntentSigners {
  readonly intent: IntentGraph | null;
  readonly status: IntentExecutionStatus;
  readonly error: IntentExecutionError | null;
  /** Step the executor is working on (preparing, signing or confirming). */
  readonly activeStepId: string | null;
  readonly stepPhases: Readonly<Record<string, LocalStepPhase>>;
  /** Why execution is paused, when `status === "paused"`. */
  readonly pauseReason: string | null;
  /** Steps that need an explicit "sign again" confirmation to continue. */
  readonly reconfirmStepIds: readonly string[];
  /**
   * Steps of the current intent whose signature request went to the wallet
   * without a known outcome (still open, or it failed in a way that does not
   * prove nothing was sent). A view never claims these were not signed.
   */
  readonly signatureUnknownStepIds: readonly string[];
  /** True while the live event stream is connected. */
  readonly streaming: boolean;
  /** Intent stored by a previous page load of this tab, if not yet resumed. */
  readonly resumableIntentId: string | null;
  /**
   * The fare (asset-change preview) of the current intent: the plan's, then
   * the newest one the user approved. Null when the API returned none.
   */
  readonly preview: IntentPreview | null;
  /** A decision the user must take before the next wallet prompt (a changed fare, a contract review). */
  readonly gate: ExecutionGate | null;
  /** Approve (`true`) or stop (`false`) at the open gate. Only an explicit approval continues. */
  readonly resolveGate: (approved: boolean) => void;
  /** Set while the owner's Rule Book holds the intent for an approval. */
  readonly policyHold: PolicyHold | null;
  /**
   * Why the current (non-terminal) intent cannot be signed with the wallets
   * connected right now: a preview account, or a step account that is not
   * connected. Execution refuses to start while this is set.
   */
  readonly bindingProblem: BindingProblem | null;
  /** Persist a plan with the connected accounts for review. No wallet prompt. */
  plan: (request: IntentRequestInput) => Promise<IntentGraph | null>;
  /**
   * Execute an intent. A request (or a graph this hook did not create, such as
   * a dry-run preview) is planned again with the connected accounts first.
   */
  start: (input: IntentRequestInput | IntentGraph) => Promise<IntentGraph | null>;
  /** Refresh a stored or given intent and continue it. Never re-signs a submitted step. */
  resume: (intentId?: string, options?: ResumeOptions) => Promise<IntentGraph | null>;
  /**
   * Show a stored intent again without continuing it (a host view that was
   * left and opened again): a fresh read, its journey, and its terminal
   * status, or paused until the user resumes. Nothing is prepared or signed.
   */
  load: (intentId: string) => Promise<IntentGraph | null>;
  /** Stop executing. Cancels the intent server-side when nothing was submitted yet. */
  cancel: () => Promise<void>;
  /** Forget the current intent (a stored resumable record is kept while steps are in flight). */
  reset: () => void;
  /** Drop the stored resumable record. */
  forgetResumable: () => void;
  /** Where the money is after every step; null until the API returned one for this intent. */
  readonly journey: Journey | null;
  /** Remembered answers that still fit the journey (consequence id → option id). */
  readonly journeyAnswers: Readonly<Record<string, string>>;
  /** Blocking consequences without a valid answer: the next signature waits for each. */
  readonly journeyBlockers: readonly JourneyConsequence[];
  /** The journey option being carried out (a stop or a re-plan in flight). */
  readonly journeyPending: string | null;
  /** Answer a journey prompt and do what the option says. */
  answerJourney: (consequenceId: string, optionId: string) => void;
  /** End the intent at its current stop (`POST /v1/intents/{id}/stop`). Never moves money. */
  stop: () => Promise<IntentGraph | null>;
  /**
   * Take over an intent planned with the connected accounts elsewhere on the
   * page (the desk's clarify commit turn), with its fare and journey, for
   * review. Preview accounts and accounts of wallets that are not connected
   * are refused exactly as in `plan`.
   */
  adopt: (intent: IntentGraph, preview: IntentPreview | null, journey: Journey | null) => IntentGraph | null;
}
