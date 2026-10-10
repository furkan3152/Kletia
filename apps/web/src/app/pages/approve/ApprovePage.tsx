import "../../site/art/base.css";
import "../../site/art/ticket.css";
import "./approve.css";

import type { PolicyApprovalView } from "@kletia/sdk";
import { PenLine, ShieldCheck, ShieldAlert } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { useRoute } from "../../routes/useRoute";
import { EndOfLine } from "../../site/art/EndOfLine";
import { LineBullet } from "../../site/art/LineBullet";
import { PlatformNumber } from "../../site/art/Ornaments";
import { Stamp } from "../../site/art/Stamp";
import { TicketFields, TicketHead, TicketShell } from "../../site/art/TicketShell";
import { lineFor } from "../../site/art/tokens";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { VoidStamp } from "../receipt/receiptStamps";
import {
  approvalSerial,
  approvalState,
  digestGroups,
  formatStamp,
  formatUsd,
  legLine,
  networkName,
  parseApprovalFragment,
  timeLeft,
  triggerWords,
  walletFamily,
  type ApprovalStateView,
} from "./approveModel";
import { ApprovedStamp, RejectedStamp } from "./approveStamps";
import { useApproval, type DigestCheck } from "./useApproval";

const loadDesk = () => import("./ApproveSignPanel");
const ApproveSignPanel = React.lazy(loadDesk);

const PAPER = "kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]";

