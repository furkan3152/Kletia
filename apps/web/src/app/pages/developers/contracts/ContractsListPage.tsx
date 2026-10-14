import type { ContractView } from "@kletia/core";
import { Plus, RefreshCw } from "lucide-react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { lineFor } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { LineBullet } from "../../../site/art/LineBullet";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { DataTable } from "../../../site/ui/DataTable";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { useNow } from "../portal/useNow";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { contractCountLine, contractRowModel } from "./contractRows";

const CONTRACTS_INTRO =
  "Your own contract functions and Solana Actions, pinned and simulated before every call. Kletia does not audit them.";

/** The key's registrations (shared by the list and the contract page). */
function useContractList(apiKey: string) {
  return useApiResource<ContractView[]>(portalKeyKind(apiKey) ? `contracts:${maskKey(apiKey)}` : null, (_client, signal) =>
    keyedClient(apiKey).contracts.list({}, { signal: sdkSignal(signal) }),
  );
}

function ContractsTable() {
  const { key } = useSessionKey();
  const developer = portalKeyKind(key) === "developer";
  const list = useContractList(key);
  const contracts = list.data ?? [];
  // Tick only while a countdown is on screen.
  const counting = contracts.some((contract) => contract.status === "pending" || contract.pendingRevision !== null);
  const now = useNow(1_000, counting);
  const count = contractCountLine(list);
  const rows = contracts.map((contract) => ({ contract, row: contractRowModel(contract, now) }));

  return (
    <section aria-label="Registrations" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {count ? (
          <p className={cx(LABEL, TEXT_MUTED)}>
            {count} for <span className="font-code normal-case tracking-normal">{maskKey(key)}</span>
          </p>
        ) : (
          <span />
        )}
        <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload registrations">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {list.status === "loading" && !list.data ? (
        <SkeletonGroup label="Loading registrations" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-14" />
          <Skeleton surface="card" className="h-14" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list registrations" onRetry={list.reload} />
      ) : (
        <DataTable
          caption="Contract registrations of this key"
          rows={rows}
          rowKey={({ row }) => row.id}
          rowHref={({ row }) => `/developers/contracts/${row.id}`}
          rowLabel={({ row }) => `Open ${row.title}`}
          empty={
            <div className={cx("flex flex-col items-start gap-4 p-5 sm:p-6", INK_BORDER, SURFACE)}>
              <Icon name="contract" size={32} />
              <p className="font-display text-title font-bold">No contracts registered with this key yet.</p>
              <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
                Register your own EVM contract functions or a Solana Actions endpoint, and intents created with this key can call them. Kletia
                pins the code, simulates every call and verifies the outcome on-chain.
              </p>
              {developer ? (
                <div className="flex flex-wrap gap-2">
                  <ButtonLink to="/developers/contracts/new?vm=evm" size="sm">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Register EVM contract
                  </ButtonLink>
                  <ButtonLink to="/developers/contracts/new?vm=svm" size="sm" variant="secondary">
                    Register Solana Action
                  </ButtonLink>
                </div>
              ) : null}
            </div>
          }
          columns={[
            {
              key: "status",
              header: "Status",
              phone: "primary",
              cell: ({ row }) => <StatusEntryPill entry={row.status} />,
            },
            {
              key: "name",
              header: "Name · address",
              phone: "primary",
              cell: ({ row }) => (
                <span className="flex min-w-0 flex-col">
                  <Link to={`/developers/contracts/${row.id}`} className={cx("break-words font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                    {row.title}
                  </Link>
                  <span className={cx("break-all text-[13px] font-normal", TEXT_MUTED)}>
                    {row.integrator} · <span className="font-code">{row.target}</span>
                  </span>
                  {row.detail ? <span className="text-[13px] font-semibold">{row.detail}</span> : null}
                </span>
              ),
            },
            {
              key: "network",
              header: "Network",
              cell: ({ contract }) => {
                const line = lineFor(contract.network);
                return line ? <LineBullet line={line} /> : contract.network;
              },
            },
            { key: "entries", header: "Entries", cell: ({ row }) => <span className="font-code text-[13px]">{row.entries}</span> },
            { key: "source", header: "Source", cell: ({ row }) => <StatusEntryPill entry={row.source} /> },
            { key: "domain", header: "Domain", cell: ({ row }) => <StatusEntryPill entry={row.domain} /> },
          ]}
        />
      )}
      {!developer ? (
        <p className={cx("text-sm", TEXT_MUTED)}>
          An agent key reads and tests its own registrations; registering, changing and deleting one takes a developer key or a rule book that
          grants permissions.registerContracts.
        </p>
      ) : null}
    </section>
  );
}

/** Contracts (`/developers/contracts`): the key's registrations as table rows; each opens its own page. */
export function ContractsListPage() {
  const { key } = useSessionKey();
  const developer = portalKeyKind(key) === "developer";
  return (
    <>
      <PortalPageHeader
        title="Contracts"
        intro={CONTRACTS_INTRO}
        actions={
          developer ? (
            <>
              <ButtonLink to="/developers/contracts/new?vm=evm">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Register EVM contract
              </ButtonLink>
              <ButtonLink to="/developers/contracts/new?vm=svm" variant="secondary">
                Register Solana Action
              </ButtonLink>
            </>
          ) : null
        }
      />
      <KeyGate purpose="list, register, test and reverify your contracts" agentKeys>
        <ContractsTable />
      </KeyGate>
    </>
  );
}
