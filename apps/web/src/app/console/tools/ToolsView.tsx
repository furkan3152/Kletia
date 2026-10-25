/**
 * The Tools view: every network's extras in one card language, filtered by network and kind. Prompt
 * tools put their sentences in the composer with their network engine pinned (the only path to the
 * Base engine's Intent Router V2); link tools open their destination; panels, forms and read-only
 * tools open here, each loaded as its own chunk (ToolPanel), with the composer still docked below.
 * The filters are keys in a well, every tool is a cartridge in a rack (tools.css).
 */
import "./tools.css";

import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import { ACTIVE_WALLET_ADDRESS } from "../../../shared/config/intentExamples";
import { Icon, networkIcon } from "../../kit";
import { navigate } from "../../routes/useRoute";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { getTool, TOOLS, type DeskTool, type ToolKind } from "./catalogue";
import { ToolPanel } from "./ToolPanel";
import { ToolSign } from "./ToolSign";
import { filterTools, networkToolNote } from "./toolsFilter";

const copy = DESK_COPY.tools;
const KINDS: readonly ToolKind[] = ["panel", "form", "read-only", "prompt", "link"];

/** A filter key (tools.css): a small keycap that latches lime when pressed. */
const FILTER = "kto-key";

function OpenTool({ tool, onBack }: { readonly tool: DeskTool; readonly onBack: () => void }) {
  const actions = useDeskActions();
  const network = tool.networks[0];
  const address = actions.accounts.evm?.address ?? "<address>";
  return (
    <section aria-labelledby="desk-tool-heading" className="kto">
      <button type="button" onClick={onBack} className="kv-link kto-back">
        <ArrowLeft width={16} height={16} aria-hidden="true" />
        {copy.back}
      </button>
      <div className="kto-open-h">
        <span className="kto-icons" aria-hidden="true">
          {tool.networks.map((key) => (
            <Icon key={key} name={networkIcon(key)} />
          ))}
        </span>
        <h2 id="desk-tool-heading" className="kv-h2">
          {tool.title}
        </h2>
      </div>
      {network && tool.needs !== "none" ? <p className="kv-muted kto-needs">{copy.needsOn(copy.needs[tool.needs], CHAINS[network].name)}</p> : null}
      <p className="kv-intro">{tool.summary}</p>
      {tool.prompts ? (
        <ul className="kto-prompts">
          {tool.prompts.map((prompt) => (
            <li key={prompt.id}>
              <button type="button" className="k-opt kto-prompt" onClick={() => actions.fill(prompt.sentence.split(ACTIVE_WALLET_ADDRESS).join(address), { engine: tool.engine })}>
                <b>{prompt.label}</b>
                <span className="kv-num">{prompt.sentence.split(ACTIVE_WALLET_ADDRESS).join(address)}</span>
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

  const visible = useMemo(() => filterTools(TOOLS, { network, kind, query }), [kind, network, query]);
  const note = networkToolNote(visible, { network, kind, query });

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
    <section aria-labelledby="desk-tools-heading" className="kto">
      <h2 id="desk-tools-heading" className="kv-h2">
        {copy.title}
      </h2>
      <label className="kto-search">
        <Search width={18} height={18} aria-hidden="true" />
        <span className="sr-only">{copy.search}</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} />
      </label>
      <div role="group" aria-label={copy.networkFilter} className="kto-filters">
        <span className="kv-label">{copy.networkFilter}</span>
        <button type="button" className={FILTER} aria-pressed={network === "all"} onClick={() => setNetwork("all")}>
          {copy.all}
        </button>
        {[...production, ...yard].map((key) => (
          <button key={key} type="button" className={FILTER} aria-pressed={network === key} onClick={() => setNetwork(key)} aria-label={CHAINS[key].name} title={CHAINS[key].name}>
            <Icon name={networkIcon(key)} />
            <span className="kto-key-stripe" style={{ background: CHAINS[key].color }} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div role="group" aria-label={copy.kindFilter} className="kto-filters">
        <span className="kv-label">{copy.kindFilter}</span>
        <button type="button" className={FILTER} aria-pressed={kind === "all"} onClick={() => setKind("all")}>
          {copy.all}
        </button>
        {KINDS.map((entry) => (
          <button key={entry} type="button" className={FILTER} aria-pressed={kind === entry} onClick={() => setKind(entry)}>
            {copy.kinds[entry]}
          </button>
        ))}
      </div>
      {note && network !== "all" ? (
        // Honest note: the network works from the composer even when no tool is built for it.
        <p role="status" className="kv-note">
          {note === "general" ? copy.networkGeneralOnly(CHAINS[network].name) : copy.networkNone(CHAINS[network].name)}
        </p>
      ) : null}
      {visible.length === 0 ? (
        note ? null : <p className="kv-empty">{copy.noMatch}</p>
      ) : (
        <ul className="kto-rack">
          {visible.map((tool) => (
            <ToolSign key={tool.id} tool={tool} onOpen={() => openTool(tool)} />
          ))}
        </ul>
      )}
    </section>
  );
}
