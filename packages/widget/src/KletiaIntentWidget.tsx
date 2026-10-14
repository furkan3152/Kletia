import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CHAINS,
  formatAmount,
  isSessionId,
  openBlockers,
  parseAccountId,
  type AccountId,
  type ContractReview as ContractReviewData,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type IntentTurnRequest,
  type Journey,
  type JourneyConsequence,
  type KletiaAppearance,
  type NetworkKey,
  type PreviewIssue,
  resolveAppearance,
  type SessionView,
  type SourceNetwork,
  type StepPreview,
  type StepStatus,
} from "@kletia/core";
import {
  KletiaApiError,
  KletiaClient,
  KletiaExecutionError,
  KletiaPolicyError,
  executeIntent,
  isIntentTerminal,
  type IntentSigners,
  type IntentTurnResult,
  type KletiaClientOptions,
  type PreviewGateContext,
} from "@kletia/sdk";
import { AssumptionChips } from "./AssumptionChips.js";
import { ClarifyCard, type ClarifyCardAnswer } from "./ClarifyCard.js";
import { ContractReview } from "./ContractReview.js";
import { FareBreakdown } from "./FareBreakdown.js";
import { JourneyRoute } from "./JourneyRoute.js";
import { PolicyNotice } from "./PolicyNotice.js";
import { ReceiptStamp } from "./ReceiptStamp.js";
import {
  blockingIssuesFor,
  clarifyEventOf,
  clarifyView,
  cleanText,
  consequenceFactsKey,
  contractReviewModel,
  fareModel,
  httpsUrl,
  isContractStep,
  isHttpsUrl,
  JOURNEY_HANDLE_IT_OPTION,
  validJourneyAnswers,
  type ClarifyEvent,
  type JourneyAnswerMemory,
  policyHold,
  policyOutcome,
  shortAddress,
  type PolicyErrorLike,
  type PolicyOutcomeView,
} from "./review.js";
import {
  describeScopeRefusal,
  KletiaScopeError,
  normalizeScope,
  outOfScope,
  scopedSourceNetwork,
  type WidgetAction,
} from "./scope.js";
import { ensureWidgetStyles } from "./styles.js";

export const DEFAULT_WIDGET_EXAMPLES: readonly string[] = [
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "stake 1.5 SOL with jito",
];

/** Stored intent ids: `int_` + 32 lower-case hex. */
const INTENT_ID = /^int_[0-9a-f]{32}$/u;

export interface KletiaIntentWidgetProps {
  /** An existing client, or options to create one (keep `clientOptions` stable, e.g. with useMemo). */
  readonly client?: KletiaClient;
  readonly clientOptions?: KletiaClientOptions;
  /**
   * Your project's publishable key (`kl_pub_…`, safe in browser code): the
   * widget's client sends it as `Authorization: Bearer kl_pub_…`, so intents
   * are owned by your project and your allowed origins and rule book apply.
   * Ignored when `client` is given (that client's key is used). Never pass a
   * secret key here; the SDK refuses anything that is not a publishable key.
   */
  readonly publishableKey?: string;
  /** CAIP-10 accounts the user controls. Required to plan. */
  readonly accounts: readonly AccountId[];
  /** Wallet signers. When omitted, the widget plans and reviews but does not execute. */
  readonly signers?: IntentSigners;
  readonly defaultText?: string;
  readonly examples?: readonly string[];
  /** Colour scheme (default: `appearance.colorScheme`, else `auto`, which follows the visitor's system). */
  readonly theme?: "light" | "dark" | "auto";
  /**
   * Appearance tokens (`kletia.appearance/v1`): colours with contrast floors,
   * radius, border, shadow, font, density and header. Safety surfaces (the
   * fare, contract reviews, policy holds, stamps, the footer) never change.
   */
  readonly appearance?: KletiaAppearance;
  /**
   * Networks this widget works with. A plan that touches any other network
   * (a bridge destination or a recipient included) is refused before Execute.
   */
  readonly networks?: readonly NetworkKey[];
  /** Kinds of action this widget offers (swap, bridge, transfer, stake, deposit, withdraw); other plans are refused before Execute. */
  readonly actions?: readonly WidgetAction[];
  /**
   * Where the money starts: a network key (kept inside `networks`) or
   * `"auto"` (Kletia picks the funded network). Sent as the request's
   * `sourceNetwork`; with preview accounts `"auto"` behaves as absent.
   */
  readonly sourceNetwork?: SourceNetwork;
  readonly maxSlippageBps?: number;
  /** Opaque metadata attached to created intents (e.g. your order id). */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Open an intent your backend created with its API key (`int_…`) instead
   * of planning one from text: the widget shows its review and fare, and the
   * user signs it with the wallet the intent was planned for.
   */
  readonly intentId?: string;
  /**
   * Run a session your backend created (`cs_…`): the widget shows who is
   * asking and what, and turns it into an intent for the connected wallet.
   */
  readonly sessionId?: string;
  /**
   * Origin of the page the visitor is on, sent with session intents (it
   * must be in the session's `allowedOrigins`). Defaults to this page's
   * origin; the hosted `/embed` frame passes its proven host origin.
   */
  readonly hostOrigin?: string | null;
  /** Ask for the asset-change preview ("fare breakdown") with every plan (default true). */
  readonly preview?: boolean;
  /**
   * Rebuild approval and receipt links on this origin when the API returns
   * non-https ones (the Kletia web app itself, for local development).
   */
  readonly linkOrigin?: string | null;
  readonly onIntentCreated?: (intent: IntentGraph) => void;
  /** An intent named by `intentId` was loaded (it was created elsewhere, so `onIntentCreated` does not fire). */
  readonly onIntentOpened?: (intent: IntentGraph) => void;
  /** A session named by `sessionId` was loaded (who is asking and what; the `/embed` frame offers only the wallets it needs). */
  readonly onSessionLoaded?: (session: SessionView) => void;
  readonly onUpdate?: (intent: IntentGraph) => void;
  readonly onComplete?: (intent: IntentGraph) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Kletia asked a clarifying question: how many, why (reason codes), of
   * what kind and whether only the person can answer (`purpose`). Never the
   * values, the options or the sentence.
   */
  readonly onClarify?: (event: ClarifyEvent) => void;
  readonly className?: string;
}

