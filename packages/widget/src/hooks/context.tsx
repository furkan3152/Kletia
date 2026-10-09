import { createContext, useContext, useMemo, type ReactNode } from "react";
import { KletiaClient, type KletiaClientOptions } from "@kletia/sdk";
import { stableKey } from "./store.js";

const KletiaClientContext = createContext<KletiaClient | null>(null);

export interface KletiaProviderProps {
  /** An existing client. */
  readonly client?: KletiaClient;
  /**
   * Options to create one (compared by value, so an inline object is fine).
   * In the browser never pass a `kl_dev_` apiKey: use the public tier or a
   * `baseUrl` that proxies through your server.
   */
  readonly options?: KletiaClientOptions;
  readonly children?: ReactNode;
}

/** Provides the Kletia client to the hooks below it. */
export function KletiaProvider({ client, options, children }: KletiaProviderProps) {
  // A new client (and so new hook state) only when the options really change.
  const optionsKey = options ? stableKey(options) : "";
  const customFetch = options?.fetch;
  const value = useMemo(
    () => client ?? new KletiaClient(options),
    // `options` is read through optionsKey (by value) and customFetch (by identity).
    [client, optionsKey, customFetch],
  );
  return <KletiaClientContext.Provider value={value}>{children}</KletiaClientContext.Provider>;
}

/** The client from the nearest `KletiaProvider`, or `override` when given. */
export function useKletiaClient(override?: KletiaClient): KletiaClient {
  const client = useContext(KletiaClientContext);
  const resolved = override ?? client;
  if (!resolved) {
    throw new Error("Kletia hooks need a client: wrap the tree in <KletiaProvider> or pass `client`.");
  }
  return resolved;
}
