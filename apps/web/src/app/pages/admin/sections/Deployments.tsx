import { useQueryClient } from "@tanstack/react-query";
import { Archive, Check, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

import { LineBullet } from "../../../site/art/LineBullet";
import { Stamp } from "../../../site/art/Stamp";
import { lineFor } from "../../../site/art/tokens";
import { Button } from "../../../site/ui/Button";
import { DataTable, type DataTableColumn } from "../../../site/ui/DataTable";
import { TextAreaField } from "../../../site/ui/Field";
import { Sheet } from "../../../site/ui/Sheet";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill, type StatusTone } from "../../../site/ui/StatusPill";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { describeAdminError } from "../api/adminClient";
import { useAdmin, useDeployments, useStepUp } from "../api/useAdmin";
import { AddressText } from "../components/AddressText";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { EmptyState, Panel, SectionHeader } from "../components/SectionHeader";
import { CONFIRM_ACTIONS } from "../model/confirm";
import { ADMIN_EVM_NETWORKS, deploymentMatrix, FOREIGN_TEXT, networkName } from "../model/plan";
import type { AdminDeploymentRecord, AdminPinnedDeployment, AdminRecordStatus } from "../model/types";
import { StepUpNote } from "../components/StepUpNote";

const STATUS_TONES: Readonly<Record<AdminRecordStatus, StatusTone>> = {
  pending: "info",
  verified: "success",
  foreign: "danger",
  verification_failed: "danger",
  superseded: "neutral",
  archived: "neutral",
};

const STATUS_LABELS: Readonly<Record<AdminRecordStatus, string>> = {
  pending: "Pending",
  verified: "Verified",
  foreign: "Foreign owner",
  verification_failed: "Failed checks",
  superseded: "Superseded",
  archived: "Archived",
};

const CELL_NAMES: Readonly<Record<string, string>> = { P: "Pinned", V: "Verified (new)", D: "Deployable", Q: "Quarantined", L: "Legacy", "-": "Not applicable" };

function NetworkCell({ network }: { readonly network: AdminDeploymentRecord["network"] }) {
  const line = lineFor(network);
  return (
    <span className="inline-flex items-center gap-2">
      {line ? <LineBullet line={line} decorative /> : null}
      {networkName(network)}
    </span>
  );
}

