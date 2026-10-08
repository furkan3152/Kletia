import React from "react";
import { ExternalLink, Percent, RefreshCw } from "lucide-react";

import { parseYields, solanaPaths } from "../api";
import { formatCompactUsd, formatFractionPercent } from "../format";
import { useSolanaResource } from "../hooks/useSolanaResource";
import { ui } from "../styles";
import { PanelHeader } from "./SolanaUi";

type SortKey = "supplyApy" | "borrowApy" | "utilization" | "totalSupplyUsd";

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: "supplyApy", label: "Supply APY" },
  { key: "borrowApy", label: "Borrow APY" },
  { key: "utilization", label: "Utilization" },
  { key: "totalSupplyUsd", label: "TVL" },
];

export function SolanaYields() {
  const yields = useSolanaResource(solanaPaths.yields(), parseYields);
  const [sortKey, setSortKey] = React.useState<SortKey>("supplyApy");
  const rows = React.useMemo(
    () => [...(yields.data ?? [])].sort((a, b) => b[sortKey] - a[sortKey]),
    [sortKey, yields.data],
  );

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        icon={Percent}
        title="Yields"
        description="Live lending rates from Kamino's main market on Solana. Read-only: rates move with utilization and are not guaranteed. Reserves under $250k supplied are hidden."
        actions={
          <>
            <button
              type="button"
              onClick={yields.refresh}
              disabled={yields.loading}
              className={ui.ghostButton}
            >
              <RefreshCw className={`h-4 w-4 ${yields.loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </button>
            <a
              href="https://app.kamino.finance"
              target="_blank"
              rel="noopener noreferrer"
              className={ui.ghostButton}
            >
              Open Kamino <ExternalLink className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        }
      />

      {yields.error ? (
        <p role="alert" className={ui.errorBox}>
          Kamino rates could not be loaded: {yields.error}
        </p>
      ) : null}

      <section aria-label="Kamino lending reserves" className={`${ui.card} overflow-hidden p-0 sm:p-0`}>
        <div aria-live="polite" className="sr-only">
          {yields.loading ? "Loading Kamino reserves" : `${rows.length} reserves`}
        </div>
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">
                Kamino main market reserves, sorted by {COLUMNS.find((column) => column.key === sortKey)?.label}
              </caption>
              <thead>
                <tr className="bg-[#F5F5F0] dark:bg-[#0F172A]">
                  <th scope="col" className={`px-4 py-2 ${ui.label}`}>
                    Asset
                  </th>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={sortKey === column.key ? "descending" : "none"}
                      className="px-2 py-1 text-right"
                    >
                      <button
                        type="button"
                        onClick={() => setSortKey(column.key)}
                        className={`min-h-9 px-2 ${ui.label} underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9945FF] ${
                          sortKey === column.key ? "text-[#9945FF] dark:text-[#C4A1FF]" : ""
                        }`}
                      >
                        {column.label}
                        {sortKey === column.key ? " ↓" : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.reserve} className="border-t-2 border-[#1A1A1A]/15 dark:border-slate-700">
                    <th scope="row" className="px-4 py-3 font-black">
                      {row.symbol}
                    </th>
                    <td className="px-4 py-3 text-right font-black text-[#047857] dark:text-[#14F195]">
                      {formatFractionPercent(row.supplyApy)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold">
                      {formatFractionPercent(row.borrowApy)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold">
                      <span className="inline-flex items-center justify-end gap-2">
                        <span
                          aria-hidden="true"
                          className="hidden h-2 w-16 border border-[#1A1A1A] bg-white dark:border-slate-500 dark:bg-[#0F172A] sm:inline-block"
                        >
                          <span
                            className="block h-full bg-[#9945FF]"
                            style={{ width: `${Math.min(100, Math.max(0, row.utilization * 100))}%` }}
                          />
                        </span>
                        {formatFractionPercent(row.utilization, 1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-bold">{formatCompactUsd(row.totalSupplyUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-4 text-sm font-bold text-gray-700 dark:text-slate-300">
            {yields.loading ? "Loading Kamino reserves…" : yields.error ? "No data." : "No reserves reported."}
          </p>
        )}
      </section>
    </div>
  );
}
