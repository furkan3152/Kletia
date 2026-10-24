/**
 * Open Polymarket orders of the wallet that trades (the Polymarket wallet,
 * or the account itself). The order book lists them only for a signed-in
 * session: a ClobAuth signature (no funds move) kept in memory for this tab.
 * Each resting order can be cancelled.
 */
import { useEffect, useState } from "react";

import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, TEXT_MUTED } from "../../site/ui/styles";
import { ViewEmpty, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_PANEL } from "../shell/viewStyles";
import { predictApi, type PredictionOpenOrder } from "./predictApi";
import { PREDICT_COPY } from "./predictCopy";
import { openOrderRows } from "./predictModel";
import { heldSession } from "./usePredictRun";

const copy = PREDICT_COPY.orders;

export interface PredictOrdersProps {
  readonly account: string;
  /** The Polymarket wallet whose orders are shown (null: the account's own). */
  readonly wallet: string | null;
  readonly signIn: (account: string) => Promise<string>;
}

export function PredictOrders({ account, wallet, signIn }: PredictOrdersProps) {
  const key = `${account}:${wallet ?? ""}`;
  const [session, setSession] = useState<{ readonly account: string; readonly value: string } | null>(null);
  const [orders, setOrders] = useState<{ readonly key: string; readonly list: readonly PredictionOpenOrder[] } | null>(null);
  const [error, setError] = useState<PlatformError | null>(null);
  const [pending, setPending] = useState<"sign-in" | "read" | string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A session this tab already holds (from an earlier order) lists the orders without signing again.
  useEffect(() => {
    const held = heldSession(account, Date.now());
    if (!held) return undefined;
    let live = true;
    predictApi.orders(account, held, wallet).then(
      (answer) => {
        if (!live) return;
        setSession({ account, value: held });
        setOrders({ key, list: answer.orders });
      },
      (failure: unknown) => {
        if (live) setError(toPlatformError(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [account, key, wallet]);

  const read = async (value: string) => {
    setPending("read");
    setError(null);
    try {
      const answer = await predictApi.orders(account, value, wallet);
      setOrders({ key, list: answer.orders });
    } catch (failure) {
      setError(toPlatformError(failure));
    } finally {
      setPending(null);
    }
  };

  const start = async () => {
    setPending("sign-in");
    setError(null);
    try {
      const value = await signIn(account);
      setSession({ account, value });
      await read(value);
    } catch (failure) {
      setError(toPlatformError(failure));
      setPending(null);
    }
  };

  const current = session?.account === account ? session.value : null;

  const cancel = async (orderId: string) => {
    if (!current) return;
    setPending(orderId);
    try {
      const answer = await predictApi.cancel(account, current, orderId);
      setNote(answer.canceled ? copy.canceled : answer.reason);
      await read(current);
    } catch (failure) {
      setError(toPlatformError(failure));
      setPending(null);
    }
  };

  const rows = orders?.key === key ? openOrderRows(orders.list) : null;
  return (
    <section aria-labelledby="predict-orders" className={VIEW_PANEL}>
      <h3 id="predict-orders" className={PANEL_TITLE}>{copy.heading}</h3>
      {!current ? (
        <div className="flex flex-col items-start gap-2">
          <p className={cx("text-sm", TEXT_MUTED)}>{copy.signInNote}</p>
          <Button variant="secondary" size="sm" loading={pending === "sign-in"} disabled={pending !== null} onClick={() => void start()}>{pending === "sign-in" ? copy.signing : copy.signIn}</Button>
        </div>
      ) : null}
      {error ? <ApiErrorPanel error={error} /> : null}
      {note ? <ViewNote role="status" tone="info">{note}</ViewNote> : null}
      {rows && rows.length === 0 ? <ViewEmpty>{copy.none}</ViewEmpty> : null}
      {rows && rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--kl-line)] p-2 text-sm">
              <span className="min-w-0">
                <span className="block font-bold">{row.side} {row.outcome} · {row.price}</span>
                <span className={cx("block", TEXT_MUTED)}>{copy.filled} {row.filled} · {row.status}</span>
              </span>
              <Button size="sm" variant="ghost" loading={pending === row.id} disabled={pending !== null} onClick={() => void cancel(row.id)}>{copy.cancel}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {current ? <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void read(current)}>{copy.refresh}</Button> : null}
    </section>
  );
}
