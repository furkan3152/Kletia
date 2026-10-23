/**
 * Orders (/app/orders): native protocol orders that fill without the user
 * online. A form for limit and DCA orders (quote, then place: the wallet
 * signs, Kletia relays the checked signature), Safe steps shown for a Safe
 * to execute, and the connected wallets' orders on Solana and the CoW
 * networks with cancel. Nothing here is simulated: every order and status
 * comes from the protocol through /v1/orders.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CHAINS } from "@kletia/core";

import { getKletiaClient, describePlatformError, toPlatformError } from "../../../shared/platform/kletiaClient";
import { useWallets } from "../../../shared/wallet/useWallets";
import { buttonClasses, cx, FOCUS_RING, LABEL } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_PANEL } from "../shell/viewStyles";
import { cancelOrder, listOrders, prepareOrder, quoteOrder, type OrderQuoteView } from "./ordersApi";
import {
  EMPTY_ORDER_FORM,
  failureLine,
  filledPercent,
  groupOrders,
  ORDER_NETWORK_KEYS,
  ORDER_PERIODS,
  orderRequestBody,
  orderSummary,
  ownerFor,
  protocolName,
  stepAction,
  type NativeOrderView,
  type OrderFormState,
  type OrderListFailureView,
  type OrderPreparationView,
  type OrderStepView,
} from "./ordersModel";
import { useOrderRunner } from "./useOrderRunner";

const copy = DESK_COPY.orders;
const FIELD = VIEW_FIELD;
const TOGGLE = cx(
  "min-h-11 border-[3px] border-control bg-surface px-4 text-xs font-black uppercase tracking-[0.12em] text-fg hover:bg-neutral-bg aria-pressed:bg-[#1A1A1A] aria-pressed:text-white dark:aria-pressed:bg-white dark:aria-pressed:text-[#0B1120]",
  FOCUS_RING,
);

/** The registry's name of a network key; an unknown key is printed as it came. */
function networkName(key: string): string {
  return (CHAINS as Readonly<Record<string, { readonly name: string } | undefined>>)[key]?.name ?? key;
}

