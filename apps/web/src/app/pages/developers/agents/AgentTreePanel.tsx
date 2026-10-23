/**
 * The Agents page (docs/platform/subagents.md): open sub-agent requests as
 * approval cards (what is granted beside the parent's own value), the agent
 * tree with each key's caps and 24 h / 7 d use, and revoke and pause. A
 * project key decides here; the owner wallet signs instead when no key
 * holder should. Agent keys see their own subtree and its requests, read-only
 * apart from revoking their descendants.
 */
import { Ban, CheckCircle2, PauseCircle, RefreshCw, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { isPlatformError } from "../keys/accountClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { formatWhen } from "../portal/portalFormat";
import { useNow } from "../portal/useNow";
import { approvalCards, formatUsd, requestStatusText, treeRows, type ApprovalCard, type SubagentRequest, type TreeRow, type UsageBar } from "./agentTreeModel";
import { agentsApi } from "./agentsClient";
import { WalletDecision } from "./WalletDecision";

const TONE: Readonly<Record<UsageBar["tone"], string>> = { ok: "bg-[#16A34A]", warn: "bg-[#D97706]", full: "bg-[#B91C1C]" };

function Bar({ bar }: { readonly bar: UsageBar }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 text-[12px]">
        <span className={LABEL}>{bar.label}</span>
        <span className="font-code">
          {formatUsd(bar.usedUsd)} {bar.capUsd ? `of ${formatUsd(bar.capUsd)}` : "(no cap of its own)"}
        </span>
      </div>
      {bar.capUsd ? (
        <div className="mt-1 h-2 border-2 border-[#1A1A1A] dark:border-[#4B5563]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.percent} aria-label={`${bar.label} use of the cap`}>
          <div className={cx("h-full", TONE[bar.tone])} style={{ width: `${bar.percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function RequestCard({ card, projectKey, onChanged }: { readonly card: ApprovalCard; readonly projectKey: string | null; readonly onChanged: (message: string) => void }) {
  const { request } = card;
  const [wallet, setWallet] = useState<"approve" | "deny" | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const withKey = async (decision: "approve" | "deny") => {
    if (!projectKey) return;
    setBusy(decision);
    setError(null);
    try {
      const decided = await agentsApi.decideWithKey(projectKey, request.id, decision);
      onChanged(`${decided.name}: ${decided.status}.`);
    } catch (failure) {
      setError(isPlatformError(failure) ? failure.message : "The decision could not be sent.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{request.name}</h3>
        <span className={cx("text-xs", TEXT_MUTED)}>
          asked by <code className="font-code">{request.parentKeyId}</code> · {card.expiresIn}
        </span>
      </div>
      <p className="text-sm">{request.purpose}</p>
      <table className="w-full text-left text-sm">
        <caption className={cx(LABEL, "pb-1 text-left")}>What the sub-agent gets, beside its parent</caption>
        <thead>
          <tr className={cx("text-[12px]", TEXT_MUTED)}>
            <th scope="col" className="pr-2 font-semibold">Rule</th>
            <th scope="col" className="pr-2 font-semibold">Sub-agent</th>
            <th scope="col" className="font-semibold">Parent</th>
          </tr>
        </thead>
        <tbody>
          {card.narrower.map((line) => (
            <tr key={line.path} className="align-top">
              <th scope="row" className="pr-2 font-semibold">{line.label}</th>
              <td className="pr-2 font-code text-[13px] font-bold">{line.child}</td>
              <td className={cx("font-code text-[13px]", TEXT_MUTED)}>{line.parent}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={cx("text-xs", TEXT_MUTED)}>
        Same as the parent: {card.same.map((line) => line.label.toLowerCase()).join(", ") || "nothing"}. Permissions: <strong>{card.permissions}</strong>. Key expires {formatWhen(request.keyExpiresAt)}. Rule book <code className="font-code">{card.hashShort}</code>.
      </p>
      {error ? (
        <p role="alert" className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {wallet ? (
        <WalletDecision request={request} decision={wallet} onCancel={() => setWallet(null)} onDone={(decided) => onChanged(`${decided.name}: ${decided.status}.`)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {projectKey ? (
            <>
              <Button variant="accent" onClick={() => void withKey("approve")} loading={busy === "approve"} disabled={busy !== null}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Approve with this key
              </Button>
              <Button variant="secondary" onClick={() => void withKey("deny")} loading={busy === "deny"} disabled={busy !== null}>
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Deny
              </Button>
            </>
          ) : null}
          <Button variant={projectKey ? "ghost" : "accent"} onClick={() => setWallet("approve")} disabled={busy !== null}>
            Approve with the owner wallet
          </Button>
          <Button variant="ghost" onClick={() => setWallet("deny")} disabled={busy !== null}>
            Deny with the owner wallet
          </Button>
        </div>
      )}
    </li>
  );
}

function NodeRow({ row, apiKey, projectKey, ownId, onChanged }: { readonly row: TreeRow; readonly apiKey: string; readonly projectKey: boolean; readonly ownId: string | null; readonly onChanged: (message: string) => void }) {
  const { node } = row;
  const [busy, setBusy] = useState<"pause" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "pause" | "revoke") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "pause") await agentsApi.pause(apiKey, node.id);
      else await agentsApi.revoke(apiKey, node.id);
      onChanged(action === "pause" ? `${node.name} and everything below it are paused.` : `${node.name} and ${row.descendants} key(s) below it are revoked.`);
    } catch (failure) {
      setError(isPlatformError(failure) ? failure.message : "The action could not be sent.");
    } finally {
      setBusy(null);
    }
  };
  const agent = node.kind === "agent";
  return (
    <li className={cx("flex min-w-0 flex-col gap-2 border-l-[3px] border-[#1A1A1A] py-2 pl-3 dark:border-[#4B5563]")} style={{ marginLeft: `${row.indent * 1.25}rem` }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-display text-[15px] font-bold">{node.name}</span>
        <span className={cx(LABEL, "border-2 border-current px-1 text-[12px]")}>{agent ? "agent" : "project key"}</span>
        <span className={cx(LABEL, "text-[12px]", node.chainMode === "paused" ? "text-[#B91C1C]" : TEXT_MUTED)}>
          {node.chainMode === "paused" ? (row.pausedAbove ? "paused by a parent" : "paused") : node.chainMode === "dry-run" ? "dry run" : "live"}
        </span>
        <code className={cx("font-code text-[12px]", TEXT_MUTED)}>{node.id}</code>
        <span className={cx("text-[12px]", TEXT_MUTED)}>{node.expiresAt ? `expires ${formatWhen(node.expiresAt)}` : "no expiry"}</span>
      </div>
      <div className="grid max-w-xl gap-2 sm:grid-cols-2">
        {row.bars.map((bar) => (
          <Bar key={bar.label} bar={bar} />
        ))}
      </div>
      {agent && node.id !== ownId ? (
        <div className="flex flex-wrap gap-2">
          {projectKey && node.mode !== "paused" ? (
            <Button size="sm" variant="secondary" onClick={() => void act("pause")} loading={busy === "pause"} disabled={busy !== null}>
              <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Pause
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void act("revoke")} loading={busy === "revoke"} disabled={busy !== null}>
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Revoke{row.descendants > 0 ? ` with ${row.descendants} below` : ""}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function History({ requests, now }: { readonly requests: readonly SubagentRequest[]; readonly now: number }) {
  const decided = requests.filter((request) => request.status !== "pending").slice(0, 20);
  if (decided.length === 0) return null;
  return (
    <section aria-labelledby="agents-history" className="flex flex-col gap-2">
      <h2 id="agents-history" className="font-display text-xl font-bold">
        Recent requests
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {decided.map((request) => (
          <li key={request.id}>
            <strong>{request.name}</strong> <span className={TEXT_MUTED}>({request.parentKeyId})</span>: {requestStatusText(request, now)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AgentTreePanel() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const now = useNow(30_000);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const tree = useApiResource(kind ? `agent-tree:${maskKey(key)}:${generation}` : null, (_client, signal) => agentsApi.tree(key, signal));
  const rows = useMemo(() => treeRows(tree.data?.nodes ?? []), [tree.data]);
  const cards = useMemo(() => approvalCards(tree.data?.requests ?? [], now), [tree.data, now]);
  const ownId = kind === "agent" ? (rows[0]?.node.id ?? null) : null;
  const changed = (message: string) => {
    setNotice(message);
    setGeneration((value) => value + 1);
  };

  if (tree.status === "error" && tree.error) return <ApiErrorPanel error={tree.error} onRetry={tree.reload} />;
  if (!tree.data) {
    return (
      <SkeletonGroup label="Loading agents">
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </SkeletonGroup>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm font-semibold">
          {notice ?? `${cards.length === 0 ? "No request waits" : `${cards.length} request${cards.length === 1 ? " waits" : "s wait"}`} for a decision.`}
        </p>
        <Button size="sm" variant="ghost" onClick={() => changed(notice ?? "Reloaded.")} aria-label="Reload agents">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {cards.length > 0 ? (
        <section aria-labelledby="agents-pending" className="flex flex-col gap-3">
          <h2 id="agents-pending" className="font-display text-xl font-bold">
            Waiting for your decision
          </h2>
          <ul className="flex flex-col gap-4">
            {cards.map((card) => (
              <RequestCard key={card.request.id} card={card} projectKey={kind === "developer" ? key : null} onChanged={changed} />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="agents-tree" className="flex flex-col gap-2">
        <h2 id="agents-tree" className="font-display text-xl font-bold">
          Agent tree
        </h2>
        <p className={cx("text-sm", TEXT_MUTED)}>
          Every key with its caps and what it moved in the rolling windows. A parent's windows count everything below it, so a sub-agent never spends past its parent. Pausing or revoking a key stops its whole subtree at once.
        </p>
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <NodeRow key={row.node.id} row={row} apiKey={key} projectKey={kind === "developer"} ownId={ownId} onChanged={changed} />
          ))}
        </ul>
      </section>
      <History requests={tree.data.requests} now={now} />
    </div>
  );
}
