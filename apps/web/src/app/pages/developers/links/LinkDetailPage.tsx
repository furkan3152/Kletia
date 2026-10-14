import type { LinkOwnerView, LinkView } from "@kletia/core";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { navigate } from "../../../routes/history";
import { lineFor } from "../../../site/art";
import { LinkTicket } from "../../../site/art/LinkTicket";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { ButtonLink } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { buttonClasses, cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { boundRows, formatDate, linkSentence, linkSerial, ticketNetworks } from "../../link/linkModel";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { formatWhen, httpsUrl } from "../portal/portalFormat";
import { useNow } from "../portal/useNow";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { LinkShare } from "./LinkCreated";
import { LinkControls, LinkCountersBoard } from "./LinkParts";
import { linkRowModel } from "./linkRows";

function isOwnerView(view: LinkView | LinkOwnerView | undefined): view is LinkOwnerView {
  return Boolean(view && "definition" in view && "ownerKeyId" in view);
}

function LinkPageBody({ linkId }: { readonly linkId: string }) {
  const { key } = useSessionKey();
  const developer = portalKeyKind(key) === "developer";
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const read = useApiResource<LinkView | LinkOwnerView>(`link:${maskKey(key)}:${linkId}:${generation}`, (_client, signal) =>
    keyedClient(key).links.get(linkId, { signal: sdkSignal(signal) }),
  );
  const link = isOwnerView(read.data) ? read.data : null;
  const now = useNow(1_000, link?.status === "pending");

  if (read.status === "loading" && !read.data) {
    return (
      <>
        <PortalPageHeader title="Intent link" back={{ label: "Links", to: "/developers/links" }} />
        <SkeletonGroup label="Loading the link" className="grid gap-6 lg:grid-cols-2">
          <Skeleton surface="card" className="h-80" />
          <Skeleton surface="card" className="h-80" />
        </SkeletonGroup>
      </>
    );
  }
  if (!link) {
    const missing = read.error?.code === "LINK_NOT_FOUND" || read.error?.status === 404 || (read.data && !isOwnerView(read.data));
    return (
      <>
        <PortalPageHeader title={missing ? "No link here" : "Intent link"} back={{ label: "Links", to: "/developers/links" }} />
        {missing ? (
          <div className={cx("flex flex-col items-start gap-3 p-5", INK_BORDER, SURFACE)}>
            <p className="text-sm">
              The key in this tab has no link <code className="font-code">{linkId}</code>. It may belong to another key; its public page is at /go/{linkId}.
            </p>
            <ButtonLink to="/developers/links" size="sm" variant="secondary">
              Back to the links
            </ButtonLink>
          </div>
        ) : read.error ? (
          <ApiErrorPanel error={read.error} title="Could not read this link" onRetry={read.reload} />
        ) : null}
      </>
    );
  }

  const row = linkRowModel(link, now);
  const page = httpsUrl(link.urls.page);
  const uses = link.uses.max !== null ? { used: Math.max(0, link.uses.max - (link.uses.left ?? 0)), max: link.uses.max } : null;
  const onChanged = (message: string, withdrawn = false) => {
    setNotice(message);
    setGeneration((value) => value + 1);
    if (withdrawn) navigate("/developers/links");
  };

  return (
    <>
      <PortalPageHeader
        title={link.title}
        back={{ label: "Links", to: "/developers/links" }}
        actions={
          <>
            <CopyButton text={link.urls.page} label="Copy link" appearance="light" />
            {page ? (
              <a href={page} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md")}>
                Open page
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </>
        }
        meta={
          <>
            <StatusEntryPill entry={row.status} />
            <span>
              {row.publisher} <StatusEntryPill entry={row.publisherStatus} className="ml-1 align-middle" />
            </span>
            <span>revision {link.revision}</span>
            {row.detail ? <span className="font-semibold">{row.detail}</span> : null}
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-6">
        <div aria-live="polite">{notice ? <p className="border-l-[6px] border-success bg-success-bg px-3 py-2 text-sm text-fg">{notice}</p> : null}</div>
        <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:items-start">
          <div className="flex min-w-0 flex-col gap-6">
            {/* The ticket exactly as visitors see it on /go. */}
            <LinkTicket
              serial={linkSerial(link.id)}
              intent={linkSentence(link)}
              publisher={{ name: link.publisher.name, ...(link.publisher.domain ? { domain: link.publisher.domain } : {}), verified: link.publisher.domainVerified }}
              bounds={boundRows(link)}
              networks={ticketNetworks(link).map((network) => lineFor(network)).filter((line): line is NonNullable<typeof line> => line !== null)}
              url={link.urls.page.replace(/^https?:\/\//u, "")}
              expires={formatDate(link.expiresAt)}
              {...(uses ? { uses } : {})}
            />
            <LinkShare link={link} />
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            <section aria-labelledby="link-counters" className="flex min-w-0 flex-col gap-3">
              <h2 id="link-counters" className="font-display text-title font-bold">
                Counters
              </h2>
              <LinkCountersBoard link={link} apiKey={key} />
            </section>
            <section aria-labelledby="link-bounds" className="flex min-w-0 flex-col gap-3">
              <h2 id="link-bounds" className="font-display text-title font-bold">
                Bounds and limits
              </h2>
              <dl className="grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                {boundRows(link).map((bound) => (
                  <div key={bound.label} className="contents">
                    <dt className={cx(LABEL, TEXT_MUTED)}>{bound.label}</dt>
                    <dd className="min-w-0 break-words">{bound.value}</dd>
                  </div>
                ))}
                <dt className={cx(LABEL, TEXT_MUTED)}>Uses</dt>
                <dd>{link.uses.max !== null ? `${link.uses.left ?? 0} of ${link.uses.max} left` : "No use limit"}</dd>
                <dt className={cx(LABEL, TEXT_MUTED)}>Per account</dt>
                <dd>{link.perAccount ? `${link.perAccount.maxUses} per visitor account` : "No limit"}</dd>
                <dt className={cx(LABEL, TEXT_MUTED)}>Expires</dt>
                <dd>{formatWhen(link.expiresAt)}</dd>
              </dl>
            </section>
            <section aria-labelledby="link-controls" className="flex min-w-0 flex-col gap-3">
              <h2 id="link-controls" className="font-display text-title font-bold">
                Controls
              </h2>
              {developer ? (
                <LinkControls link={link} apiKey={key} onChanged={onChanged} />
              ) : (
                <p className={cx("text-sm", TEXT_MUTED)}>An agent key pauses and withdraws links only when its rule book grants permissions.links.</p>
              )}
              <p className={cx("text-[13px]", TEXT_MUTED)}>
                Changes only ever tighten what visitors can do (PATCH /v1/links/{"{id}"}); to change where the money goes, publish a new link.
              </p>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

/** One link (`/developers/links/:linkId`): the ticket as visitors see it, its share cards, counters, bounds and controls. */
export function LinkDetailPage({ linkId }: { readonly linkId: string }) {
  const { key } = useSessionKey();
  if (portalKeyKind(key)) return <LinkPageBody linkId={linkId} />;
  return (
    <>
      <PortalPageHeader title="Intent link" back={{ label: "Links", to: "/developers/links" }} />
      <KeyGate purpose="read this link's counters, pause it or withdraw it" agentKeys>
        {null}
      </KeyGate>
    </>
  );
}
