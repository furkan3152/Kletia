import type { ContractView } from "@kletia/core";
import { ChevronDown, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { lineFor } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { LineBullet } from "../../../site/art/LineBullet";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { NeedKey } from "../portal/NeedKey";
import { PortalTabs } from "../portal/PortalTabs";
import { useNow } from "../portal/useNow";
import { ContractDetail } from "./ContractDetail";
import { contractStatus } from "./contractModel";
import { RegisterContractWizard } from "./RegisterContractWizard";
import { SolanaActionForm } from "./SolanaActionForm";

const STRIPE: Readonly<Record<string, string>> = { green: "#0B7A4B", yellow: "#FFD60A", red: "#C8102E" };

function sourceBadge(contract: ContractView): { label: string; tone: "green" | "yellow" | "neutral" } {
  if (contract.vm === "svm") {
    const programs = contract.verification.programs ?? [];
    const verified = programs.length > 0 && programs.every((program) => program.verified === true);
    return verified ? { label: "Programs verified", tone: "green" } : { label: "Programs not all verified", tone: "yellow" };
  }
  const status = contract.verification.source?.status ?? "unknown";
  if (status === "exact_match" || status === "match") return { label: "Source verified", tone: "green" };
  return { label: status === "unverified" ? "Source not verified" : "Source unknown", tone: "yellow" };
}

function ContractRow({ contract, now, open, onToggle, apiKey, onChanged }: { readonly contract: ContractView; readonly now: number; readonly open: boolean; readonly onToggle: () => void; readonly apiKey: string; readonly onChanged: (message: string, removed?: boolean) => void }) {
  const status = contractStatus(contract, now);
  const line = lineFor(contract.network);
  const source = sourceBadge(contract);
  const panelId = `contract-${contract.id}`;
  return (
    <li className={cx("relative flex min-w-0 flex-col gap-3 py-4 pl-6 pr-4 sm:pr-5", INK_BORDER, SURFACE)}>
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-2.5 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: STRIPE[status.tone] }} />
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-2 font-display text-lg font-bold leading-tight">
            {line ? <LineBullet line={line} /> : null}
            <span className="min-w-0 break-words">{contract.integrator.name}</span>
            <span className={cx("font-code text-[11px] font-bold", TEXT_MUTED)}>{contract.id}</span>
          </p>
          <p className="mt-1 break-all font-code text-[12px]">{contract.vm === "evm" ? contract.address : contract.origin}</p>
          <p className={cx("mt-1 text-sm", TEXT_MUTED)}>{contract.actions.map((action) => action.label).join(" · ")}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Badge tone="outline">r{contract.revision}{contract.activeRevision !== null && contract.activeRevision !== contract.revision ? ` · serving r${contract.activeRevision}` : ""}</Badge>
        <Badge tone="outline">{contract.visibility}</Badge>
        <Badge tone={source.tone}>{source.label}</Badge>
        <Badge tone={contract.integrator.domainVerified ? "green" : "yellow"}>{contract.integrator.domainVerified ? "Domain verified" : "Domain not verified"}</Badge>
      </div>
      {status.detail ? <p className={cx("text-sm font-semibold", status.tone === "red" && "text-[#B91C1C] dark:text-[#FCA5A5]")}>{status.detail}</p> : null}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className={cx("inline-flex min-h-10 items-center gap-1.5 self-start text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4", FOCUS_RING)}
      >
        <ChevronDown className={cx("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
        {open ? "Hide details" : "Details, test and reverify"}
      </button>
      {open ? (
        <div id={panelId} className="min-w-0">
          <ContractDetail contract={contract} apiKey={apiKey} onChanged={onChanged} />
        </div>
      ) : null}
    </li>
  );
}

type Mode = "list" | "evm" | "svm";

/** Developer portal: your custom contract registrations (BYOC design §7.4). The key stays in memory only. */
export default function ContractsPanel() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const [mode, setMode] = useState<Mode>("list");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useApiResource<ContractView[]>(kind ? `contracts:${maskKey(key)}` : null, (_client, signal) => keyedClient(key).contracts.list({}, { signal: sdkSignal(signal) }));
  // Tick only while a countdown is on screen.
  const counting = mode === "list" && (list.data ?? []).some((contract) => contract.status === "pending" || contract.pendingRevision !== null);
  const now = useNow(1_000, counting);

  if (!kind) return <NeedKey purpose="list, register, test and reverify contracts for your own project integration" agentKeys />;

  const contracts = list.data ?? [];
  const onChanged = (message: string, removed = false) => {
    setNotice(message);
    if (removed) setOpen(null);
    list.reload();
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className={cx("max-w-3xl text-sm leading-relaxed", TEXT_MUTED)}>
        Registrations stay in your project and run through your own SDK, widget or integrator embed.
        Kletia&apos;s main website does not execute custom contract calls. Registration does not add a contract to the public protocol catalog.
      </p>
      <PortalTabs
        label="Contracts"
        active={mode}
        onChange={(next) => {
          setMode(next);
          setNotice(null);
        }}
        tabs={[
          { id: "list", label: "Registrations", note: list.data ? String(contracts.length) : undefined },
          { id: "evm", label: "Register EVM contract" },
          { id: "svm", label: "Register Solana Action" },
        ]}
      >
        {mode === "list" ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className={cx(LABEL, TEXT_MUTED)}>
                {list.status === "loading" ? (
                  "Loading…"
                ) : (
                  <>
                    {contracts.length} of at most 25 registrations for <span className="font-code normal-case tracking-normal">{maskKey(key)}</span>
                  </>
                )}
              </p>
              <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload registrations">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Reload
              </Button>
            </div>
            <div aria-live="polite">
              {notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">{notice}</p> : null}
            </div>
            {list.status === "loading" && !list.data ? (
              <SkeletonGroup label="Loading registrations" className="flex flex-col gap-3">
                <Skeleton surface="card" className="h-28" />
                <Skeleton surface="card" className="h-28" />
              </SkeletonGroup>
            ) : list.status === "error" && list.error ? (
              <ApiErrorPanel error={list.error} title="Could not list registrations" onRetry={list.reload} />
            ) : contracts.length === 0 ? (
              <div className={cx("flex flex-col items-start gap-4 p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
                <Icon name="contract" size={36} />
                <p className="font-display text-xl font-bold">No contracts registered with this key yet.</p>
                <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
                  Register your own EVM contract functions or a Solana Actions endpoint, and intents created with this key can call them. Kletia
                  pins the code, simulates every call and verifies the outcome on-chain. It does not audit your contract.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setMode("evm")}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Register an EVM contract
                  </Button>
                  <Button variant="secondary" onClick={() => setMode("svm")}>
                    Register a Solana Action
                  </Button>
                </div>
              </div>
            ) : (
              <ul className="flex min-w-0 flex-col gap-4">
                {contracts.map((contract) => (
                  <ContractRow
                    key={contract.id}
                    contract={contract}
                    now={now}
                    open={open === contract.id}
                    onToggle={() => setOpen((current) => (current === contract.id ? null : contract.id))}
                    apiKey={key}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : mode === "evm" ? (
          <RegisterContractWizard
            apiKey={key}
            onRegistered={(contract) => {
              setNotice(`Registered ${contract.integrator.name} (${contract.id}).`);
              list.reload();
            }}
            onCancel={() => setMode("list")}
          />
        ) : (
          <SolanaActionForm
            apiKey={key}
            onRegistered={(contract) => {
              setNotice(`Registered ${contract.integrator.name} (${contract.id}).`);
              list.reload();
            }}
            onCancel={() => setMode("list")}
          />
        )}
      </PortalTabs>
    </div>
  );
}
