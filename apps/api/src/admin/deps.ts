/**
 * Injectable dependencies of the admin API (configuration, store, chain
 * clients, clock, outbound fetch). Production uses the defaults; tests
 * replace any of them.
 */
import type { AdminEvmNetwork, AdminSessionView } from "@kletia/core";
import type { PublicClient } from "viem";
import { evmClient } from "../platform/engine/chains/evm.js";
import { nativeUsdPrice } from "../platform/engine/prices.js";
import { platformDatabaseUrl } from "../platform/http/db.js";
import { adminConfig, type AdminConfig } from "./config.js";
import { MemoryAdminStore } from "./store/memory.js";
import { PostgresAdminStore } from "./store/postgres.js";
import type { AdminSessionRecord, AdminStore } from "./store/types.js";

export interface AdminDeps {
  readonly config: () => AdminConfig;
  readonly store: () => AdminStore;
  readonly client: (network: AdminEvmNetwork) => PublicClient;
  readonly now: () => Date;
  readonly fetch: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  readonly nativeUsd: (network: AdminEvmNetwork) => Promise<number | null>;
}

/** The authenticated admin of one request. */
export interface AdminSessionContext {
  readonly idHash: string;
  readonly record: AdminSessionRecord;
  readonly view: AdminSessionView;
  /** Checksummed EVM addresses that may send on-chain admin transactions for this session. */
  readonly actors: readonly string[];
  /** Address written to the audit log and to createdBy fields. */
  readonly actor: string;
}

let defaultStore: AdminStore | null = null;

function selectStore(): AdminStore {
  if (defaultStore) return defaultStore;
  if (platformDatabaseUrl()) defaultStore = new PostgresAdminStore();
  else defaultStore = new MemoryAdminStore({ production: process.env.NODE_ENV === "production" });
  return defaultStore;
}

export function defaultAdminDeps(): AdminDeps {
  return {
    config: adminConfig,
    store: selectStore,
    client: (network) => evmClient(network),
    now: () => new Date(),
    fetch: (input, init) => fetch(input, init),
    env: process.env,
    nativeUsd: (network) => nativeUsdPrice(network),
  };
}
