import type { ContractTestResult } from "@kletia/core";
import { CircleAlert } from "lucide-react";

import { ContractReviewCard } from "../../../../shared/platform/ContractReviewCard";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { formatUsd } from "../portal/portalFormat";

function amountText(amount: ContractTestResult["input"]): string {
  if (!amount) return "—";
  return `${amount.formatted} ${amount.symbol}`;
}

/**
 * A test run of one entry: what goes in and comes out, the transactions the
 * wallet would be asked to sign (described, never calldata), and the review
 * card exactly as users will see it. Nothing here was stored or signed.
 */
export function SimulationPreview({ result }: { readonly result: ContractTestResult }) {
  const ok = result.review.simulation.status === "ok";
  return (
    <div className="flex min-w-0 flex-col gap-5" aria-label="Test result">
      <div className={cx("flex flex-col gap-3 p-4", INK_BORDER_THIN, ok ? "bg-[#E9FFF5] dark:bg-[#0E2A20]" : "bg-[#FFF3B0] text-[#1A1A1A]")}>
        <p className="font-display text-lg font-bold">
          {ok ? "The simulation passed." : "The simulation could not run."} Nothing was stored or signed.
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className={cx(LABEL, "!text-[10px]")}>In</dt>
            <dd className="break-words font-code text-[13px] font-bold">{amountText(result.input)}</dd>
          </div>
          <div className="min-w-0">
            <dt className={cx(LABEL, "!text-[10px]")}>Expected out</dt>
            <dd className="break-words font-code text-[13px] font-bold">{amountText(result.expectedOutput)}</dd>
          </div>
          <div className="min-w-0">
            <dt className={cx(LABEL, "!text-[10px]")}>At least</dt>
            <dd className="break-words font-code text-[13px] font-bold">{amountText(result.minimumOutput)}</dd>
          </div>
          <div className="min-w-0">
            <dt className={cx(LABEL, "!text-[10px]")}>Network fees</dt>
            <dd className="break-words font-code text-[13px] font-bold">
              {result.feesUsd !== undefined ? formatUsd(result.feesUsd) : "—"}
              {result.gas ? <span className="font-normal"> · gas {Number(result.gas).toLocaleString("en-US")}</span> : null}
            </dd>
          </div>
        </dl>
      </div>
      <div className="min-w-0">
        <p className={cx(LABEL, "mb-2")}>What the wallet would sign, in order</p>
        <ol className="flex flex-col gap-2">
          {result.transactions.map((transaction, index) => (
            <li key={`${transaction.description}-${index}`} className={cx("flex min-w-0 gap-3 p-3 text-sm", INK_BORDER_THIN)}>
              <span className="font-display text-lg font-bold leading-none">{index + 1}</span>
              <span className="min-w-0">
                <span className="block break-words font-semibold">{transaction.description}</span>
                <span className={cx("block break-all font-code text-[11px]", TEXT_MUTED)}>
                  {transaction.to ? `to ${transaction.to}` : null}
                  {transaction.selector ? ` · selector ${transaction.selector}` : null}
                  {transaction.value && transaction.value !== "0" ? ` · value ${transaction.value} wei` : null}
                  {transaction.programs && transaction.programs.length > 0 ? `programs ${transaction.programs.join(", ")}` : null}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      {result.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {result.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 text-sm">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#A84B00] dark:text-[#FBBF24]" aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="min-w-0">
        <p className={cx(LABEL, "mb-2")}>The review your users will see</p>
        <ContractReviewCard review={result.review} title={`Test · ${result.entry}`} />
      </div>
    </div>
  );
}
