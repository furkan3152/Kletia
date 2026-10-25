/**
 * Holdings: balances of the connected wallets on every network of the lane,
 * from one batch read. Each row: line bullet, network, priced total, the
 * top holdings exactly as the API formats them, "Start here" (sets the
 * departure) and "Fund" (Coinbase on Base, the faucet on Arc, a bridge
 * sentence elsewhere). A network whose last read failed keeps its reading
 * with "not updated". The old engines' verified position scans stay
 * reachable as engine tasks.
 */
import { RefreshCw } from "lucide-react";
import type React from "react";
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import { Icon, networkIcon } from "../../kit";
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
  /** The full Holdings view: the heading reads like every other view's title (the rail keeps the small label). */
  readonly asView?: boolean;
}

/** Links that act (Start here, Fund, scans): views.css. */
const LINK = "kv-link";

function laneNetworks(lane: Lane): NetworkKey[] {
  return NETWORK_KEYS.filter((key) => (CHAINS[key].lane === "testnet" ? "testnet" : "production") === lane);
}

export function HoldingsPanel({ lane, snapshot, loading, failed, perAccount, onRefresh, headingLevel = 2, asView = false }: HoldingsPanelProps) {
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
    <section aria-label={copy.asideLabel} className="khd">
      <div className="khd-h">
        <Heading className={asView ? "kv-h2" : "kv-eng"}>{copy.title}</Heading>
        {connected ? (
          <button type="button" onClick={onRefresh} aria-label={copy.refresh} disabled={loading} className="k-key k-key--sm">
            <RefreshCw className={loading ? "kdb-spin" : undefined} aria-hidden="true" />
            {snapshot ? <span>{clockOf(snapshot.observedAt)}</span> : null}
          </button>
        ) : null}
      </div>
      {!connected ? (
        <p className="kv-empty">{copy.connect}</p>
      ) : (
        <>
          <p className="khd-total" aria-live="polite">
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
          {perAccount ? <p className="kv-muted khd-small">{copy.perAccount}</p> : null}
          <ul className="khd-rack">
            {laneNetworks(lane).map((network) => {
              const entry = snapshot?.byNetwork[network] ?? null;
              const labels = holdingLabels(entry);
              const usd = entry && lane === "production" ? formatUsd(entry.totalUsd > 0 ? entry.totalUsd : null) : null;
              const needsWallet = CHAINS[network].namespace === "solana" ? !actions.accounts.connected.solana : !actions.accounts.connected.evm;
              return (
                <li key={network} className="khd-cart" style={{ "--khd-stripe": CHAINS[network].color } as React.CSSProperties} data-empty={!entry || (!usd && labels.length === 0) ? "" : undefined}>
                  <span className="khd-ic" aria-hidden="true">
                    <Icon name={networkIcon(network)} />
                  </span>
                  <div className="khd-body">
                    <div className="khd-row">
                      <span className="khd-name">{CHAINS[network].name}</span>
                      <span className="khd-usd kv-num">{entry ? (usd ?? (labels.length ? "" : copy.empty)) : ""}</span>
                    </div>
                    {needsWallet ? (
                      <p className="khd-small kv-muted">{CHAINS[network].namespace === "solana" ? DESK_COPY.departure.walletHintSolana : DESK_COPY.departure.walletHintEvm}</p>
                    ) : entry ? (
                      <>
                        {labels.length ? <p className="khd-labels kv-num">{labels.join(" · ")}{entry.unpriced ? ` · ${copy.unpriced(entry.unpriced)}` : ""}</p> : null}
                        {entry.stale ? <p className="khd-small khd-stale">{copy.notUpdated(clockOf(entry.observedAt))}</p> : null}
                        <div className="khd-act">
                          <button type="button" className={LINK} aria-label={copy.startHereLabel(CHAINS[network].name)} onClick={() => actions.setDeparture(network)}>
                            {copy.startHere}
                          </button>
                          <button type="button" className={LINK} onClick={() => fund(network)}>
                            {network === "base" ? copy.fundCoinbase : network === "arc" ? copy.fundFaucet : copy.fund}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="khd-scans">
            <p className="kv-eng">{copy.verifiedScans}</p>
            <div className="khd-act">
              {LEGACY_NETWORKS.map((network) => (
                <button key={network} type="button" className="k-key k-key--sm" onClick={() => actions.startEngineTask(copy.scanPrompt[network], network, "tool")}>
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
