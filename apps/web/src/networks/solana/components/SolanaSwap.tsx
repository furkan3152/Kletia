import React from "react";
import { ArrowDownUp, RefreshCw, ShieldCheck } from "lucide-react";

import type { SolanaPortfolio, SolanaPreparedSwap } from "../api";
import { formatTokenAmount } from "../format";
import { exceedsBalance, maxSpendable, useSwapFlow } from "../hooks/useSwapFlow";
import { canonicalToken, type TokenOption } from "../tokens";
import { ui } from "../styles";
import { LiveQuote, PreparedSwapDetails } from "./QuoteDetails";
import { ExecutionPanel } from "./SolanaUi";
import { TokenPicker } from "./TokenPicker";

const SLIPPAGE_PRESETS = [30, 50, 100] as const;

/** Owner and mainnet portfolio come from the desk's SolanaToolHost, which also offers the wallet connection. */
interface SolanaSwapProps {
  owner: string | null;
  portfolio: SolanaPortfolio | null;
}

export function SlippagePresets({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (bps: number) => void;
  disabled?: boolean;
}) {
  const groupId = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={groupId} className={ui.label}>
        Max slippage
      </span>
      <div role="group" aria-labelledby={groupId} className="flex flex-wrap gap-2">
        {SLIPPAGE_PRESETS.map((bps) => (
          <button
            key={bps}
            type="button"
            disabled={disabled}
            aria-pressed={value === bps}
            onClick={() => onChange(bps)}
            className={ui.chip(value === bps)}
          >
            {(bps / 100).toFixed(1)}%
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Jupiter swap form (desk tool 04): best-price routing across Solana venues.
 * Kletia prepares and simulates the transaction and useSolanaExecution runs
 * its pre-sign checks before the wallet is asked.
 */
export function SolanaSwap({ owner, portfolio }: SolanaSwapProps) {
  const [from, setFrom] = React.useState<TokenOption>(() => canonicalToken("SOL"));
  const [to, setTo] = React.useState<TokenOption>(() => canonicalToken("USDC"));
  const [amount, setAmount] = React.useState("");
  const [slippageBps, setSlippageBps] = React.useState(50);
  const amountId = React.useId();
  const amountHintId = React.useId();
  const flow = useSwapFlow({ owner, from, to, amount, slippageBps });
  const { execution } = flow;
  const locked = execution.phase !== "idle" && execution.phase !== "confirmed" && execution.phase !== "failed";
  const max = maxSpendable(portfolio, from);
  const overBalance = amount.trim() !== "" && !flow.amountError && exceedsBalance(portfolio, from, amount);

  const flip = () => {
    setFrom(to);
    setTo(from);
    execution.reset();
  };

  return (
    <div className="flex flex-col gap-5">

      <form
        className={`${ui.card} flex flex-col gap-4`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!overBalance) flow.startReview();
        }}
      >
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <TokenPicker
            label="From"
            value={from}
            excludeMint={to.mint}
            onChange={(token) => {
              setFrom(token);
              execution.reset();
            }}
          />
          <button
            type="button"
            onClick={flip}
            disabled={locked}
            aria-label="Swap the from and to tokens"
            className={`${ui.ghostButton} h-12 w-12 self-end justify-self-center p-0`}
          >
            <ArrowDownUp className="h-4 w-4" aria-hidden="true" />
          </button>
          <TokenPicker
            label="To"
            value={to}
            excludeMint={from.mint}
            onChange={(token) => {
              setTo(token);
              execution.reset();
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={amountId} className={ui.label}>
              Amount ({from.symbol})
            </label>
            {max !== null ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => setAmount(max)}
                className={ui.textButton}
              >
                Max {formatTokenAmount(max)}
              </button>
            ) : null}
          </div>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            value={amount}
            disabled={locked}
            onChange={(event) => {
              setAmount(event.target.value.replace(",", "."));
              if (execution.phase === "failed" || execution.phase === "confirmed") execution.reset();
            }}
            aria-invalid={Boolean(flow.amountError) || overBalance}
            aria-describedby={amountHintId}
            className={ui.input}
          />
          <p id={amountHintId} className={ui.hint} aria-live="polite">
            {flow.amountError ??
              (overBalance
                ? `Amount exceeds your ${from.symbol} balance.`
                : from.symbol === "SOL"
                  ? "Max keeps 0.01 SOL for network fees and rent."
                  : "Quotes refresh automatically as you type.")}
          </p>
        </div>

        <SlippagePresets value={slippageBps} onChange={setSlippageBps} disabled={locked} />

        <LiveQuote
          quote={flow.quote.data}
          pending={flow.quotePending}
          error={flow.quote.error}
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={
              !flow.canReview || locked || overBalance || flow.quotePending || !flow.quote.data
            }
            className={ui.primaryButton}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Review swap
          </button>
          <button
            type="button"
            onClick={flow.quote.refresh}
            disabled={!flow.quoteIsCurrent || flow.quote.loading}
            className={ui.ghostButton}
          >
            <RefreshCw className={`h-4 w-4 ${flow.quote.loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh quote
          </button>
        </div>
      </form>

      <ExecutionPanel<SolanaPreparedSwap> execution={execution} confirmLabel="Sign swap in wallet">
        {execution.prepared ? <PreparedSwapDetails prepared={execution.prepared.details} /> : null}
      </ExecutionPanel>
    </div>
  );
}
