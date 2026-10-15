/**
 * React side of the admin client: the panel context (client, session,
 * wallets, catalog, address book), react-query reads keyed under "admin", and
 * the wallet operations every section shares (switch network, sign, send,
 * wait). Loaded only inside AdminConsole (wallet code).
 */
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { Abi, Hex, PublicClient, WalletClient } from "viem";
import { useConfig } from "wagmi";
import { getPublicClient, getWalletClient, signMessage, signTypedData, switchChain } from "wagmi/actions";

import { useSolanaWallet } from "../../../../shared/wallet/solana/useSolanaWallet";
import type { AddressBook } from "../model/preview";
import { payloadSha256 } from "../model/confirm";
import { chainIdOf } from "../model/plan";
import { safeTxTypedData, type SafeTxInput } from "../model/safe";
import { sessionKind, type ConnectedWallets, type EvmSigner } from "../model/session";
import { base58Encode, messageBytes } from "../model/signIn";
import type { AdminCatalog, AdminEvmNetwork, AdminSessionView } from "../model/types";
import { AdminApiError, gateFor, type AdminClient } from "./adminClient";

export interface AdminContextValue {
  readonly client: AdminClient;
  readonly session: AdminSessionView;
  readonly wallets: ConnectedWallets;
  readonly signer: EvmSigner;
  readonly catalog: AdminCatalog | null;
  readonly book: AddressBook;
  /** Wallet operations (switch, sign, send, wait), shared by every section. */
  readonly ops: WalletOps;
  /** An error that ends the session or turns the panel off (401, ADMIN_DISABLED …): the app resets its gate. */
  readonly reportGateError: (error: unknown) => void;
  /** Switch to another section (`?section=`), optionally with a focus target id. */
  readonly goTo: (section: AdminSectionId, focus?: string) => void;
}

export type AdminSectionId = "overview" | "deployments" | "deploy" | "manage" | "safe" | "fees" | "services" | "environment" | "audit" | "export";

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin outside the admin panel.");
  return value;
}

/** Errors that belong to the whole panel, not to one card. */
const PANEL_GATES = new Set(["signed-out", "disabled", "store", "origin", "missing"]);

/** A read of the admin API: retried once when retryable, and a session-ending error resets the panel. */
export function useAdminQuery<T>(key: readonly unknown[], read: (client: AdminClient) => Promise<T>, options: { readonly enabled?: boolean; readonly refetchInterval?: number | false } = {}): UseQueryResult<T, AdminApiError> {
  const { client, reportGateError } = useAdmin();
  const query = useQuery<T, AdminApiError>({
    queryKey: ["admin", ...key],
    queryFn: () => read(client),
    retry: (count, error) => count < 1 && error instanceof AdminApiError && error.retryable,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
  });
  const error = query.error;
  useEffect(() => {
    if (error && PANEL_GATES.has(gateFor(error) ?? "")) reportGateError(error);
  }, [error, reportGateError]);
  return query;
}

/** Shared reads, so sections hit one cache entry. */
export const useDeployments = () => useAdminQuery(["deployments"], (client) => client.deployments());
export const useProfiles = () => useAdminQuery(["profiles"], (client) => client.profiles());
export const useArtifact = (artifactId: string | null) =>
  useAdminQuery(["artifact", artifactId], (client) => client.artifact(artifactId as string), { enabled: Boolean(artifactId) });

/* ---------------- Wallet operations ---------------- */

export interface WalletOps {
  /** Switch the EVM wallet to the network's chain (wagmi adds the chain from the app's list). */
  ensureChain: (network: AdminEvmNetwork) => Promise<void>;
  publicClient: (network: AdminEvmNetwork) => PublicClient;
  /** Sends creation data from the connected EVM wallet; returns the tx hash. */
  sendDeploy: (network: AdminEvmNetwork, data: Hex) => Promise<Hex>;
  /** Simulates, then sends a contract call from the connected EVM wallet; returns the tx hash. */
  writeCall: (input: { network: AdminEvmNetwork; address: string; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }) => Promise<Hex>;
  /** Signs a SafeTx with the connected EVM wallet. */
  signSafeTx: (network: AdminEvmNetwork, safe: string, tx: SafeTxInput) => Promise<Hex>;
  /** Signs a message with the wallet that holds the session (EVM personal_sign, Solana signMessage + base58). */
  signWithSessionWallet: (message: string) => Promise<string>;
  /** Signs a message with a given wallet family (sign-in). */
  signText: (kind: "evm" | "solana", message: string) => Promise<string>;
  waitReceipt: (network: AdminEvmNetwork, hash: Hex, confirmations: number) => Promise<{ status: "success" | "reverted"; blockNumber: bigint; contractAddress?: string | null }>;
}

