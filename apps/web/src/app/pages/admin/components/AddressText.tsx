import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useState } from "react";

import { copyText } from "../../../site/ui/clipboard";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { addressUrl, txUrl } from "../model/plan";
import { nameFor, type AddressBook } from "../model/preview";
import { shortAddress } from "../model/session";
import type { AdminEvmNetwork } from "../model/types";

export interface AddressTextProps {
  readonly address: string | null | undefined;
  readonly network?: AdminEvmNetwork;
  readonly book?: AddressBook;
  /** Print the whole address instead of 0xabcd…1234. */
  readonly full?: boolean;
  /** A transaction hash instead of an address (explorer link goes to the tx). */
  readonly tx?: boolean;
  readonly copy?: boolean;
  readonly className?: string;
}

/** An address (or tx hash) in mono, its address-book name, a copy button and an explorer link. */
export function AddressText({ address, network, book, full = false, tx = false, copy = true, className }: AddressTextProps) {
  if (!address) return <span className={cx("text-sm", TEXT_MUTED)}>None</span>;
  const name = book ? nameFor(book, address) : null;
  const href = network ? (tx ? txUrl(network, address) : addressUrl(network, address)) : null;
  return (
    <span className={cx("inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {name ? <span className="font-bold">{name}</span> : null}
      <code className={cx("min-w-0 break-all font-code text-[13px]", name && TEXT_MUTED)} title={address}>
        {full ? address : shortAddress(address)}
      </code>
      {copy ? <IconCopy text={address} label={`Copy ${tx ? "transaction hash" : "address"}`} /> : null}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cx("inline-flex h-8 w-8 items-center justify-center", FOCUS_RING)} aria-label={`Open ${tx ? "transaction" : "address"} in the explorer (opens in a new tab)`}>
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  );
}

/** A compact copy button for inline addresses (icon only, announced politely). */
function IconCopy({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        const ok = await copyText(text);
        setCopied(ok);
        if (ok) window.setTimeout(() => setCopied(false), 1500);
      }}
      className={cx("inline-flex h-8 w-8 items-center justify-center hover:bg-[#C6FF3A] hover:text-[#121212]", FOCUS_RING)}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
