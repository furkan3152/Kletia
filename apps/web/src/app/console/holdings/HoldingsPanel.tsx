/**
 * Holdings (console design 3.9): balances of the connected wallets on every
 * network of the lane, from one batch read. Each row: line bullet, network,
 * priced total, the top holdings exactly as the API formats them, "Start
 * here" (sets the departure) and "Fund" (Coinbase on Base, the faucet on Arc,
 * a bridge sentence elsewhere). A network whose last read failed keeps its
 * reading with "not updated". The old engines' verified position scans stay
 * reachable as engine tasks.
 */
import { RefreshCw } from "lucide-react";
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { LEGACY_NETWORKS, type Lane } from "../state/deskModel";
import { formatUsd, holdingLabels, laneTotals, mostFunded, type HoldingsSnapshot } from "../state/holdings";
import { useDeskActions } from "../shell/deskContext";
import { clockOf, fundSentence } from "../tasks/taskModel";

const copy = DESK_COPY.holdings;

export interface HoldingsPanelProps {
  readonly lane: Lane;
  readonly snapshot: HoldingsSnapshot | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly perAccount: boolean;
  readonly onRefresh: () => void;
  readonly headingLevel?: 2 | 3;
}

const LINK =
  "inline-flex min-h-11 items-center text-xs font-black uppercase tracking-wider text-[var(--kl-accent-text)] underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]";

function laneNetworks(lane: Lane): NetworkKey[] {
  return NETWORK_KEYS.filter((key) => (CHAINS[key].lane === "testnet" ? "testnet" : "production") === lane);
}

export function HoldingsPanel({ lane, snapshot, loading, failed, perAccount, onRefresh, headingLevel = 2 }: HoldingsPanelProps) {
  const actions = useDeskActions();
  const connected = actions.accounts.connected.evm || actions.accounts.connected.solana;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const totals = snapshot ? laneTotals(snapshot) : null;
  const best = mostFunded(snapshot);

  const fund = (network: NetworkKey) => {
    if (network === "arc") {
      window.open("https://faucet.circle.com", "_blank", "noopener,noreferrer");
      return;
    }
    if (network === "base") {
      actions.openView("tools", "coinbase-onramp");
      return;
    }
    const from = best && best !== network ? best : network === "solana" ? "base" : "solana";
    actions.fill(fundSentence(from, network));
  };

  return (
    <section aria-label={copy.asideLabel} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Heading className="text-xs font-black uppercase tracking-[0.16em] text-muted">{copy.title}</Heading>
        {connected ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label={copy.refresh}
            disabled={loading}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 border-2 border-control bg-surface px-2 text-xs font-bold text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
            {snapshot ? <span>{clockOf(snapshot.observedAt)}</span> : null}
          </button>
        ) : null}
      </div>
      {!connected ? (
        <p className="border-2 border-dashed border-control p-3 text-sm font-semibold">{copy.connect}</p>
      ) : (
        <>
          <p className="text-sm font-bold" aria-live="polite">
            {loading && !snapshot
              ? copy.loading
              : failed && !snapshot
                ? copy.unavailable
                : totals
                  ? lane === "testnet"
                    ? DESK_COPY.empty.testYard
                    : `${copy.laneTotal(DESK_COPY.departure.groupProduction, formatUsd(totals.totalUsd) ?? "$0.00")}${totals.unpriced ? ` · ${copy.unpriced(totals.unpriced)}` : ""}`
                  : ""}
          </p>
          {perAccount ? <p className="text-xs text-muted">{copy.perAccount}</p> : null}
          <ul className="flex flex-col gap-2">
            {laneNetworks(lane).map((network) => {
              const entry = snapshot?.byNetwork[network] ?? null;
              const labels = holdingLabels(entry);
              const usd = entry && lane === "production" ? formatUsd(entry.totalUsd > 0 ? entry.totalUsd : null) : null;
              const needsWallet = CHAINS[network].namespace === "solana" ? !actions.accounts.connected.solana : !actions.accounts.connected.evm;
              return (
                <li key={network} className="border-2 border-control bg-surface p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-bold">
                      <LineBullet line={LINES[network]} decorative />
                      <span className="truncate">{CHAINS[network].name}</span>
                    </span>
                    <span className="shrink-0 font-code text-sm font-bold">{entry ? (usd ?? (labels.length ? "" : copy.empty)) : ""}</span>
                  </div>
                  {needsWallet ? (
                    <p className="mt-1 text-xs text-muted">{CHAINS[network].namespace === "solana" ? DESK_COPY.departure.walletHintSolana : DESK_COPY.departure.walletHintEvm}</p>
                  ) : entry ? (
                    <>
                      {labels.length ? <p className="mt-1 break-words font-code text-xs">{labels.join(" · ")}{entry.unpriced ? ` · ${copy.unpriced(entry.unpriced)}` : ""}</p> : null}
                      {entry.stale ? <p className="mt-1 text-xs font-bold text-[var(--kl-warning)]">{copy.notUpdated(clockOf(entry.observedAt))}</p> : null}
                      <div className="mt-1 flex flex-wrap gap-x-4">
                        <button type="button" className={LINK} aria-label={copy.startHereLabel(CHAINS[network].name)} onClick={() => actions.setDeparture(network)}>
                          {copy.startHere}
                        </button>
                        <button type="button" className={LINK} onClick={() => fund(network)}>
                          {network === "base" ? copy.fundCoinbase : network === "arc" ? copy.fundFaucet : copy.fund}
                        </button>
                      </div>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-muted">{copy.verifiedScans}</p>
            <div className="flex flex-wrap gap-x-4">
              {LEGACY_NETWORKS.map((network) => (
                <button key={network} type="button" className={LINK} onClick={() => actions.startEngineTask(copy.scanPrompt[network], network, "tool")}>
                  {CHAINS[network].shortName}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
