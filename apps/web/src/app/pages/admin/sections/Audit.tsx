/** The audit log (admin design A.9): every login attempt and every mutation, newest first, paged by time. */
import { useState } from "react";

import { Button } from "../../../site/ui/Button";
import { DataTable, type DataTableColumn } from "../../../site/ui/DataTable";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, TEXT_MUTED } from "../../../site/ui/styles";
import { useAdmin, useAdminQuery } from "../api/useAdmin";
import { AddressText } from "../components/AddressText";
import { AdminError } from "../components/AdminError";
import { EmptyState, SectionHeader } from "../components/SectionHeader";
import type { AdminAuditEntry } from "../model/types";

export function AuditSection() {
  const { book } = useAdmin();
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const before = pages[pages.length - 1] ?? null;
  const audit = useAdminQuery(["audit", before], (api) => api.audit({ limit: 50, before }));

  const columns: readonly DataTableColumn<AdminAuditEntry>[] = [
    { key: "at", header: "When (UTC)", phone: "secondary", cell: (row) => <span className="whitespace-nowrap font-code text-[13px]">{row.at.slice(0, 19).replace("T", " ")}</span> },
    { key: "action", header: "Action", phone: "primary", cell: (row) => <code className="font-code text-[13px] font-bold">{row.action}</code> },
    { key: "outcome", header: "Outcome", phone: "primary", cell: (row) => <StatusPill tone={row.outcome === "ok" ? "success" : row.outcome === "denied" ? "warning" : "danger"}>{row.outcome}</StatusPill> },
    { key: "who", header: "Wallet", cell: (row) => (row.address ? <AddressText address={row.address} book={book} copy={false} /> : <span className={TEXT_MUTED}>Unknown</span>) },
    {
      key: "target",
      header: "Target",
      cell: (row) => (
        <span className="break-all font-code text-[13px]">
          {Object.entries(row.target)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ") || "--"}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader icon="name" eyebrow="Audit log" title="Who did what" intro="Every sign-in attempt and every change made through the panel, written before the API answered. Reads are not logged, except exports." />
      {audit.error ? <AdminError error={audit.error} title="The audit log could not load" onRetry={() => void audit.refetch()} /> : null}
      {audit.isLoading ? <Skeleton className="h-64" surface="card" /> : null}
      {audit.data ? (
        <DataTable caption="Admin audit log" columns={columns} rows={audit.data.entries} rowKey={(row) => row.id} empty={<EmptyState>No admin actions yet.</EmptyState>} />
      ) : null}
      <div className={cx("flex flex-wrap items-center gap-2")}>
        {pages.length > 1 ? (
          <Button variant="secondary" size="sm" onClick={() => setPages((list) => list.slice(0, -1))}>
            Newer
          </Button>
        ) : null}
        {audit.data?.next ? (
          <Button variant="secondary" size="sm" onClick={() => setPages((list) => [...list, audit.data?.next ?? null])}>
            Older
          </Button>
        ) : null}
      </div>
    </div>
  );
}
