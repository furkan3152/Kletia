import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AccountId } from "@kletia/core";
import type { KletiaClient, NetworkCapabilities, PortfolioResponse, QuoteRequest, QuoteResponse } from "@kletia/sdk";
import { useKletiaClient } from "./context.js";
import { createRequestLoader, type LoaderState, type RequestLoader } from "./loader.js";

export interface UseRequestResult<T> extends LoaderState<T> {
  /** Requests the current input again now. */
  reload(): void;
}

function useLoader<I, T>(loader: RequestLoader<I, T>, input: I | null): UseRequestResult<T> {
  useEffect(() => loader.attach(), [loader]);
  // Inputs are compared by value inside the loader, so object literals are fine.
  useEffect(() => {
    loader.update(input);
  });
  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);
  return useMemo(() => ({ ...state, reload: loader.reload }), [state, loader]);
}

export interface UseQuoteOptions {
  readonly client?: KletiaClient;
  /** Wait after the last input change before quoting (default 400 ms). */
  readonly debounceMs?: number;
  /** Keep the previous quote visible while a new one loads (default false). */
  readonly keepPreviousData?: boolean;
}

/**
 * Debounced quote for one movement. The request in flight is aborted when
 * the input changes or the component unmounts; pass null to quote nothing
 * (e.g. while the amount is empty).
 */
export function useQuote(input: QuoteRequest | null | undefined, options: UseQuoteOptions = {}): UseRequestResult<QuoteResponse> {
  const client = useKletiaClient(options.client);
  const { debounceMs = 400, keepPreviousData = false } = options;
  const loader = useMemo(
    () => createRequestLoader<QuoteRequest, QuoteResponse>((request, signal) => client.quote(request, { signal }), { debounceMs, keepPreviousData }),
    [client, debounceMs, keepPreviousData],
  );
  return useLoader(loader, input ?? null);
}

/** Networks with their actions and protocols (`GET /v1/networks`). */
export function useNetworks(options: { readonly client?: KletiaClient } = {}): UseRequestResult<NetworkCapabilities[]> {
  const client = useKletiaClient(options.client);
  const loader = useMemo(
    () => createRequestLoader<true, NetworkCapabilities[]>((_input, signal) => client.networks({ signal })),
    [client],
  );
  return useLoader(loader, true);
}

/** Balances of one CAIP-10 account; null loads nothing. */
export function usePortfolio(
  accountId: AccountId | string | null | undefined,
  options: { readonly client?: KletiaClient } = {},
): UseRequestResult<PortfolioResponse> {
  const client = useKletiaClient(options.client);
  const loader = useMemo(
    () => createRequestLoader<string, PortfolioResponse>((account, signal) => client.portfolio(account, { signal })),
    [client],
  );
  return useLoader(loader, accountId ?? null);
}
