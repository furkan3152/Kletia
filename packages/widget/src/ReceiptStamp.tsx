import { useEffect, useId, useRef, useState } from "react";
import { KletiaApiError, type KletiaClient } from "@kletia/sdk";
import { RECEIPT_EVIDENCE_WARNING, RECEIPT_SHARE_PROFILES, receiptApplies, receiptShareHref, type ReceiptShareProfile } from "./review.js";

type ReceiptState =
  | { readonly status: "checking" }
  | { readonly status: "pending"; readonly expectedBy: string | null; readonly retryAfterSeconds: number }
  | { readonly status: "ready"; readonly receiptId: string; readonly sequence: number | null }
  | { readonly status: "none" }
  | { readonly status: "error"; readonly message: string };

export interface ReceiptStampProps {
  readonly client: KletiaClient;
  readonly intentId: string;
  readonly intentStatus: string;
  /** Rebuilds non-https receipt links on this origin (the Kletia web app only). */
  readonly fallbackOrigin?: string | null;
}

const MIN_POLL_MS = 20_000;
const MAX_POLL_MS = 120_000;

function receiptNumber(receiptId: string): string {
  const hex = receiptId.replace(/^rcpt_/u, "").toUpperCase();
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

/**
 * The receipt of a finished intent. Receipts are private until shared, so
 * this shows the receipt stamp and a "Share" action that creates a link
 * with the profile the user picks; nothing is shared without that choice.
 */
export function ReceiptStamp({ client, intentId, intentStatus, fallbackOrigin }: ReceiptStampProps) {
  const [state, setState] = useState<ReceiptState>({ status: "checking" });
  const [profile, setProfile] = useState<ReceiptShareProfile>("route");
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const groupId = useId();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applies = receiptApplies(intentStatus);
  useEffect(() => {
    if (!applies) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const result = await client.receipts.get(intentId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const receiptId = result.receipt?.payload?.receiptId;
        if (result.receipt && typeof receiptId === "string") {
          const sequence = typeof result.receipt.payload.sequence === "number" ? result.receipt.payload.sequence : null;
          setState({ status: "ready", receiptId, sequence });
          return;
        }
        const pending = result.pending;
        const retry = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (pending?.retryAfterSeconds ?? 30) * 1000));
        setState({ status: "pending", expectedBy: pending?.expectedBy ?? null, retryAfterSeconds: Math.round(retry / 1000) });
        timer = setTimeout(() => void check(), retry);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof KletiaApiError && (error.code === "RECEIPT_NOT_APPLICABLE" || error.code === "RECEIPTS_DISABLED" || error.status === 404)) {
          setState({ status: "none" });
          return;
        }
        if (error instanceof KletiaApiError && error.code === "RECEIPT_NOT_READY") {
          setState({ status: "pending", expectedBy: null, retryAfterSeconds: MIN_POLL_MS / 1000 });
          timer = setTimeout(() => void check(), MIN_POLL_MS);
          return;
        }
        setState({ status: "error", message: "Kletia could not read the receipt right now." });
      }
    };
    void check();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [applies, client, intentId]);

  if (!applies || state.status === "none" || state.status === "checking") return null;
  if (state.status === "error") return <p className="kw-muted kw-receipt">{state.message}</p>;
  if (state.status === "pending") {
    const by = state.expectedBy && Number.isFinite(Date.parse(state.expectedBy)) ? new Date(state.expectedBy).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : null;
    return (
      <p className="kw-receipt kw-muted" role="status">
        Receipt: waiting for every leg to be final on-chain{by ? `, expected by ${by}` : ""}. Kletia signs it then.
      </p>
    );
  }

  const share = async () => {
    setSharing(true);
    setShareError(null);
    try {
      const { share: created } = await client.receipts.share(intentId, { profile });
      if (!mounted.current) return;
      const href = receiptShareHref(created, { fallbackOrigin: fallbackOrigin ?? null });
      if (!href) setShareError("Kletia returned a receipt link this widget cannot open.");
      setLink(href);
    } catch (error) {
      if (!mounted.current) return;
      setShareError(error instanceof KletiaApiError ? error.message : "Sharing failed.");
    } finally {
      if (mounted.current) setSharing(false);
    }
  };
  const chosen = RECEIPT_SHARE_PROFILES.find((item) => item.id === profile);

  return (
    <div className="kw-receipt">
      <p className="kw-receipt-head">
        <span className="kw-stamp kw-stamp-receipt">Receipt No. {receiptNumber(state.receiptId)}</span>
        <span className="kw-muted">Signed by Kletia. Private until you share it.</span>
      </p>
      {link ? (
        <p className="kw-receipt-link">
          <a className="kw-link" href={link} target="_blank" rel="noreferrer noopener">
            Open the shared receipt
            <span className="kw-sr"> (opens in a new tab)</span>
          </a>
          <button
            type="button"
            className="kw-btn kw-btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(
                () => mounted.current && setCopied(true),
                () => undefined,
              );
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <span className="kw-muted kw-block">Anyone with this link can read what you chose to show. The link is shown once.</span>
        </p>
      ) : open ? (
        <fieldset className="kw-share" disabled={sharing}>
          <legend>What the link shows</legend>
          {RECEIPT_SHARE_PROFILES.map((item) => (
            <label key={item.id} className="kw-share-opt">
              <input type="radio" name={groupId} value={item.id} checked={profile === item.id} onChange={() => setProfile(item.id)} />
              <span>
                <strong>{item.label}</strong> <span className="kw-muted">{item.description}</span>
              </span>
            </label>
          ))}
          {chosen?.revealsAddresses ? <p className="kw-warn">{RECEIPT_EVIDENCE_WARNING}</p> : null}
          <div className="kw-row">
            <button type="button" className="kw-btn kw-btn-sm kw-primary" onClick={() => void share()}>
              {sharing ? "Creating…" : "Create link"}
            </button>
            <button type="button" className="kw-btn kw-btn-sm" onClick={() => setOpen(false)}>
              Not now
            </button>
          </div>
        </fieldset>
      ) : (
        <button type="button" className="kw-btn kw-btn-sm" onClick={() => setOpen(true)}>
          Share receipt…
        </button>
      )}
      {shareError ? <p className="kw-error">{shareError}</p> : null}
    </div>
  );
}

export default ReceiptStamp;
