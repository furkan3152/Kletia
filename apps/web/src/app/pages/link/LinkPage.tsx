import "../../site/art/base.css";
import "./link.css";

import { Flag, PenLine } from "lucide-react";
import React, { useEffect, useId, useMemo, useState } from "react";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { CUSTOM_CONTRACT_EXECUTION_MESSAGE, isCustomContractExecution } from "../../../shared/platform/contractExecutionBoundary";
import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { LINK_PATH_PATTERN } from "../../routes/routeTable";
import { useRoute } from "../../routes/useRoute";
import { EndOfLine } from "../../site/art/EndOfLine";
import { LinkTicket } from "../../site/art/LinkTicket";
import { PlatformNumber } from "../../site/art/Ornaments";
import { Stamp } from "../../site/art/Stamp";
import { lineFor } from "../../site/art/tokens";
import { FareTable } from "../../site/intent/FareTable";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { VoidStamp } from "../receipt/receiptStamps";
import { DepartureChooser } from "./DepartureChooser";
import { FixedByPublisher } from "./FixedByPublisher";
import { REPORT_REASONS, reportLink, type FundingChoice, type ReportReason } from "./linkClient";
import {
  boundRows,
  boundsFor,
  checkAmount,
  formatDate,
  fundingOptions,
  httpsOnly,
  indicativeFare,
  linkSentence,
  linkSerial,
  linkState,
  namespacesFor,
  readPrefill,
  ticketNetworks,
} from "./linkModel";
import { useLinkQuote, useLinkView } from "./useLinkFlow";
import type { LinkView } from "@kletia/core";

const loadSignPanel = () => import("./LinkSignPanel");
const LinkSignPanel = React.lazy(loadSignPanel);

const PAPER = "kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]";