/**
 * The widget's client: `client` when given, else one built from
 * `clientOptions` with the publishable key (sent as `Authorization: Bearer
 * kl_pub_…`). With a key and an explicit `hostOrigin` (the hosted frame's
 * proven host), requests also carry `Kletia-Host-Origin`, which the API
 * checks against the project's allowed origins.
 */
export function createWidgetClient(options: Pick<KletiaIntentWidgetProps, "client" | "clientOptions" | "publishableKey" | "hostOrigin">): KletiaClient {
  if (options.client) return options.client;
  const { clientOptions, publishableKey, hostOrigin } = options;
  if (!publishableKey) return new KletiaClient(clientOptions);
  const headers = typeof hostOrigin === "string" && hostOrigin ? { ...clientOptions?.headers, "kletia-host-origin": hostOrigin } : clientOptions?.headers;
  return new KletiaClient({ ...clientOptions, publishableKey, ...(headers ? { headers } : {}) });
}

const STATUS_TONE: Partial<Record<StepStatus, "ok" | "bad" | "live">> = {
  settled: "ok",
  confirmed: "ok",
  failed: "bad",
  indeterminate: "bad",
  awaiting_signature: "live",
  submitted: "live",
  settling: "live",
};

function useResolvedTheme(theme: KletiaIntentWidgetProps["theme"]): "light" | "dark" {
  const [prefersDark, setPrefersDark] = useState(false);
  useEffect(() => {
    if (theme !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(query.matches);
    const listener = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [theme]);
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

function describeError(error: unknown): string {
  if (error instanceof KletiaExecutionError && error.references) {
    const count = error.references.length;
    const them = count === 1 ? "it" : "them";
    const sent = `Your wallet already sent ${count} transaction${count === 1 ? "" : "s"} for this step, but Kletia has not recorded ${them}`;
    return error.cause instanceof KletiaApiError && !error.cause.retryable
      ? `${sent}: ${error.cause.message} This step will not be signed again; check your wallet's activity and plan a new intent if needed.`
      : `${sent} yet. Resubmit reports ${them} without signing again.`;
  }
  if (error instanceof KletiaApiError && error.code === "CONTRACT_PENDING" && error.retryAfterSeconds !== null) {
    return pendingText(new Date(Date.now() + error.retryAfterSeconds * 1000));
  }
  if (error instanceof KletiaApiError) {
    const issue = error.issues[0];
    const message = issue ? `${error.message} (${issue.path || "request"}: ${issue.message})` : error.message;
    const hints = error.hints.slice(0, 3);
    return hints.length > 0 ? `${message} Try: ${hints.map((hint) => `“${hint}”`).join(", ")}.` : message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * A checkout whose contract registration is still in its activation delay:
 * when it opens, in local time and minutes from now.
 */
function pendingText(opensAt: Date): string {
  const minutes = Math.max(1, Math.ceil((opensAt.getTime() - Date.now()) / 60_000));
  const clock = opensAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `This checkout opens at ${clock} (in ${minutes} min). Kletia waits before a newly registered contract can be used, so its owner is warned first.`;
}

/** The latest activation time among a session's pending registrations, while it is still ahead. */
function sessionOpensAt(session: SessionView | null, now: number): Date | null {
  const times = (session?.warnings ?? [])
    .filter((warning) => warning.code === "CONTRACT_PENDING")
    .map((warning) => Date.parse(warning.activatesAt))
    .filter((time) => Number.isFinite(time) && time > now);
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

/** The host of an origin, for text ("acme.example"); empty when it is not a URL. */
function hostOf(origin: string): string {
  try {
    return cleanText(new URL(origin).host, 120);
  } catch {
    return "";
  }
}

/** Same wallet: EVM addresses on any chain (case-insensitive), Solana addresses exactly. */
function sameOwner(a: string, b: string): boolean {
  const left = parseAccountId(a);
  const right = parseAccountId(b);
  if (!left || !right || left.chain.namespace !== right.chain.namespace) return false;
  if (left.chain.namespace === "eip155") return left.address.toLowerCase() === right.address.toLowerCase();
  return left.chain.id === right.chain.id && left.address === right.address;
}

/** The first wallet step whose account is not one of the connected accounts. */
function unboundStep(intent: IntentGraph, accounts: readonly AccountId[]): IntentStep | null {
  if (isIntentTerminal(intent)) return null;
  return (
    [...intent.steps]
      .sort((a, b) => a.index - b.index)
      .find((step) => step.mode === "wallet" && !["settled", "skipped", "submitted", "confirmed", "settling"].includes(step.status) && !accounts.some((account) => sameOwner(account, step.account))) ?? null
  );
}

function StepRow({ step }: { step: IntentStep }) {
  const chain = CHAINS[step.network];
  // Only https explorer links are rendered; anything else (e.g. javascript:) is dropped.
  const evidence = [...step.evidence].reverse().find((item) => item.url && isHttpsUrl(item.url));
  return (
    <li className="kw-step">
      <div className="kw-step-top">
        <span className="kw-step-title">{step.title}</span>
        <span className="kw-status" data-tone={STATUS_TONE[step.status] ?? undefined}>
          {step.status.replace(/_/gu, " ")}
        </span>
      </div>
      <span className="kw-net">
        <span className="kw-dot" style={{ background: chain.color }} aria-hidden="true" />
        {chain.shortName} · {step.protocol}
        {step.settlement?.destinationNetwork
          ? ` → ${CHAINS[step.settlement.destinationNetwork].shortName}`
          : ""}
      </span>
      {step.input || step.expectedOutput ? (
        <span className="kw-io">
          {step.input ? (
            <>
              <strong>{formatAmount(step.input.formatted)}</strong> {step.input.symbol}
            </>
          ) : null}
          {step.input && step.expectedOutput ? " → " : null}
          {step.expectedOutput ? (
            <>
              ~<strong>{formatAmount(step.expectedOutput.formatted)}</strong> {step.expectedOutput.symbol}
            </>
          ) : null}
          {step.minimumOutput ? ` (min ${formatAmount(step.minimumOutput.formatted)})` : null}
        </span>
      ) : null}
      {step.warnings?.map((warning) => (
        <span key={warning} className="kw-warn">
          {warning}
        </span>
      ))}
      {step.failure ? <span className="kw-warn">{step.failure.message}</span> : null}
      {evidence?.url ? (
        <a className="kw-link" href={evidence.url} target="_blank" rel="noreferrer noopener">
          View on explorer
        </a>
      ) : null}
    </li>
  );
}

/** A pause before the wallet prompt that needs the user. */
type Gate =
  | {
      readonly kind: "fare";
      readonly preview: IntentPreview;
      readonly previous: IntentPreview | null;
      readonly changes: readonly PreviewIssue[];
      readonly reason: PreviewGateContext["reason"];
      readonly stepTitle: string;
    }
  | {
      readonly kind: "review";
      readonly review: ContractReviewData;
      /** The plan-time review, to show what moved since planning. */
      readonly planned: ContractReviewData | null;
      readonly stepTitle: string;
      readonly stepNumber: number;
    };

const GATE_COPY: Readonly<Record<PreviewGateContext["reason"], string>> = {
  "before-prepare": "Check the fare before Kletia prepares this step.",
  prepared: "This is the fare of exactly what your wallet will sign. It differs from the one you approved.",
  changed: "The fare changed since you approved it. Kletia did not hand anything to your wallet.",
  unacknowledged: "Kletia no longer had the fare you approved, so here is the fare of exactly what your wallet will sign.",
};

/**
 * Drop-in intent widget. Plans a natural-language intent through the Kletia
 * API (or opens an intent or session your backend created), shows the
 * reviewed steps with the fare breakdown and, when wallet signers are
 * provided, executes it step by step. Custom-contract steps show their
 * review and need an explicit confirmation before each signature; a fare
 * that changed is shown again before anything is signed.
 */
export function KletiaIntentWidget(props: KletiaIntentWidgetProps) {
  const {
    accounts,
    signers,
    examples = DEFAULT_WIDGET_EXAMPLES,
    appearance,
    networks,
    actions,
    sourceNetwork,
    maxSlippageBps,
    metadata,
    intentId,
    sessionId,
    hostOrigin,
    preview: wantPreview = true,
    linkOrigin = null,
    onIntentCreated,
    onIntentOpened,
    onUpdate,
    onComplete,
    onError,
    onClarify,
    className,
    publishableKey,
  } = props;
  // Notifications only: their identity must not reload the intent or session.
  const notify = useRef({ onError, onIntentOpened, onSessionLoaded: props.onSessionLoaded });
  useLayoutEffect(() => {
    notify.current = { onError, onIntentOpened, onSessionLoaded: props.onSessionLoaded };
  });
  const client = useMemo(
    () => createWidgetClient({ client: props.client, clientOptions: props.clientOptions, publishableKey, hostOrigin }),
    [props.client, props.clientOptions, publishableKey, hostOrigin],
  );
  const resolvedTheme = useResolvedTheme(props.theme ?? appearance?.colorScheme ?? "auto");
  const resolvedAppearance = useMemo(() => resolveAppearance(appearance, resolvedTheme), [appearance, resolvedTheme]);
  const rootStyle = useMemo(
    () => (Object.keys(resolvedAppearance.vars).length > 0 ? (resolvedAppearance.vars as CSSProperties) : undefined),
    [resolvedAppearance],
  );
  // Keyed by content, so a new array with the same networks does not re-check or re-report a plan.
  const networksKey = networks?.join(",") ?? "";
  const actionsKey = actions?.join(",") ?? "";
  const scope = useMemo(
    () => normalizeScope({ networks: networksKey ? networksKey.split(",") : [], actions: actionsKey ? actionsKey.split(",") : [] }),
    [networksKey, actionsKey],
  );
  const source = scopedSourceNetwork(sourceNetwork, scope);
  const textId = useId();
  const amountId = useId();
  const [text, setText] = useState(props.defaultText ?? "");
  const [intent, setIntent] = useState<IntentGraph | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "planning" | "executing">(intentId || sessionId ? "loading" : "idle");
  const [error, setError] = useState<unknown>(null);
  /** Broadcast references Kletia has not accepted yet, by step id: resubmitted, never signed again. */
  const [unreported, setUnreported] = useState<Readonly<Record<string, readonly string[]>>>({});
  /** The fare on screen (the plan's, or the newest one Kletia returned). */
  const [fare, setFare] = useState<IntentPreview | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateAck, setGateAck] = useState(false);
  /** Plan-time acknowledgements of custom-contract steps, by step id. */
  const [acks, setAcks] = useState<Readonly<Record<string, boolean>>>({});
  const [hold, setHold] = useState<PolicyOutcomeView | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessionAmount, setSessionAmount] = useState("");
  /** This widget ran (or opened) a stored intent, so its receipt is the user's to share. */
  const [owned, setOwned] = useState(false);
  /** Why the last execution stopped without an error (the user stopped at a gate). */
  const [stopped, setStopped] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const gateResolve = useRef<((approved: boolean) => void) | null>(null);
  const gateRef = useRef<HTMLDivElement | null>(null);
  /** Digests of fares the user approved (pressing Execute approves the fare on screen). */
  const approvedDigests = useRef(new Set<string>());
  /** The text task's last clarify turn (its questions, assumptions and thread). */
  const [turn, setTurn] = useState<IntentTurnResult | null>(null);
  /** The answer a clarify turn or a journey prompt is sending (pressed, others disabled). */
  const [pendingAnswer, setPendingAnswer] = useState<string | null>(null);
  /** "Not now": the open question waits, folded. */
  const [questionHidden, setQuestionHidden] = useState(false);
  /** Where the money is after each step: read with the plan and on step changes, never polled. */
  const [journey, setJourney] = useState<Journey | null>(null);
  /** Answers to journey prompts for this intent, with the facts they answered. */
  const [journeyMemory, setJourneyMemory] = useState<Readonly<Record<string, JourneyAnswerMemory>>>({});
  /** One polite announcement at a time (a question appeared, Kletia assumed, a blocker appeared). */
  const [announcement, setAnnouncement] = useState("");
  /** Bumped by every turn and plan: a response for an older one is ignored. */
  const turnEpoch = useRef(0);
  const promptRef = useRef<HTMLDivElement | null>(null);
  const executeRef = useRef<HTMLButtonElement | null>(null);
  /** The user answered from a card: focus follows to the next prompt or Execute. */
  const [focusAfterTurn, setFocusAfterTurn] = useState(false);
  /** Remembered answers that still fit this journey (asked again when their facts changed). */
  const journeyAnswers = useMemo(() => validJourneyAnswers(journey, journeyMemory), [journey, journeyMemory]);

  const closeGate = useCallback((approved: boolean) => {
    const resolve = gateResolve.current;
    gateResolve.current = null;
    setGate(null);
    setGateAck(false);
    resolve?.(approved);
  }, []);

  useEffect(() => {
    ensureWidgetStyles();
    return () => {
      abortRef.current?.abort();
      // A turn answered after unmount is never applied.
      turnEpoch.current += 1;
      // A pending review never turns into a signature once the widget is gone.
      const resolve = gateResolve.current;
      gateResolve.current = null;
      resolve?.(false);
    };
  }, []);

  // A decision before the wallet prompt takes focus, so keyboard and screen-reader users meet it first.
  const gateKey = gate ? (gate.kind === "fare" ? `fare:${gate.preview.digest}` : `review:${gate.stepNumber}`) : null;
  useEffect(() => {
    if (gateKey) gateRef.current?.focus();
  }, [gateKey]);

  const origin = useMemo(() => {
    if (hostOrigin !== undefined) return hostOrigin;
    const value = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    return typeof value === "string" && value !== "null" ? value : null;
  }, [hostOrigin]);

  /**
   * A fresh fare for a stored intent (computed now, else the last one Kletia
   * kept); null when the API has none. Intents without a plan record come
   * from an API that keeps no fares.
   */
  const loadFare = useCallback(
    async (stored: IntentGraph, signal?: AbortSignal): Promise<IntentPreview | null> => {
      if (!wantPreview || !stored.plan) return null;
      const options = signal ? { signal } : {};
      try {
        return await client.intents.preview(stored.id, { ...options, maxRetries: 0 });
      } catch {
        // Rate limited or unavailable: fall back to the kept one.
      }
      try {
        return await client.intents.getPreview(stored.id, options);
      } catch {
        return null;
      }
    },
    [client, wantPreview],
  );

  // Flow A: an intent the integrator created. Flow B: a session the integrator created.
  useEffect(() => {
    if (!intentId && !sessionId) return undefined;
    const controller = new AbortController();
    setPhase("loading");
    setError(null);
    void (async () => {
      try {
        if (intentId) {
          if (!INTENT_ID.test(intentId)) throw new KletiaApiError({ code: "INTENT_NOT_FOUND", message: "This link does not name a Kletia intent.", status: 0 });
          const loaded = await client.intents.get(intentId, { signal: controller.signal });
          if (controller.signal.aborted) return;
          // The fare is read before anything renders: the review then appears once, with its fare,
          // instead of the steps being pushed down when the fare arrives (layout shift).
          const loadedFare = await loadFare(loaded, controller.signal);
          if (controller.signal.aborted) return;
          const loadedJourney = await client.intents.journey(loaded.id, { signal: controller.signal }).catch(() => null);
          if (controller.signal.aborted) return;
          setIntent(loaded);
          setOwned(true);
          setHold(policyHold(loaded, { fallbackOrigin: linkOrigin }));
          setFare(loadedFare);
          setJourney(loadedJourney && loadedJourney.intentId === loaded.id ? loadedJourney : null);
          setJourneyMemory({});
          notify.current.onIntentOpened?.(loaded);
        } else if (sessionId) {
          if (!isSessionId(sessionId)) throw new KletiaApiError({ code: "SESSION_NOT_FOUND", message: "This link does not name a Kletia session.", status: 0 });
          const view = await client.sessions.get(sessionId, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setSession(view);
          setSessionAmount(view.amount?.default ?? "");
          notify.current.onSessionLoaded?.(view);
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught);
        notify.current.onError?.(caught);
      } finally {
        if (!controller.signal.aborted) setPhase("idle");
      }
    })();
    return () => controller.abort();
  }, [client, intentId, sessionId, loadFare, linkOrigin]);

  // A plan outside the scope is reported once per intent; Execute stays disabled (see `refusal` below).
  const scopeRefusal = intent ? outOfScope(intent, scope) : null;
  const refusedFor = scopeRefusal && intent ? intent.id : null;
  const latestRefusal = useRef(scopeRefusal);
  latestRefusal.current = scopeRefusal;
  useEffect(() => {
    if (refusedFor && latestRefusal.current) notify.current.onError?.(new KletiaScopeError(latestRefusal.current));
  }, [refusedFor]);

  const adopt = (created: IntentGraph, createdFare: IntentPreview | null, createdJourney: Journey | null = null) => {
    setIntent(created);
    setFare(createdFare);
    setJourney(createdJourney && createdJourney.intentId === created.id ? createdJourney : null);
    setJourneyMemory({});
    setHold(policyHold(created, { fallbackOrigin: linkOrigin }));
    setAcks({});
    approvedDigests.current.clear();
    onIntentCreated?.(created);
  };

  /** Clears the previous plan before a new sentence or a structured re-plan. */
  const clearPlan = () => {
    setError(null);
    setIntent(null);
    setFare(null);
    setJourney(null);
    setJourneyMemory({});
    setHold(null);
    setStopped(null);
    setUnreported({});
  };

  /** The request context of every turn and plan: accounts, departure, slippage, metadata. */
  const context = () => ({
    accounts,
    ...(source ? { sourceNetwork: source } : {}),
    ...(maxSlippageBps ? { constraints: { maxSlippageBps } } : {}),
    ...(metadata ? { metadata } : {}),
  });

  /**
   * One clarify turn (text mode always plans this way): a new
   * sentence (`fresh`), an answer or an assumption change. A response that
   * arrives after a newer turn, a reset or a new sentence is ignored; a
   * refusal keeps the card and the thread as they were.
   */
  const runTurn = async (input: Pick<IntentTurnRequest, "text" | "answer" | "assumption">, pendingKey: string, fresh: boolean) => {
    if (accounts.length === 0) return;
    const thread = fresh ? null : turn?.thread ?? null;
    if (!fresh && !thread) return;
    turnEpoch.current += 1;
    const mine = turnEpoch.current;
    setPhase("planning");
    setPendingAnswer(pendingKey);
    if (fresh) {
      clearPlan();
      setTurn(null);
      setQuestionHidden(false);
    } else {
      setError(null);
    }
    try {
      const memory = thread ? ("spec" in thread ? { thread } : { threadId: thread.id }) : {};
      const response = await client.intents.turn({ ...context(), ...memory, ...input }, { journey: true, ...(wantPreview ? { preview: true } : {}) });
      if (mine !== turnEpoch.current) return;
      if (response.status === "needs_input") {
        clearPlan();
        setTurn(response);
        setQuestionHidden(false);
        setAnnouncement(clarifyView(response).announcement);
        const event = clarifyEventOf(response);
        if (event) onClarify?.(event);
      } else if (response.status === "planned") {
        setTurn(response);
        setStopped(null);
        setUnreported({});
        adopt(response.intent, wantPreview ? response.preview ?? null : null, response.journey ?? null);
        setAnnouncement(clarifyView(response).announcement);
      } else {
        clearPlan();
        setTurn(null);
      }
      if (!fresh) setFocusAfterTurn(true);
    } catch (caught) {
      if (mine !== turnEpoch.current) return;
      setError(caught);
      onError?.(caught);
    } finally {
      if (mine === turnEpoch.current) {
        setPendingAnswer(null);
        setPhase("idle");
      }
    }
  };

  const plan = async () => {
    if (!text.trim() || accounts.length === 0) return;
    await runTurn({ text: text.trim() }, "message", true);
  };

  const openQuestions = turn?.status === "needs_input" ? turn.questions : [];
  const answerQuestion = (answer: ClarifyCardAnswer) => {
    const questionId = answer.questionId ?? openQuestions[0]?.id;
    // Only questions still open on this thread are answered (never after a reset or a new sentence).
    if (!questionId || pendingAnswer !== null || !openQuestions.some((question) => question.id === questionId)) return;
    if ("optionId" in answer) void runTurn({ answer: { question: questionId, option: answer.optionId } }, answer.optionId, false);
    else if (answer.text.trim()) void runTurn({ answer: { question: questionId, text: answer.text.trim().slice(0, 1000) } }, "text", false);
  };

  const chooseAssumption = (assumptionId: string, optionId: string) => {
    if (turn?.status !== "planned" || pendingAnswer !== null || phase === "executing") return;
    const assumption = turn.assumptions.find((entry) => entry.id === assumptionId);
    if (!assumption || !assumption.alternatives.some((option) => option.id === optionId)) return;
    void runTurn({ assumption: { id: assumptionId, option: optionId } }, `assumption:${optionId}`, false);
  };

  /** A structured plan (a journey option that re-plans, e.g. with a gas top-up), with its fare and journey. */
  const planRequest = async (request: JourneyConsequence["options"][number]["action"] & { readonly type: "replan" }) => {
    turnEpoch.current += 1;
    const mine = turnEpoch.current;
    setPhase("planning");
    clearPlan();
    setTurn(null);
    try {
      const created = await client.intents.create({ ...request.request, ...(metadata && !request.request.metadata ? { metadata } : {}) }, { journey: true });
      if (mine !== turnEpoch.current) return;
      adopt(created.intent, wantPreview ? created.preview : null, created.journey);
      setFocusAfterTurn(true);
    } catch (caught) {
      if (mine !== turnEpoch.current) return;
      setError(caught);
      onError?.(caught);
    } finally {
      if (mine === turnEpoch.current) setPhase("idle");
    }
  };

  /** The user answered a journey prompt: remember it (with its facts) and do what the option says. */
  const answerJourney = (consequenceId: string, optionId: string) => {
    const consequence = journey?.consequences.find((entry) => entry.id === consequenceId);
    if (!consequence || !intent || busy) return;
    const option = consequence.options.find((entry) => entry.id === optionId) ?? null;
    if (!option && optionId !== JOURNEY_HANDLE_IT_OPTION) return;
    setJourneyMemory((current) => ({ ...current, [consequenceId]: { option: optionId, facts: consequenceFactsKey(consequence) } }));
    setFocusAfterTurn(true);
    const action = option?.action;
    if (!action) return;
    if (action.type === "replan") void planRequest(action);
    else if (action.type === "plan-new") setText(cleanText(action.text, 1000));
    else if (action.type === "link") {
      const url = httpsUrl(action.url);
      if (url && typeof window !== "undefined") window.open(url.href, "_blank", "noopener,noreferrer");
    } else if (action.type === "stop") {
      const current = intent;
      setPhase("planning");
      void client.intents
        .stop(current.id)
        .then((stoppedIntent) => {
          setIntent(stoppedIntent.intent);
          if (stoppedIntent.journey && stoppedIntent.journey.intentId === current.id) setJourney(stoppedIntent.journey);
        })
        .catch((caught: unknown) => {
          setError(caught);
          onError?.(caught);
        })
        .finally(() => setPhase("idle"));
    }
    // acknowledge and retry: remembered; Execute continues.
  };

  const sessionOriginAllowed = !session || (origin !== null && session.allowedOrigins.includes(origin));
  // A session whose contract is still pending opens by itself: re-render when it does.
  const [clock, setClock] = useState(() => Date.now());
  const opensAt = sessionOpensAt(session, clock);
  const opensAtTime = opensAt?.getTime() ?? null;
  useEffect(() => {
    if (opensAtTime === null) return undefined;
    notify.current.onError?.(new KletiaApiError({ code: "CONTRACT_PENDING", message: "This checkout's contract is not active yet.", status: 409 }));
    const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.max(1_000, opensAtTime - Date.now() + 500), 2_147_000_000));
    return () => clearTimeout(timer);
  }, [opensAtTime]);
  const planSession = async () => {
    if (!session || !sessionId || accounts.length === 0 || !signers || !origin || !sessionOriginAllowed || opensAt) return;
    setPhase("planning");
    setError(null);
    try {
      const amount = session.amount && sessionAmount.trim() ? { amount: sessionAmount.trim() } : {};
      const { intent: created } = await client.sessions.createIntent(sessionId, { accounts, hostOrigin: origin, ...amount });
      setOwned(true);
      const createdFare = await loadFare(created);
      adopt(created, createdFare, await client.intents.journey(created.id).catch(() => null));
    } catch (caught) {
      setError(caught);
      onError?.(caught);
    } finally {
      setPhase("idle");
    }
  };

  const execute = async () => {
    if (!intent || !signers) return;
    // Fail closed: an open journey blocker is answered before anything is prepared.
    if (journey && journey.intentId === intent.id && openBlockers(journey, journeyAnswers).length > 0) {
      promptRef.current?.focus();
      return;
    }
    const tracked = journey && journey.intentId === intent.id ? journeyAnswers : null;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("executing");
    setError(null);
    setHold(null);
    setStopped(null);
    setOwned(true);
    // Pressing Execute approves the fare on screen; any other fare is shown again first.
    const shown = fare;
    if (shown) approvedDigests.current.add(shown.digest);
    /** The newest fare the user approved: printed struck through when a later one is worse. */
    let lastApproved = shown;
    const ask = (next: Gate) =>
      new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) {
          resolve(false);
          return;
        }
        gateResolve.current?.(false);
        gateResolve.current = resolve;
        setGateAck(false);
        setGate(next);
      });
    const titleOf = (step: IntentStep) => `Step ${step.index + 1}: ${cleanText(step.title, 120)}`;
    try {
      const final = await executeIntent(client, intent, signers, {
        signal: controller.signal,
        pendingReferences: unreported,
        onUpdate: (next) => {
          setIntent(next);
          onUpdate?.(next);
        },
        // The fare gate only runs against an API that returned a fare; without one the SDK
        // still refuses any blocking preview issue on its own.
        ...(shown
          ? {
              preview: shown,
              onPreview: async (next: IntentPreview, stepPreview: StepPreview | null, context: PreviewGateContext) => {
                // Never sign through an issue Kletia marked as blocking, whatever the user clicks.
                const blocking = blockingIssuesFor(context.step.id, stepPreview, next);
                if (blocking.length > 0) {
                  setFare(next);
                  throw new KletiaExecutionError(
                    `Kletia will not sign step ${context.step.index + 1}: ${blocking.map((issue) => issue.message || issue.code).join("; ")}`,
                    context.intent.id,
                    context.step.id,
                  );
                }
                if (context.reason === "before-prepare" && approvedDigests.current.has(next.digest)) return true;
                const approved = await ask({
                  kind: "fare",
                  preview: next,
                  previous: lastApproved,
                  changes: context.changes,
                  reason: context.reason,
                  stepTitle: titleOf(context.step),
                });
                if (approved) {
                  approvedDigests.current.add(next.digest);
                  lastApproved = next;
                  setFare(next);
                } else {
                  setStopped(`You stopped before signing ${titleOf(context.step)}. Nothing was signed for it.`);
                }
                return approved;
              },
            }
          : {}),
        onReview: async (step, review, context) => {
          const approved = await ask({ kind: "review", review, planned: context.planned ?? null, stepTitle: titleOf(step), stepNumber: step.index + 1 });
          if (!approved) setStopped(`You stopped before signing ${titleOf(step)}. Nothing was signed for it.`);
          return approved;
        },
        onApprovalRequired: (_approval, policyError) => {
          setHold(policyOutcome(policyError, { fallbackOrigin: linkOrigin }));
        },
        // With a journey, the SDK reads it on step changes (never polling) and stops before the
        // wallet prompt of a leg whose blocker is unanswered.
        ...(tracked
          ? {
              journeyAnswers: tracked,
              onJourney: (next: Journey) => {
                if (next.intentId === intent.id) setJourney(next);
              },
              onJourneyBlocked: (blockers: readonly JourneyConsequence[], step: IntentStep) => {
                const first = blockers[0];
                setStopped(`Kletia has a question before ${titleOf(step)}${first ? `: ${cleanText(first.title, 160)}` : ""}. Nothing was signed for it.`);
                setAnnouncement(`Kletia has a question before ${titleOf(step)}.`);
              },
            }
          : {}),
      });
      setUnreported({});
      setIntent(final);
      if (tracked) {
        // Where the money is now, after the last step change.
        void client.intents.journey(final.id).then((next) => {
          if (next.intentId === final.id) setJourney(next);
        }).catch(() => undefined);
      }
      if (isIntentTerminal(final)) onComplete?.(final);
    } catch (caught) {
      // Keep only what this failure left unreported; the next Execute resubmits it.
      setUnreported(
        caught instanceof KletiaExecutionError && caught.references && caught.intentId === intent.id
          ? { [caught.stepId]: caught.references }
          : {},
      );
      const cause = caught instanceof KletiaExecutionError && caught.cause instanceof KletiaApiError ? caught.cause : caught;
      setError(cause instanceof KletiaPolicyError ? cause : caught);
      onError?.(caught);
      void client.intents.get(intent.id).then(setIntent).catch(() => undefined);
      if (tracked) {
        void client.intents.journey(intent.id).then((next) => {
          if (next.intentId === intent.id) setJourney(next);
        }).catch(() => undefined);
      }
    } finally {
      const resolve = gateResolve.current;
      gateResolve.current = null;
      resolve?.(false);
      setGate(null);
      setPhase("idle");
    }
  };

  const busy = phase !== "idle";
  const finished = intent ? ["completed", "failed", "partially_completed", "cancelled", "expired"].includes(intent.status) : false;
  const resubmit = intent
    ? intent.steps.some(
        (step) => unreported[step.id] && (step.status === "ready" || step.status === "awaiting_signature"),
      )
    : false;
  const contractSteps = intent ? [...intent.steps].sort((a, b) => a.index - b.index).filter((step) => isContractStep(step) && step.call?.review) : [];
  const missingAck = contractSteps.some((step) => step.call?.review && contractReviewModel(step.call.review).needsAcknowledgement && !acks[step.id]);
  const unbound = intent && (intentId || sessionId) ? unboundStep(intent, accounts) : null;
  const fareBlocking = fare ? fareModel(fare, intent).blocking : [];
  const policyError = error instanceof KletiaApiError ? policyOutcome(error as PolicyErrorLike, { fallbackOrigin: linkOrigin }) : null;
  const sessionMode = Boolean(sessionId) && !intent;
  const textMode = !intentId && !sessionId;
  const refusal = finished ? null : scopeRefusal;
  const shownJourney = journey && intent && journey.intentId === intent.id ? journey : null;
  const journeyBlockers = shownJourney && !finished ? openBlockers(shownJourney, journeyAnswers) : [];
  const readyButBlocked = Boolean(intent && signers) && !busy && !finished && !missingAck && !unbound && fareBlocking.length === 0 && !refusal;
  const canExecute = readyButBlocked && journeyBlockers.length === 0;
  const questionOpen = textMode && turn?.status === "needs_input" && openQuestions.length > 0;
  const card = questionOpen && turn ? clarifyView(turn).card : null;
  const laneLabel = signers ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : "Preview";
  const header = resolvedAppearance.header;

  // After an answer, focus moves to the next prompt (the clarify card focuses itself) or to Execute.
  useEffect(() => {
    if (!focusAfterTurn || busy) return;
    setFocusAfterTurn(false);
    if (questionOpen) return;
    const prompt = promptRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]');
    if (prompt) prompt.focus();
    else if (executeRef.current && !executeRef.current.disabled) executeRef.current.focus();
  }, [focusAfterTurn, busy, questionOpen]);

  return (
    <section
      className={`kw-root${className ? ` ${className}` : ""}`}
      data-theme={resolvedTheme}
      {...(appearance?.density === "compact" ? { "data-density": "compact" } : {})}
      {...(appearance?.shadow === "soft" || appearance?.shadow === "none" ? { "data-shadow": appearance.shadow } : {})}
      style={rootStyle}
      aria-label="Kletia intent"
    >
      {header !== "none" ? (
        <div className="kw-head">
          <span className="kw-brand">
            Klet<b>ia</b> intents
          </span>
          <span className="kw-lane">{laneLabel}</span>
        </div>
      ) : null}

      {textMode ? (
        <>
          <label className="kw-label" htmlFor={textId}>
            What should happen?
          </label>
          <textarea
            id={textId}
            className="kw-textarea"
            value={text}
            maxLength={1000}
            placeholder="bridge 25 USDC from base to solana then swap half to JitoSOL"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void plan();
            }}
          />
          <div className="kw-chips">
            {examples.map((example) => (
              <button key={example} type="button" className="kw-chip" onClick={() => setText(example)}>
                {example}
              </button>
            ))}
          </div>
          {/* The kw-clarify slot: one question card, or Kletia's assumptions once planned. */}
          {questionOpen || (turn?.status === "planned" && intent && !finished && turn.intent.id === intent.id && turn.assumptions.length > 0) ? (
            <div className="kw-clarify">
              {card && !questionHidden ? (
                <ClarifyCard
                  question={card}
                  pending={pendingAnswer}
                  disabled={busy && pendingAnswer === null}
                  autoFocus
                  onAnswer={answerQuestion}
                  onDismiss={() => setQuestionHidden(true)}
                />
              ) : null}
              {card && questionHidden ? (
                <p className="kw-hint kw-clarify-wait">
                  {openQuestions.length === 1 ? "1 question is waiting." : `${openQuestions.length} questions are waiting.`}{" "}
                  <button type="button" className="kw-linkbtn" onClick={() => setQuestionHidden(false)}>
                    Show
                  </button>
                </p>
              ) : null}
              {!questionOpen && turn?.status === "planned" ? (
                <AssumptionChips assumptions={turn.assumptions} onChange={chooseAssumption} disabled={busy} />
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {session && sessionMode ? (
        <div className="kw-session">
          <p className="kw-session-who">
            <strong>{cleanText(session.integrator.name, 80) || "An integrator"}</strong>
            {session.integrator.website && isHttpsUrl(session.integrator.website) ? (
              <span className="kw-muted"> · {hostOf(session.integrator.website)}</span>
            ) : null}
            <span className={session.integrator.domainVerified ? "kw-stamp" : "kw-stamp kw-stamp-warn"}>
              {session.integrator.domainVerified ? "Domain verified" : "Domain not verified"}
            </span>
          </p>
          <p>{origin && hostOf(origin) ? `${hostOf(origin)} is asking you to:` : "This session asks you to:"}</p>
          <ol className="kw-review-args">
            {session.actions.map((action, position) => (
              <li key={position}>{cleanText(action.label, 160) || action.kind}</li>
            ))}
          </ol>
          {session.amount ? (
            <>
              <label className="kw-label" htmlFor={amountId}>
                Amount{session.amount.symbol ? ` (${cleanText(session.amount.symbol, 16)})` : ""}, from {cleanText(session.amount.min, 32)} to {cleanText(session.amount.max, 32)}
              </label>
              <input
                id={amountId}
                className="kw-input"
                inputMode="decimal"
                value={sessionAmount}
                onChange={(event) => setSessionAmount(event.target.value.replace(/[^0-9.]/gu, "").slice(0, 32))}
              />
            </>
          ) : null}
          {opensAt && session.status === "active" ? (
            <p className="kw-error kw-pending" role="status">
              {pendingText(opensAt)}
            </p>
          ) : null}
          {session.status !== "active" ? (
            <p className="kw-error">{session.status === "expired" ? "This session expired. Ask the site for a new one." : "This session was already used."}</p>
          ) : !sessionOriginAllowed ? (
            <p className="kw-error">
              This session was not created for {origin ? hostOf(origin) || "this page" : "this page"}, so Kletia will not run it here.
            </p>
          ) : null}
          <p className="kw-muted">You review the plan and sign every step in your own wallet. The site cannot sign for you.</p>
        </div>
      ) : null}

      <div className="kw-row">
        {textMode ? (
          <button
            type="button"
            className="kw-btn"
            disabled={busy || !text.trim() || accounts.length === 0}
            onClick={() => void plan()}
          >
            {phase === "planning" && pendingAnswer === "message" ? "Planning…" : "Plan"}
          </button>
        ) : null}
        {sessionMode && session ? (
          <button
            type="button"
            className="kw-btn"
            disabled={busy || !signers || accounts.length === 0 || session.status !== "active" || !sessionOriginAllowed || opensAt !== null}
            onClick={() => void planSession()}
            title={signers ? undefined : "Connect a wallet to plan with your accounts"}
          >
            {phase === "planning" ? "Planning…" : signers ? "Plan with my wallet" : "Connect a wallet to plan"}
          </button>
        ) : null}
        {!sessionMode ? (
          <button
            ref={executeRef}
            type="button"
            className="kw-btn kw-primary"
            // Blocked only by a journey question: still focusable, pressing it moves focus to the question.
            disabled={!canExecute && !(readyButBlocked && journeyBlockers.length > 0)}
            aria-disabled={readyButBlocked && journeyBlockers.length > 0 ? true : undefined}
            aria-describedby={readyButBlocked && journeyBlockers.length > 0 ? `${textId}-blocked` : undefined}
            onClick={() => {
              if (journeyBlockers.length > 0) {
                const radio = promptRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]');
                (radio ?? promptRef.current)?.focus();
                return;
              }
              void execute();
            }}
            title={signers ? undefined : "Connect wallets to execute"}
          >
            {phase === "executing" ? "Executing…" : resubmit ? "Resubmit" : "Execute"}
          </button>
        ) : null}
      </div>

      {intent && !finished && !busy && !gate && signers && missingAck ? (
        <p className="kw-muted kw-hint">Read the custom contract below and tick its acknowledgement to enable Execute.</p>
      ) : null}
      {questionOpen && !intent ? <p className="kw-muted kw-hint">Answer the question above to plan.</p> : null}
      {readyButBlocked && journeyBlockers.length > 0 ? (
        <p className="kw-hint kw-jr-gate" id={`${textId}-blocked`}>
          {journeyBlockers.length === 1 ? "Answer 1 question in the itinerary to enable Execute." : `Answer ${journeyBlockers.length} questions in the itinerary to enable Execute.`}
        </p>
      ) : null}
      <p className="kw-sr" role="status" aria-live="polite">
        {announcement}
      </p>

      {gate ? (
        <div
          ref={gateRef}
          tabIndex={-1}
          className="kw-gate"
          role="group"
          aria-label={gate.kind === "fare" ? "Check the fare again before signing" : "Confirm the custom contract before signing"}
        >
          {gate.kind === "fare" ? (
            <>
              <p className="kw-gate-title">{gate.stepTitle}</p>
              <p>{GATE_COPY[gate.reason]}</p>
              <FareBreakdown
                preview={gate.preview}
                intent={intent}
                previous={gate.reason === "changed" || gate.changes.length > 0 ? gate.previous : null}
                changes={gate.changes}
              />
              <div className="kw-row">
                <button type="button" className="kw-btn kw-primary" onClick={() => closeGate(true)}>
                  Approve this fare
                </button>
                <button type="button" className="kw-btn" onClick={() => closeGate(false)}>
                  Stop
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="kw-gate-title">{gate.stepTitle}</p>
              <p>Kletia prepared this step. Check the contract before your wallet asks you to sign.</p>
              <ContractReview review={gate.review} planned={gate.planned} title={`Step ${gate.stepNumber}`} acknowledged={gateAck} onAcknowledge={setGateAck} />
              <div className="kw-row">
                <button
                  type="button"
                  className="kw-btn kw-primary"
                  disabled={contractReviewModel(gate.review).needsAcknowledgement && !gateAck}
                  onClick={() => closeGate(true)}
                >
                  Sign this step
                </button>
                <button type="button" className="kw-btn" onClick={() => closeGate(false)}>
                  Stop
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div aria-live="polite">
        {policyError ? (
          <PolicyNotice outcome={policyError} />
        ) : error ? (
          <div className="kw-error">{describeError(error)}</div>
        ) : null}
        {hold && !finished ? <PolicyNotice outcome={hold} {...(signers ? { onCheckAgain: () => void execute(), busy } : {})} /> : null}
        {stopped && !busy && !finished ? (
          <p className="kw-stopped" role="status">
            {stopped} Press Execute to see it again.
          </p>
        ) : null}
        {refusal ? (
          <div className="kw-error kw-scope" role="alert">
            <p className="kw-scope-title">Not available here</p>
            {describeScopeRefusal(refusal, scope).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>Nothing was signed. Execute stays off for this plan.</p>
          </div>
        ) : null}
        {unbound ? (
          <div className="kw-error">
            This intent was prepared for <code className="kw-break">{shortAddress(unbound.account)}</code> on {CHAINS[unbound.network]?.name ?? unbound.network}. Connect that wallet to sign it.
          </div>
        ) : null}
        {intent && (intentId || sessionId) && (intent.status === "expired" || intent.status === "cancelled") ? (
          <p className="kw-stopped" role="status">
            This intent {intent.status === "expired" ? "expired" : "was cancelled"}, so nothing can be signed here. Ask the site that sent you here for a new one.
          </p>
        ) : null}
        {intent ? (
          <>
            <div className="kw-summary">
              <h3>{intent.summary.title}</h3>
              <div className="kw-meta">
                <span>Status: {intent.status.replace(/_/gu, " ")}</span>
                <span>{intent.summary.signaturesRequired} signature(s)</span>
                {intent.summary.totalFeesUsd !== undefined ? (
                  <span>Fees ≈ ${intent.summary.totalFeesUsd.toFixed(2)}</span>
                ) : null}
                {intent.summary.estimatedSeconds !== undefined ? (
                  <span>ETA ≈ {Math.max(1, Math.round(intent.summary.estimatedSeconds))}s</span>
                ) : null}
              </div>
            </div>
            {fare && !finished && !gate ? <FareBreakdown preview={fare} intent={intent} /> : null}
            {/* The kw-journey slot: after the fare, before the steps. Never hideable by appearance. */}
            {shownJourney ? (
              <JourneyRoute
                journey={shownJourney}
                answered={journeyAnswers}
                onAnswer={answerJourney}
                holdPrompt={questionOpen || Boolean(gate)}
                busy={busy}
                promptRef={promptRef}
              />
            ) : null}
            <ol className="kw-steps">
              {intent.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>
            {!finished && contractSteps.length > 0 && !gate
              ? contractSteps.map((step) => (
                  <ContractReview
                    key={step.id}
                    review={step.call!.review}
                    title={`Step ${step.index + 1}`}
                    acknowledged={Boolean(acks[step.id])}
                    onAcknowledge={(value) => setAcks((current) => ({ ...current, [step.id]: value }))}
                    disabled={busy}
                  />
                ))
              : null}
            {finished && owned && intent.plan ? <ReceiptStamp client={client} intentId={intent.id} intentStatus={intent.status} fallbackOrigin={linkOrigin} /> : null}
          </>
        ) : null}
      </div>
      <div className="kw-foot">
        <span>
          {header === "none" ? `${laneLabel} · ` : ""}Non-custodial · your wallet signs every step
        </span>
        <a className="kw-link" href="https://kletiaai.xyz" target="_blank" rel="noreferrer noopener">
          Kletia
        </a>
      </div>
    </section>
  );
}

export default KletiaIntentWidget;
