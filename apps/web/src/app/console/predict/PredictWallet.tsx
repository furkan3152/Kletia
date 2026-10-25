/**
 * The Predict view's wallet panel: the Polymarket wallet(s) Kletia found for
 * the connected EVM wallet (derived and checked on Polygon by
 * GET /v1/predictions/wallets), which one trades, its pUSD and USDC.e, why a
 * wallet is read only, and the moves Kletia builds for it (deposit from the
 * EVM wallet; withdraw to it and wrap USDC.e for a Safe). A pick among
 * several is a rack of cartridges (a radio group); one column at every width. Drawn as the
 * machine's wallet cartridge: grip ridges, the striped badge, a lamp that is lit when
 * the wallet trades here.
 */
import { useState } from "react";
import type { PolymarketWallet } from "@kletia/core";

import type { PlatformError } from "../../../shared/platform/kletiaClient";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { Cartridges } from "../../kit";
import { ViewEmpty, ViewLoading, ViewNote } from "../shell/ViewParts";
import { VIEW_FIELD, VIEW_LABEL } from "../shell/viewStyles";
import type { PolymarketWalletsResponse } from "./predictApi";
import { PREDICT_COPY } from "./predictCopy";
import { moveProblems, shortAddress, walletRows, type WalletMove } from "./predictModel";

const copy = PREDICT_COPY.wallet;

export interface PredictWalletProps {
  readonly account: string | null;
  readonly view: PolymarketWalletsResponse | null;
  readonly error: PlatformError | null;
  readonly selected: PolymarketWallet | null;
  readonly busy: boolean;
  readonly onPick: (address: string) => void;
  readonly onConnect: () => void;
  readonly onRetry: () => void;
  readonly onMove: (move: WalletMove) => void;
}

const ACTION_LABELS = { deposit: copy.deposit, withdraw: copy.withdraw, wrap: copy.wrap } as const;

export function PredictWallet({ account, view, error, selected, busy, onPick, onConnect, onRetry, onMove }: PredictWalletProps) {
  const [move, setMove] = useState<WalletMove>({ action: "deposit", asset: "pUSD", amount: "" });
  const rows = walletRows(view?.wallets ?? []);
  const current = rows.find((row) => row.address === selected?.address) ?? null;
  const problems = moveProblems(move, selected);
  return (
    <section aria-labelledby="predict-wallet" className="kp-wallet">
      <div className="kp-wallet-h">
        <span className="kp-wallet-av" aria-hidden="true" data-off={current?.tradable ? undefined : ""} />
        <div style={{ minWidth: 0 }}>
          <h3 id="predict-wallet">{copy.heading}</h3>
          <p>{current ? `${current.kind} · ${shortAddress(current.address)}` : "Polygon · pUSD"}</p>
        </div>
        <span className="kp-wallet-lamp" aria-hidden="true" data-on={current?.tradable ? "" : undefined} />
      </div>
      <p className="kt-risk">{copy.intro}</p>
      {!account ? <ViewEmpty action={<Button variant="secondary" size="sm" onClick={onConnect}>{PREDICT_COPY.ticket.connect}</Button>}>{copy.connect}</ViewEmpty> : null}
      {account && !view && !error ? <ViewLoading>{copy.loading}</ViewLoading> : null}
      {error ? <ApiErrorPanel error={error} onRetry={onRetry} /> : null}
      {view && rows.length === 0 ? <ViewEmpty>{copy.none}</ViewEmpty> : null}
      {rows.length > 1 ? (
        <Cartridges
          label={copy.pick}
          value={current?.address ?? ""}
          onChange={onPick}
          options={rows.map((row) => ({ id: row.address, label: `${row.kind} · ${shortAddress(row.address)}`, detail: `${row.balance} · ${row.tradable ? copy.tradable : copy.readOnly}`, icon: "wallet" as const }))}
        />
      ) : null}
      {current ? (
        <div className="kp-wallet-slot">
          <b>{current.line}</b>
          <p className="kp-wallet-row" style={{ margin: 0 }}>
            <span>{current.kind}</span>
            <span className="kv-num" style={{ fontWeight: 600 }}>{current.balance}</span>
            <span>{current.tradable ? copy.tradable : copy.readOnly}</span>
            {current.onProfile ? <span>{copy.onProfile}</span> : null}
          </p>
          <p className="kp-wallet-addr" style={{ margin: 0 }}>{current.address}</p>
          {current.note ? <ViewNote tone={current.tradable ? "info" : "warning"}>{current.note}</ViewNote> : null}
          <details className="kt-more">
            <summary>{copy.verified}</summary>
            <p style={{ overflowWrap: "anywhere" }}>{selected?.verifiedBy}</p>
          </details>
        </div>
      ) : null}
      {view?.profile.status === "unverified" && view.profile.wallet ? <ViewNote tone="warning">{copy.unverified(view.profile.wallet)}</ViewNote> : null}
      {current && current.actions.length > 0 ? (
        <form
          className="kp-moves"
          aria-labelledby="predict-wallet-moves"
          onSubmit={(event) => {
            event.preventDefault();
            if (problems.length === 0) onMove(move);
          }}
        >
          <h4 id="predict-wallet-moves" className="kv-eng">{copy.moves}</h4>
          <div className="kp-moves-grid">
            <label className="kv-field">
              <span className={VIEW_LABEL}>{copy.action}</span>
              <select className={VIEW_FIELD} value={move.action} onChange={(event) => {
                const action = event.target.value as WalletMove["action"];
                setMove((value) => ({ ...value, action, asset: action === "wrap" ? "USDC.e" : value.asset }));
              }}>
                {current.actions.map((action) => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}
              </select>
            </label>
            <label className="kv-field">
              <span className={VIEW_LABEL}>{copy.asset}</span>
              <select className={VIEW_FIELD} value={move.asset} disabled={move.action === "wrap"} onChange={(event) => setMove((value) => ({ ...value, asset: event.target.value === "USDC.e" ? "USDC.e" : "pUSD" }))}>
                <option value="pUSD">pUSD</option>
                <option value="USDC.e">USDC.e</option>
              </select>
            </label>
            <label className="kv-field">
              <span className={VIEW_LABEL}>{copy.amount}</span>
              <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder="25" value={move.amount} onChange={(event) => setMove((value) => ({ ...value, amount: event.target.value }))} />
            </label>
          </div>
          {move.amount && problems.length > 0 ? <ul className="kt-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          <p className="kv-muted" style={{ margin: 0, fontSize: 12.5 }}>{copy.gas}</p>
          <Button type="submit" variant="secondary" loading={busy} disabled={busy || problems.length > 0}>{copy.prepareMove}</Button>
        </form>
      ) : null}
    </section>
  );
}