function NoService({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className={PAPER}>
      <div className={cx(CONTAINER, "grid min-h-[60vh] items-center gap-10 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}>
        <div className="min-w-0">
          <p className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#0047E0] dark:text-[#7EA6FF]">Approval gate · no service</p>
          <h1 className="mt-4 text-balance font-display text-[clamp(2.2rem,5.6vw,3.8rem)] font-bold leading-[1.02] tracking-[-0.04em]">{title}</h1>
          <p className={cx("mt-6 max-w-xl text-lg leading-relaxed", TEXT_MUTED)}>{body}</p>
          <nav aria-label="Open platforms" className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/" size="lg">
              Home
            </ButtonLink>
            <ButtonLink to="/developers" variant="secondary" size="lg">
              How the Rule Book works
            </ButtonLink>
          </nav>
        </div>
        <div className="min-w-0">
          <EndOfLine platform="AP" />
        </div>
      </div>
    </div>
  );
}

function NetworkMark({ network }: { readonly network: string }) {
  const line = lineFor(network);
  return line ? <LineBullet line={line} /> : <span>{networkName(network)}</span>;
}

function GateStamp({ state }: { readonly state: ApprovalStateView }) {
  switch (state.status) {
    case "approved":
      return <ApprovedStamp animate className="kla-ticket__stamp" />;
    case "rejected":
      return <RejectedStamp animate className="kla-ticket__stamp" />;
    case "expired":
      return <VoidStamp detail="APPROVAL EXPIRED" animate className="kla-ticket__stamp" />;
    default:
      return <Stamp state="held" detail="AWAITING APPROVAL" animate className="kla-ticket__stamp" />;
  }
}

/** The intent held at the gate, printed as a ticket: legs, full recipients, value, ceiling, why, digest. */
function GateTicket({ view, state }: { readonly view: PolicyApprovalView; readonly state: ApprovalStateView }) {
  const legs = view.steps.map(legLine);
  const ceiling = formatUsd(view.ceilingUsd);
  return (
    <TicketShell
      label={`Approval ${approvalSerial(view.id)}`}
      kind="intent"
      state={state.status}
      className="kl-gate"
      main={
        <>
          <TicketHead icon="shield" title="Kletia approval" serial={approvalSerial(view.id)} />
          <div>
            <p className="kla-ticket__eyebrow">Held for a second look</p>
            <p className="kl-gate__title">{view.title ? `“${view.title}”` : "An intent planned by an API key"}</p>
          </div>
          <div>
            <p className="kla-ticket__eyebrow">Legs</p>
            <ol className="kl-gate__legs">
              {legs.map((leg, index) => (
                <li key={view.steps[index]?.id ?? index} className="kl-gate__leg">
                  <span className="kl-gate__leg-no" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="kl-gate__leg-what">
                    <span className="kla-sr">Leg {index + 1}: </span>
                    <NetworkMark network={leg.from} />
                    {leg.to ? (
                      <>
                        <span aria-hidden="true">→</span>
                        <span className="kla-sr">to</span>
                        <NetworkMark network={leg.to} />
                      </>
                    ) : null}
                    <strong>{leg.verb}</strong>
                    {leg.amounts ? <span>{leg.amounts}</span> : null}
                    <span>via {leg.via}</span>
                  </span>
                  <span className="kl-gate__leg-to">
                    <span className="kl-gate__k">Money goes to</span>
                    {leg.recipientName ? <strong className="[overflow-wrap:anywhere]">{leg.recipientName}</strong> : null}
                    <span className="kl-gate__mono">{leg.recipient}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <dl className="kl-gate__money">
            <div>
              <dt className="kl-gate__k">Value when held</dt>
              <dd>{formatUsd(view.notionalUsd) ?? "Not priced"}</dd>
            </div>
            <div>
              <dt className="kl-gate__k">Approve up to</dt>
              <dd>{ceiling}</dd>
            </div>
          </dl>
          <div>
            <p className="kla-ticket__eyebrow">Why the rule book held it</p>
            <ul className="kl-gate__triggers">
              {view.triggers.length > 0 ? view.triggers.map((trigger) => <li key={trigger}>{triggerWords(trigger)}</li>) : <li>A rule asked for a second look.</li>}
            </ul>
          </div>
          <TicketFields
            fields={[
              { label: "Requested by", value: <span className="kl-gate__mono">{view.keyId}</span> },
              { label: "Asked", value: formatStamp(view.createdAt) },
              { label: state.status === "pending" ? "Expires" : "Expiry", value: formatStamp(view.expiresAt) },
            ]}
          />
          <div>
            <p className="kla-ticket__eyebrow">Digest of the steps</p>
            <p className="kl-gate__digest">
              {digestGroups(view.digest).map((group) => (
                <span key={group}>{group}</span>
              ))}
            </p>
          </div>
        </>
      }
      stub={
        <>
          <p className="kla-ticket__stub-k">Up to</p>
          <p className="kl-gate__stub-n">{ceiling}</p>
          <p className="kl-gate__stub-sub">{state.status === "pending" ? `Decide ${timeLeft(view.expiresAt)}` : state.title}</p>
          <p className="kla-sr">Decision: {state.title}.</p>
          <GateStamp state={state} />
        </>
      }
    />
  );
}

function DigestNote({ check }: { readonly check: DigestCheck }) {
  if (check === "match") {
    return (
      <p className={cx("flex items-start gap-2 bg-[#E3F5EA] p-3 text-sm font-semibold text-[#0B3D24]", INK_BORDER)}>
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Checked in this browser: the digest above is the digest of the intent's steps, as printed.
      </p>
    );
  }
  if (check === "mismatch") {
    return (
      <p className={cx("flex items-start gap-2 bg-[#FFE4E4] p-3 text-sm font-semibold text-[#7F1D1D]", INK_BORDER)} role="alert">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        The digest does not match the intent it names. Do not approve; this page will not ask your wallet to sign it.
      </p>
    );
  }
  return (
    <p className={cx("flex items-start gap-2 bg-[#FFF3B0] p-3 text-sm font-semibold text-[#1A1A1A]", INK_BORDER)}>
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      The intent could not be read, so the digest was not checked here. Your wallet would sign the digest printed above.
    </p>
  );
}

function WhoDecides({ view }: { readonly view: PolicyApprovalView }) {
  const wallets = view.approvers.wallets;
  const keysAllowed = !view.approvers.requireWallet;
  return (
    <div className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE)}>
      <p className={LABEL}>Who can decide</p>
      {wallets.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {wallets.map((wallet) => (
            <li key={wallet} className="flex flex-wrap items-center gap-2 text-sm font-bold">
              <span className="font-code">{wallet}</span>
              <span className={cx("text-xs font-semibold", TEXT_MUTED)}>{walletFamily(wallet) === "evm" ? "EVM wallet, signs typed data (EIP-712)" : "Solana wallet, signs a text message"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-semibold">The rule book lists no approver wallets.</p>
      )}
      <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
        {keysAllowed
          ? `${view.approvers.keys > 0 ? `One of the ${view.approvers.keys} approver keys the rule book lists` : "A project key of the project (not the key that asked)"} can also decide, in the developer portal or with `
          : "The rule book requires a wallet signature: API keys cannot decide this one."}
        {keysAllowed ? <span className="font-code text-[13px]">kletia approvals approve {view.id} --yes</span> : null}
        {keysAllowed ? "." : null}
      </p>
    </div>
  );
}

function Gate({ id }: { readonly id: string }) {
  const { state, reload, settle } = useApproval(id);
  const [deciding, setDeciding] = useState(false);
  const [justDecided, setJustDecided] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const decided = useCallback(
    (next: PolicyApprovalView) => {
      settle(next);
      setDeciding(false);
      setJustDecided(true);
    },
    [settle],
  );

  // After a decision signed here, the desk is gone: bring the ticket (and its new stamp) into view and move focus to the heading.
  useEffect(() => {
    if (!justDecided) return;
    const heading = headingRef.current;
    heading?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    heading?.focus({ preventScroll: true });
  }, [justDecided]);
  const [now, setNow] = useState(() => Date.now());

  // The expiry line counts down once a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const view = state.phase === "ready" ? state.view : null;
  const gate = useMemo(() => (view ? approvalState(view, now) : null), [view, now]);

  useEffect(() => {
    if (gate) window.document.title = `${gate.status === "pending" ? "Approval requested" : `Approval ${gate.title.toLowerCase()}`}: Kletia Rule Book`;
  }, [gate]);

  if (state.phase === "loading") {
    return (
      // Keyed: the loaded page mounts new nodes instead of reusing (and moving) this one, a layout shift with reduced motion.
      <div key="loading" className={cx(CONTAINER, "flex min-h-[50vh] items-center justify-center py-16")} role="status">
        <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
          Reading the approval
        </span>
      </div>
    );
  }
  if (state.phase === "missing") {
    return (
      <NoService
        title="This approval does not exist."
        body="Check that you copied the whole link, including everything after #. Approval links are never listed anywhere; ask whoever sent it for a new one."
      />
    );
  }
  if (state.phase === "error") {
    return (
      <div className={cx(CONTAINER, "py-16")}>
        <h1 className="mb-6 font-display text-3xl font-bold">The approval did not load</h1>
        <ApiErrorPanel error={state.error} title="Kletia could not be reached" onRetry={reload} />
      </div>
    );
  }
  if (!view || !gate) return null;

  const canSign = gate.open && view.approvers.wallets.length > 0 && state.digest !== "mismatch";
  const heading =
    gate.status === "pending"
      ? "A rule book is holding this intent for a second look."
      : gate.status === "approved"
        ? "Approved at the gate."
        : gate.status === "rejected"
          ? "Rejected at the gate."
          : "This approval expired.";

  return (
    <>
      <div className={PAPER}>
        <div className={cx(CONTAINER, "grid gap-10 py-10 sm:py-14 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start")}>
          <div className="min-w-0">
            <PlatformNumber n={1}>Approval gate</PlatformNumber>
            <h1 ref={headingRef} tabIndex={-1} className="mt-5 scroll-mt-24 text-balance font-display text-[clamp(2rem,4.4vw,3.2rem)] font-bold leading-[1.05] tracking-[-0.035em] focus:outline-none">
              {heading}
            </h1>
            <p className={cx("mt-4 max-w-xl text-base leading-relaxed sm:text-lg", TEXT_MUTED)}>{gate.detail}</p>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              Decision: {gate.title}.
            </p>
            <ul className={cx("mt-6 max-w-xl list-disc space-y-2 pl-5 text-sm leading-relaxed", TEXT_MUTED)}>
              <li>Reading this page approves nothing. Only a listed wallet's signature, or an approver key, decides.</li>
              <li>An approval covers this intent's steps and value up to the ceiling. Kletia quotes again before anything is signed, and every other rule still applies.</li>
              <li>Signing is not a transaction: no gas, no funds move. Your wallet signs the decision, the digest, the ceiling and an expiry.</li>
            </ul>
          </div>
          <div className="min-w-0" style={{ "--kla-table": "var(--kla-paper)" } as CSSProperties}>
            <GateTicket view={view} state={gate} />
            <div className="mt-6">
              <DigestNote check={state.digest} />
            </div>
          </div>
        </div>
      </div>

      <section aria-labelledby="kl-gate-decide" className="py-12 sm:py-16">
        <div className={cx(CONTAINER, "grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]")}>
          <div className="min-w-0">
            <PlatformNumber n={2}>Decide</PlatformNumber>
            <h2 id="kl-gate-decide" className="mt-4 font-display text-[1.75rem] font-bold leading-[1.1] tracking-[-0.025em] sm:text-[2.1rem]">
              {gate.open ? "Approve or reject with the named wallet" : "A decision is final"}
            </h2>
            <p className={cx("mt-3 max-w-xl text-base leading-relaxed", TEXT_MUTED)}>
              {gate.open
                ? "Connect the wallet the rule book names, choose a decision and sign it. The approval is decided once; nothing can change it afterwards."
                : "Nothing on this page can be signed any more. Plan a new intent to ask again."}
            </p>
            <div className="mt-6">
              <WhoDecides view={view} />
            </div>
          </div>
          <div className="min-w-0">
            {!gate.open ? (
              <div className={cx("flex flex-col gap-2 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
                <p className="font-display text-xl font-bold">{gate.title}</p>
                <p className="text-sm leading-relaxed">{gate.detail}</p>
              </div>
            ) : !canSign ? (
              <div className={cx("flex flex-col gap-2 p-4 sm:p-5", INK_BORDER, SURFACE)}>
                <p className="font-display text-lg font-bold">Nothing to sign here</p>
                <p className="text-sm leading-relaxed">
                  {state.digest === "mismatch"
                    ? "The digest does not belong to the steps printed above, so this page will not ask a wallet to sign it."
                    : "This rule book lets only API keys decide. Use the developer portal or the CLI command on the left."}
                </p>
              </div>
            ) : deciding ? (
              <LazyBoundary
                resetKey={view.id}
                fallback={(retry) => (
                  <div className={cx("flex flex-col items-start gap-3 p-4", INK_BORDER, SURFACE)} role="alert">
                    <p className="font-semibold">The wallet panel could not load.</p>
                    <Button size="sm" variant="secondary" onClick={retry}>
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
                  <ApproveSignPanel view={view} onDecided={decided} onClose={() => setDeciding(false)} />
                </React.Suspense>
              </LazyBoundary>
            ) : (
              <div className={cx("flex flex-col items-start gap-3 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
                <p className="font-display text-lg font-bold">Ready when you are</p>
                <p className="text-sm leading-relaxed">
                  Connect the listed wallet. Nothing is signed until you choose a decision and confirm it in your wallet.
                </p>
                <Button
                  size="lg"
                  onClick={() => setDeciding(true)}
                  onMouseEnter={() => void loadDesk().catch(() => undefined)}
                  onFocus={() => void loadDesk().catch(() => undefined)}
                >
                  <PenLine className="h-4 w-4" aria-hidden="true" />
                  Decide with my wallet
                </Button>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

/** `/approve#apr_…`: the Rule Book approval gate. The id stays in the fragment, so it never reaches a server log. */
export default function ApprovePage() {
  const { location } = useRoute();
  const fragment = useMemo(() => parseApprovalFragment(location.hash), [location.hash]);
  if (fragment.kind === "none") {
    return (
      <NoService
        title="Open the full approval link."
        body="Approval links end with #apr_ and 32 characters. Kletia puts the approval id after the #, so it never reaches a server; copy the whole link from the message you received."
      />
    );
  }
  if (fragment.kind === "invalid") {
    return <NoService title="This approval link is damaged." body="The part after # is not an approval id. Copy the whole link again, including everything after #." />;
  }
  return <Gate key={fragment.id} id={fragment.id} />;
}
