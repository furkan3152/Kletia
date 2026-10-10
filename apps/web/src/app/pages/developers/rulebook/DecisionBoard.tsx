import "../../../site/art/board.css";
import "./rulebook.css";

import { verifyDecisionChain, type PolicyDecision } from "@kletia/core";
import type { PolicyDecisionFilter, PolicyDecisionList } from "@kletia/sdk";
import { RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField } from "../../../site/ui/Field";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { shortId } from "../portal/portalFormat";
import { OUTCOME_FLAPS } from "./policyModel";

const TONE: Readonly<Record<string, string>> = {
  allow: "cleared",
  confirm: "held",
  deny: "refused",
  approved: "approved",
  rejected: "rejected",
  observed: "observed",
};

function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export interface DecisionBoardProps {
  readonly apiKey: string;
  readonly keys: readonly { readonly id: string; readonly name: string }[];
  readonly names: ReadonlyMap<string, string>;
}

/**
 * The decision log as a departure board: time, key, intent, stage, the
 * outcome on a flap and the first rule that decided. With no filter, the
 * loaded page's hash chain is checked here (`verifyDecisionChain`).
 */
export function DecisionBoard({ apiKey, keys, names }: DecisionBoardProps) {
  const [keyId, setKeyId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [stage, setStage] = useState("");
  const [older, setOlder] = useState<PolicyDecision[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const filter: PolicyDecisionFilter = {
    ...(keyId ? { keyId } : {}),
    ...(outcome ? { outcome: outcome as PolicyDecisionFilter["outcome"] } : {}),
    ...(stage ? { stage: stage as PolicyDecisionFilter["stage"] } : {}),
    limit: 50,
  };
  const filterKey = `${keyId}|${outcome}|${stage}`;
  const [seenFilter, setSeenFilter] = useState(filterKey);
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey);
    setOlder([]);
    setExhausted(false);
  }
  const page = useApiResource<PolicyDecisionList>(`decisions:${filterKey}`, (_client, signal) => keyedClient(apiKey).policies.decisions(filter, { signal: sdkSignal(signal) }));
  const more = useApiAction((_client, signal, after: string) => keyedClient(apiKey).policies.decisions({ ...filter, after }, { signal: sdkSignal(signal) }));
  const decisions = [...(page.data?.decisions ?? []), ...older];
  const filtered = Boolean(keyId || outcome || stage);
  const chain = !filtered && decisions.length > 0 ? verifyDecisionChain(decisions, page.data?.head ?? undefined) : null;
  const last = decisions[decisions.length - 1];
  const canLoadMore = (page.data?.decisions.length ?? 0) >= 50 && last !== undefined && !exhausted;

  const loadOlder = async () => {
    if (!last) return;
    const next = await more.run(last.id);
    if (next) {
      setOlder((current) => [...current, ...next.decisions]);
      if (next.decisions.length < 50) setExhausted(true);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <SelectField label="Key" value={keyId} onChange={(event) => setKeyId(event.target.value)} options={[{ value: "", label: "Every key" }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <SelectField
          label="Outcome"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          options={[
            { value: "", label: "Every outcome" },
            { value: "allow", label: "Cleared" },
            { value: "confirm", label: "Held" },
            { value: "deny", label: "Refused" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "observed", label: "Observed" },
          ]}
        />
        <SelectField
          label="Stage"
          value={stage}
          onChange={(event) => setStage(event.target.value)}
          options={[
            { value: "", label: "Every stage" },
            ...["plan", "prepare", "submit", "evaluate", "approval", "amendment", "key"].map((value) => ({ value, label: value })),
          ]}
        />
      </div>

      {page.status === "error" && page.error ? <ApiErrorPanel error={page.error} title="Could not read the decision log" onRetry={page.reload} /> : null}

      <div className="kla-board min-w-0">
        <div className="kla-board__head">
          <p className="kla-board__title">
            Decisions <span className="kla-board__sub">Rule Book log</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {chain ? (
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 border-2 px-2 py-1 font-code text-[10.5px] font-black uppercase tracking-[0.12em]",
                  chain.valid ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#FF8A8E] text-[#FF8A8E]",
                )}
              >
                {chain.valid ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />}
                {chain.valid ? "Chain verified" : "Chain broken"}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOlder([]);
                setExhausted(false);
                page.reload();
              }}
              className="inline-flex min-h-9 items-center gap-1.5 border-2 border-[#3A3F4A] px-2.5 font-code text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#F4F1EA] hover:border-[#FFD60A] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reload
            </button>
          </div>
        </div>
        <div className={cx("overflow-x-auto", FOCUS_RING)} tabIndex={0} role="region" aria-label="Rule Book decisions (scrolls sideways)">
          <table className="kla-board__table" aria-busy={page.status === "loading" || undefined}>
            <caption className="sr-only">Rule Book decisions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Key</th>
                <th scope="col" className="hidden md:table-cell">
                  Intent
                </th>
                <th scope="col" className="hidden sm:table-cell">
                  Stage
                </th>
                <th scope="col">Outcome</th>
                <th scope="col" className="hidden lg:table-cell">
                  First rule
                </th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision) => {
                const rule = decision.violations[0]?.rule ?? decision.triggers[0]?.rule ?? null;
                const tone = TONE[decision.outcome] ?? "observed";
                return (
                  <tr key={decision.id}>
                    <td className="whitespace-nowrap font-code text-[12px] text-[#F4F1EA]">{clock(decision.at)}</td>
                    <th scope="row" className="min-w-0 max-w-[10rem] truncate text-[13px] font-semibold text-[#F4F1EA]">
                      {decision.keyId ? names.get(decision.keyId) ?? shortId(decision.keyId) : "Project"}
                    </th>
                    <td className="hidden font-code text-[12px] text-[#A9B6C8] md:table-cell">{decision.intentId ? shortId(decision.intentId) : decision.dryRun ? "dry run" : "—"}</td>
                    <td className="hidden font-code text-[12px] uppercase tracking-[0.08em] text-[#A9B6C8] sm:table-cell">{decision.stage}</td>
                    <td>
                      <span className="kl-rb-flap" data-tone={tone}>
                        {OUTCOME_FLAPS[decision.outcome] ?? decision.outcome.toUpperCase()}
                      </span>
                    </td>
                    <td className="hidden font-code text-[12px] text-[#F4F1EA] lg:table-cell">{rule ?? "—"}</td>
                  </tr>
                );
              })}
              {decisions.length === 0 && page.status !== "loading" ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-sm text-[#A9B6C8]">
                    {filtered ? "No decision matches these filters." : "No decisions yet. Every plan, prepare, simulator run, approval and amendment is logged here."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={cx("text-xs", TEXT_MUTED)}>
          {chain && !chain.valid ? `Chain problems: ${chain.problems.join("; ")}.` : filtered ? "The chain check needs the unfiltered log: clear the filters to verify it." : chain ? `Checked ${decisions.length} records up to seq ${chain.head?.seq ?? "—"} with verifyDecisionChain.` : ""}
          {page.data?.head ? ` Head: seq ${page.data.head.seq}, ${page.data.head.chainHash.slice(0, 18)}….` : ""}
        </p>
        {canLoadMore ? (
          <Button size="sm" variant="secondary" loading={more.status === "loading"} onClick={() => void loadOlder()}>
            Load older decisions
          </Button>
        ) : null}
      </div>
      {more.status === "error" && more.error ? <ApiErrorPanel error={more.error} title="Could not load older decisions" /> : null}
      <p className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Kept 30 days by default · decisions name rule ids, never the request itself</p>
    </div>
  );
}
