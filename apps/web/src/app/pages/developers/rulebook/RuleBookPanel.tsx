import "./rulebook.css";

import type { ContractView, PolicyDocument } from "@kletia/core";
import type { ApiKeySummary, PolicyReadResponse } from "@kletia/sdk";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { NeedKey } from "../portal/NeedKey";
import { PortalTabs } from "../portal/PortalTabs";
import { useNow } from "../portal/useNow";
import { AgentKeyForm } from "./AgentKeyForm";
import { DecisionBoard } from "./DecisionBoard";
import { InspectionDesk } from "./InspectionDesk";
import { KeyTreeMap, type StationState } from "./KeyTreeMap";
import { buildKeyTree } from "./policyModel";
import { RuleBookEditor, type BookScope } from "./RuleBookEditor";

type Tab = "book" | "desk" | "board" | "agents";

function stationOf(read: PolicyReadResponse | null | undefined): StationState {
  const head = read?.policy ?? null;
  const document = head && head.status !== "none" ? head.document : null;
  return { mode: document?.mode ?? null, version: head && head.status !== "none" ? head.version : null, pending: Boolean(head?.pending) };
}

/**
 * The Rule Book in the developer portal (policy design §12.4): the key tree
 * as a branch line, each key's rule book as a booklet of 13 articles, the
 * inspection desk (the simulator), the decision board and agent keys. The
 * key stays in this tab's memory only.
 */
export default function RuleBookPanel() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const [tab, setTab] = useState<Tab>("book");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<PolicyDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const tag = kind ? `${maskKey(key)}:${generation}` : null;

  const keys = useApiResource<ApiKeySummary[]>(tag ? `rb-keys:${tag}` : null, (_client, signal) => keyedClient(key).keys.list({ signal: sdkSignal(signal) }));
  const contracts = useApiResource<ContractView[]>(tag ? `rb-contracts:${tag}` : null, (_client, signal) => keyedClient(key).contracts.list({}, { signal: sdkSignal(signal) }));
  const liveKeys = useMemo(() => (keys.data ?? []).filter((item) => !item.revokedAt), [keys.data]);
  const ids = liveKeys.map((item) => item.id).join(",");
  const heads = useApiResource<Map<string, StationState>>(tag && ids ? `rb-heads:${tag}:${ids}` : null, async (_client, signal) => {
    const client = keyedClient(key);
    const entries = await Promise.all(
      liveKeys.slice(0, 40).map(async (item) => {
        try {
          return [item.id, stationOf(await client.policies.get(item.id, { signal: sdkSignal(signal) }))] as const;
        } catch {
          return [item.id, { mode: null, version: item.policyVersion ?? null, pending: false }] as const;
        }
      }),
    );
    return new Map(entries);
  });
  const project = useApiResource<PolicyReadResponse>(tag ? `rb-project:${tag}` : null, (_client, signal) => keyedClient(key).policies.project.get({ signal: sdkSignal(signal) }));

  const tree = useMemo(() => buildKeyTree(liveKeys), [liveKeys]);
  const current = liveKeys.find((item) => item.current);
  const selectedId = selected && (selected === "project" || liveKeys.some((item) => item.id === selected)) ? selected : current?.id ?? liveKeys[0]?.id ?? "project";
  const selectedKey = liveKeys.find((item) => item.id === selectedId) ?? null;
  const scope: BookScope = selectedKey ? { kind: "key", key: selectedKey } : { kind: "project" };
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of keys.data ?? []) map.set(item.id, item.name);
    const projectId = project.data?.policy && "projectId" in project.data.policy ? (project.data.policy as { projectId?: string }).projectId : undefined;
    if (projectId) map.set(projectId, "Project");
    return map;
  }, [keys.data, project.data]);
  const pendingAnywhere = [...(heads.data?.values() ?? [])].some((state) => state.pending) || Boolean(project.data?.policy?.pending);
  const now = useNow(pendingAnywhere ? 1_000 : 30_000);
  const onDraft = useCallback((next: PolicyDocument | null) => setDraft(next), []);

  if (!kind) return <NeedKey purpose="read and edit rule books, run the simulator, read the decision log and issue agent keys" agentKeys />;

  const refreshAll = (message: string) => {
    setNotice(message);
    setGeneration((value) => value + 1);
  };
  const canWrite = kind === "developer";
  const projectKeys = liveKeys.filter((item) => item.kind !== "agent").map((item) => ({ id: item.id, name: item.name }));
  const deskKeys = liveKeys.map((item) => ({ id: item.id, name: `${item.name}${item.kind === "agent" ? " (agent)" : ""}` }));

  if (keys.status === "loading" && !keys.data) {
    return (
      <SkeletonGroup label="Loading the key tree" className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
        <Skeleton surface="card" className="h-64" />
        <Skeleton surface="card" className="h-96" />
      </SkeletonGroup>
    );
  }
  if (keys.status === "error" && keys.error) return <ApiErrorPanel error={keys.error} title="Could not list the keys" onRetry={keys.reload} />;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={cx(LABEL, TEXT_MUTED)}>
          {liveKeys.length} {liveKeys.length === 1 ? "key" : "keys"} · read with <span className="font-code normal-case tracking-normal">{maskKey(key)}</span>
          {kind === "agent" ? " (agent key: its own subtree only)" : ""}
        </p>
        <Button size="sm" variant="ghost" onClick={() => refreshAll("")} aria-label="Reload keys and rule books">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      <div aria-live="polite">
        {notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">{notice}</p> : null}
      </div>
      <div className="grid min-w-0 gap-6 xl:grid-cols-[17rem_minmax(0,1fr)] xl:items-start">
        <div className="min-w-0 xl:sticky xl:top-28">
          <KeyTreeMap
            nodes={tree}
            states={heads.data ?? new Map()}
            project={project.data ? stationOf(project.data) : null}
            selected={selectedId}
            onSelect={(id) => {
              setSelected(id);
              setDraft(null);
            }}
          />
        </div>
        <PortalTabs
          label="Rule Book"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "book", label: "Rule book" },
            { id: "desk", label: "Inspection desk" },
            { id: "board", label: "Decision board" },
            { id: "agents", label: "Agent keys", note: String(liveKeys.filter((item) => item.kind === "agent").length) },
          ]}
        >
          {/* The editor stays mounted while another tab is open, so an unsaved draft survives (and the desk can use it). */}
          <div hidden={tab !== "book"}>
            <RuleBookEditor
              key={selectedId}
              scope={scope}
              apiKey={key}
              canWrite={canWrite}
              contracts={contracts.data ?? null}
              projectKeys={projectKeys}
              now={now}
              onDraft={onDraft}
              onSaved={refreshAll}
            />
          </div>
          {tab === "book" ? null : tab === "desk" ? (
            <InspectionDesk apiKey={key} keys={deskKeys} keyId={selectedKey?.id ?? null} draft={selectedKey ? draft : null} names={names} />
          ) : tab === "board" ? (
            <DecisionBoard apiKey={key} keys={deskKeys} names={names} />
          ) : (
            <AgentKeyForm apiKey={key} keys={liveKeys} tree={tree} contracts={contracts.data ?? null} selected={selectedId} onChanged={refreshAll} />
          )}
        </PortalTabs>
      </div>
    </div>
  );
}
