import {
  formatAccountId,
  isEvmAddress,
  isSolanaAddress,
  type AccountId,
  type ClarifyThread,
  type IntentGraph,
  type IntentTurnRequest,
} from "@kletia/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { PLATFORM_ORIGIN, PREVIEW_ACCOUNTS, type PlatformError } from "../../../shared/platform/kletiaClient";
import { postIntentTurn, turnPlatformError, turnResponseOf, type TurnExchange, type TurnResponse } from "../../../shared/platform/platformApi";

export interface StudioAccounts {
  readonly evm: AccountId;
  readonly solana: AccountId;
  /** True when the account came from the preview defaults. */
  readonly evmIsPreview: boolean;
  readonly solanaIsPreview: boolean;
}

export function resolveStudioAccounts(evmAddress: string, solanaAddress: string): StudioAccounts {
  const evm = evmAddress.trim();
  const solana = solanaAddress.trim();
  return {
    evm: evm && isEvmAddress(evm) ? formatAccountId("base", evm) : (PREVIEW_ACCOUNTS.evm as AccountId),
    solana: solana && isSolanaAddress(solana) ? formatAccountId("solana", solana) : (PREVIEW_ACCOUNTS.solana as AccountId),
    evmIsPreview: !(evm && isEvmAddress(evm)),
    solanaIsPreview: !(solana && isSolanaAddress(solana)),
  };
}

/** The clarify input of one Studio turn (the sentence first, then answers and chips). */
export type StudioInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "answer"; readonly question: string; readonly option?: string; readonly text?: string }
  | { readonly kind: "assumption"; readonly id: string; readonly option: string };

export interface StudioPlan {
  readonly status: "idle" | "loading" | "success" | "error";
  /** The planned dry-run intent of the last turn, when it planned. */
  readonly data: IntentGraph | undefined;
  /** The last readable turn response (needs_input, planned or cancelled). */
  readonly response: TurnResponse | null;
  readonly error: PlatformError | null;
  readonly latencyMs: number | null;
}

/** Exchanges kept for the response tab (newest last). */
const EXCHANGES_KEPT = 8;

const IDLE: StudioPlan = { status: "idle", data: undefined, response: null, error: null, latencyMs: null };

function unreachable(): PlatformError {
  return { code: "UNREACHABLE", message: "The Kletia API is unreachable from this browser right now.", status: 0, issues: [], requestId: null, retryable: true, unreachable: true };
}

/** A client-held thread blob of a response; null for anything else. */
function threadOf(response: TurnResponse | null): ClarifyThread | null {
  const thread = response?.thread as Partial<ClarifyThread> | undefined;
  return thread && thread.spec === "kletia.thread/v1" && typeof thread.id === "string" ? (thread as ClarifyThread) : null;
}

/**
 * State for the Studio composer: prompt, optional accounts and the clarify
 * exchange. Every turn is a dry run with its fare and itinerary
 * (`POST /v1/intents?clarify=true&dryRun=true&preview=true&journey=true`,
 * `journeyReads=none` with demo accounts); questions are always on. One client-held thread per composer, reset by a new sentence.
 * Each exchange is kept exactly as sent and received for the response tab.
 */
