import "../../site/art/base.css";
import "./receipt.css";

import { DEFAULT_REVERIFY_RPCS, displayRpcUrl, reverifyReceipt, type ReverifyReport } from "@kletia/sdk/receipts";
import { Download, EyeOff, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useRoute } from "../../routes/useRoute";
import { formatBoardClock } from "../../site/art/boardFormat";
import { EndOfLine } from "../../site/art/EndOfLine";
import { PlatformNumber } from "../../site/art/Ornaments";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../site/ui/Button";
import { CopyButton } from "../../site/ui/CopyButton";
import { CONTAINER, cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { plannedRows, reportRows, summarize, type RecheckRow } from "./recheck";
import { RecheckBoard } from "./RecheckBoard";
import { parseReceiptFragment, receiptIdFromPath, receiptPageUrl, REVERIFY_COMMAND, reverifyCommandFor } from "./receiptLink";
import { formatDay, offlineVerdict, receiptModel, stampDay } from "./receiptModel";
import { ReceiptTicket } from "./ReceiptTicket";
import { useReceipt, type LoadedReceipt } from "./useReceipt";

type Recheck =
  | { readonly phase: "idle" }
  | { readonly phase: "running" }
  | { readonly phase: "done"; readonly report: ReverifyReport; readonly at: Date }
  | { readonly phase: "error"; readonly message: string };

const PAPER = "kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Saves the receipt as the reader sees it (signed payload plus the details this link opened). */
function downloadReceipt(loaded: LoadedReceipt) {
  const { document } = loaded;
  const blob = new Blob([`${JSON.stringify({ receipt: document }, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `kletia-receipt-${document.payload.receiptId}-${document.payload.sequence}.json`;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function Missing() {
  return (
    <div className={PAPER}>
      <div className={cx(CONTAINER, "grid min-h-[60vh] items-center gap-10 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}>
        <div className="min-w-0">
          <p className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#0047E0] dark:text-[#7EA6FF]">Receipt · no service</p>
          <h1 className="mt-4 text-balance font-display text-[clamp(2.2rem,5.6vw,3.8rem)] font-bold leading-[1.02] tracking-[-0.04em]">
            This receipt is not shared any more.
          </h1>
          <p className={cx("mt-6 max-w-xl text-lg leading-relaxed", TEXT_MUTED)}>
            Its owner revoked the link or let it expire, or the address is incomplete. Kletia answers the same way for receipts that were never
            shared, so this page cannot tell which. Ask the owner for a new link.
          </p>
          <nav aria-label="Open platforms" className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/" size="lg">
              Home
            </ButtonLink>
            <ButtonLink to="/developers" variant="secondary" size="lg">
              How receipts work
            </ButtonLink>
          </nav>
        </div>
        <div className="min-w-0">
          <EndOfLine platform="R" />
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className={cx(CONTAINER, "flex min-h-[50vh] items-center justify-center py-16")} role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        Checking the receipt
      </span>
    </div>
  );
}

function ReceiptView({ loaded, hasKeyInUrl, onReload }: { readonly loaded: LoadedReceipt; readonly hasKeyInUrl: boolean; readonly onReload: () => void }) {
  const { document, verification, share, status, provenance } = loaded;
  const model = useMemo(() => receiptModel(document), [document]);
  const verdict = useMemo(() => offlineVerdict(verification), [verification]);
  const [recheck, setRecheck] = useState<Recheck>({ phase: "idle" });
  const [keyInUrl, setKeyInUrl] = useState(hasKeyInUrl);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const evidenceShown = model.legs.some((leg) => leg.evidence !== null && leg.evidence.anchors.length > 0);
  const canRecheck = verdict.kind === "verified" && evidenceShown;
  const display = useCallback((url: string) => displayRpcUrl(url), []);
  const rows: readonly RecheckRow[] = useMemo(() => {
    if (recheck.phase === "done") return reportRows(document, model.legs, recheck.report);
    return plannedRows(document, model.legs, DEFAULT_REVERIFY_RPCS, display, recheck.phase === "running" ? "checking" : "ready");
  }, [display, document, model.legs, recheck]);
  const summary = recheck.phase === "done" ? summarize(recheck.report, model.legs) : null;
  const rechecked = summary && summary.verdict === "verified" ? { day: stampDay(todayUtc()), sources: summary.agreeingSources } : null;

  const runRecheck = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRecheck({ phase: "running" });
    try {
      const report = await reverifyReceipt(document, { keys: loaded.keys, signal: controller.signal });
      if (!controller.signal.aborted) setRecheck({ phase: "done", report, at: new Date() });
    } catch (error) {
      if (!controller.signal.aborted) setRecheck({ phase: "error", message: error instanceof Error ? error.message.slice(0, 200) : "The recheck failed." });
    }
  };

  const removeKey = () => {
    try {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setKeyInUrl(false);
    } catch {
      // Leave the address as it is.
    }
  };

  const pageUrl = receiptPageUrl(window.location.origin, model.receiptId);
  const announcement = verdict.kind === "verified" ? "Receipt verified in this browser." : `Receipt void. ${verdict.sentence}`;

  return (
    <>
      <div className={PAPER}>
        <div className={cx(CONTAINER, "py-10 sm:py-14")}>
          <PlatformNumber n={1}>Verifiable receipt</PlatformNumber>
          <h1 className="mt-5 max-w-4xl text-balance font-display text-[clamp(2rem,4.6vw,3.4rem)] font-bold leading-[1.04] tracking-[-0.035em]">
            {verdict.kind === "verified" ? "Kletia signed this receipt." : "This receipt does not check out."}
          </h1>
          <p className={cx("mt-4 max-w-2xl text-base leading-relaxed sm:text-lg", TEXT_MUTED)}>
            {verdict.kind === "verified"
              ? "You can check it without trusting us: the signature was verified here, in your browser, and the transactions can be read again from public nodes."
              : verdict.sentence}
          </p>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          {status?.supersededBy ? (
            <p className={cx("mt-5 max-w-2xl bg-[#FFF3B0] p-3 text-sm font-semibold text-[#1A1A1A]", INK_BORDER)}>
              A newer issue of this receipt exists. Ask the owner for its link: this one may describe an earlier state of the intent.
            </p>
          ) : null}
          <div className="mt-8" style={{ "--kla-table": "var(--kla-paper)" } as CSSProperties}>
            <ReceiptTicket model={model} verdict={verdict} share={share} supersededBy={status?.supersededBy ?? null} rechecked={rechecked} animate />
          </div>
          {verdict.kind === "void" ? (
            <div className={cx("mt-8 max-w-3xl bg-[#FFE4E4] p-4 text-[#1A1A1A] dark:bg-[#2A1215] dark:text-[#FEE2E2]", INK_BORDER, HARD_SHADOW)}>
              <p className="font-display text-lg font-bold">What did not check out</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm font-semibold">
                {verdict.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="kl-rcpt-check" className="py-12 sm:py-16">
        <div className={cx(CONTAINER, "grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]")}>
          <div className="kl-rcpt-blueprint min-w-0 p-5 sm:p-6">
            <p className="font-code text-[10px] font-bold uppercase tracking-[0.2em] text-[#FFD60A]">Drawing KL-RCPT · check it yourself</p>
            <h2 id="kl-rcpt-check" className="mt-2 font-display text-2xl font-bold tracking-[-0.02em] text-white">
              Check it yourself
            </h2>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt>Digest (SHA-256 of the signed payload)</dt>
                <dd>{document.digest}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt>Key</dt>
                <dd>
                  {document.signature.kid}{" "}
                  <span className="text-[#FFD60A]">
                    {provenance === "pinned"
                      ? "(pinned in @kletia/core)"
                      : provenance === "two-origins"
                        ? "(listed by api and by this site)"
                        : "(not confirmed)"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Signed</dt>
                <dd>{formatDay(document.payload.issuedOn)}</dd>
              </div>
              <div>
                <dt>Transparency log</dt>
                <dd>
                  {model.inclusion
                    ? `Batch ${model.inclusion.batch}${model.inclusion.anchored ? ", anchored on Base" : ", not anchored yet"}`
                    : "Not in a closed batch yet"}
                </dd>
              </div>
            </dl>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => void runRecheck()} disabled={!canRecheck || recheck.phase === "running"} variant="accent">
                <RefreshCw className={cx("h-4 w-4", recheck.phase === "running" && "motion-safe:animate-spin")} aria-hidden="true" />
                {recheck.phase === "running" ? "Checking public nodes" : recheck.phase === "done" ? "Re-check again" : "Re-check on-chain now"}
              </Button>
              <Button variant="secondary" onClick={() => downloadReceipt(loaded)}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Save receipt file
              </Button>
            </div>
            {!canRecheck ? (
              <p className="mt-3 text-sm text-[#DCE6FA]">
                {verdict.kind !== "verified"
                  ? "A receipt that does not verify is not re-checked."
                  : "The owner sealed the transactions, so there is nothing to re-check from this link."}
              </p>
            ) : null}
            <div className="mt-6 border-t border-white/25 pt-5">
              <p className="font-code text-[10px] font-bold uppercase tracking-[0.2em] text-[#B9CDF6]">Or from a terminal</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <code className="min-w-0 flex-1 bg-[#082a66] px-3 py-2 text-white">{REVERIFY_COMMAND}</code>
                <CopyButton
                  text={reverifyCommandFor(keyInUrl ? window.location.href : pageUrl)}
                  label="Copy the command with this page's link"
                  notify="inline"
                />
              </div>
              <p className="mt-2 text-xs text-[#DCE6FA]">The copied command includes this page's link{keyInUrl ? ", with its key" : ""}.</p>
            </div>
          </div>

          <div className={cx("min-w-0 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
            <p className={cx(LABEL, "flex items-center gap-2 text-[#0047E0] dark:text-[#7EA6FF]")}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Privacy
            </p>
            <ul className={cx("mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed", TEXT_MUTED)}>
              <li>
                The key after <span className="font-code">#</span> in a share link is used only here, in your browser, to open what the owner shared.
                Browsers never send that part of a link to any server, and this page never does either.
              </li>
              <li>Anyone with the full link can read what it shows. The owner can revoke it at any time; copies already saved cannot be recalled.</li>
              <li>
                Re-checking asks public nodes ({[...new Set(rows.map((row) => row.source.replace(/^https?:\/\//u, "")))].slice(0, 3).join(", ") || "none for this link"}) about these
                transactions. Those nodes see your IP address and the transaction hashes, nothing else.
              </li>
              <li>Kletia never shows the intent id in a receipt: it is a capability, and only its hash is signed.</li>
            </ul>
            {keyInUrl ? (
              <Button variant="secondary" size="sm" className="mt-5" onClick={removeKey}>
                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                Remove the key from the address bar
              </Button>
            ) : hasKeyInUrl ? (
              <p className={cx("mt-5 text-sm font-semibold")} role="status">
                The key is no longer in the address bar. Reloading shows only the signed part.
              </p>
            ) : null}
            {share.kind === "unavailable" ? (
              <ApiErrorPanel className="mt-5" error={share.error} title="The shared details did not load" onRetry={onReload} />
            ) : null}
            {loaded.keyNotes.length > 0 && provenance === "none" ? (
              <p className={cx("mt-5 text-xs", TEXT_MUTED)}>{loaded.keyNotes.join(" ")}</p>
            ) : null}
          </div>
        </div>

        <div className={cx(CONTAINER, "mt-10")}>
          {rows.length > 0 ? (
            <RecheckBoard
              rows={rows}
              clock={recheck.phase === "done" ? formatBoardClock(recheck.at) : "--:-- UTC"}
              busy={recheck.phase === "running"}
              started={recheck.phase !== "idle"}
            />
          ) : null}
          <div className="mt-4 max-w-3xl" aria-live="polite">
            {summary ? (
              <div className={cx("p-4", INK_BORDER, SURFACE)}>
                <p className="font-display text-lg font-bold">{summary.headline}</p>
                {summary.lines.length > 0 ? (
                  <ul className={cx("mt-2 list-disc space-y-1 pl-5 text-sm", TEXT_MUTED)}>
                    {summary.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : recheck.phase === "error" ? (
              <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)}>The recheck stopped: {recheck.message}</p>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

/** `/r/<receiptId>#s=<shareId>&k=<key>`: a shared receipt, verified in the browser. */
export default function ReceiptPage() {
  const { location } = useRoute();
  const receiptId = receiptIdFromPath(location.pathname) ?? "";
  const fragment = useMemo(() => parseReceiptFragment(location.hash), [location.hash]);
  const { state, reload } = useReceipt(receiptId, fragment);

  useEffect(() => {
    if (state.phase === "ready") window.document.title = `Receipt ${state.receipt.document.payload.receiptId.slice(5, 13).toUpperCase()}: Kletia`;
  }, [state]);

  if (state.phase === "loading") return <Loading />;
  if (state.phase === "missing") return <Missing />;
  if (state.phase === "error") {
    return (
      <div className={cx(CONTAINER, "py-16")}>
        <h1 className="mb-6 font-display text-3xl font-bold">The receipt did not load</h1>
        <ApiErrorPanel error={state.error} title="Kletia could not be reached" onRetry={reload} />
      </div>
    );
  }
  return <ReceiptView key={`${receiptId}:${fragment.kind}`} loaded={state.receipt} hasKeyInUrl={fragment.kind === "share"} onReload={reload} />;
}
