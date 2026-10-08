import { LoaderCircle, Route, TriangleAlert } from "lucide-react";

import type { SolanaPreparedSwap, SolanaQuote } from "../api";
import { formatTokenAmount } from "../format";
import { ui } from "../styles";
import { DetailRow } from "./SolanaUi";

function routeLabel(quote: SolanaQuote): string {
  const venues = quote.route.map((leg) =>
    leg.percent < 100 ? `${leg.label} (${leg.percent}%)` : leg.label,
  );
  return venues.length > 0 ? venues.join(" → ") : "Direct";
}

export function QuoteSummary({ quote }: { quote: SolanaQuote }) {
  const impactPercent = quote.priceImpactPct * 100;
  return (
    <dl className="flex flex-col">
      <DetailRow label="You pay">
        {formatTokenAmount(quote.input.formatted)} {quote.input.token.symbol}
      </DetailRow>
      <DetailRow label="Expected">
        {formatTokenAmount(quote.output.formatted)} {quote.output.token.symbol}
      </DetailRow>
      <DetailRow label="Minimum received">
        {formatTokenAmount(quote.output.minimumFormatted)} {quote.output.token.symbol}
      </DetailRow>
      <DetailRow label="Price impact">
        <span
          className={
            impactPercent > 1 ? "text-[#B91C1C] dark:text-red-300" : "text-[#047857] dark:text-[#14F195]"
          }
        >
          {impactPercent < 0.01 ? "< 0.01%" : `${impactPercent.toFixed(2)}%`}
        </span>
      </DetailRow>
      <DetailRow label="Slippage limit">{(quote.slippageBps / 100).toFixed(2)}%</DetailRow>
      <DetailRow label="Route">
        <span className="inline-flex items-center gap-1">
          <Route className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {routeLabel(quote)}
        </span>
      </DetailRow>
    </dl>
  );
}

export function QuoteWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className={`${ui.warningBox} flex flex-col gap-1`} aria-label="Quote warnings">
      {warnings.map((warning) => (
        <li key={warning} className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {warning}
        </li>
      ))}
    </ul>
  );
}

/** Live quote card: loading, error and up-to-date states. */
export function LiveQuote({
  quote,
  pending,
  error,
}: {
  quote: SolanaQuote | null;
  pending: boolean;
  error: string | null;
}) {
  return (
    <section aria-label="Live quote" className={`${ui.subtleCard} flex flex-col gap-2`}>
      <div className="flex items-center justify-between gap-2" aria-live="polite">
        <h3 className={ui.label}>Live Jupiter quote</h3>
        {pending ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-[#9945FF]">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Updating
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm font-bold text-[#B91C1C] dark:text-red-300">
          {error}
        </p>
      ) : null}
      {quote ? (
        <div className={pending ? "opacity-60" : undefined}>
          <QuoteSummary quote={quote} />
          <QuoteWarnings warnings={quote.warnings} />
        </div>
      ) : !error ? (
        <p className="text-sm font-bold text-gray-600 dark:text-slate-300">
          {pending ? "Fetching the best route…" : "Enter an amount to see the best route."}
        </p>
      ) : null}
    </section>
  );
}

export function PreparedSwapDetails({ prepared }: { prepared: SolanaPreparedSwap }) {
  return (
    <div className="flex flex-col gap-2">
      <QuoteSummary quote={prepared} />
      <dl className="flex flex-col">
        <DetailRow label="Priority fee">
          {(prepared.transaction.prioritizationFeeLamports / 1_000_000_000).toFixed(6)} SOL
        </DetailRow>
        <DetailRow label="Valid until block">{prepared.transaction.lastValidBlockHeight}</DetailRow>
      </dl>
      <QuoteWarnings warnings={prepared.warnings} />
    </div>
  );
}
