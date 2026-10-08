import React from "react";
import { fromBaseUnits } from "@kletia/core";
import { ExternalLink, Landmark, ShieldCheck } from "lucide-react";

import type { SolanaPortfolio, SolanaPreparedSwap } from "../api";
import { formatTokenAmount } from "../format";
import { balanceOf, exceedsBalance, maxSpendable, useSwapFlow } from "../hooks/useSwapFlow";
import {
  canonicalToken,
  LIQUID_STAKING_OPTIONS,
  type LiquidStakingSymbol,
} from "../tokens";
import { ui } from "../styles";
import { LiveQuote, PreparedSwapDetails } from "./QuoteDetails";
import { ConnectSolanaCta, ExecutionPanel, PanelHeader } from "./SolanaUi";
import { SlippagePresets } from "./SolanaSwap";

interface SolanaStakeProps {
  owner: string | null;
  portfolio: SolanaPortfolio | null;
}

export function SolanaStake({ owner, portfolio }: SolanaStakeProps) {
  const [lst, setLst] = React.useState<LiquidStakingSymbol>("JitoSOL");
  const [amount, setAmount] = React.useState("");
  const [slippageBps, setSlippageBps] = React.useState(50);
  const amountId = React.useId();
  const hintId = React.useId();
  const groupId = React.useId();
  const sol = React.useMemo(() => canonicalToken("SOL"), []);
  const target = React.useMemo(() => canonicalToken(lst), [lst]);
  const flow = useSwapFlow({ owner, from: sol, to: target, amount, slippageBps, titleVerb: "Stake" });
  const { execution } = flow;
  const locked =
    execution.phase !== "idle" && execution.phase !== "confirmed" && execution.phase !== "failed";
  const max = maxSpendable(portfolio, sol);
  const overBalance =
    amount.trim() !== "" && !flow.amountError && exceedsBalance(portfolio, sol, amount);
  const quote = flow.quote.data;
  const rate =
    quote && Number(quote.input.formatted) > 0
      ? Number(quote.output.formatted) / Number(quote.input.formatted)
      : null;

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        icon={Landmark}
        title="Liquid staking"
        description="Stake SOL into a liquid staking token. Kletia routes the deposit through Jupiter, so it executes as a swap into the token at the live pool price."
      />
      {!owner ? <ConnectSolanaCta /> : null}

      <form
        className={`${ui.card} flex flex-col gap-4`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!overBalance) flow.startReview();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend id={groupId} className={`${ui.label} mb-2`}>
            Staking token
          </legend>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {LIQUID_STAKING_OPTIONS.map((option) => {
              const selected = option.symbol === lst;
              const optionToken = canonicalToken(option.symbol);
              const held = balanceOf(portfolio, optionToken);
              return (
                <label
                  key={option.symbol}
                  className={`flex cursor-pointer flex-col gap-1 border-[3px] border-[#1A1A1A] p-3 shadow-[3px_3px_0_#1A1A1A] transition-[transform,background-color] duration-100 focus-within:outline focus-within:outline-4 focus-within:outline-offset-2 focus-within:outline-[#9945FF] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569] ${
                    selected
                      ? "bg-[#1A1A1A] text-white dark:bg-[#14F195] dark:text-[#1A1A1A]"
                      : "bg-white hover:-translate-y-0.5 dark:bg-[#1A2841]"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-black uppercase">
                      <input
                        type="radio"
                        name={`${groupId}-lst`}
                        value={option.symbol}
                        checked={selected}
                        disabled={locked}
                        onChange={() => {
                          setLst(option.symbol);
                          execution.reset();
                        }}
                        className="h-4 w-4 accent-[#9945FF]"
                      />
                      {option.symbol}
                    </span>
                    <span className="text-[10px] font-black uppercase opacity-80">{option.protocol}</span>
                  </span>
                  <span className="text-xs font-bold leading-snug opacity-90">{option.summary}</span>
                  {held && held !== "0" ? (
                    <span className="text-[10px] font-black uppercase opacity-80">
                      Held: {formatTokenAmount(fromBaseUnits(held, optionToken.decimals))}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
          <a
            href={LIQUID_STAKING_OPTIONS.find((option) => option.symbol === lst)?.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start text-[11px] font-black uppercase text-[#9945FF] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9945FF] dark:text-[#C4A1FF]"
          >
            About {lst} <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={amountId} className={ui.label}>
              SOL to stake
            </label>
            {max !== null ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => setAmount(max)}
                className="text-[11px] font-black uppercase text-[#9945FF] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9945FF] disabled:opacity-50 dark:text-[#C4A1FF]"
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
            aria-describedby={hintId}
            className={ui.input}
          />
          <p id={hintId} className="text-xs font-bold text-gray-600 dark:text-slate-300" aria-live="polite">
            {flow.amountError ??
              (overBalance
                ? "Amount exceeds your SOL balance."
                : rate !== null
                  ? `Live rate: 1 SOL ≈ ${rate.toFixed(6)} ${lst}.`
                  : "Max keeps 0.01 SOL for network fees and rent.")}
          </p>
        </div>

        <SlippagePresets value={slippageBps} onChange={setSlippageBps} disabled={locked} />
        <LiveQuote quote={quote} pending={flow.quotePending} error={flow.quote.error} />

        <button
          type="submit"
          disabled={!flow.canReview || locked || overBalance || flow.quotePending || !quote}
          className={`${ui.primaryButton} self-start`}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Review stake
        </button>
      </form>

      <ExecutionPanel<SolanaPreparedSwap> execution={execution} confirmLabel={`Sign ${lst} stake`}>
        {execution.prepared ? <PreparedSwapDetails prepared={execution.prepared.details} /> : null}
      </ExecutionPanel>
    </div>
  );
}
