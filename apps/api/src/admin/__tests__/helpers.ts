/**
 * Admin API test helpers: an admin router on an ephemeral port with injected
 * config, memory store, clock, mocked chain client and mocked fetch; wallet
 * fixtures for EVM (viem local account) and Solana (node:crypto ed25519).
 */
import { generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getBase58Decoder } from "@solana/kit";
import express from "express";
import { ContractFunctionRevertedError, TransactionReceiptNotFoundError, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseAdminConfig, type AdminConfig } from "../config.js";
import type { AdminDeps } from "../deps.js";
import { createAdminRouter } from "../http/router.js";
import { MemoryAdminStore } from "../store/memory.js";

export const ORIGIN = "http://localhost:5174";
export const CORS_ORIGINS = ["http://localhost:5174", "http://127.0.0.1:5174", "https://kletiaai.xyz", "https://kletia-frontend.onrender.com"];

export interface SolanaWallet {
  readonly address: string;
  readonly privateKey: KeyObject;
  sign(message: string): string;
}

export function solanaWallet(): SolanaWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = getBase58Decoder().decode(new Uint8Array(raw));
  return {
    address, privateKey,
    sign: (message) => getBase58Decoder().decode(new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), privateKey))),
  };
}

export function evmWallet(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export function revert(functionName = "read"): Error {
  return new ContractFunctionRevertedError({ abi: [], functionName });
}

export function receiptNotFound(hash: `0x${string}`): Error {
  return new TransactionReceiptNotFoundError({ hash });
}

/** A chain client mock: every method can be replaced per test; unknown reads revert. */
export type MockClient = Record<string, (...args: any[]) => any> & {
  reads: Map<string, (args: readonly unknown[], address: string) => unknown>;
};

export function mockClient(chainId = 8453): MockClient {
  const reads = new Map<string, (args: readonly unknown[], address: string) => unknown>();
  const client: MockClient = {
    reads,
    getChainId: async () => chainId,
    getBlockNumber: async () => 1000n,
    getCode: async () => "0x",
    getBalance: async () => 0n,
    getLogs: async () => [],
    verifyMessage: async () => false,
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => { throw receiptNotFound(hash); },
    getTransaction: async () => { throw new Error("no tx"); },
    readContract: async ({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address: string }) => {
      const key = `${address.toLowerCase()}:${functionName}`;
      const handler = reads.get(key) ?? reads.get(functionName);
      if (!handler) throw revert(functionName);
      return handler(args ?? [], address);
    },
  } as unknown as MockClient;
  return client;
}

export interface Harness {
  readonly base: string;
  readonly store: MemoryAdminStore;
  readonly clients: Map<string, MockClient>;
  readonly fetchCalls: { url: string; init: RequestInit | undefined }[];
  env: NodeJS.ProcessEnv;
  config: AdminConfig;
  now: Date;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

export function testConfig(env: NodeJS.ProcessEnv): AdminConfig {
  return parseAdminConfig({ NODE_ENV: "test", ...env }, CORS_ORIGINS);
}

export async function startHarness(options: { env: NodeJS.ProcessEnv; config?: AdminConfig; now?: Date }): Promise<Harness> {
  const store = new MemoryAdminStore();
  const clients = new Map<string, MockClient>();
  const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
  const harness = {
    store, clients, fetchCalls,
    env: options.env,
    config: options.config ?? testConfig(options.env),
    now: options.now ?? new Date("2026-10-15T12:00:00.000Z"),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  } as Partial<Harness> as Harness;
  const chainIds: Record<string, number> = { base: 8453, arbitrum: 42161, ethereum: 1, optimism: 10, polygon: 137, arc: 5042002, "arbitrum-sepolia": 421614 };
  const deps: Partial<AdminDeps> = {
    config: () => harness.config,
    store: () => store,
    client: (network) => {
      if (!clients.has(network)) clients.set(network, mockClient(chainIds[network]));
      return clients.get(network) as unknown as PublicClient;
    },
    now: () => harness.now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      return harness.fetchImpl(url, init);
    }) as typeof fetch,
    // A live view: tests replace harness.env between calls.
    env: new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, name) => (typeof name === "string" ? harness.env[name] : undefined),
      has: (_target, name) => typeof name === "string" && name in harness.env,
      ownKeys: () => Reflect.ownKeys(harness.env),
      getOwnPropertyDescriptor: (_target, name) => (typeof name === "string" && name in harness.env
        ? { configurable: true, enumerable: true, value: harness.env[name], writable: true } : undefined),
    }),
    nativeUsd: async () => 2000,
  };
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json());
  app.use("/api/admin", createAdminRouter(deps));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  Object.assign(harness, {
    base: `http://127.0.0.1:${port}/api/admin`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return harness;
}

export interface Reply<T = any> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export async function call<T = any>(
  harness: Harness, method: string, path: string,
  options: { body?: unknown; cookie?: string | null; origin?: string | null; header?: boolean; contentType?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.header !== false) headers["x-kletia-admin"] = "1";
  if (options.cookie) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = options.contentType ?? "application/json";
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(`${harness.base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

export function cookieFrom(reply: Reply): string | null {
  const header = reply.headers.get("set-cookie");
  if (!header) return null;
  return header.split(";")[0] ?? null;
}

/** Full EVM sign-in; returns the session cookie. */
export async function signInEvm(harness: Harness, account: PrivateKeyAccount, chainId = 8453): Promise<{ cookie: string; reply: Reply }> {
  const nonce = await call(harness, "POST", "/auth/nonce", { body: { address: account.address, chainId } });
  if (nonce.status !== 200) throw new Error(`nonce ${nonce.status} ${JSON.stringify(nonce.body)}`);
  const signature = await account.signMessage({ message: nonce.body.message });
  const reply = await call(harness, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
  const cookie = cookieFrom(reply);
  if (reply.status !== 200 || !cookie) throw new Error(`verify ${reply.status} ${JSON.stringify(reply.body)}`);
  return { cookie, reply };
}

export async function signInSolana(harness: Harness, wallet: SolanaWallet): Promise<{ cookie: string; reply: Reply }> {
  const nonce = await call(harness, "POST", "/auth/nonce", { body: { walletKind: "solana", address: wallet.address } });
  if (nonce.status !== 200) throw new Error(`nonce ${nonce.status} ${JSON.stringify(nonce.body)}`);
  const reply = await call(harness, "POST", "/auth/verify", { body: { message: nonce.body.message, signature: wallet.sign(nonce.body.message) } });
  const cookie = cookieFrom(reply);
  if (reply.status !== 200 || !cookie) throw new Error(`verify ${reply.status} ${JSON.stringify(reply.body)}`);
  return { cookie, reply };
}
