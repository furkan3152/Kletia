/**
 * Framework-neutral request loader behind `useQuote`, `useNetworks` and
 * `usePortfolio`: debounced, one request in flight, the previous request
 * aborted when the input changes or the owner unmounts, and stale responses
 * ignored.
 */
import { createStore, stableKey } from "./store.js";

export type LoaderStatus = "idle" | "loading" | "success" | "error";

export interface LoaderState<T> {
  readonly status: LoaderStatus;
  /** The result for the current input (or the previous input's while loading, with `keepPreviousData`). */
  readonly data: T | null;
  readonly error: unknown;
  /** When `data` was received (ms since epoch). */
  readonly updatedAt: number | null;
}

export interface RequestLoader<I, T> {
  getState(): LoaderState<T>;
  subscribe(listener: () => void): () => void;
  /** Sets the input; null clears it. Equal inputs (by value) do nothing. */
  update(input: I | null): void;
  /** Loads the current input again now. */
  reload(): void;
  /**
   * Starts accepting inputs (mount). The returned function detaches
   * (unmount): it aborts the request in flight, ignores its response and
   * forgets the input, so the next `update` after a remount loads again.
   */
  attach(): () => void;
}

export interface RequestLoaderOptions {
  /** Wait this long after the last input change before requesting (default 0). */
  readonly debounceMs?: number;
  /** Keep showing the previous input's data while a new input loads (default false). */
  readonly keepPreviousData?: boolean;
}

const IDLE: LoaderState<never> = Object.freeze({ status: "idle", data: null, error: null, updatedAt: null });

export function createRequestLoader<I, T>(
  fetcher: (input: I, signal: AbortSignal) => Promise<T>,
  options: RequestLoaderOptions = {},
): RequestLoader<I, T> {
  const debounceMs = Math.max(0, options.debounceMs ?? 0);
  const store = createStore<LoaderState<T>>(IDLE);
  let input: I | null = null;
  let key: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let attached = 0;

  const cancelPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const run = (requestKey: string, value: I) => {
    timer = null;
    const mine = new AbortController();
    controller = mine;
    fetcher(value, mine.signal).then(
      (data) => {
        if (attached === 0 || mine.signal.aborted || key !== requestKey) return;
        controller = null;
        store.setState({ status: "success", data, error: null, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (attached === 0 || mine.signal.aborted || key !== requestKey) return;
        controller = null;
        store.setState({ ...store.getState(), status: "error", error });
      },
    );
  };

  const schedule = (immediate: boolean, inputChanged: boolean) => {
    if (attached === 0 || input === null || key === null) return;
    cancelPending();
    const requestKey = key;
    const value = input;
    const previous = store.getState();
    const data = inputChanged && !options.keepPreviousData ? null : previous.data;
    store.setState({ status: "loading", data, error: null, updatedAt: data === null ? null : previous.updatedAt });
    if (immediate || debounceMs === 0) run(requestKey, value);
    else timer = setTimeout(() => run(requestKey, value), debounceMs);
  };

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    update: (next) => {
      if (attached === 0) return;
      const nextKey = next === null ? null : stableKey(next);
      if (nextKey === key) return;
      key = nextKey;
      input = next;
      if (next === null) {
        cancelPending();
        store.setState(IDLE);
        return;
      }
      schedule(false, true);
    },
    reload: () => schedule(true, false),
    attach: () => {
      attached += 1;
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        attached -= 1;
        if (attached > 0) return;
        cancelPending();
        key = null;
        input = null;
        const state = store.getState();
        if (state.status === "loading") store.setState({ ...state, status: state.data === null ? "idle" : "success" });
      };
    },
  };
}
