import { explorerAddressUrl, isEvmAddress } from "@kletia/core";
import type { ContractWithRevisions } from "@kletia/sdk";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { navigate } from "../../../routes/history";
import { lineFor } from "../../../site/art";
import { LineBullet } from "../../../site/art/LineBullet";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { ButtonLink } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { PortalTabs } from "../portal/PortalTabs";
import { httpsUrl } from "../portal/portalFormat";
import { useNow } from "../portal/useNow";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import {
  ContractActions,
  ContractDomain,
  ContractEntries,
  ContractPinsAndVerification,
  ContractRecentCalls,
  ContractRevisions,
  ContractTest,
} from "./ContractDetail";
import { contractRowModel, contractTabOf, type ContractTab } from "./contractRows";

/** Replaces `?tab=` without a router navigation (no focus move, no history entry). */
function replaceTab(tab: ContractTab): void {
  const url = new URL(window.location.href);
  if (tab === "overview") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function ContractView({ contractId, search }: { readonly contractId: string; readonly search: URLSearchParams }) {
  const { key } = useSessionKey();
  const developer = portalKeyKind(key) === "developer";
  const [tab, setTab] = useState<ContractTab>(() => contractTabOf(search));
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useApiResource<ContractWithRevisions>(`contract:${maskKey(key)}:${contractId}:${generation}`, (_client, signal) =>
    keyedClient(key).contracts.get(contractId, { signal: sdkSignal(signal) }),
  );
  const contract = detail.data ?? null;
  const counting = Boolean(contract && (contract.status === "pending" || contract.pendingRevision !== null));
  const now = useNow(1_000, counting);

  if (detail.status === "loading" && !contract) {
    return (
      <>
        <PortalPageHeader title="Contract" back={{ label: "Contracts", to: "/developers/contracts" }} />
        <SkeletonGroup label="Loading the registration" className="flex flex-col gap-3">
          <Skeleton surface="card" className="h-12" />
          <Skeleton surface="card" className="h-64" />
        </SkeletonGroup>
      </>
    );
  }
  if (!contract) {
    const missing = detail.error?.code === "CONTRACT_NOT_FOUND" || detail.error?.status === 404;
    return (
      <>
        <PortalPageHeader title={missing ? "No contract here" : "Contract"} back={{ label: "Contracts", to: "/developers/contracts" }} />
        {missing ? (
          <div className={cx("flex flex-col items-start gap-3 p-5", INK_BORDER, SURFACE)}>
            <p className="text-sm">
              The key in this tab has no registration <code className="font-code">{contractId}</code>. It may have been deleted, or it belongs to another key.
            </p>
            <ButtonLink to="/developers/contracts" size="sm" variant="secondary">
              Back to the contracts
            </ButtonLink>
          </div>
        ) : detail.error ? (
          <ApiErrorPanel error={detail.error} title="Could not read this registration" onRetry={detail.reload} />
        ) : null}
      </>
    );
  }

  const row = contractRowModel(contract, now);
  const target = contract.vm === "evm" ? contract.address ?? "" : contract.origin ?? "";
  const explorer = contract.vm === "evm" && isEvmAddress(target) ? httpsUrl(explorerAddressUrl(contract.network, target)) : null;
  const line = lineFor(contract.network);
  const select = (next: ContractTab) => {
    setTab(next);
    replaceTab(next);
  };
  const onChanged = (message: string, removed = false) => {
    if (removed) {
      navigate("/developers/contracts");
      return;
    }
    setNotice(message);
    setGeneration((value) => value + 1);
  };

  return (
    <>
      <PortalPageHeader
        title={row.title}
        back={{ label: "Contracts", to: "/developers/contracts" }}
        actions={<ContractActions contract={contract} apiKey={key} onChanged={onChanged} canWrite={developer} />}
        meta={
          <>
            <StatusEntryPill entry={row.status} />
            <span>
              {row.integrator} · revision {contract.revision}
              {contract.activeRevision !== null && contract.activeRevision !== contract.revision ? ` (serving ${contract.activeRevision})` : ""} · {contract.visibility}
            </span>
            {row.detail ? <span className="font-semibold">{row.detail}</span> : null}
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          {line ? <LineBullet line={line} /> : null}
          <code className="min-w-0 break-all font-code text-[13px]">{target}</code>
          {target ? <CopyButton text={target} label={contract.vm === "evm" ? "Copy the address" : "Copy the origin"} appearance="light" /> : null}
          {explorer ? (
            <a href={explorer} target="_blank" rel="noopener noreferrer" className={cx("inline-flex min-h-9 items-center gap-1 font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
              Explorer
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </PortalPageHeader>

      <div className="flex min-w-0 flex-col gap-4">
        <div aria-live="polite">{notice ? <p className="border-l-[6px] border-success bg-success-bg px-3 py-2 text-sm text-fg">{notice}</p> : null}</div>
        <PortalTabs
          label="Contract"
          active={tab}
          onChange={select}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "entries", label: "Entries", note: String(contract.actions.length) },
            { id: "test", label: "Test" },
            { id: "pins", label: "Pins and verification" },
            { id: "revisions", label: "Revisions", note: String(contract.revisions?.length ?? 1) },
            { id: "domain", label: "Domain" },
          ]}
        >
          <div className={cx("min-w-0 border-[3px] border-t-0 border-control p-4 sm:p-6", SURFACE)}>
            {tab === "overview" ? (
              <div className="flex min-w-0 flex-col gap-6">
                <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div className="min-w-0">
                    <dt className={cx(LABEL, TEXT_MUTED)}>Status</dt>
                    <dd className="mt-1">
                      <StatusEntryPill entry={row.status} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={cx(LABEL, TEXT_MUTED)}>Source</dt>
                    <dd className="mt-1">
                      <StatusEntryPill entry={row.source} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={cx(LABEL, TEXT_MUTED)}>Domain</dt>
                    <dd className="mt-1">
                      <StatusEntryPill entry={row.domain} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={cx(LABEL, TEXT_MUTED)}>Who can call it</dt>
                    <dd className="mt-1">{contract.visibility === "project" ? "Every key of your project" : "This key only"}</dd>
                  </div>
                </dl>
                <section aria-labelledby="contract-overview-entries" className="flex min-w-0 flex-col gap-2">
                  <h2 id="contract-overview-entries" className={LABEL}>
                    What users see in the review
                  </h2>
                  <ContractEntries contract={contract} />
                </section>
                <section aria-labelledby="contract-overview-calls" className="flex min-w-0 flex-col gap-2">
                  <h2 id="contract-overview-calls" className={LABEL}>
                    Recent call steps
                  </h2>
                  <ContractRecentCalls contract={contract} apiKey={key} />
                </section>
              </div>
            ) : tab === "entries" ? (
              <ContractEntries contract={contract} />
            ) : tab === "test" ? (
              <ContractTest contract={contract} apiKey={key} />
            ) : tab === "pins" ? (
              <ContractPinsAndVerification contract={contract} />
            ) : tab === "revisions" ? (
              <ContractRevisions contract={contract} />
            ) : (
              <ContractDomain contract={contract} />
            )}
          </div>
        </PortalTabs>
      </div>
    </>
  );
}

/** One registration (`/developers/contracts/:contractId?tab=`): overview, entries, test, pins, revisions and domain. */
export function ContractPage({ contractId, search }: { readonly contractId: string; readonly search: URLSearchParams }) {
  const { key } = useSessionKey();
  if (portalKeyKind(key)) return <ContractView contractId={contractId} search={search} />;
  return (
    <>
      <PortalPageHeader title="Contract" back={{ label: "Contracts", to: "/developers/contracts" }} />
      <KeyGate purpose="read, test and reverify this registration" agentKeys>
        {null}
      </KeyGate>
    </>
  );
}
