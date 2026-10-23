/**
 * One tool as a platform sign (console design 3.10, the language of
 * site/art/PlatformSign): an ink board with the platform number and the kind
 * flap, then the network bullets, one line, the wallet it needs and "Open".
 */
import { ArrowUpRight } from "lucide-react";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import type { DeskTool } from "./catalogue";

const copy = DESK_COPY.tools;

export interface ToolSignProps {
  readonly tool: DeskTool;
  readonly onOpen: () => void;
}

export function ToolSign({ tool, onOpen }: ToolSignProps) {
  // A link with a flow (the Coinbase onramp) opens its panel here first, not a new tab.
  const external = tool.kind === "link" && tool.external && !tool.flow;
  return (
    <li className={cx("flex flex-col", INK_BORDER, SURFACE)}>
      <div className="flex items-center justify-between gap-2 bg-[#1A1A1A] px-3 py-2 text-white dark:bg-[#F1F5F9] dark:text-[#0B1120]">
        <span className="font-code text-sm font-bold" aria-hidden="true">
          {String(tool.number).padStart(2, "0")}
        </span>
        <span className="border-2 border-current px-1.5 text-xs font-black uppercase tracking-wider">{copy.kinds[tool.kind]}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="font-display text-base font-bold">{tool.title}</h3>
        {tool.networks.length > 0 ? (
          <p className="flex flex-wrap gap-1">
            {tool.networks.map((network) => (
              <LineBullet key={network} line={LINES[network]} />
            ))}
          </p>
        ) : null}
        <p className="text-sm">{tool.summary}</p>
        <p className={cx(LABEL, "!text-xs text-muted")}>{copy.needs[tool.needs]}</p>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${copy.open} ${tool.title}${external ? ` (${copy.opensInNewTab})` : ""}`}
          className="mt-auto inline-flex min-h-11 items-center justify-center gap-1.5 self-start border-[3px] border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] dark:shadow-[2px_2px_0_#475569]"
        >
          {copy.open}
          {external ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        </button>
      </div>
    </li>
  );
}