function Gone({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className={PAPER}>
      <div className={cx(CONTAINER, "grid min-h-[60vh] items-center gap-10 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}>
        <div className="min-w-0">
          <p className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#0047E0] dark:text-[#7EA6FF]">Intent link · no service</p>
          <h1 className="mt-4 text-balance font-display text-[clamp(2.2rem,5.6vw,3.8rem)] font-bold leading-[1.02] tracking-[-0.04em]">{title}</h1>
          <p className={cx("mt-6 max-w-xl text-lg leading-relaxed", TEXT_MUTED)}>{body}</p>
          <nav aria-label="Open platforms" className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/" size="lg">
              Home
            </ButtonLink>
            <ButtonLink to="/studio" variant="secondary" size="lg">
              Intent Studio
            </ButtonLink>
          </nav>
        </div>
        <div className="min-w-0">
          <EndOfLine platform="GO" />
        </div>
      </div>
    </div>
  );
}

function SectionHead({ n, eyebrow, title, intro, id }: { readonly n: number; readonly eyebrow: string; readonly title: string; readonly intro?: React.ReactNode; readonly id: string }) {
  return (
    <header className="mb-6 max-w-3xl">
      <PlatformNumber n={n}>{eyebrow}</PlatformNumber>
      <h2 id={id} className="mt-4 text-balance font-display text-[1.75rem] font-bold leading-[1.1] tracking-[-0.025em] sm:text-[2.1rem]">
        {title}
      </h2>
      {intro ? <div className={cx("mt-3 text-base leading-relaxed", TEXT_MUTED)}>{intro}</div> : null}
    </header>
  );
}

function ReportForm({ linkId }: { readonly linkId: string }) {
  const id = useId();
  const [reason, setReason] = useState<ReportReason>("phishing");
  const [state, setState] = useState<{ readonly status: "idle" | "sending" | "sent" } | { readonly status: "error"; readonly error: PlatformError }>({ status: "idle" });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState({ status: "sending" });
    try {
      await reportLink(linkId, reason);
      setState({ status: "sent" });
    } catch (error) {
      setState({ status: "error", error: toPlatformError(error) });
    }
  };
  if (state.status === "sent") {
    return (
      <p className="text-sm font-semibold" role="status">
        Reported. Kletia counts reports and can suspend a link; nothing about you was stored.
      </p>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className={LABEL}>
          Report this link
        </label>
        <select
          id={id}
          value={reason}
          onChange={(event) => setReason(event.target.value as ReportReason)}
          className={cx("min-h-11 max-w-full bg-white px-3 text-sm font-semibold text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white", INK_BORDER)}
        >
          {REPORT_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="secondary" disabled={state.status === "sending"}>
        <Flag className="h-4 w-4" aria-hidden="true" />
        {state.status === "sending" ? "Sending" : "Report"}
      </Button>
      {state.status === "error" ? <p className="w-full text-sm font-semibold text-[#B91C1C] dark:text-[#FCA5A5]" role="alert">{state.error.message}</p> : null}
    </form>
  );
}

function verifiedSource(source: string | undefined): boolean {
  return typeof source === "string" && /match/u.test(source);
}

function LinkLanding({ view }: { readonly view: LinkView }) {
  const { location } = useRoute();
  const amountId = useId();
  const amountHelpId = useId();
  const options = useMemo(() => fundingOptions(view), [view]);
  const prefill = useMemo(() => readPrefill(location.search, view), [location.search, view]);
  const [optionKey, setOptionKey] = useState<string | null>(() => prefill.optionKey ?? options[0]?.key ?? null);
  const option = options.find((candidate) => candidate.key === optionKey) ?? null;
  const bounds = option ? boundsFor(view, option.symbol) : null;
  const [amountText, setAmountText] = useState<Record<string, string>>(() =>
    prefill.amount && (prefill.optionKey ?? options[0]?.key) ? { [(prefill.optionKey ?? options[0]?.key) as string]: prefill.amount } : {},
  );
  const rawAmount = option ? (amountText[option.key] ?? bounds?.default ?? "") : "";
  const amountCheck = option && bounds ? checkAmount(rawAmount, bounds, option.decimals, option.symbol) : null;
  const state = linkState(view);
  const choice: FundingChoice | null =
    state.usable && option && (!bounds || amountCheck?.ok)
      ? { network: option.network, asset: option.symbol, ...(bounds && amountCheck?.ok ? { amount: amountCheck.value } : {}) }
      : null;
  const { quote, results, retry } = useLinkQuote(view.id, choice);
  const arrivals = useMemo(() => {
    const out: Record<string, number | undefined> = {};
    for (const candidate of options) {
      const entry = Object.entries(results).find(([key, value]) => key.startsWith(`${candidate.key}:`) && value.status === "ok");
      const preview = entry && entry[1].status === "ok" ? entry[1].response.preview : null;
      if (preview?.arrival) out[candidate.key] = preview.arrival.seconds;
    }
    return out;
  }, [options, results]);

  const contracts = view.destination.actions.filter((action) => action.contract);
  const needsAcknowledgement = !view.publisher.domainVerified || contracts.some((action) => !action.contract?.domainVerified || !verifiedSource(action.contract?.source));
  const [acknowledged, setAcknowledged] = useState(false);
  const [signing, setSigning] = useState(false);
  const quoted = quote.status === "ok" ? quote.response : null;
  const needed = quoted ? namespacesFor(quoted.intent) : [];
  const integrationOnly = isCustomContractExecution(view.destination) || isCustomContractExecution(quoted?.intent);
  const canContinue = Boolean(!integrationOnly && choice && quoted && needed.length > 0 && (!needsAcknowledgement || acknowledged));

  useEffect(() => {
    window.document.title = `${view.title} · ${view.publisher.name} | Kletia link`;
  }, [view.publisher.name, view.title]);

  const pageUrl = `${window.location.origin}/go/${view.id}`;
  const website = httpsOnly(view.publisher.website);
  const usesMax = view.uses.max;
  const uses = usesMax !== null && view.uses.left !== null ? { used: Math.max(0, usesMax - view.uses.left), max: usesMax } : undefined;
  const destinationName = lineFor(view.destination.network)?.name ?? view.destination.network;

  return (
    <>
      <div className={PAPER} style={{ "--kla-table": "var(--kla-paper)" } as React.CSSProperties}>
        <div className={cx(CONTAINER, "grid gap-10 py-10 sm:py-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start")}>
          <div className="min-w-0">
            <PlatformNumber n={1}>Intent link</PlatformNumber>
            <h1 className="mt-5 text-balance font-display text-[clamp(2rem,4.6vw,3.3rem)] font-bold leading-[1.04] tracking-[-0.035em] [overflow-wrap:anywhere]">
              {view.title}
            </h1>
            {view.description ? <p className={cx("mt-4 max-w-2xl text-base leading-relaxed sm:text-lg [overflow-wrap:anywhere]", TEXT_MUTED)}>{view.description}</p> : null}
            <p className="mt-5 text-sm font-semibold leading-relaxed">
              Published by <span className="font-bold">{view.publisher.name}</span>
              {view.publisher.domain ? (
                <>
                  {" "}
                  ·{" "}
                  {website ? (
                    <a className="underline decoration-2 underline-offset-2" href={website} target="_blank" rel="noopener noreferrer">
                      {view.publisher.domain}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    view.publisher.domain
                  )}
                </>
              ) : null}{" "}
              ·{" "}
              {view.publisher.domainVerified ? (
                <span>{view.publisher.domain} published a file that authorizes this link. That says nothing about its honesty.</span>
              ) : (
                <span className="bg-[#FFD60A] px-1 text-[#1A1A1A]">Unverified publisher: nobody confirmed this link comes from that website.</span>
              )}
            </p>
            {!state.usable ? (
              <div className={cx("mt-6 flex flex-wrap items-center gap-5 bg-[#FFFCF2] p-4 text-[#1A1A1A]", INK_BORDER, HARD_SHADOW)} role="status">
                <div className="w-[170px] shrink-0">
                  {state.tone === "held" ? <Stamp state="held" detail={state.stamp} animate className="kl-link-stamp" /> : <VoidStamp detail={state.stamp} animate className="kl-link-stamp" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-display text-xl font-bold">{state.title}</p>
                  <p className="mt-1 text-sm leading-relaxed">{state.detail}</p>
                </div>
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            <LinkTicket
              serial={linkSerial(view.id)}
              intent={linkSentence(view)}
              publisher={{ name: view.publisher.name, ...(view.publisher.domain ? { domain: view.publisher.domain } : {}), verified: view.publisher.domainVerified }}
              bounds={boundRows(view)}
              networks={ticketNetworks(view).map((network) => lineFor(network)).filter((line): line is NonNullable<typeof line> => line !== null)}
              url={pageUrl.replace(/^https?:\/\//u, "")}
              expires={formatDate(view.expiresAt)}
              {...(uses ? { uses } : {})}
              note="This link fixes where the money goes. You choose where it starts, review the plan and sign it in your own wallet."
            />
          </div>
        </div>
      </div>

      <section aria-labelledby="kl-link-start" className="py-12 sm:py-16">
        <div className={CONTAINER}>
          <SectionHead
            n={2}
            id="kl-link-start"
            eyebrow="Choose where you start"
            title="Where does your money start?"
            intro={`It arrives on ${destinationName}. Kletia plans the route, through the bridge auction when it starts on another network.`}
          />
          {prefill.ignored.length > 0 ? (
            <ul className={cx("mb-5 max-w-3xl list-disc bg-[#FFF3B0] py-3 pl-8 pr-4 text-sm font-semibold text-[#1A1A1A]", INK_BORDER)}>
              {prefill.ignored.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              <DepartureChooser
                options={options}
                value={optionKey}
                onChange={setOptionKey}
                disabled={!state.usable || signing}
                arrivals={arrivals}
                quotingKey={quote.status === "loading" && option ? option.key : null}
                destination={destinationName}
              />
              {option && bounds ? (
                <div className={cx("flex flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
                  <label htmlFor={amountId} className={LABEL}>
                    Amount in {option.symbol}
                  </label>
                  <input
                    id={amountId}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    value={rawAmount}
                    disabled={!state.usable || signing}
                    aria-invalid={amountCheck && !amountCheck.ok ? true : undefined}
                    aria-describedby={amountHelpId}
                    onChange={(event) => setAmountText((current) => ({ ...current, [option.key]: event.target.value }))}
                    className={cx("min-h-12 w-full bg-white px-3 font-code text-lg font-bold text-[#1A1A1A] dark:bg-[#0F1A2C] dark:text-white", INK_BORDER)}
                  />
                  <p id={amountHelpId} className={cx("text-sm", amountCheck && !amountCheck.ok ? "font-semibold text-[#B91C1C] dark:text-[#FCA5A5]" : TEXT_MUTED)}>
                    {amountCheck && !amountCheck.ok ? amountCheck.message : `The publisher allows ${bounds.min} to ${bounds.max} ${option.symbol}.`}
                  </p>
                </div>
              ) : option ? (
                <div className={cx("flex flex-col gap-1 bg-[#FFD60A] p-4 text-[#1A1A1A]", INK_BORDER)}>
                  <p className={LABEL}>Fixed amount</p>
                  <p className="font-display text-xl font-bold">{view.destination.actions[0]?.label ?? "A fixed amount"}</p>
                  <p className="text-sm font-semibold">Kletia sizes what you send from {option.networkName} so the payee receives at least this amount.</p>
                </div>
              ) : null}
            </div>

            <div className="min-w-0" aria-live="polite" aria-busy={quote.status === "loading" || undefined}>
              {!state.usable ? (
                <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)}>No fare: this link cannot start a new intent right now.</p>
              ) : quote.status === "ok" ? (
                <div className="flex flex-col gap-3">
                  <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
                    Indicative fare for a stand-in account. Kletia quotes again with your own wallet, and asks you to approve the fare before anything is
                    signed.
                  </p>
                  <FareTable preview={indicativeFare(quote.response.preview)} intent={quote.response.intent} />
                </div>
              ) : quote.status === "error" ? (
                <ApiErrorPanel error={quote.error} title="No fare for this choice" onRetry={retry} />
              ) : quote.status === "loading" ? (
                <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)} role="status">
                  Asking the bridge auction for a fare from {option?.networkName}…
                </p>
              ) : (
                <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)}>Choose where you start{bounds ? " and an amount" : ""} to see the fare.</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="kl-link-fixed" className="border-t-[3px] border-[#1A1A1A] bg-[#EDE9DF] py-12 sm:py-16 dark:border-[#4B5563] dark:bg-[#0E1729]">
        <div className={CONTAINER}>
          <SectionHead n={3} id="kl-link-fixed" eyebrow="Fixed by the publisher" title="Where the money goes" />
          <div className="max-w-3xl">
            <FixedByPublisher view={view} needsAcknowledgement={needsAcknowledgement} acknowledged={acknowledged} onAcknowledge={setAcknowledged} disabled={signing} />
          </div>
        </div>
      </section>

      <section aria-labelledby="kl-link-sign" className="border-t-[3px] border-[#1A1A1A] py-12 sm:py-16 dark:border-[#4B5563]">
        <div className={CONTAINER}>
          <SectionHead
            n={4}
            id="kl-link-sign"
            eyebrow="Sign in your wallet"
            title="Review the plan, then sign"
            intro={integrationOnly ? CUSTOM_CONTRACT_EXECUTION_MESSAGE : "Kletia plans with your own account, shows the fare again, and your wallet asks for every signature. Kletia never holds keys or funds."}
          />
          {signing && option && !integrationOnly ? (
            <LazyBoundary
              resetKey={option.key}
              fallback={(reload) => (
                <div className={cx("flex flex-col items-start gap-3 p-4", INK_BORDER, SURFACE)} role="alert">
                  <p className="font-semibold">The wallet panel could not load.</p>
                  <Button size="sm" variant="secondary" onClick={reload}>
                    Reload
                  </Button>
                </div>
              )}
            >
              <React.Suspense
                fallback={
                  <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)} role="status">
                    Loading the wallet panel…
                  </p>
                }
              >
                <LinkSignPanel
                  linkId={view.id}
                  view={view}
                  option={option}
                  amount={choice?.amount ?? null}
                  needed={needed}
                  quoted={quoted?.intent ?? null}
                  onClose={() => setSigning(false)}
                />
              </React.Suspense>
            </LazyBoundary>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <Button
                size="lg"
                disabled={!canContinue}
                onClick={() => setSigning(true)}
                onMouseEnter={() => void loadSignPanel().catch(() => undefined)}
                onFocus={() => void loadSignPanel().catch(() => undefined)}
              >
                <PenLine className="h-4 w-4" aria-hidden="true" />
                Continue with my wallet
              </Button>
              {!canContinue ? (
                <p className={cx("text-sm", TEXT_MUTED)}>
                  {integrationOnly
                    ? "This link calls a custom contract. Continue through the publisher's own project integration."
                    : !state.usable
                    ? "This link cannot start a new intent right now."
                    : !quoted
                      ? "A fare for your choice comes first."
                      : needsAcknowledgement && !acknowledged
                        ? "Tick the acknowledgement under “Where the money goes” first."
                        : "Nothing to sign for this choice."}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section aria-label="Small print" className="border-t-[3px] border-[#1A1A1A] py-10 dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]")}>
          <ul className={cx("list-disc space-y-2 pl-5 text-sm leading-relaxed", TEXT_MUTED)}>
            {view.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
            <li>Kletia stores day-level counts for this link: no addresses, IP addresses or browser details.</li>
          </ul>
          <ReportForm linkId={view.id} />
        </div>
      </section>
    </>
  );
}

/** `/go/<linkId>`: an intent link landing page (the static host rewrites it to the API shell with this link's preview tags). */
export default function LinkPage() {
  const { location } = useRoute();
  const linkId = LINK_PATH_PATTERN.exec(location.pathname)?.[1] ?? "";
  const { state, reload } = useLinkView(linkId);
  if (state.phase === "loading") {
    return (
      // Keyed: the loaded page mounts new nodes instead of reusing (and moving) this one, a layout shift with reduced motion.
      <div key="loading" className={cx(CONTAINER, "flex min-h-[50vh] items-center justify-center py-16")} role="status">
        <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
          Reading the link
        </span>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className={cx(CONTAINER, "py-16")}>
        <h1 className="mb-6 font-display text-3xl font-bold">The link did not load</h1>
        <ApiErrorPanel error={state.error} title="Kletia could not be reached" onRetry={reload} />
      </div>
    );
  }
  if (state.load.kind === "missing") {
    return <Gone title="This link does not exist." body="Check that you copied the whole address. Links are never listed anywhere, so only the publisher can send you a working one." />;
  }
  if (state.load.kind === "gone") {
    return <Gone title="This link is no longer available." body={`${state.load.message} Ask the publisher for a new link.`} />;
  }
  return <LinkLanding key={state.load.view.id} view={state.load.view} />;
}
