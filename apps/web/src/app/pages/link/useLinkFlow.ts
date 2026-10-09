/**
 * Data for the intent link page: the public link view, and an indicative
 * quote for the visitor's funding choice (debounced, cached per choice for
 * 20 s like the API's own cache, and never retried automatically: quotes are
 * rate limited per visitor).
 */
import type { LinkIntentResponse } from "@kletia/sdk";
import { useCallback, useEffect, useState } from "react";

import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { loadLink, quoteLink, type FundingChoice, type LinkLoad } from "./linkClient";

export type LinkState = { readonly phase: "loading" } | { readonly phase: "error"; readonly error: PlatformError } | ({ readonly phase: "loaded" } & { readonly load: LinkLoad });

export function useLinkView(linkId: string): { readonly state: LinkState; readonly reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${linkId}|${attempt}`;
  const [result, setResult] = useState<{ readonly key: string; readonly state: LinkState } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    loadLink(linkId, controller.signal).then(
      (load) => {
        if (active) setResult({ key, state: { phase: "loaded", load } });
      },
      (error: unknown) => {
        if (active) setResult({ key, state: { phase: "error", error: toPlatformError(error) } });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, linkId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { state: result && result.key === key ? result.state : { phase: "loading" }, reload };
}

export type QuoteState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly response: LinkIntentResponse; readonly at: number }
  | { readonly status: "error"; readonly error: PlatformError; readonly at: number };

const QUOTE_TTL_MS = 20_000;
const DEBOUNCE_MS = 650;

function choiceKey(choice: FundingChoice): string {
  return `${choice.network}:${choice.asset}:${choice.amount ?? ""}`;
}

/** The indicative fare of `choice` (null: nothing to quote yet). */
export function useLinkQuote(linkId: string, choice: FundingChoice | null): { readonly quote: QuoteState; readonly results: Readonly<Record<string, QuoteState>>; readonly retry: () => void } {
  const [results, setResults] = useState<Readonly<Record<string, QuoteState>>>({});
  const [attempt, setAttempt] = useState(0);
  const key = choice ? choiceKey(choice) : null;
  const current = key ? results[key] : undefined;

  useEffect(() => {
    if (!choice || !key) return undefined;
    const existing = results[key];
    const fresh = existing && (existing.status === "ok" || existing.status === "error") && Date.now() - existing.at <= QUOTE_TTL_MS;
    if (fresh && !(existing.status === "error" && attempt > 0)) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setResults((all) => ({ ...all, [key]: { status: "loading" } }));
      quoteLink(linkId, choice, null, controller.signal).then(
        (response) => setResults((all) => ({ ...all, [key]: { status: "ok", response, at: Date.now() } })),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResults((all) => ({ ...all, [key]: { status: "error", error: toPlatformError(error), at: Date.now() } }));
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `results` is read for the cache check only; a new result must not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, linkId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // A cached fare older than the API's own cache shows until its refresh arrives (the plan with the wallet quotes again anyway).
  const quote: QuoteState = !choice || !key ? { status: "idle" } : current ?? { status: "loading" };
  return { quote, results, retry };
}
