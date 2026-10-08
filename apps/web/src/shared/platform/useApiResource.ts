import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KletiaClient } from "@kletia/sdk";

import { getKletiaClient, toPlatformError, type PlatformError } from "./kletiaClient";

export type ApiStatus = "idle" | "loading" | "success" | "error";

export type ApiLoader<T> = (client: KletiaClient, signal: AbortSignal) => Promise<T>;

export interface ApiResource<T> {
  readonly status: ApiStatus;
  /** Last successful value; kept while a reload is in flight. */
  readonly data: T | undefined;
  readonly error: PlatformError | null;
  /** Wall-clock time of the last settled response. */
  readonly updatedAt: number | null;
  /** Round-trip time of the last settled response, in milliseconds. */
  readonly latencyMs: number | null;
  readonly reload: () => void;
}

interface Settled<T> {
  readonly token: string;
  readonly data: T | undefined;
  readonly error: PlatformError | null;
  readonly updatedAt: number;
  readonly latencyMs: number;
}

/**
 * Fetches a Kletia API resource. `key` identifies the request: when it
 * changes the previous request is aborted and a new one starts; `null`
 * keeps the hook idle. The loader always receives the shared client.
 */
export function useApiResource<T>(key: string | null, loader: ApiLoader<T>): ApiResource<T> {
  const loaderRef = useRef(loader);
  useLayoutEffect(() => {
    loaderRef.current = loader;
  });

  const [generation, setGeneration] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [lastData, setLastData] = useState<T | undefined>(undefined);
  const token = key === null ? null : `${key}#${generation}`;

  useEffect(() => {
    if (token === null) return undefined;
    const controller = new AbortController();
    const startedAt = performance.now();
    let client: KletiaClient;
    try {
      client = getKletiaClient();
    } catch (error) {
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        setSettled({
          token,
          data: undefined,
          error: toPlatformError(error),
          updatedAt: Date.now(),
          latencyMs: 0,
        });
      });
      return () => controller.abort();
    }
    loaderRef
      .current(client, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setLastData(data);
        setSettled({
          token,
          data,
          error: null,
          updatedAt: Date.now(),
          latencyMs: Math.round(performance.now() - startedAt),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({
          token,
          data: undefined,
          error: toPlatformError(error),
          updatedAt: Date.now(),
          latencyMs: Math.round(performance.now() - startedAt),
        });
      });
    return () => controller.abort();
  }, [token]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const current = settled && settled.token === token ? settled : null;
  const status: ApiStatus =
    token === null ? "idle" : current === null ? "loading" : current.error ? "error" : "success";

  return {
    status,
    data: current && !current.error ? current.data : lastData,
    error: current?.error ?? null,
    updatedAt: settled?.updatedAt ?? null,
    latencyMs: settled?.latencyMs ?? null,
    reload,
  };
}

export interface ApiAction<A extends unknown[], T> {
  readonly status: ApiStatus;
  readonly data: T | undefined;
  readonly error: PlatformError | null;
  readonly latencyMs: number | null;
  /** Runs the action; aborts any previous run. Resolves to the value, or undefined on failure. */
  readonly run: (...args: A) => Promise<T | undefined>;
  readonly reset: () => void;
}

/** Imperative API call (form submits, explorer requests) with abort and error state. */
export function useApiAction<A extends unknown[], T>(
  action: (client: KletiaClient, signal: AbortSignal, ...args: A) => Promise<T>,
): ApiAction<A, T> {
  const actionRef = useRef(action);
  useLayoutEffect(() => {
    actionRef.current = action;
  });
  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    status: ApiStatus;
    data: T | undefined;
    error: PlatformError | null;
    latencyMs: number | null;
  }>({ status: "idle", data: undefined, error: null, latencyMs: null });

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((previous) => ({ ...previous, status: "loading", error: null }));
    const startedAt = performance.now();
    try {
      const data = await actionRef.current(getKletiaClient(), controller.signal, ...args);
      if (controller.signal.aborted) return undefined;
      setState({
        status: "success",
        data,
        error: null,
        latencyMs: Math.round(performance.now() - startedAt),
      });
      return data;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      setState({
        status: "error",
        data: undefined,
        error: toPlatformError(error),
        latencyMs: Math.round(performance.now() - startedAt),
      });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setState({ status: "idle", data: undefined, error: null, latencyMs: null });
  }, []);

  return { ...state, run, reset };
}
