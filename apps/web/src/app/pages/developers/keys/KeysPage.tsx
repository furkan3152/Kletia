import type { ApiKeySummary } from "@kletia/sdk";
import { Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { useNow } from "../portal/useNow";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { AuthTable } from "./AuthTable";
import { IssueKeySheet } from "./IssueKeySheet";
import { keyedClient } from "./keyClient";
import { KeysTable } from "./KeysTable";
import { maskKey, portalKeyKind, useSessionKey } from "./sessionKey";
import { UsagePanel } from "./UsagePanel";

/** The keys the loaded key may see: its project's (developer key) or its own subtree (agent key). */
function ProjectKeys() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const now = useNow(30_000);
  const list = useApiResource<ApiKeySummary[]>(kind ? `keys:${maskKey(key)}` : null, (_client, signal) => keyedClient(key).keys.list({ signal: sdkSignal(signal) }));
  const keys = list.data ?? [];

  return (
    <section aria-labelledby="keys-list" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="keys-list" className={cx(LABEL, TEXT_MUTED)}>
          {kind === "agent" ? "Keys under " : list.data ? `${keys.length} ${keys.length === 1 ? "key" : "keys"} in the project of ` : "Keys in the project of "}
          <span className="font-code normal-case tracking-normal">{maskKey(key)}</span>
        </h2>
        <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload keys">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {kind === "agent" ? (
        <p className={cx("text-sm", TEXT_MUTED)}>
          Agent keys never manage project keys: this is the agent key and the keys issued under it. Load a developer key to see the whole project.
        </p>
      ) : null}
      {list.status === "loading" && !list.data ? (
        <SkeletonGroup label="Loading keys" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-12" />
          <Skeleton surface="card" className="h-12" />
          <Skeleton surface="card" className="h-12" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list keys" onRetry={list.reload} />
      ) : (
        <KeysTable keys={keys} now={now} onChanged={list.reload} />
      )}
    </section>
  );
}

/**
 * Keys and usage (`/developers/keys`): the project's keys with kind,
 * status and lane, "Issue a key" in a sheet (sandbox or live), the usage
 * of the key in this tab by route, and the authentication reference.
 * Issuing works without a key: this is where a first key comes from.
 * from.
 */
export function KeysPage() {
  const { key } = useSessionKey();
  const [issuing, setIssuing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const kind = portalKeyKind(key);

  return (
    <>
      <PortalPageHeader
        title="Keys and usage"
        intro="Issue, rotate and revoke the keys of your project and read their usage. Keys belong on servers: a kl_dev_ key manages your webhooks and keys, and browsers use the public tier or a publishable key."
        actions={
          <Button onClick={() => setIssuing(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Issue a key
          </Button>
        }
      />
      <div className="flex min-w-0 flex-col gap-10">
        <div className="flex items-start gap-3 border-[3px] border-[#1A1A1A] bg-[#1A1A1A] p-4 text-white dark:border-[#4B5563] dark:bg-[#060A14]">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#FFD60A]" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-white/80">
            <span className="font-bold text-white">Keys belong on servers.</span> Keep <code className="font-code">kl_dev_</code> and{" "}
            <code className="font-code">kl_agt_</code> keys in your server&apos;s secret store, never in browser code. This page holds a key only in
            this tab&apos;s memory; reloading forgets it.
          </p>
        </div>
        <KeyGate purpose="list, rotate and revoke the keys of your project and read their usage" agentKeys>
          <div key={generation} className="flex min-w-0 flex-col gap-10">
            <ProjectKeys />
            {kind ? <UsagePanel /> : null}
          </div>
        </KeyGate>
        <AuthTable />
      </div>
      <IssueKeySheet open={issuing} onClose={() => setIssuing(false)} onIssued={() => setGeneration((value) => value + 1)} />
    </>
  );
}
