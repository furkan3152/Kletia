/**
 * Orders (/app/orders), in the Card machine language: native protocol orders that fill without the
 * user online. The ticket on the right (Limit or DCA, the network as cartridges, the pair, amount
 * and price; quote, then place: the wallet signs, Kletia relays the checked signature); on the left
 * the quote as facts, Safe steps for a Safe to execute, and the connected wallets' orders on Solana
 * and the CoW networks with cancel. Nothing here is simulated: every order and status comes from
 * the protocol through /v1/orders.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CHAINS, type IntentHandoff } from "@kletia/core";

import { getKletiaClient, describePlatformError, toPlatformError } from "../../../shared/platform/kletiaClient";
import { useWallets } from "../../../shared/wallet/useWallets";
import { Cartridges, CardTray, Key, Segmented, Sleeve, networkIcon } from "../../kit";
import { buttonClasses } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { ViewEmpty, ViewFacts, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_LABEL, VIEW_PANEL } from "../shell/viewStyles";
import { InstrumentHead, SideSwitch, Ticket, TradeLayout } from "../trade/TradeParts";
import { cancelOrder, listOrders, prepareOrder, quoteOrder, type OrderQuoteView } from "./ordersApi";
import {
  EMPTY_ORDER_FORM,
  failureLine,
  filledPercent,
  groupOrders,
  ORDER_NETWORK_KEYS,
  ORDER_PERIODS,
  orderErrorMessage,
  orderRequestBody,
  orderSummary,
  ownerFor,
  priceOrientation,
  protocolName,
  stepAction,
  type NativeOrderView,
  type OrderFormState,
  type OrderListFailureView,
  type OrderPreparationView,
  type OrderStepView,
} from "./ordersModel";
import { useOrderRunner } from "./useOrderRunner";
import { orderPrefill } from "../handoff/handoffModel";
import { HandoffNote } from "../handoff/HandoffNote";
import { useHandoff } from "../handoff/useHandoff";

const copy = DESK_COPY.orders;
/** The tray before a quote: what will print there (nothing is guessed before the protocol answers). */
const QUOTE_EMPTY = "The least you receive, the market price and the fees print here when you get a quote.";
const FIELD = VIEW_FIELD;

/** The registry's name of a network key; an unknown key is printed as it came. */
function networkName(key: string): string {
  return (CHAINS as Readonly<Record<string, { readonly name: string } | undefined>>)[key]?.name ?? key;
}

function errorText(error: unknown): string {
  const platform = toPlatformError(error);
  return orderErrorMessage(platform) ?? describePlatformError(platform);
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="kv-field">
      <span className={VIEW_LABEL}>{label}</span>
      {children}
    </label>
  );
}

function QuotePanel({ quote }: { readonly quote: OrderQuoteView }) {
  const rows: [string, string][] = [];
  if (quote.buy) rows.push([copy.least, `${quote.buy.formatted} ${quote.buy.symbol}`]);
  if (quote.market) rows.push([copy.market, `${quote.market.formatted} ${quote.market.symbol}`]);
  if (quote.limitVsMarketPct !== null) rows.push(["", quote.limitVsMarketPct > 0 ? copy.vsMarket(quote.limitVsMarketPct.toFixed(2)) : copy.vsMarketNow]);
  if (quote.schedule) {
    rows.push([copy.perPart, `${quote.schedule.perPart.formatted} ${quote.schedule.perPart.symbol}`]);
    rows.push([copy.ends, new Date(quote.schedule.endsAt).toLocaleString()]);
  }
  if (quote.expiresAt) rows.push([copy.expires, new Date(quote.expiresAt).toLocaleString()]);
  rows.push([copy.fees, quote.fees], [copy.custody, quote.custody]);
  return (
    <section aria-label={copy.quoteHeading} className={VIEW_PANEL}>
      <h3 className={PANEL_TITLE}>
        {copy.quoteHeading} · {protocolName(quote.protocol)}
      </h3>
      <ViewFacts live rows={rows.map(([term, value]) => ({ label: term, value }))} />
      {quote.warnings.map((warning) => (
        <ViewNote key={warning} tone="warning">
          {warning}
        </ViewNote>
      ))}
    </section>
  );
}

