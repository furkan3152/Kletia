import type { LinkOwnerView } from "@kletia/core";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { lineFor } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { LineBullet } from "../../../site/art/LineBullet";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { DataTable } from "../../../site/ui/DataTable";
import { SelectField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { useNow } from "../portal/useNow";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { linkFilterOf, linkRowModel, type LinkFilter } from "./linkRows";

const LINKS_INTRO = "Pages that do one fixed thing in the visitor's own wallet. Counters never hold visitor data.";

function Networks({ networks }: { readonly networks: readonly string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {networks.map((network) => {
        const line = lineFor(network);
        return line ? <LineBullet key={network} line={line} /> : <span key={network}>{network}</span>;
      })}
    </span>
  );
}

/** Writes `?status=` back without a router navigation (no focus move, no history entry). */
function replaceFilter(filter: LinkFilter): void {
  const url = new URL(window.location.href);
  if (filter) url.searchParams.set("status", filter);
  else url.searchParams.delete("status");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function LinksTable({ initialFilter }: { readonly initialFilter: LinkFilter }) {
  const { key } = useSessionKey();
  const developer = portalKeyKind(key) === "developer";
  const [filter, setFilter] = useState<LinkFilter>(initialFilter);
  const list = useApiResource<LinkOwnerView[]>(`links:${maskKey(key)}:${filter}`, (_client, signal) =>
    keyedClient(key).links.list(filter ? { status: filter } : {}, { signal: sdkSignal(signal) }),
  );
  const links = list.data ?? [];
  const now = useNow(1_000, links.some((link) => link.status === "pending"));
  const rows = links.map((link) => linkRowModel(link, now));

  return (
    <section aria-label="Your links" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectField
          label="Show"
          value={filter}
          onChange={(event) => {
            const next = linkFilterOf(new URLSearchParams({ status: event.target.value }));
            setFilter(next);
            replaceFilter(next);
          }}
          containerClassName="w-48"
          options={[
            { value: "", label: "Every link" },
            { value: "active", label: "Active" },
            { value: "pending", label: "Pending" },
            { value: "paused", label: "Paused" },
            { value: "suspended", label: "Suspended" },
            { value: "deleted", label: "Withdrawn" },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload links">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {list.status === "loading" && !list.data ? (
        <SkeletonGroup label="Loading links" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-14" />
          <Skeleton surface="card" className="h-14" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list links" onRetry={list.reload} />
      ) : (
        <DataTable
          caption="Intent links of this key"
          rows={rows}
          rowKey={(row) => row.id}
          rowHref={(row) => `/developers/links/${row.id}`}
          rowLabel={(row) => `Open ${row.title}`}
          empty={
            <div className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
              <Icon name="ticket" size={32} />
              <p className="font-display text-title font-bold">{filter ? "No link with this status." : "No links published with this key yet."}</p>
              <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
                A link is a public page that does one fixed thing in the visitor&apos;s own wallet: pay you, deposit into your contract, or bridge
                and stake. You fix where the money goes; visitors choose where it comes from.
              </p>
              {developer && !filter ? (
                <ButtonLink to="/developers/links/new" size="sm">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New link
                </ButtonLink>
              ) : null}
            </div>
          }
          columns={[
            { key: "status", header: "Status", phone: "primary", cell: (row) => <StatusEntryPill entry={row.status} /> },
            {
              key: "title",
              header: "Title",
              phone: "primary",
              cell: (row) => (
                <span className="flex min-w-0 flex-col">
                  {/* User content: rendered as text only. */}
                  <Link to={`/developers/links/${row.id}`} className={cx("break-words font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                    {row.title}
                  </Link>
                  {row.detail ? <span className="text-[13px] font-semibold">{row.detail}</span> : null}
                </span>
              ),
            },
            {
              key: "publisher",
              header: "Publisher",
              cell: (row) => (
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="break-words">{row.publisher}</span>
                  <StatusEntryPill entry={row.publisherStatus} />
                </span>
              ),
            },
            {
              key: "route",
              header: "From → to",
              cell: (row) => (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Networks networks={row.from} />
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">to</span>
                  <Networks networks={[row.to]} />
                </span>
              ),
            },
            { key: "views", header: "Views", align: "end", cell: (row) => <span className="font-code">{row.views}</span> },
            { key: "intents", header: "Intents", align: "end", cell: (row) => <span className="font-code">{row.intents}</span> },
          ]}
        />
      )}
      <p className={cx("text-[13px]", TEXT_MUTED)}>
        Counters cover the last 7 days; a dash means the API did not report them. A key holds at most 200 active links.
        {!developer ? " An agent key publishes and changes links only when its rule book grants permissions.links." : ""}
      </p>
    </section>
  );
}

/** Intent links (`/developers/links?status=`): the key's links as table rows; each opens its own page. */
export function LinksListPage({ search }: { readonly search: URLSearchParams }) {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const [initialFilter] = useState(() => linkFilterOf(search));
  return (
    <>
      <PortalPageHeader
        title="Intent links"
        intro={LINKS_INTRO}
        actions={
          kind === "developer" ? (
            <ButtonLink to="/developers/links/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New link
            </ButtonLink>
          ) : null
        }
      />
      <KeyGate purpose="publish, pause and withdraw intent links and read their counters" agentKeys>
        <LinksTable initialFilter={initialFilter} />
      </KeyGate>
    </>
  );
}