export function useWalletOps(session: AdminSessionView | null): WalletOps {
  const config = useConfig();
  const solana = useSolanaWallet();

  const ensureChain = useCallback(
    async (network: AdminEvmNetwork) => {
      const chainId = chainIdOf(network);
      const wallet = await getWalletClient(config).catch(() => null);
      if (wallet && wallet.chain?.id === chainId) return;
      try {
        await switchChain(config, { chainId } as never);
      } catch (error) {
        const name = network === "arbitrum-sepolia" ? "Arbitrum Sepolia" : network.charAt(0).toUpperCase() + network.slice(1);
        throw Object.assign(new Error(`Switch to ${name} in your wallet to continue.`), { cause: error });
      }
    },
    [config],
  );

  const publicClient = useCallback(
    (network: AdminEvmNetwork) => {
      // The wagmi config lists all seven admin EVM chains (providers.tsx); its chain-id union is erased here.
      const client = getPublicClient(config, { chainId: chainIdOf(network) } as never) as unknown as PublicClient | undefined;
      if (!client) throw new Error(`No RPC for ${network} in this browser.`);
      return client;
    },
    [config],
  );

  const walletFor = useCallback(
    async (network: AdminEvmNetwork) => {
      await ensureChain(network);
      return (await getWalletClient(config, { chainId: chainIdOf(network) } as never)) as unknown as WalletClient;
    },
    [config, ensureChain],
  );

  const sendDeploy = useCallback(
    async (network: AdminEvmNetwork, data: Hex) => {
      const wallet = await walletFor(network);
      if (!wallet.account) throw new Error("Connect the EVM admin wallet.");
      // A transaction without `to` is a contract creation: exactly the previewed creation data.
      return wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, data, to: null } as Parameters<WalletClient["sendTransaction"]>[0]);
    },
    [walletFor],
  );

  const writeCall = useCallback<WalletOps["writeCall"]>(
    async ({ network, address, abi, functionName, args, value }) => {
      const wallet = await walletFor(network);
      const reader = publicClient(network);
      const { request } = await reader.simulateContract({
        account: wallet.account,
        address: address as Hex,
        abi,
        functionName,
        args: args as unknown[],
        ...(value !== undefined && value > 0n ? { value } : {}),
      } as Parameters<typeof reader.simulateContract>[0]);
      return wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
    },
    [publicClient, walletFor],
  );

  const signSafeTx = useCallback(
    async (network: AdminEvmNetwork, safe: string, tx: SafeTxInput) => {
      await ensureChain(network);
      const typed = safeTxTypedData(chainIdOf(network), safe, tx);
      return signTypedData(config, typed as Parameters<typeof signTypedData>[1]);
    },
    [config, ensureChain],
  );

  const signText = useCallback(
    async (kind: "evm" | "solana", message: string) => {
      if (kind === "evm") return signMessage(config, { message });
      const feature = solana.wallet?.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage] | undefined;
      const account = solana.account;
      if (!feature || !account) throw new Error("This Solana wallet cannot sign messages. Connect a wallet that supports message signing.");
      const [output] = await feature.signMessage({ account, message: messageBytes(message) });
      if (!output?.signature || output.signature.length !== 64) throw new Error("The Solana wallet returned no signature.");
      return base58Encode(output.signature);
    },
    [config, solana.account, solana.wallet],
  );

  const signWithSessionWallet = useCallback(
    async (message: string) => {
      if (!session) throw new Error("Sign in first.");
      return signText(sessionKind(session), message);
    },
    [session, signText],
  );

  const waitReceipt = useCallback<WalletOps["waitReceipt"]>(
    async (network, hash, confirmations) => {
      const receipt = await publicClient(network).waitForTransactionReceipt({ hash, confirmations, timeout: 10 * 60_000 });
      return { status: receipt.status, blockNumber: receipt.blockNumber, contractAddress: receipt.contractAddress ?? null };
    },
    [publicClient],
  );

  return useMemo(
    () => ({ ensureChain, publicClient, sendDeploy, writeCall, signSafeTx, signWithSessionWallet, signText, waitReceipt }),
    [ensureChain, publicClient, sendDeploy, writeCall, signSafeTx, signWithSessionWallet, signText, waitReceipt],
  );
}

/**
 * Step-up confirmation: a fresh `confirm` nonce bound to the action and the
 * body's hash, signed by the wallet that holds the session.
 */
export function useStepUp() {
  const { client, session, ops } = useAdmin();
  return useCallback(
    async (action: string, body: Readonly<Record<string, unknown>>, network?: AdminEvmNetwork) => {
      const kind = sessionKind(session);
      const nonce = await client.confirmNonce({
        walletKind: kind,
        address: session.address,
        chainId: session.chainId,
        action,
        ...(network ? { network } : {}),
        payloadSha256: payloadSha256(body),
      });
      const signature = await ops.signWithSessionWallet(nonce.message);
      return { message: nonce.message, signature };
    },
    [client, ops, session],
  );
}
