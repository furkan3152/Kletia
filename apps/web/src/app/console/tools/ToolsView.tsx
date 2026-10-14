/**
 * The Tools view (console design 3.10): every network's extras in one card
 * language, filtered by network and kind. Prompt tools put their sentences in
 * the composer with their network engine pinned (the only path to the Base
 * engine's Intent Router V2); link tools open their destination; panels,
 * forms and read-only tools open here, each loaded as its own chunk
 * (ToolPanel), with the composer still docked below.
 */
import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import { ACTIVE_WALLET_ADDRESS } from "../../../shared/config/intentExamples";
import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { navigate } from "../../routes/useRoute";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { getTool, TOOLS, type DeskTool, type ToolKind } from "./catalogue";
import { ToolPanel } from "./ToolPanel";
import { ToolSign } from "./ToolSign";

const copy = DESK_COPY.tools;
const KINDS: readonly ToolKind[] = ["panel", "form", "read-only", "prompt", "link"];

const FILTER =
  "inline-flex min-h-11 items-center gap-1.5 border-2 border-control px-2.5 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] aria-[pressed=true]:bg-[#1A1A1A] aria-[pressed=true]:text-white dark:aria-[pressed=true]:bg-[#F1F5F9] dark:aria-[pressed=true]:text-[#0B1120]";

function OpenTool({ tool, onBack }: { readonly tool: DeskTool; readonly onBack: () => void }) {
  const actions = useDeskActions();
  const network = tool.networks[0];
  const address = actions.accounts.evm?.address ?? "<address>";
  return (
    <section aria-labelledby="desk-tool-heading" className="flex flex-col gap-4 pb-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 items-center gap-2 self-start text-xs font-black uppercase tracking-wider text-fg underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {copy.back}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        {tool.networks.map((key) => (
          <LineBullet key={key} line={LINES[key]} decorative />
        ))}
        <h2 id="desk-tool-heading" className="font-display text-2xl font-bold">
          {tool.title}
        </h2>
      </div>
      {network && tool.needs !== "none" ? (
        <p className="text-sm font-semibold text-muted">{copy.needsOn(copy.needs[tool.needs], CHAINS[network].name)}</p>
      ) : null}
      <p className="text-sm">{tool.summary}</p>
      {tool.prompts ? (
        <ul className="flex flex-col gap-2">
          {tool.prompts.map((prompt) => (
            <li key={prompt.id}>
              <button
                type="button"
                onClick={() => actions.fill(prompt.sentence.split(ACTIVE_WALLET_ADDRESS).join(address), { engine: tool.engine })}
                className={cx("flex min-h-11 w-full flex-col gap-1 p-3 text-left focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]", INK_BORDER, SURFACE)}
              >
                <span className="text-sm font-bold">{prompt.label}</span>
                <span className="break-words font-code text-xs text-muted">{prompt.sentence.split(ACTIVE_WALLET_ADDRESS).join(address)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ToolPanel tool={tool} />
      )}
    </section>
  );
}

export interface ToolsViewProps {
  readonly toolId: string | null;
}

export function ToolsView({ toolId }: ToolsViewProps) {
  const actions = useDeskActions();
  const [network, setNetwork] = useState<NetworkKey | "all">("all");
  const [kind, setKind] = useState<ToolKind | "all">("all");
  const [query, setQuery] = useState("");
  const open = toolId ? getTool(toolId) : null;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOLS.filter(
      (tool) =>
        (network === "all" || tool.networks.length === 0 || tool.networks.includes(network)) &&
        (kind === "all" || tool.kind === kind) &&
        (!needle || `${tool.title} ${tool.summary}`.toLowerCase().includes(needle)),
    );
  }, [kind, network, query]);

  const openTool = (tool: DeskTool) => {
    // The Coinbase onramp needs a session token first: it opens as a panel that runs that flow.
    if (tool.kind === "link" && tool.href && !tool.flow) {
      if (tool.external) window.open(tool.href, "_blank", "noopener,noreferrer");
      else navigate(tool.href);
      return;
    }
    actions.openView("tools", tool.id);
  };

  if (open) return <OpenTool tool={open} onBack={() => actions.openView("tools", null)} />;

  const production = NETWORK_KEYS.filter((key) => CHAINS[key].lane !== "testnet");
  const yard = NETWORK_KEYS.filter((key) => CHAINS[key].lane === "testnet");

  return (
    <section aria-labelledby="desk-tools-heading" className="flex flex-col gap-4 pb-8">
      <h2 id="desk-tools-heading" className="font-display text-2xl font-bold">
        {copy.title}
      </h2>
      <label className="flex min-h-11 items-center gap-2 border-2 border-control bg-surface px-3 focus-within:outline focus-within:outline-4 focus-within:outline-offset-2 focus-within:outline-[var(--kl-focus)]">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">{copy.search}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.search}
          className="min-h-10 w-full bg-transparent text-base text-fg placeholder:text-[var(--kl-placeholder)] focus:outline-none"
        />
      </label>
      <div role="group" aria-label={copy.networkFilter} className="flex flex-wrap items-center gap-2">
        <span className={cx(LABEL, "!text-[11px]")}>{copy.networkFilter}</span>
        <button type="button" className={FILTER} aria-pressed={network === "all"} onClick={() => setNetwork("all")}>
          {copy.all}
        </button>
        {[...production, ...yard].map((key) => (
          <button key={key} type="button" className={FILTER} aria-pressed={network === key} onClick={() => setNetwork(key)} aria-label={CHAINS[key].name}>
            <LineBullet line={LINES[key]} decorative />
          </button>
        ))}
      </div>
      <div role="group" aria-label={copy.kindFilter} className="flex flex-wrap items-center gap-2">
        <span className={cx(LABEL, "!text-[11px]")}>{copy.kindFilter}</span>
        <button type="button" className={FILTER} aria-pressed={kind === "all"} onClick={() => setKind("all")}>
          {copy.all}
        </button>
        {KINDS.map((entry) => (
          <button key={entry} type="button" className={FILTER} aria-pressed={kind === entry} onClick={() => setKind(entry)}>
            {copy.kinds[entry]}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="text-sm font-semibold">{copy.noMatch}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((tool) => (
            <ToolSign key={tool.id} tool={tool} onOpen={() => openTool(tool)} />
          ))}
        </ul>
      )}
    </section>
  );
}
