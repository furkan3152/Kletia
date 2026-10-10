import type { LinkOwnerView } from "@kletia/core";
import { ArrowUpRight, Plus } from "lucide-react";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { CopyButton } from "../../../site/ui/CopyButton";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { WELL_KNOWN_PATH, wellKnownSnippet } from "../contracts/contractModel";
import { formatWhen, httpsUrl } from "../portal/portalFormat";
import { blinkActionUrl, cardUrl } from "./linkTemplates";

/** The page URL and the share cards of a link, as printed by the API (never a URL the browser was not given by it). */
export function LinkShare({ link }: { readonly link: LinkOwnerView }) {
  const page = httpsUrl(link.urls.page);
  const wide = cardUrl(PLATFORM_ORIGIN, link.id, "wide", link.revision);
  const square = cardUrl(PLATFORM_ORIGIN, link.id, "square", link.revision);
  const blink = blinkActionUrl(PLATFORM_ORIGIN, link);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={LABEL}>Page</p>
        <div className="flex min-w-0 flex-col gap-2 border-[3px] border-[#1A1A1A] bg-[#0D1117] p-2 pl-3 text-[#E6EDF3] dark:border-[#4B5563] sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all font-code text-[13px]">{link.urls.page}</code>
          <div className="flex shrink-0 gap-2">
            <CopyButton text={link.urls.page} label="Copy the link" />
            {page ? (
              <a href={page} target="_blank" rel="noopener noreferrer" className={cx("inline-flex min-h-9 items-center gap-1 border-2 border-white/25 px-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-white hover:border-[#FFD60A] hover:text-[#FFD60A]", FOCUS_RING)}>
                Open
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
      {wide && square ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={LABEL}>Share cards (what a pasted link unfurls as)</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:items-start">
            <img src={wide} alt={`Share card of ${link.title}, 1200 by 600`} width={1200} height={600} loading="lazy" className={cx("h-auto w-full bg-[#121418]", INK_BORDER_THIN)} />
            <img src={square} alt={`Square card of ${link.title}, used as the blink icon`} width={600} height={600} loading="lazy" className={cx("h-auto w-full max-w-[14rem] bg-[#121418]", INK_BORDER_THIN)} />
          </div>
        </div>
      ) : null}
      {blink ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={LABEL}>Blink</p>
          <div className="flex min-w-0 items-center gap-2 border-2 border-[#1A1A1A] p-2 dark:border-[#4B5563]">
            <code className="min-w-0 flex-1 break-all font-code text-[12px]">{blink}</code>
            <CopyButton text={blink} label="Copy the blink URL" appearance="light" />
          </div>
          <p className={cx("text-xs", TEXT_MUTED)}>Blink clients also find it from the page URL through actions.json.</p>
        </div>
      ) : link.blink.enabled ? (
        <p className={cx("text-sm", TEXT_MUTED)}>No blink yet: {link.blink.reason ?? "the link is not eligible"}.</p>
      ) : null}
    </div>
  );
}

/** Shown once a link is published: its state, URL, cards and the domain file. */
export function LinkCreated({ link, onAnother }: { readonly link: LinkOwnerView; readonly onAnother: () => void }) {
  const website = httpsUrl(link.publisher.website);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div role="status" className={cx("flex flex-col gap-2 p-4", INK_BORDER_THIN, link.status === "pending" ? "bg-[#FFF3B0] text-[#1A1A1A]" : "bg-[#E9FFF5] dark:bg-[#0E2A20]")}>
        <p className="font-display text-xl font-bold">
          Published <code className="font-code text-base">{link.id}</code>.
        </p>
        <p className="text-sm">
          {link.status === "pending"
            ? `It pays a fixed third party or calls a contract, so it is pending until ${formatWhen(link.activatesAt)}; your webhooks heard link.created first.`
            : "It is active: share the page, and every visitor signs in their own wallet."}
        </p>
      </div>
      <LinkShare link={link} />
      {!link.publisher.domainVerified && website ? (
        <div className="min-w-0">
          <p className={cx(LABEL, "mb-2")}>Verify your domain</p>
          <p className={cx("mb-3 text-sm", TEXT_MUTED)}>
            Publish this at <code className="break-all font-code">{`${website.replace(/\/+$/u, "")}${WELL_KNOWN_PATH}`}</code>. Unverified publishers print a red seal, are capped at $1,000 per intent and get no blink.
          </p>
          <CodeBlock code={wellKnownSnippet([], [link.id], [link.ownerKeyId])} language="json" label="Domain verification file" filename="kletia.json" />
        </div>
      ) : null}
      <Button variant="secondary" className="self-start" onClick={onAnother}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Make another link
      </Button>
    </div>
  );
}