function SafeSteps({ steps }: { readonly steps: readonly OrderStepView[] }) {
  return (
    <section aria-label={copy.safeHeading} className={VIEW_PANEL}>
      <h3 className={PANEL_TITLE}>{copy.safeHeading}</h3>
      <p className="kv-intro">{copy.safeHint}</p>
      <ol className="kt-list" style={{ listStyle: "decimal", paddingLeft: 20 }}>
        {steps.map((step, index) =>
          step.kind === "safe-transaction" ? (
            <li key={index} className="kv-field">
              <b>{step.description}</b>
              <span className="kv-num" style={{ overflowWrap: "anywhere", fontSize: 13 }}>
                {copy.safeTo}: {step.to}
              </span>
              <span className="kv-num" style={{ overflowWrap: "anywhere", fontSize: 13 }}>
                {copy.safeData}: {step.data}
              </span>
            </li>
          ) : null,
        )}
      </ol>
    </section>
  );
}

function OrderRow({ order, canCancel, busy, onCancel }: { readonly order: NativeOrderView; readonly canCancel: boolean; readonly busy: boolean; readonly onCancel: () => void }) {
  const pct = filledPercent(order);
  return (
    <li className="kt-pos">
      <p className="kt-pos-h">
        <b>{orderSummary(order)}</b>
        <span className="kv-muted">
          {protocolName(order.protocol)} · {networkName(order.network)}
        </span>
      </p>
      {pct !== null || order.expiresAt ? (
        <p className="kv-muted" style={{ margin: 0, fontSize: 13 }}>
          {pct !== null ? copy.filled(String(pct)) : null}
          {order.expiresAt ? `${pct !== null ? " · " : ""}${copy.expiresAt(new Date(order.expiresAt).toLocaleString())}` : null}
        </p>
      ) : null}
      {pct !== null ? (
        <span className="ko-fill" aria-hidden="true">
          <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </span>
      ) : null}
      {canCancel ? (
        <div className="kt-pos-act">
          <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy} onClick={onCancel}>
            {copy.cancel}
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function OrdersView() {
  const wallets = useWallets();
  const evm = wallets.evm?.address ?? null;
  const solana = wallets.solana?.address ?? null;
  const owners = useMemo(() => [evm, solana].filter((owner): owner is string => owner !== null), [evm, solana]);
  const run = useOrderRunner();

  const [form, setForm] = useState<OrderFormState>(EMPTY_ORDER_FORM);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  useHandoff("orders", useCallback((handoff: IntentHandoff) => {
    if (handoff.surface !== "orders") return;
    const prefill = orderPrefill(handoff.input, EMPTY_ORDER_FORM, Date.now());
    if ("form" in prefill) setForm(prefill.form);
    setHandoffNote("form" in prefill ? `${handoff.summary}: check the form, then quote and sign.` : `${handoff.summary}. ${prefill.problem}`);
  }, []));
  const [quote, setQuote] = useState<OrderQuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [safeSteps, setSafeSteps] = useState<readonly OrderStepView[] | null>(null);
  const [orders, setOrders] = useState<readonly NativeOrderView[]>([]);
  const [failures, setFailures] = useState<readonly OrderListFailureView[]>([]);
  const [version, setVersion] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const ownersKey = owners.join(",");
  const requestKey = `${ownersKey}#${version}`;
  const loading = ownersKey !== "" && loadedKey !== requestKey;
  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    if (!ownersKey) return;
    let live = true;
    listOrders(getKletiaClient(), ownersKey.split(",")).then(
      (reply) => {
        if (!live) return;
        setOrders(reply.orders);
        setFailures(reply.failures);
        setLoadedKey(requestKey);
      },
      (error: unknown) => {
        if (!live) return;
        setFailures([{ protocol: "orders", network: "all", code: "", message: errorText(error) }]);
        setLoadedKey(requestKey);
      },
    );
    return () => {
      live = false;
    };
  }, [ownersKey, requestKey]);

  const owner = ownerFor(form.network, { evm, solana });
  const request = orderRequestBody(form, owner);
  const update = (patch: Partial<OrderFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setQuote(null);
  };

  const execute = async (preparation: OrderPreparationView, done: (reference: string) => string) => {
    setSafeSteps(null);
    const result = await run(preparation, (index) => setStatus(`${copy.step(String(index + 1), String(preparation.steps.length))}: ${stepAction(preparation.steps[index]!)}`));
    if (result.kind === "safe") setSafeSteps(result.steps);
    else setStatus(done(result.order.reference));
    refresh();
  };

  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    setStatus(copy.working);
    try {
      await task();
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const onQuote = () =>
    act(async () => {
      if (!("body" in request)) return;
      setQuote(await quoteOrder(getKletiaClient(), request.body));
      setStatus("");
    });
  const onPlace = () =>
    act(async () => {
      if (!("body" in request)) return;
      await execute(await prepareOrder(getKletiaClient(), request.body), copy.submitted);
    });
  const onCancel = (order: NativeOrderView) =>
    act(async () => {
      await execute(await cancelOrder(getKletiaClient(), order.id, order.owner), copy.cancelled);
    });

  const grouped = groupOrders(orders);
  const orientation = priceOrientation(form);

  const ticket = (
    <Ticket id="desk-orders-create" title={copy.createHeading}>
      <form className="kt-ticket-form" onSubmit={(event) => event.preventDefault()} aria-labelledby="desk-orders-create">
        <Segmented
          fill
          tall
          ariaLabel={copy.modeLabel}
          value={form.mode}
          onChange={(mode) => update({ mode })}
          options={(["limit", "dca"] as const).map((mode) => ({ id: mode, label: copy.modes[mode] }))}
        />
        <Cartridges
          label={copy.network}
          value={form.network}
          onChange={(network) => update({ network })}
          options={ORDER_NETWORK_KEYS.map((key) => ({ id: key, label: networkName(key), icon: networkIcon(key), stripe: CHAINS[key].color, detail: key === "solana" ? "Jupiter" : "CoW Protocol" }))}
        />
        {form.mode === "limit" ? (
          <SideSwitch
            label={copy.side}
            value={form.side}
            onChange={(side) => update({ side })}
            options={[
              { id: "sell", label: copy.sides.sell, tone: "go" },
              { id: "buy", label: copy.sides.buy, tone: "go" },
            ]}
          />
        ) : null}
        <div className="kt-row2">
          <Field label={copy.sell}>
            <input className={FIELD} value={form.sell} onChange={(event) => update({ sell: event.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={copy.buy}>
            <input className={FIELD} value={form.buy} onChange={(event) => update({ buy: event.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <Field label={form.mode === "dca" ? copy.amountDca : copy.amount}>
          <input className={FIELD} value={form.amount} onChange={(event) => update({ amount: event.target.value })} inputMode="decimal" autoComplete="off" />
        </Field>
        {form.mode === "limit" ? (
          <>
            <div className="kv-field">
              <Field label={`${copy.price} (${copy.priceHint(orientation.counted || "?", orientation.per || "?")})`}>
                <input className={FIELD} value={form.price} onChange={(event) => update({ price: event.target.value })} inputMode="decimal" autoComplete="off" />
              </Field>
              <button type="button" className="kv-link" style={{ alignSelf: "flex-start" }} onClick={() => update({ priceFlipped: !form.priceFlipped, price: "" })}>
                {copy.flipPrice(orientation.per || "?", orientation.counted || "?")}
              </button>
            </div>
            <Field label={copy.expiry}>
              <input className={FIELD} value={form.expiryDays} onChange={(event) => update({ expiryDays: event.target.value })} inputMode="numeric" autoComplete="off" />
            </Field>
          </>
        ) : (
          <div className="kt-row2">
            <Field label={copy.period}>
              <select className={FIELD} value={form.period} onChange={(event) => update({ period: event.target.value as OrderFormState["period"] })}>
                {ORDER_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {copy.periods[period]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={copy.count}>
              <input className={FIELD} value={form.count} onChange={(event) => update({ count: event.target.value })} inputMode="numeric" autoComplete="off" />
            </Field>
          </div>
        )}
        {"problem" in request ? <ViewNote>{request.problem}</ViewNote> : null}
        <button type="button" className={buttonClasses("secondary", "md")} disabled={busy || !("body" in request)} onClick={() => void onQuote()}>
          {copy.quote}
        </button>
        <Key tone="lime" disabled={busy || !("body" in request)} onClick={() => void onPlace()}>
          {copy.place}
        </Key>
        <p role="status" aria-live="polite" className="kt-risk" style={{ minHeight: 20 }}>
          {status}
        </p>
      </form>
    </Ticket>
  );

  const main = (
    <>
      <InstrumentHead
        title={
          <p className="kv-h2" style={{ fontSize: 26 }}>
            {(form.sell.trim() || "?") + " / " + (form.buy.trim() || "?")}
          </p>
        }
        sub={`${copy.modes[form.mode]} · ${networkName(form.network)} · ${form.network === "solana" ? "Jupiter" : "CoW Protocol"}`}
      />
      <CardTray label={copy.quoteHeading} status={quote ? protocolName(quote.protocol) : null}>
        {quote ? <QuotePanel quote={quote} /> : <Sleeve title={copy.quoteHeading}><p className="kv-muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>{QUOTE_EMPTY}</p></Sleeve>}
      </CardTray>
      {safeSteps ? <SafeSteps steps={safeSteps} /> : null}
    </>
  );

  const list = (
    <section aria-labelledby="desk-orders-list" className="kv-sec">
      <div className="kv-sec-h">
        <h3 id="desk-orders-list">{copy.listHeading}</h3>
        {owners.length > 0 ? (
          <button type="button" className={buttonClasses("ghost", "sm")} disabled={loading} onClick={refresh}>
            {copy.refresh}
          </button>
        ) : null}
      </div>
      {owners.length === 0 ? <ViewEmpty>{copy.connect}</ViewEmpty> : null}
      {loading ? <ViewLoading>{copy.loading}</ViewLoading> : null}
      {failures.length > 0 ? (
        <ViewNote tone="danger">
          <p style={{ margin: 0 }}>{copy.readFailed}</p>
          <ul>
            {failures.map((failure, index) => (
              <li key={index}>{failureLine(failure)}</li>
            ))}
          </ul>
        </ViewNote>
      ) : null}
      {owners.length > 0 && !loading && orders.length === 0 && failures.length === 0 ? <ViewEmpty>{copy.empty}</ViewEmpty> : null}
      {(["open", "filled", "closed", "unknown"] as const).map((group) =>
        grouped[group].length > 0 ? (
          <div key={group} className="kv-field">
            <h4 className="kv-eng">{copy.groups[group]}</h4>
            <ul className="kt-list">
              {grouped[group].map((order) => (
                <OrderRow key={order.id} order={order} busy={busy} canCancel={order.cancellable && owners.some((entry) => entry.toLowerCase() === order.owner.toLowerCase())} onCancel={() => void onCancel(order)} />
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );

  return (
    <section aria-labelledby="desk-orders-heading" className="flex flex-col gap-6 pb-8">
      <ViewHeader id="desk-orders-heading" title={copy.title} intro={copy.intro} />
      <HandoffNote text={handoffNote} />
      <TradeLayout main={main} ticket={ticket} rest={list} />
    </section>
  );
}