function errorText(error: unknown): string {
  return describePlatformError(toPlatformError(error));
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
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
      <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        {rows.map(([term, value], index) => (
          <div key={`${term}-${index}`} className="contents">
            <dt className="font-bold">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
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
      <p className="text-sm">{copy.safeHint}</p>
      <ol className="flex list-decimal flex-col gap-3 pl-5">
        {steps.map((step, index) =>
          step.kind === "safe-transaction" ? (
            <li key={index} className="text-sm">
              <p className="font-bold">{step.description}</p>
              <p className="break-all font-code">
                {copy.safeTo}: {step.to}
              </p>
              <p className="break-all font-code">
                {copy.safeData}: {step.data}
              </p>
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
    <li className={cx(VIEW_PANEL, "gap-1 p-3 sm:flex-row sm:items-center sm:justify-between")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs font-black uppercase tracking-wider">
          {protocolName(order.protocol)} · {networkName(order.network)}
        </p>
        <p className="text-sm">{orderSummary(order)}</p>
        <p className="text-xs text-muted">
          {pct !== null ? copy.filled(String(pct)) : null}
          {order.expiresAt ? ` · ${copy.expiresAt(new Date(order.expiresAt).toLocaleString())}` : null}
        </p>
      </div>
      {canCancel ? (
        <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy} onClick={onCancel}>
          {copy.cancel}
        </button>
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
  const counter = form.side === "sell" || form.mode === "dca" ? form.buy : form.sell;
  const unit = form.side === "sell" || form.mode === "dca" ? form.sell : form.buy;

  return (
    <section aria-labelledby="desk-orders-heading" className="flex flex-col gap-6 pb-8">
      <ViewHeader id="desk-orders-heading" title={copy.title} intro={copy.intro} />

      <form className={cx(VIEW_PANEL, "gap-4")} onSubmit={(event) => event.preventDefault()} aria-labelledby="desk-orders-create">
        <h3 id="desk-orders-create" className={PANEL_TITLE}>
          {copy.createHeading}
        </h3>
        <div role="group" aria-label={copy.modeLabel} className="flex gap-2">
          {(["limit", "dca"] as const).map((mode) => (
            <button key={mode} type="button" className={TOGGLE} aria-pressed={form.mode === mode} onClick={() => update({ mode })}>
              {copy.modes[mode]}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={copy.network}>
            <select className={FIELD} value={form.network} onChange={(event) => update({ network: event.target.value as OrderFormState["network"] })}>
              {ORDER_NETWORK_KEYS.map((key) => (
                <option key={key} value={key}>
                  {networkName(key)}
                </option>
              ))}
            </select>
          </Field>
          {form.mode === "limit" ? (
            <Field label={copy.side}>
              <select className={FIELD} value={form.side} onChange={(event) => update({ side: event.target.value as OrderFormState["side"] })}>
                <option value="sell">{copy.sides.sell}</option>
                <option value="buy">{copy.sides.buy}</option>
              </select>
            </Field>
          ) : null}
          <Field label={copy.sell}>
            <input className={FIELD} value={form.sell} onChange={(event) => update({ sell: event.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={copy.buy}>
            <input className={FIELD} value={form.buy} onChange={(event) => update({ buy: event.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={form.mode === "dca" ? copy.amountDca : copy.amount}>
            <input className={FIELD} value={form.amount} onChange={(event) => update({ amount: event.target.value })} inputMode="decimal" autoComplete="off" />
          </Field>
          {form.mode === "limit" ? (
            <>
              <Field label={`${copy.price} (${copy.priceHint(counter || "?", unit || "?")})`}>
                <input className={FIELD} value={form.price} onChange={(event) => update({ price: event.target.value })} inputMode="decimal" autoComplete="off" />
              </Field>
              <Field label={copy.expiry}>
                <input className={FIELD} value={form.expiryDays} onChange={(event) => update({ expiryDays: event.target.value })} inputMode="numeric" autoComplete="off" />
              </Field>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
        {"problem" in request ? <ViewNote>{request.problem}</ViewNote> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClasses("secondary", "md")} disabled={busy || !("body" in request)} onClick={() => void onQuote()}>
            {copy.quote}
          </button>
          <button type="button" className={buttonClasses("primary", "md")} disabled={busy || !("body" in request)} onClick={() => void onPlace()}>
            {copy.place}
          </button>
        </div>
        <p role="status" aria-live="polite" className="min-h-5 text-sm">
          {status}
        </p>
      </form>

      {quote ? <QuotePanel quote={quote} /> : null}
      {safeSteps ? <SafeSteps steps={safeSteps} /> : null}

      <section aria-labelledby="desk-orders-list" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 id="desk-orders-list" className={PANEL_TITLE}>
            {copy.listHeading}
          </h3>
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
            <p>{copy.readFailed}</p>
            <ul className="list-disc pl-5 font-normal">
              {failures.map((failure, index) => (
                <li key={index}>{failureLine(failure)}</li>
              ))}
            </ul>
          </ViewNote>
        ) : null}
        {owners.length > 0 && !loading && orders.length === 0 && failures.length === 0 ? <ViewEmpty>{copy.empty}</ViewEmpty> : null}
        {(["open", "filled", "closed", "unknown"] as const).map((group) =>
          grouped[group].length > 0 ? (
            <div key={group} className="flex flex-col gap-2">
              <h4 className={cx(LABEL, "text-muted")}>{copy.groups[group]}</h4>
              <ul className="flex flex-col gap-2">
                {grouped[group].map((order) => (
                  <OrderRow key={order.id} order={order} busy={busy} canCancel={order.cancellable && owners.some((entry) => entry.toLowerCase() === order.owner.toLowerCase())} onCancel={() => void onCancel(order)} />
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </section>
    </section>
  );
}