export function useStudioPlanner(initialText = "") {
  const [text, setText] = useState(initialText);
  const [evmAddress, setEvmAddress] = useState("");
  const [solanaAddress, setSolanaAddress] = useState("");
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const [plan, setPlan] = useState<StudioPlan>(IDLE);
  const [exchanges, setExchanges] = useState<readonly TurnExchange[]>([]);
  /** The chip or "text" being sent (pressed, others disabled). */
  const [pending, setPending] = useState<string | null>(null);
  const threadRef = useRef<ClarifyThread | null>(null);
  const sentenceRef = useRef<string>("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const evmError =
    evmAddress.trim() && !isEvmAddress(evmAddress.trim()) ? "Not a valid EVM address (0x followed by 40 hex characters)." : undefined;
  const solanaError =
    solanaAddress.trim() && !isSolanaAddress(solanaAddress.trim()) ? "Not a valid Solana address (base58 public key)." : undefined;
  const textError = submittedText !== null && !text.trim() ? "Describe an outcome first." : undefined;

  /** One turn: the accounts every time (a client-held thread keeps no context), the thread after the first. */
  const turn = useCallback(
    async (input: StudioInput, pendingKey: string | null): Promise<TurnResponse | undefined> => {
      const accounts = resolveStudioAccounts(evmAddress, solanaAddress);
      const fresh = input.kind === "text";
      const thread = fresh ? null : threadRef.current;
      if (!fresh && !thread) return undefined;
      const request: IntentTurnRequest = {
        accounts: [accounts.evm, accounts.solana],
        ...(thread ? { thread } : {}),
        ...(input.kind === "text" ? { text: input.text } : {}),
        ...(input.kind === "answer" ? { answer: { question: input.question, ...(input.option ? { option: input.option } : {}), ...(input.text ? { text: input.text } : {}) } } : {}),
        ...(input.kind === "assumption" ? { assumption: { id: input.id, option: input.option } } : {}),
      };
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setPending(pendingKey);
      setPlan((current) => ({ ...current, status: "loading", error: null }));
      let exchange: TurnExchange;
      try {
        exchange = await postIntentTurn(
          PLATFORM_ORIGIN,
          request,
          // Demo accounts are never read: the itinerary is built without account reads.
          { dryRun: true, preview: true, journey: true, ...(accounts.evmIsPreview && accounts.solanaIsPreview ? { journeyReads: "none" as const } : {}) },
          { signal: controller.signal },
        );
      } catch {
        if (controller.signal.aborted) return undefined;
        setPending(null);
        setPlan((current) => ({ ...current, status: "error", error: unreachable() }));
        return undefined;
      }
      if (controller.signal.aborted) return undefined;
      setPending(null);
      setExchanges((current) => [...current, exchange].slice(-EXCHANGES_KEPT));
      const response = turnResponseOf(exchange);
      if (!response) {
        // A refused turn changes nothing: the thread and the card stay as they were.
        setPlan((current) => ({ ...current, status: "error", error: turnPlatformError(exchange), latencyMs: exchange.latencyMs }));
        return undefined;
      }
      threadRef.current = threadOf(response) ?? threadRef.current;
      setPlan({
        status: "success",
        data: response.status === "planned" ? response.intent : undefined,
        response,
        error: null,
        latencyMs: exchange.latencyMs,
      });
      return response;
    },
    [evmAddress, solanaAddress],
  );

  /** Plans a sentence from scratch (a new thread). */
  const submit = useCallback(
    async (override?: string) => {
      const prompt = (override ?? text).trim();
      setSubmittedText(prompt);
      if (override !== undefined) setText(override);
      if (!prompt || evmError || solanaError) return undefined;
      threadRef.current = null;
      sentenceRef.current = prompt;
      setExchanges([]);
      return turn({ kind: "text", text: prompt }, null);
    },
    [text, evmError, solanaError, turn],
  );

  /** Answers the open question (a chip or typed text) with the same thread. */
  const answer = useCallback(
    (input: { readonly question: string; readonly option?: string; readonly text?: string }) =>
      turn({ kind: "answer", ...input }, input.option ?? "text"),
    [turn],
  );

  /** Another value for one of Kletia's assumptions: plans again in place. */
  const changeAssumption = useCallback((id: string, option: string) => turn({ kind: "assumption", id, option }, null), [turn]);

  /** Forgets the thread and the exchange ("New"). */
  const reset = useCallback(() => {
    controllerRef.current?.abort();
    threadRef.current = null;
    setExchanges([]);
    setPending(null);
    setPlan(IDLE);
  }, []);

  return {
    text,
    setText,
    evmAddress,
    setEvmAddress,
    solanaAddress,
    setSolanaAddress,
    evmError,
    solanaError,
    textError,
    accounts: resolveStudioAccounts(evmAddress, solanaAddress),
    plan,
    exchanges,
    pending,
    submit,
    answer,
    changeAssumption,
    reset,
  };
}