/** Every deployment on every network (admin design G.2): the matrix, new records with their checks, and the pinned set. */
export function DeploymentsSection() {
  const { catalog, book, goTo } = useAdmin();
  const deployments = useDeployments();
  const [open, setOpen] = useState<AdminDeploymentRecord | null>(null);
  const records = useMemo(() => deployments.data?.records ?? [], [deployments.data]);
  const pinned = deployments.data?.pinned ?? catalog?.pinned ?? [];
  const matrix = useMemo(() => (catalog ? deploymentMatrix(catalog, records) : []), [catalog, records]);

  const recordColumns: readonly DataTableColumn<AdminDeploymentRecord>[] = [
    { key: "contract", header: "Contract", phone: "primary", cell: (row) => <span className="font-bold">{catalog?.contracts[row.contractId]?.name ?? row.contractId}{row.instance ? ` (${row.instance})` : ""}</span> },
    { key: "status", header: "Status", phone: "primary", cell: (row) => <StatusPill tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</StatusPill> },
    { key: "network", header: "Network", cell: (row) => <NetworkCell network={row.network} /> },
    { key: "address", header: "Address", cell: (row) => <AddressText address={row.address} network={row.network} copy={false} /> },
    { key: "when", header: "Recorded", cell: (row) => <span className="font-code text-[13px]">{row.createdAt.slice(0, 16).replace("T", " ")} UTC</span> },
    {
      key: "open",
      header: "Details",
      align: "end",
      cell: (row) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(row)}>
          Checks
        </Button>
      ),
    },
  ];

  const pinnedColumns: readonly DataTableColumn<AdminPinnedDeployment>[] = [
    { key: "contract", header: "Contract", phone: "primary", cell: (row) => <span className="font-bold">{catalog?.contracts[row.contractId]?.name ?? row.contractId}</span> },
    { key: "lifecycle", header: "Lifecycle", phone: "primary", cell: (row) => <StatusPill tone={row.lifecycle === "current" ? "success" : row.lifecycle === "legacy" ? "neutral" : "info"}>{row.lifecycle}</StatusPill> },
    { key: "network", header: "Network", cell: (row) => <NetworkCell network={row.network} /> },
    { key: "address", header: "Address", cell: (row) => <AddressText address={row.address} network={row.network} copy={false} /> },
    { key: "owner", header: "Owner", cell: (row) => (row.owner ? <AddressText address={row.owner} book={book} copy={false} /> : <span className={TEXT_MUTED}>No owner</span>) },
  ];

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        icon="contract"
        eyebrow="Deployments"
        title="Every deployment, every network"
        intro="The matrix shows what is pinned, verified, deployable, quarantined or legacy on each EVM network. A deployment made here is recorded and verified from chain data; it reaches the product only after the lead pins it in a release."
        actions={
          <Button variant="primary" onClick={() => goTo("deploy")}>
            Deploy a contract
          </Button>
        }
      />
      {deployments.error ? <AdminError error={deployments.error} title="The deployments could not load" onRetry={() => void deployments.refetch()} /> : null}

      <Panel title="Matrix">
        <div className={cx("min-w-0 overflow-x-auto", INK_BORDER, SURFACE)}>
          {!catalog ? (
            <div className="p-4">
              <Skeleton className="h-40" surface="card" />
            </div>
          ) : (
            <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
              <caption className="sr-only">Contracts by network: P pinned, V verified, D deployable, Q quarantined, L legacy, dash not applicable</caption>
              <thead className="bg-surface-2">
                <tr>
                  <th scope="col" className={cx(LABEL, "px-4 py-3", TEXT_MUTED)}>
                    Contract
                  </th>
                  {ADMIN_EVM_NETWORKS.map((network) => {
                    const line = lineFor(network);
                    return (
                      <th key={network} scope="col" className="px-2 py-3 text-center">
                        {line ? <LineBullet line={line} /> : network}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
                {matrix.map((row) => (
                  <tr key={row.contractId}>
                    <th scope="row" className="px-4 py-2 font-bold">
                      {row.title}
                    </th>
                    {ADMIN_EVM_NETWORKS.map((network) => (
                      <td key={network} className="px-2 py-2 text-center">
                        <span className="kl-admin__cell" data-cell={row.cells[network]} title={`${CELL_NAMES[row.cells[network]]} on ${networkName(network)}`}>
                          <span aria-hidden="true">{row.cells[network]}</span>
                          <span className="sr-only">{CELL_NAMES[row.cells[network]]}</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className={cx("flex flex-wrap gap-x-4 gap-y-1 text-sm", TEXT_MUTED)}>
          {Object.entries(CELL_NAMES).map(([letter, name]) => (
            <span key={letter} className="inline-flex items-center gap-1.5">
              <span className="kl-admin__cell !h-6 !min-w-6 text-xs" data-cell={letter} aria-hidden="true">
                {letter}
              </span>
              {name}
            </span>
          ))}
          <span>Solana and Solana Devnet: no Kletia programs.</span>
        </p>
      </Panel>

      <Panel title="New deployments">
        {deployments.isLoading ? (
          <Skeleton className="h-24" surface="card" />
        ) : (
          <DataTable
            caption="Deployments recorded in the admin panel"
            columns={recordColumns}
            rows={records}
            rowKey={(row) => row.id}
            empty={<EmptyState>No new deployments yet. Pinned contracts are listed below.</EmptyState>}
          />
        )}
      </Panel>

      <Panel title="Pinned contracts">
        <DataTable caption="Live contracts pinned in the repository" columns={pinnedColumns} rows={pinned} rowKey={(row) => `${row.network}:${row.address}`} />
      </Panel>

      <RecordSheet record={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function RecordSheet({ record, onClose }: { readonly record: AdminDeploymentRecord | null; readonly onClose: () => void }) {
  const { client, catalog, book } = useAdmin();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState<"reverify" | "archived" | "superseded" | null>(null);
  const [notes, setNotes] = useState("");
  const [current, setCurrent] = useState<AdminDeploymentRecord | null>(null);
  const shown = current && record && current.id === record.id ? current : record;

  const refresh = (next: AdminDeploymentRecord) => {
    setCurrent(next);
    void queryClient.invalidateQueries({ queryKey: ["admin", "deployments"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
  };

  const reverify = async () => {
    if (!shown) return;
    setBusy("reverify");
    try {
      refresh(await client.reverify(shown.id));
      toast.success("Checks ran again against the latest block");
    } catch (error) {
      toast.error("Reverify failed", { description: describeAdminError(error) });
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: "archived" | "superseded") => {
    if (!shown) return;
    setBusy(status);
    try {
      const body = { status, ...(notes.trim() ? { notes: notes.trim() } : {}) };
      const confirmation = await stepUp(CONFIRM_ACTIONS.recordStatus, body, shown.network);
      refresh(await client.setRecordStatus(shown.id, { ...body, confirmation }));
      toast.success(status === "archived" ? "Record archived" : "Record marked superseded");
    } catch (error) {
      toast.error("The status did not change", { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={Boolean(record)} onClose={onClose} title="Deployment record" side="right" phone="full" widthClassName="md:w-[34rem]">
      {shown ? (
        <div className="flex flex-col gap-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={cx(LABEL, TEXT_MUTED)}>{networkName(shown.network)}</p>
              <p className="font-display text-2xl font-bold">{catalog?.contracts[shown.contractId]?.name ?? shown.contractId}</p>
              <StatusPill tone={STATUS_TONES[shown.status]} className="mt-2">
                {STATUS_LABELS[shown.status]}
              </StatusPill>
            </div>
            {shown.status === "verified" ? <Stamp state="settled" detail="VERIFIED" className="h-20 w-auto shrink-0" labelled /> : null}
            {shown.status === "verification_failed" ? <Stamp state="failed" detail="CHECKS FAILED" className="h-20 w-auto shrink-0" labelled /> : null}
            {shown.status === "foreign" ? <Stamp state="failed" detail="FOREIGN" className="h-20 w-auto shrink-0" labelled /> : null}
          </div>
          {shown.status === "foreign" ? <p className="border-[3px] border-[#B91C1C] bg-danger-bg p-3 text-sm font-bold text-danger">{FOREIGN_TEXT}</p> : null}
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className={cx(LABEL, TEXT_MUTED)}>Address</dt>
              <dd>
                <AddressText address={shown.address} network={shown.network} full />
              </dd>
            </div>
            <div>
              <dt className={cx(LABEL, TEXT_MUTED)}>Transaction</dt>
              <dd>
                <AddressText address={shown.txHash} network={shown.network} tx />
              </dd>
            </div>
            <div>
              <dt className={cx(LABEL, TEXT_MUTED)}>Deployer</dt>
              <dd>
                <AddressText address={shown.deployer} network={shown.network} book={book} />
              </dd>
            </div>
            <div>
              <dt className={cx(LABEL, TEXT_MUTED)}>Owner</dt>
              <dd>{shown.expectedOwner ? <AddressText address={shown.expectedOwner} network={shown.network} book={book} /> : "No owner"} ({shown.ownerKind})</dd>
            </div>
            <div>
              <dt className={cx(LABEL, TEXT_MUTED)}>Wired into the product</dt>
              <dd>{shown.wired ? "Yes" : "No. The lead pins it in a release."}</dd>
            </div>
          </dl>
          <div>
            <p className={cx(LABEL, "mb-2", TEXT_MUTED)}>Checks</p>
            <ul className="flex flex-col gap-1.5">
              {shown.checks.map((check) => (
                <li key={check.id} className={cx("flex items-start gap-2 border-l-[4px] px-3 py-2 text-sm", check.ok ? "border-[#0B5E3A] bg-success-bg" : "border-[#B91C1C] bg-danger-bg")}>
                  {check.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="passed" /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="failed" />}
                  <span>
                    <span className="font-code text-[13px] font-bold">{check.id}</span> {check.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className={cx(LABEL, "mb-2", TEXT_MUTED)}>Constructor arguments</p>
            <dl className="grid gap-1.5 font-code text-[13px]">
              {Object.entries(shown.constructorArgs).map(([name, value]) => (
                <div key={name} className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
                  <dt className="font-bold">{name}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <StepUpNote />
          <Button variant="secondary" onClick={() => void reverify()} loading={busy === "reverify"} disabled={busy !== null}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Reverify against the latest block
          </Button>
          {shown.status !== "archived" ? (
            <div className="flex flex-col gap-3 border-t-2 border-dashed border-[#1A1A1A]/25 pt-4 dark:border-white/15">
              <p className={cx("text-sm", TEXT_MUTED)}>Changing a record's status changes what the checklist offers next, so the wallet that holds the session signs a confirmation.</p>
              <TextAreaField label="Note (optional)" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button variant="ink" onClick={() => void setStatus("archived")} loading={busy === "archived"} disabled={busy !== null}>
                  <Archive className="h-4 w-4" aria-hidden="true" />
                  Archive
                </Button>
                {shown.status === "verified" ? (
                  <Button variant="secondary" onClick={() => void setStatus("superseded")} loading={busy === "superseded"} disabled={busy !== null}>
                    Mark superseded
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
