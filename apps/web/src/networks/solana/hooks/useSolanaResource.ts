import { useCallback, useEffect, useState } from "react";

import { errorMessage, isAbortError, solanaRequest } from "../api";

export interface SolanaResource<T> {
  /** Last successful value for the current path (kept while refreshing). */
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Re-read the current path. */
  refresh: () => void;
}

interface ResourceState<T> {
  readonly key: string | null;
  readonly path: string | null;
  readonly data: T | null;
  readonly error: string | null;
}

/**
 * GET a `/api/solana` path with abort-on-change, a timeout and typed
 * validation. `path === null` disables the request. `parse` must be stable
 * (a module-level parser).
 */
export function useSolanaResource<T>(
  path: string | null,
  parse: (body: unknown) => T,
): SolanaResource<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({
    key: null,
    path: null,
    data: null,
    error: null,
  });
  const key = path === null ? null : `${nonce}:${path}`;

  useEffect(() => {
    if (key === null || path === null) return;
    const controller = new AbortController();
    solanaRequest(path, parse, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, path, data, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((previous) => ({
          key,
          path,
          data: previous.path === path ? previous.data : null,
          error: errorMessage(error),
        }));
      },
    );
    return () => controller.abort();
  }, [key, path, parse]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return {
    data: path !== null && state.path === path ? state.data : null,
    error: key !== null && state.key === key ? state.error : null,
    loading: key !== null && state.key !== key,
    refresh,
  };
}

/** Value that only updates after `delayMs` without changes. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}
