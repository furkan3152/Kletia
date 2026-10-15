/**
 * Export (admin design B.6): every verified new deployment as JSON, for the
 * lead to pin in a release. The request is audited (`export.download`), so
 * the panel fetches it only when asked.
 */
import { Download, FileJson } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { JsonView } from "../../../site/ui/JsonView";
import { cx, TEXT_MUTED } from "../../../site/ui/styles";
import { exportFileName } from "../api/adminClient";
import { useAdmin } from "../api/useAdmin";
import { AdminError } from "../components/AdminError";
import { EmptyState, SectionHeader } from "../components/SectionHeader";
import type { AdminExport } from "../model/types";

export function ExportSection() {
  const { client } = useAdmin();
  const [data, setData] = useState<AdminExport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const count = data ? Object.values(data.networks).reduce((sum, entries) => sum + (entries?.length ?? 0), 0) : 0;
  const text = data ? `${JSON.stringify(data, null, 2)}\n` : "";

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await client.exportDeployments());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(data.exportedAt);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="transfer"
        eyebrow="Export"
        title="Hand the addresses back"
        intro="Every verified new deployment with its constructor arguments, code hashes, compiler profile and explorer link. Pinned contracts are already in the repository and are not repeated."
        actions={
          <Button onClick={() => void load()} loading={busy}>
            <FileJson className="h-4 w-4" aria-hidden="true" />
            {data ? "Export again" : "Prepare the export"}
          </Button>
        }
      />
      {error ? <AdminError error={error} title="The export failed" onRetry={() => void load()} /> : null}
      {!data && !error ? <EmptyState>Preparing an export is logged in the audit log. Nothing is fetched until you ask.</EmptyState> : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="accent" onClick={download} disabled={count === 0}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Download {exportFileName(data.exportedAt)}
            </Button>
            <span className="inline-flex items-center gap-2 text-sm font-bold">
              <CopyButton text={text} label="Copy the export JSON" appearance="light" />
              Copy JSON
            </span>
            <span className={cx("text-sm", TEXT_MUTED)}>
              {count} verified deployment{count === 1 ? "" : "s"}, API commit {data.apiCommit ? data.apiCommit.slice(0, 7) : "unknown"}.
            </span>
          </div>
          {count === 0 ? <EmptyState>No verified new deployments yet. Deploy and verify one first.</EmptyState> : null}
          <JsonView value={data} label="deployments export" />
        </>
      ) : null}
    </div>
  );
}
