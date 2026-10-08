import { explorerAddressUrl } from "@kletia/core";
import {
  ArrowLeftRight,
  BadgeCheck,
  ExternalLink,
  Landmark,
  LayoutDashboard,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react";

import { shortenAddress } from "../../../shared/wallet/types";
import type { SolanaPortfolio } from "../api";
import { formatSignedPercent, formatTokenAmount, formatUsd } from "../format";
import type { SolanaResource } from "../hooks/useSolanaResource";
import type { SolanaTab } from "../solanaTabs";
import { ui } from "../styles";
import { ConnectSolanaCta, PanelHeader } from "./SolanaUi";

interface SolanaOverviewProps {
  owner: string | null;
  portfolio: SolanaResource<SolanaPortfolio>;
  onNavigate: (tab: SolanaTab) => void;
}

const QUICK_ACTIONS: readonly { tab: SolanaTab; label: string; Icon: typeof Send }[] = [
  { tab: "ask", label: "Ask", Icon: MessageSquare },
  { tab: "swap", label: "Swap", Icon: ArrowLeftRight },
  { tab: "send", label: "Send", Icon: Send },
  { tab: "stake", label: "Stake", Icon: Landmark },
];

export function SolanaOverview({ owner, portfolio, onNavigate }: SolanaOverviewProps) {
  const { data, error, loading, refresh } = portfolio;

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        icon={LayoutDashboard}
        title="Solana overview"
        description="Live balances from Solana RPC, priced with Jupiter. Every action below prepares an unsigned transaction for your wallet."
        actions={
          owner ? (
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className={ui.ghostButton}
              aria-label="Refresh Solana portfolio"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </button>
          ) : null
        }
      />

      {!owner ? (
        <ConnectSolanaCta />
      ) : (
        <>
          <section
            aria-label="Portfolio value"
            className={`${ui.card} relative overflow-hidden bg-[#1A1A1A] text-white dark:bg-[#0B1120]`}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rotate-12 border-[3px] border-[#14F195] bg-gradient-to-br from-[#9945FF] to-[#14F195] opacity-70"
            />
            <div className="relative flex flex-col gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#14F195]">
                Total value · Solana mainnet
              </p>
              <p className="text-4xl font-black tracking-tight sm:text-5xl" aria-live="polite">
                {data ? formatUsd(data.totalUsd) : loading ? "Loading…" : "—"}
              </p>
              <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-gray-300">
                <span className="font-mono">{shortenAddress(owner, 6, 6)}</span>
                <a
                  href={explorerAddressUrl("solana", owner)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-black uppercase text-[#14F195] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#14F195]"
                >
                  Solscan <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                {data?.slot ? <span>Slot {data.slot}</span> : null}
              </p>
            </div>
            <div className="relative mt-4 flex flex-wrap gap-2">
              {QUICK_ACTIONS.map(({ tab, label, Icon }) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onNavigate(tab)}
                  className="inline-flex min-h-11 items-center gap-2 border-[3px] border-white bg-white px-3 py-2 text-xs font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#14F195] transition-transform duration-100 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#14F195] active:translate-y-0.5"
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          {error ? (
            <p role="alert" className={ui.errorBox}>
              Portfolio could not be loaded: {error}
            </p>
          ) : null}

          <section aria-label="Holdings" className={`${ui.card} overflow-hidden p-0 sm:p-0`}>
            <div className="flex items-center justify-between border-b-[3px] border-[#1A1A1A] px-4 py-3 dark:border-[#4B5563]">
              <h3 className="text-sm font-black uppercase tracking-wider">Holdings</h3>
              {data ? (
                <span className={ui.label}>
                  {data.holdings.length} assets
                  {data.unpricedCount > 0 ? ` · ${data.unpricedCount} unpriced` : ""}
                </span>
              ) : null}
            </div>
            {data && data.holdings.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <caption className="sr-only">Solana token balances with USD value</caption>
                  <thead>
                    <tr className="bg-[#F5F5F0] dark:bg-[#0F172A]">
                      <th scope="col" className={`px-4 py-2 ${ui.label}`}>Asset</th>
                      <th scope="col" className={`px-4 py-2 text-right ${ui.label}`}>Amount</th>
                      <th scope="col" className={`px-4 py-2 text-right ${ui.label}`}>Value</th>
                      <th scope="col" className={`px-4 py-2 text-right ${ui.label}`}>24h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.map((holding) => (
                      <tr
                        key={holding.mint}
                        className="border-t-2 border-[#1A1A1A]/15 dark:border-slate-700"
                      >
                        <th scope="row" className="px-4 py-3 font-black">
                          <span className="flex items-center gap-2">
                            {holding.symbol}
                            {holding.verified ? (
                              <BadgeCheck
                                className="h-4 w-4 text-[#9945FF]"
                                aria-label="Verified token"
                              />
                            ) : (
                              <span className="border-2 border-[#1A1A1A] bg-[#FFD60A] px-1 text-[9px] uppercase text-[#1A1A1A]">
                                Unverified
                              </span>
                            )}
                          </span>
                          <span className="block text-[11px] font-bold text-gray-600 dark:text-slate-400">
                            {holding.name}
                          </span>
                        </th>
                        <td className="px-4 py-3 text-right font-mono font-bold">
                          {formatTokenAmount(holding.formatted)}
                        </td>
                        <td className="px-4 py-3 text-right font-black">
                          {formatUsd(holding.usdValue)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-black ${
                            holding.change24h === null
                              ? "text-gray-500"
                              : holding.change24h >= 0
                                ? "text-[#047857] dark:text-[#14F195]"
                                : "text-[#B91C1C] dark:text-red-300"
                          }`}
                        >
                          {formatSignedPercent(holding.change24h)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p-4 text-sm font-bold text-gray-700 dark:text-slate-300" aria-live="polite">
                {loading
                  ? "Reading balances from Solana…"
                  : data
                    ? "This wallet holds no SOL or SPL tokens yet. Bridge funds in from Base or Arbitrum in Kletia Studio."
                    : "Balances will appear here once loaded."}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
