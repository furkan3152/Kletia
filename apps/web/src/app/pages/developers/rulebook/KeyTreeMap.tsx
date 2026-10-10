import "./rulebook.css";

import type { PolicyMode } from "@kletia/core";
import type { ApiKeySummary } from "@kletia/sdk";

import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { formatWhen } from "../portal/portalFormat";
import type { TreeNode } from "./policyModel";

export interface StationState {
  readonly mode: PolicyMode | null;
  readonly version: number | null;
  readonly pending: boolean;
}

export interface KeyTreeMapProps {
  readonly nodes: readonly TreeNode<ApiKeySummary>[];
  readonly states: ReadonlyMap<string, StationState>;
  readonly project: StationState | null;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}

function Lamp({ mode }: { readonly mode: PolicyMode | null }) {
  return (
    <span className="kl-rb-lamp shrink-0" data-aspect={mode ?? "live"} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function modeWord(mode: PolicyMode | null): string {
  return mode === "paused" ? "paused" : mode === "dry-run" ? "dry run" : "live";
}

function Station({ keyItem, state, selected, onSelect }: { readonly keyItem: ApiKeySummary; readonly state: StationState | undefined; readonly selected: boolean; readonly onSelect: () => void }) {
  const agent = keyItem.kind === "agent";
  const edition = state?.version ?? keyItem.policyVersion ?? null;
  const mode = state?.mode ?? null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "flex w-full min-w-0 items-start gap-2.5 border-[3px] px-3 py-2 text-left transition-colors",
        selected
          ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#FFD60A] dark:shadow-[3px_3px_0_#475569]"
          : "border-[#1A1A1A]/30 bg-white text-[#1A1A1A] hover:border-[#1A1A1A] dark:border-white/20 dark:bg-[#131E32] dark:text-white dark:hover:border-white/60",
        FOCUS_RING,
      )}
    >
      <Lamp mode={mode} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 break-words font-display text-[15px] font-bold leading-tight">{keyItem.name}</span>
          <span className="font-code text-[10px] font-black uppercase tracking-[0.1em]">{agent ? "agent" : "project key"}</span>
        </span>
        <span className="mt-0.5 block font-code text-[11px] font-semibold">
          {edition ? `Rule book, edition ${edition}` : agent ? "Observer (no rule book)" : "No rule book"} · {modeWord(mode)}
        </span>
        <span className={cx("block text-[11px]", selected ? "text-[#1A1A1A]" : TEXT_MUTED)}>
          {keyItem.expiresAt ? `Expires ${formatWhen(keyItem.expiresAt)}` : "No expiry"}
          {keyItem.current ? " · in memory" : ""}
        </span>
        {state?.pending ? (
          <span
            className={cx(
              "mt-1 inline-block border-2 border-dashed border-[#A84B00] px-1.5 font-code text-[10px] font-black uppercase tracking-[0.08em]",
              selected ? "text-[#7A3500]" : "text-[#7A3500] dark:border-[#FBBF24] dark:text-[#FBBF24]",
            )}
          >
            Pending amendment
          </span>
        ) : null}
      </span>
    </button>
  );
}

function Branch({ nodes, states, selected, onSelect }: { readonly nodes: readonly TreeNode<ApiKeySummary>[]; readonly states: ReadonlyMap<string, StationState>; readonly selected: string; readonly onSelect: (id: string) => void }) {
  return (
    <ul className="kl-rb-tree__branch mt-2 flex flex-col gap-2">
      {nodes.map((node) => (
        <li key={node.key.id}>
          <Station keyItem={node.key} state={states.get(node.key.id)} selected={selected === node.key.id} onSelect={() => onSelect(node.key.id)} />
          {node.children.length > 0 ? <Branch nodes={node.children} states={states} selected={selected} onSelect={onSelect} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The key tree as a branch line: the project rule book at the head of the
 * trunk, project keys as stations on it, agent keys on thinner branches.
 * Each station shows its edition, expiry, a signal lamp (live, dry run,
 * paused) and a flag for a pending amendment. Selecting one opens its book.
 */
export function KeyTreeMap({ nodes, states, project, selected, onSelect }: KeyTreeMapProps) {
  return (
    <nav aria-label="Keys and their rule books" className="kl-rb-tree min-w-0">
      <p className={cx(LABEL, "mb-2")}>Branch line</p>
      <button
        type="button"
        onClick={() => onSelect("project")}
        aria-pressed={selected === "project"}
        className={cx(
          "flex w-full min-w-0 items-start gap-2.5 border-[3px] border-[#1A1A1A] px-3 py-2 text-left dark:border-[#4B5563]",
          selected === "project" ? "bg-[#FFD60A] text-[#1A1A1A] dark:border-[#FFD60A]" : "bg-[#1A1A1A] text-white dark:bg-[#060A14]",
          FOCUS_RING,
        )}
      >
        <Lamp mode={project?.mode ?? null} />
        <span className="min-w-0">
          <span className="block font-display text-[15px] font-bold">The project</span>
          <span className="block font-code text-[11px] font-semibold">
            {project?.version ? `Rule book, edition ${project.version}` : "No project rule book"} · bounds every key
          </span>
          {project?.pending ? <span className="mt-1 inline-block font-code text-[10px] font-black uppercase tracking-[0.08em]">Pending amendment</span> : null}
        </span>
      </button>
      <ul className="kl-rb-tree__line mt-2 flex flex-col gap-3 pb-1 pt-1">
        {nodes.map((node) => (
          <li key={node.key.id} className="kl-rb-station">
            <Station keyItem={node.key} state={states.get(node.key.id)} selected={selected === node.key.id} onSelect={() => onSelect(node.key.id)} />
            {node.children.length > 0 ? <Branch nodes={node.children} states={states} selected={selected} onSelect={onSelect} /> : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
