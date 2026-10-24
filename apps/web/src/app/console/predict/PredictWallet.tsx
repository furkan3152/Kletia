/**
 * The Predict view's wallet panel: the Polymarket wallet(s) Kletia found for
 * the connected EVM wallet (derived and checked on Polygon by
 * GET /v1/predictions/wallets), which one trades, its pUSD and USDC.e, why a
 * wallet is read only, and the moves Kletia builds for it (deposit from the
 * EVM wallet; withdraw to it and wrap USDC.e for a Safe). A pick among
 * several is a radio group; one column at every width.
 */
import { useState } from "react";
import type { PolymarketWallet } from "@kletia/core";

import type { PlatformError } from "../../../shared/platform/kletiaClient";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { ViewEmpty, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_PANEL } from "../shell/viewStyles";
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
    <section aria-labelledby="predict-wallet" className={VIEW_PANEL}>
      <h3 id="predict-wallet" className={PANEL_TITLE}>{copy.heading}</h3>
      <p className="max-w-prose text-sm">{copy.intro}</p>
      {!account ? <ViewEmpty action={<Button variant="secondary" size="sm" onClick={onConnect}>{PREDICT_COPY.ticket.connect}</Button>}>{copy.connect}</ViewEmpty> : null}
      {account && !view && !error ? <ViewLoading>{copy.loading}</ViewLoading> : null}
      {error ? <ApiErrorPanel error={error} onRetry={onRetry} /> : null}
      {view && rows.length === 0 ? <ViewEmpty>{copy.none}</ViewEmpty> : null}
      {rows.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={cx(LABEL, "mb-1")}>{copy.pick}</legend>
          {rows.map((row) => (
            <label key={row.address} className="flex min-h-11 cursor-pointer items-start gap-2 border-2 border-[var(--kl-line)] p-2">
              <input type="radio" name="polymarket-wallet" className="mt-1" checked={row.address === current?.address} onChange={() => onPick(row.address)} />
              <span className="min-w-0 text-sm">
                <span className="block font-bold">{row.kind} · {shortAddress(row.address)}</span>
                <span className={cx("block", TEXT_MUTED)}>{row.balance} · {row.tradable ? copy.tradable : copy.readOnly}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {current ? (
        <div className="flex min-w-0 flex-col gap-2 border-2 border-[var(--kl-line)] p-3">
          <p className="break-words font-bold">{current.line}</p>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <span>{current.kind}</span>
            <span className="font-code font-bold">{current.balance}</span>
            <span>{current.tradable ? copy.tradable : copy.readOnly}</span>
            {current.onProfile ? <span>{copy.onProfile}</span> : null}
          </p>
          <p className="break-all font-code text-xs">{current.address}</p>
          {current.note ? <ViewNote tone={current.tradable ? "info" : "warning"}>{current.note}</ViewNote> : null}
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-bold">{copy.verified}</summary>
            <p className="break-words">{selected?.verifiedBy}</p>
          </details>
        </div>
      ) : null}
      {view?.profile.status === "unverified" && view.profile.wallet ? <ViewNote tone="warning">{copy.unverified(view.profile.wallet)}</ViewNote> : null}
      {current && current.actions.length > 0 ? (
        <form
          className="flex flex-col gap-2"
          aria-labelledby="predict-wallet-moves"
          onSubmit={(event) => {
            event.preventDefault();
            if (problems.length === 0) onMove(move);
          }}
        >
          <h4 id="predict-wallet-moves" className={LABEL}>{copy.moves}</h4>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold">{copy.action}</span>
              <select className={VIEW_FIELD} value={move.action} onChange={(event) => {
                const action = event.target.value as WalletMove["action"];
                setMove((value) => ({ ...value, action, asset: action === "wrap" ? "USDC.e" : value.asset }));
              }}>
                {current.actions.map((action) => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold">{copy.asset}</span>
              <select className={VIEW_FIELD} value={move.asset} disabled={move.action === "wrap"} onChange={(event) => setMove((value) => ({ ...value, asset: event.target.value === "USDC.e" ? "USDC.e" : "pUSD" }))}>
                <option value="pUSD">pUSD</option>
                <option value="USDC.e">USDC.e</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold">{copy.amount}</span>
              <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder="25" value={move.amount} onChange={(event) => setMove((value) => ({ ...value, amount: event.target.value }))} />
            </label>
          </div>
          {move.amount && problems.length > 0 ? <ul className="list-disc pl-5 text-sm">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          <p className={cx("text-xs", TEXT_MUTED)}>{copy.gas}</p>
          <Button type="submit" variant="secondary" loading={busy} disabled={busy || problems.length > 0}>{copy.prepareMove}</Button>
        </form>
      ) : null}
    </section>
  );
}
