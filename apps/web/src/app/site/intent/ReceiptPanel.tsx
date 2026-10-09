import { KletiaApiError, type ReceiptShare } from "@kletia/sdk";
import {
  RECEIPT_EVIDENCE_WARNING,
  RECEIPT_SHARE_PROFILES,
  receiptApplies,
  receiptShareHref,
  type ReceiptShareProfile,
} from "@kletia/widget/review";
import { Download, ExternalLink, Link2, Share2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";
import { Button } from "../ui/Button";
import { CopyButton } from "../ui/CopyButton";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";

type ReceiptState =
  | { readonly status: "checking" }
  | { readonly status: "pending"; readonly expectedBy: string | null }
  | { readonly status: "ready"; readonly receiptId: string; readonly sequence: number; readonly document: unknown }
  | { readonly status: "none" }
  | { readonly status: "error" };

const MIN_POLL_MS = 20_000;
const MAX_POLL_MS = 120_000;

const EXPIRY_OPTIONS: readonly { readonly label: string; readonly seconds: number | null }[] = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
  { label: "1 year", seconds: 31_536_000 },
  { label: "Never", seconds: null },
];

const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });
const dayFormatter = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" });

function receiptNumber(receiptId: string): string {
  const hex = receiptId.replace(/^rcpt_/u, "").toUpperCase();
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

function profileOf(groups: readonly string[]): string {
  if (groups.length === 0) return "Route only";
  const hasEvidence = groups.some((group) => group.includes("evidence"));
  const hasParties = groups.some((group) => group.includes("parties") || group === "intent.request");
  if (hasParties) return "Everything";
  if (hasEvidence) return "Proof";
  return "Route and amounts";
}

/**
 * The owner's receipt of a finished intent. Receipts are private until the
 * owner shares them, so this prints the receipt stamp, waits for finality
 * while it is pending, and offers "Share…" (what the link shows, the
 * evidence warning, the expiry), "Download receipt" and the active shares
 * with "Revoke". A share link carries its key in the fragment and is shown
 * once; it opens `/r/<receiptId>` on this site.
 */
export function ReceiptPanel({ intentId, intentStatus, className }: { readonly intentId: string; readonly intentStatus: string; readonly className?: string }) {
  const [state, setState] = useState<ReceiptState>({ status: "checking" });
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ReceiptShareProfile>("route");
  const [expiry, setExpiry] = useState(2);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [shares, setShares] = useState<readonly ReceiptShare[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const groupId = useId();
  const expiryId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadShares = useCallback(async () => {
    try {
      const list = await getKletiaClient().receipts.shares(intentId);
      if (mounted.current) setShares(list);
    } catch {
      // The list is a convenience; sharing still works.
    }
  }, [intentId]);

  const applies = receiptApplies(intentStatus);
  useEffect(() => {
    if (!applies) return undefined;
    const controller = new AbortController();
    let timer: number | undefined;
    const check = async () => {
      try {
        const result = await getKletiaClient().receipts.get(intentId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const receipt = result.receipt;
        if (receipt && typeof receipt.payload?.receiptId === "string") {
          setState({ status: "ready", receiptId: receipt.payload.receiptId, sequence: receipt.payload.sequence, document: receipt });
          void loadShares();
          return;
        }
        const retry = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (result.pending?.retryAfterSeconds ?? 30) * 1000));
        setState({ status: "pending", expectedBy: result.pending?.expectedBy ?? null });
        timer = window.setTimeout(() => void check(), retry);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof KletiaApiError && caught.code === "RECEIPT_NOT_READY") {
          setState({ status: "pending", expectedBy: null });
          timer = window.setTimeout(() => void check(), MIN_POLL_MS);
          return;
        }
        if (caught instanceof KletiaApiError && (caught.code === "RECEIPT_NOT_APPLICABLE" || caught.code === "RECEIPTS_DISABLED" || caught.status === 404)) {
          setState({ status: "none" });
          return;
        }
        setState({ status: "error" });
      }
    };
    void check();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applies, intentId, loadShares]);

  if (!applies || state.status === "none" || state.status === "checking") return null;

  const shell = cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE, className);
  if (state.status === "error") {
    return (
      <section aria-label="Receipt" className={shell}>
        <p className={cx("text-sm", TEXT_MUTED)}>Kletia could not read this intent's receipt right now.</p>
      </section>
    );
  }
  if (state.status === "pending") {
    const by = state.expectedBy && Number.isFinite(Date.parse(state.expectedBy)) ? timeFormatter.format(new Date(state.expectedBy)) : null;
    return (
      <section aria-label="Receipt" className={shell}>
        <p className={LABEL}>Receipt</p>
        <p className="text-sm font-semibold" role="status">
          Waiting for every leg to be final on-chain{by ? `, expected by ${by}` : ""}. Kletia signs the receipt then; this page checks
          again by itself.
        </p>
      </section>
    );
  }

  const ready = state;
  const share = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const seconds = EXPIRY_OPTIONS[expiry]?.seconds;
      const { share: created } = await getKletiaClient().receipts.share(intentId, {
        profile,
        expiresInSeconds: seconds === undefined ? 2_592_000 : seconds,
      });
      if (!mounted.current) return;
      const href = receiptShareHref(created, { fallbackOrigin: window.location.origin });
      setLink(href);
      setOpen(false);
      if (!href) setMessage("Kletia returned a receipt link this page cannot open.");
      void loadShares();
    } catch (caught) {
      if (mounted.current) setMessage(caught instanceof KletiaApiError ? caught.message : "Sharing failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const revoke = async (shareId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await getKletiaClient().receipts.unshare(intentId, shareId);
      if (mounted.current) setShares((current) => current.filter((item) => item.id !== shareId));
    } catch (caught) {
      if (mounted.current) setMessage(caught instanceof KletiaApiError ? caught.message : "Revoking failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const download = () => {
    const blob = new Blob([`${JSON.stringify(ready.document, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${ready.receiptId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const chosen = RECEIPT_SHARE_PROFILES.find((item) => item.id === profile);

  return (
    <section aria-label="Receipt" className={shell}>
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex -rotate-2 items-center border-[3px] border-[#0047E0] px-2.5 py-1 font-code text-[11px] font-black uppercase tracking-[0.12em] text-[#0047E0] dark:border-[#7EA6FF] dark:text-[#7EA6FF]"
        >
          Receipt · No. {receiptNumber(ready.receiptId)}
        </span>
        <p className="text-sm font-semibold">
          Kletia signed receipt No. {receiptNumber(ready.receiptId)}
          {ready.sequence > 1 ? ` (issue ${ready.sequence})` : ""}. It is private until you share a link.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open} disabled={busy}>
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          Share…
        </Button>
        <Button size="sm" variant="secondary" onClick={download}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download receipt
        </Button>
      </div>

      {open ? (
        <fieldset className={cx("m-0 flex flex-col gap-2 p-3", INK_BORDER)} disabled={busy}>
          <legend className={cx(LABEL, "px-1")}>What the link shows</legend>
          {RECEIPT_SHARE_PROFILES.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="radio"
                name={groupId}
                value={item.id}
                checked={profile === item.id}
                onChange={() => setProfile(item.id)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#0052FF]"
              />
              <span>
                <span className="font-bold">{item.label}.</span> <span className={TEXT_MUTED}>{item.description}</span>
              </span>
            </label>
          ))}
          {chosen?.revealsAddresses ? (
            <p className="border-2 border-[#1A1A1A] bg-[#FFF3B0] px-2.5 py-1.5 text-xs font-bold text-[#1A1A1A]">{RECEIPT_EVIDENCE_WARNING}</p>
          ) : null}
          <label htmlFor={expiryId} className="mt-1 text-xs font-bold">
            Link expires after
          </label>
          <select
            id={expiryId}
            value={expiry}
            onChange={(event) => setExpiry(Number(event.target.value))}
            className={cx("min-h-11 max-w-[12rem] bg-white px-2 text-sm font-semibold dark:bg-[#0B1120]", INK_BORDER)}
          >
            {EXPIRY_OPTIONS.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void share()} loading={busy}>
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Create link
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </fieldset>
      ) : null}

      {link ? (
        <div className={cx("flex flex-col gap-2 p-3", INK_BORDER)}>
          <p className="text-xs font-bold">Your receipt link. It carries the key that opens it, so it is shown only now.</p>
          <p className="break-all font-code text-xs">{link}</p>
          <div className="flex flex-wrap gap-2">
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-9 items-center gap-1.5 border-[3px] border-[#1A1A1A] bg-white px-3 text-[11px] font-black uppercase tracking-[0.12em] text-[#1A1A1A] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:focus-visible:outline-[#FFD60A]"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Open receipt
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <CopyButton text={link} label="Copy the receipt link" appearance="light" />
          </div>
        </div>
      ) : null}

      {shares.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className={LABEL}>Shared links</p>
          <ul className="flex flex-col gap-1.5">
            {shares.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-dashed border-[#1A1A1A]/20 pt-1.5 text-sm dark:border-white/10">
                <span>
                  <span className="font-bold">{profileOf(item.groups)}</span>
                  <span className={TEXT_MUTED}>
                    {" "}
                    · {item.expiresAt && Number.isFinite(Date.parse(item.expiresAt)) ? `expires ${dayFormatter.format(new Date(item.expiresAt))}` : "no expiry"}
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => void revoke(item.id)} disabled={busy}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm font-bold text-[#B42318] dark:text-[#FCA5A5]">
          {message}
        </p>
      ) : null}
    </section>
  );
}
