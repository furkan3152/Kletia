import type { NetworkKey } from "@kletia/core";
import type { QuoteResponse, QuoteRoute } from "@kletia/sdk";
import { Gavel, Timer, Trophy } from "lucide-react";
import React, { useState } from "react";

import { requestQuote } from "../../../shared/platform/platformApi";
import { useApiAction } from "../../../shared/platform/useApiResource";
import { formatSeconds, formatUsd, networkName, protocolName } from "../../site/intent/format";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { SelectField, TextField } from "../../site/ui/Field";
import { cx, HARD_SHADOW, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

const BRIDGE_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana"];

const RULES: readonly { title: string; body: string }[] = [
  {
    title: "Most guaranteed output",
    body: "The highest minimum output net of extra costs wins. A venue whose extra costs cannot be priced is not eligible.",
  },
  {
    title: "Then the fastest within your limit",
    body: "Ties go to the shortest settlement estimate within constraints.maxSeconds (default 600 s). Slower quotes cannot win.",
  },
  { title: "Then the fewest transactions", body: "Fewer wallet prompts for the same outcome." },
];

const LIMITS = [
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes (default)" },
  { value: "3600", label: "1 hour" },
];

function RouteRow({ route, rank, winner }: { route: QuoteRoute; rank: number; winner: boolean }) {
  const net = route.netMinimumOutput ?? route.minimumOutput;
  const eligible = route.eligible !== false;
  return (
    <li
      className={cx(
        "kl-node-in grid min-w-0 gap-x-4 gap-y-2 p-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-center",
        winner ? "bg-[#FFF7CC] dark:bg-[#22345A]" : "",
      )}
      style={{ "--kl-delay": `${Math.min(rank, 6) * 80}ms` } as React.CSSProperties}
    >
      <span className="font-display text-2xl font-bold leading-none">#{rank + 1}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 font-bold">
          {protocolName(route.protocol)}
          {winner ? (
            <Badge tone="ink" className="kl-stamp">
              <Trophy className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Wins
            </Badge>
          ) : null}
          {!eligible ? <Badge tone="red">Not eligible</Badge> : null}
        </p>
        <p className={cx("font-code text-[11px]", TEXT_MUTED)}>
          {route.transactionCount} tx · {formatSeconds(route.estimatedSeconds) ?? "time unknown"}
          {route.feesUsd !== undefined ? ` · fees ${formatUsd(route.feesUsd)}` : ""}
          {route.extraCosts && route.extraCosts.length > 0
            ? ` · plus ${route.extraCosts.map((cost) => `${cost.formatted} ${cost.symbol}`).join(", ")}`
            : ""}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 text-right font-code text-xs sm:block sm:space-y-0.5">
        <div>
          <dt className={cx("inline", TEXT_MUTED)}>guaranteed </dt>
          <dd className="inline font-bold">
            {net.formatted} {net.symbol}
          </dd>
        </div>
        <div>
          <dt className={cx("inline", TEXT_MUTED)}>expected </dt>
          <dd className="inline">
            {route.output.formatted} {route.output.symbol}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/** How the planner picks a bridge venue, with a live auction over POST /v1/quotes. */
export function BridgeAuction() {
  const [form, setForm] = useState({ from: "base" as NetworkKey, to: "arbitrum" as NetworkKey, amount: "25", maxSeconds: "600" });
  const action = useApiAction((client, signal, request: Parameters<typeof requestQuote>[2]) => requestQuote(client, signal, request));
  const quote: QuoteResponse | undefined = action.status === "success" ? action.data : undefined;
  const sameNetwork = form.from === form.to;
  const validAmount = /^(0|[1-9]\d*)(\.\d+)?$/u.test(form.amount.trim()) && Number(form.amount) > 0;

  const run = (event: React.FormEvent) => {
    event.preventDefault();
    if (sameNetwork || !validAmount) return;
    void action.run({
      from: { network: form.from, asset: "USDC", amount: form.amount.trim() },
      to: { network: form.to, asset: "USDC" },
      slippageBps: 50,
      maxSeconds: Number.parseInt(form.maxSeconds, 10),
    });
  };

  const options = BRIDGE_NETWORKS.map((network) => ({ value: network, label: networkName(network) }));
  const best = quote?.best ?? null;
  const winnerIndex =
    quote && best ? quote.routes.findIndex((route) => route.protocol === best.protocol && route.output.amount === best.output.amount) : -1;

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
          For every cross-network bridge step the planner asks each venue that serves the route (Relay, LI.FI and deBridge DLN) for a
          quote in parallel, with 8 seconds per venue, then ranks them:
        </p>
        <ol className="flex flex-col gap-3">
          {RULES.map((rule, index) => (
            <li key={rule.title} className={cx("flex gap-3 p-3", INK_BORDER_THIN, SURFACE)}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#1A1A1A] font-display text-lg font-bold text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]">
                {index + 1}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-bold">{rule.title}</span>
                <span className={cx("text-sm", TEXT_MUTED)}>{rule.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <ul className={cx("flex flex-col gap-1.5 text-sm", TEXT_MUTED)}>
          <li>
            <code className="font-code text-[12px] text-[#1A1A1A] dark:text-white">preferProtocols</code> puts venues first;{" "}
            <code className="font-code text-[12px] text-[#1A1A1A] dark:text-white">avoidProtocols</code> never asks them.
          </li>
          <li>
            Naming a venue (&ldquo;bridge 25 USDC from base to arbitrum <span className="font-bold">via lifi</span>&rdquo;) skips the auction.
          </li>
          <li>Losing and failing quotes are kept as quote evidence on the step.</li>
          <li>
            At prepare, a cost above the plan plus slippage is refused with <code className="font-code text-[12px]">409 QUOTE_MOVED</code>.
          </li>
        </ul>
      </div>

      <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex items-center gap-2">
          <Gavel className="h-4 w-4" aria-hidden="true" />
          <h3 className="font-display text-xl font-bold">Run a live auction</h3>
        </div>
        <form onSubmit={run} noValidate className="grid gap-3 sm:grid-cols-2">
          <SelectField label="From" value={form.from} options={options} onChange={(event) => setForm((previous) => ({ ...previous, from: event.target.value as NetworkKey }))} />
          <SelectField label="To" value={form.to} options={options} onChange={(event) => setForm((previous) => ({ ...previous, to: event.target.value as NetworkKey }))} />
          <TextField
            label="USDC amount"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => setForm((previous) => ({ ...previous, amount: event.target.value }))}
            error={!validAmount ? "Enter a positive decimal amount." : undefined}
            mono
          />
          <SelectField label="maxSeconds" value={form.maxSeconds} options={LIMITS} onChange={(event) => setForm((previous) => ({ ...previous, maxSeconds: event.target.value }))} />
          <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
            <p className={cx("text-xs", TEXT_MUTED)}>
              {sameNetwork ? "Pick two different networks." : "POST /v1/quotes with neutral accounts: priced exactly, not executable."}
            </p>
            <Button type="submit" loading={action.status === "loading"} disabled={sameNetwork || !validAmount}>
              <Timer className="h-4 w-4" aria-hidden="true" />
              Ask the venues
            </Button>
          </div>
        </form>
        <div aria-live="polite" className="flex min-w-0 flex-col gap-3">
          {action.status === "error" && action.error ? (
            <ApiErrorPanel error={action.error} title="The auction could not run" />
          ) : quote ? (
            <>
              <p className={cx(LABEL, TEXT_MUTED)}>
                {quote.routes.length} quote{quote.routes.length === 1 ? "" : "s"} · {networkName(form.from)} → {networkName(form.to)}
              </p>
              {quote.routes.length > 0 ? (
                <ol className={cx("divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER_THIN)}>
                  {quote.routes.map((route, index) => (
                    <RouteRow key={`${route.protocol}-${index}`} route={route} rank={index} winner={index === winnerIndex} />
                  ))}
                </ol>
              ) : (
                <p className="text-sm">No venue could quote this route.</p>
              )}
              {quote.unavailable.length > 0 ? (
                <ul className={cx("flex flex-col gap-1 text-xs", TEXT_MUTED)}>
                  {quote.unavailable.map((item) => (
                    <li key={item.protocol}>
                      <span className="font-bold text-[#1A1A1A] dark:text-white">{protocolName(item.protocol)}</span> did not quote: {item.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className={cx("border-[3px] border-dashed border-[#1A1A1A]/30 p-4 text-sm dark:border-white/15", TEXT_MUTED)}>
              Quotes are live market data: the winner can change from one minute to the next.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
