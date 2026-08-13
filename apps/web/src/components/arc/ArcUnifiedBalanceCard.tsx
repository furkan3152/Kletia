import { useEffect, useRef, useState } from "react";
import {
  CircleDollarSign,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useAccount, useChainId } from "wagmi";
import {
  readArcUnifiedUsdcBalance,
  type ArcUnifiedBalanceSnapshot,
} from "../../networks/arc/runtime/unifiedBalanceRuntime";
import { NETWORKS } from "../../config/networks";

type ScopedState<T> = {
  sessionKey: string;
  value: T;
};

const hasAmount = (value: string): boolean => !/^0(?:\.0+)?$/.test(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "Circle Gateway Unified Balance query failed.";

export function ArcUnifiedBalanceCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const sessionKey = `${chainId}:${address?.toLowerCase() ?? "disconnected"}`;
  const currentSession = useRef(sessionKey);
  useEffect(() => {
    currentSession.current = sessionKey;
  }, [sessionKey]);

  const [snapshotState, setSnapshotState] =
    useState<ScopedState<ArcUnifiedBalanceSnapshot> | null>(null);
  const [errorState, setErrorState] = useState<ScopedState<string> | null>(
    null,
  );
  const [loadingSession, setLoadingSession] = useState<string | null>(null);

  const sessionMatches = isConnected && chainId === NETWORKS.arc.chainId;
  const snapshot =
    snapshotState?.sessionKey === sessionKey ? snapshotState.value : null;
  const error = errorState?.sessionKey === sessionKey ? errorState.value : null;
  const isLoading = loadingSession === sessionKey;

  const refresh = async () => {
    if (!address || !sessionMatches) {
      setErrorState({
        sessionKey,
        value: isConnected
          ? "Switch wallet to Arc Testnet network for Circle Gateway data."
          : "Connect wallet first for Circle Gateway data.",
      });
      return;
    }

    const requestedSession = sessionKey;
    setErrorState(null);
    setLoadingSession(requestedSession);
    try {
      const nextSnapshot = await readArcUnifiedUsdcBalance(address, chainId);
      if (currentSession.current !== requestedSession) return;
      setSnapshotState({
        sessionKey: requestedSession,
        value: nextSnapshot,
      });
    } catch (queryError) {
      if (currentSession.current !== requestedSession) return;
      setSnapshotState(null);
      setErrorState({
        sessionKey: requestedSession,
        value: errorMessage(queryError),
      });
    } finally {
      if (currentSession.current === requestedSession) {
        setLoadingSession(null);
      }
    }
  };

  const chainRows =
    snapshot?.accounts.flatMap((account) => account.chains) ?? [];
  const visibleRows = chainRows.filter(
    (chain) =>
      hasAmount(chain.confirmedBalance) ||
      hasAmount(chain.pendingBalance) ||
      chain.pendingTransactions.length > 0,
  );

  return (
    <section className="border-[4px] border-[#1A1A1A] bg-[#D1FAE5] p-5 text-[#1A1A1A] shadow-[8px_8px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[8px_8px_0_#475569] md:p-7">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
        <div className="max-w-3xl">
          <div className="mb-2 inline-flex items-center gap-2 border-[2px] border-[#1A1A1A] bg-white px-2 py-1 text-[10px] font-black uppercase tracking-widest">
            <ShieldCheck className="h-3.5 w-3.5" />
            Read only • no signature
          </div>
          <h3 className="flex items-center gap-3 text-2xl font-black uppercase md:text-4xl">
            <span className="flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#8B5CF6] text-white shadow-[3px_3px_0_#1A1A1A]">
              <CircleDollarSign className="h-6 w-6" />
            </span>
            Unified USDC
          </h3>
          <p className="mt-3 text-sm font-bold leading-relaxed">
            The official Circle Gateway balance aggregates across supported testnet chains. This value is not the normal wallet balance; it shows USDC deposited to the Gateway, spendable across chains, and pending deposits.</p>
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={!sessionMatches || isLoading}
          className="flex min-w-[190px] items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-4 py-3 text-xs font-black uppercase tracking-wider shadow-[4px_4px_0_#1A1A1A] transition-all enabled:hover:-translate-y-1 enabled:hover:shadow-[6px_6px_0_#1A1A1A] enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {isLoading ? "Gateway okunuyor" : "Fetch live balance"}
        </button>
      </div>

      {!sessionMatches && (
        <div className="mt-5 border-[3px] border-[#1A1A1A] bg-[#FACC15] p-3 text-xs font-black uppercase shadow-[3px_3px_0_#1A1A1A]">
          {isConnected
            ? "Wrong network: even read-only queries open only in Arc Testnet session."
            : "Enable read-only query by connecting the Arc Testnet wallet."}
        </div>
      )}

      {error && (
        <div className="mt-5 border-[3px] border-[#1A1A1A] bg-[#FCA5A5] p-3 text-xs font-black shadow-[3px_3px_0_#1A1A1A]">
          {error}
        </div>
      )}

      {snapshot && (
        <div className="mt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border-[3px] border-[#1A1A1A] bg-white p-4 shadow-[4px_4px_0_#1A1A1A]">
              <span className="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                Confirmed Gateway balance
              </span>
              <span className="mt-1 block break-all text-3xl font-black">
                {snapshot.totalConfirmedBalance} USDC
              </span>
            </div>
            <div className="border-[3px] border-[#1A1A1A] bg-[#FDE68A] p-4 shadow-[4px_4px_0_#1A1A1A]">
              <span className="block text-[10px] font-black uppercase tracking-widest text-gray-600">
                Pending deposits
              </span>
              <span className="mt-1 block break-all text-3xl font-black">
                {snapshot.totalPendingBalance} USDC
              </span>
            </div>
          </div>

          <div className="mt-4 border-[3px] border-[#1A1A1A] bg-white p-4 shadow-[4px_4px_0_#1A1A1A]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b-[2px] border-[#1A1A1A] pb-2 text-[10px] font-black uppercase tracking-widest">
              <span>Circle Gateway • testnet only</span>
              <span>{new Date(snapshot.observedAt).toLocaleTimeString()}</span>
            </div>
            {visibleRows.length === 0 ? (
              <p className="text-sm font-bold">
                No verified or pending Gateway USDC balance found for this account.</p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {visibleRows.map((chain) => (
                  <div
                    key={chain.chain}
                    className="border-[2px] border-[#1A1A1A] bg-[#F8FAFC] p-3 text-xs font-bold"
                  >
                    <div className="font-black uppercase">{chain.chain}</div>
                    <div>Verified: {chain.confirmedBalance} USDC</div>
                    <div>Bekleyen: {chain.pendingBalance} USDC</div>
                    {chain.pendingTransactions.length > 0 && (
                      <div className="mt-1 text-[10px] font-black uppercase text-[#8B5CF6]">
                        {chain.pendingTransactions.length} pending Gateway investment</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <p className="mt-5 text-[10px] font-bold uppercase leading-relaxed text-gray-600">
        Source: Circle App Kit Unified Balance / Gateway. Query is limited to `networkType: testnet`; it does not create transactions or request wallet signatures or private keys. The open wallet address is sent to the Circle Gateway read-only API for balance query.</p>
    </section>
  );
}
