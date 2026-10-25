import React from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { parseYields, solanaPaths } from "../api";
import { formatCompactUsd, formatFractionPercent } from "../format";
import { useSolanaResource } from "../hooks/useSolanaResource";
import { ui } from "../styles";

type SortKey = "supplyApy" | "borrowApy" | "utilization" | "totalSupplyUsd";

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: "supplyApy", label: "Supply APY" },
  { key: "borrowApy", label: "Borrow APY" },
  { key: "utilization", label: "Utilization" },
  { key: "totalSupplyUsd", label: "TVL" },
];

/** Kamino lending rates (desk tool 07, read only; Jupiter Lend rates appear in a deposit plan); no wallet needed. */
export function SolanaYields() {
  const yields = useSolanaResource(solanaPaths.yields(), parseYields);
  const [sortKey, setSortKey] = React.useState<SortKey>("supplyApy");
  const rows = React.useMemo(
    () => [...(yields.data ?? [])].sort((a, b) => b[sortKey] - a[sortKey]),
    [sortKey, yields.data],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-2xl flex-col gap-1.5 text-sm text-muted">
          <p>
            Live lending rates from Kamino's main market. Read only: rates move with utilization and are not guaranteed.
            Reserves under $250k supplied are hidden.
          </p>
          <p>
            Jupiter Lend is not in this table yet: plan a deposit on Solana in the console and the plan shows the rate of the
            venue it picks, Jupiter Lend or Kamino.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
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
        </div>
      </div>

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
                <tr className="bg-surface-2">
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
                        className={`min-h-9 px-2 ${ui.label} underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-focus ${
                          sortKey === column.key ? "!text-[#1A36B0] dark:!text-[#8FA6FF]" : ""
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
                  <tr key={row.reserve} className="border-t-2 border-[#121212]/15 dark:border-slate-700">
                    <th scope="row" className="px-4 py-3 font-black">
                      {row.symbol}
                    </th>
                    <td className="px-4 py-3 text-right font-black text-[#047857] dark:text-[#6EE7B7]">
                      {formatFractionPercent(row.supplyApy)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold">
                      {formatFractionPercent(row.borrowApy)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold">
                      <span className="inline-flex items-center justify-end gap-2">
                        <span
                          aria-hidden="true"
                          className="hidden h-2 w-16 border border-[#121212] bg-surface dark:border-slate-500 sm:inline-block"
                        >
                          <span
                            className="block h-full bg-[#2F5BFF] dark:bg-[#8FA6FF]"
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
          <p className="p-4 text-sm font-bold text-muted">
            {yields.loading ? "Loading Kamino reserves…" : yields.error ? "No data." : "No reserves reported."}
          </p>
        )}
      </section>
    </div>
  );
}
