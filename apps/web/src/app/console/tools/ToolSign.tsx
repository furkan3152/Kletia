/**
 * One tool as a cartridge (Card machine): grip ridges, the
 * number and the kind on the label, the networks it runs on as drawings with a colour stripe,
 * one line, the wallet it needs and "Open".
 */
import type React from "react";
import { ArrowUpRight } from "lucide-react";
import { CHAINS } from "@kletia/core";

import { Icon, networkIcon } from "../../kit";
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
  const stripe = tool.networks[0] ? CHAINS[tool.networks[0]].color : undefined;
  return (
    <li className="kto-cart" style={stripe ? ({ "--kto-stripe": stripe } as React.CSSProperties) : undefined}>
      <div className="kto-cart-top">
        <span className="kto-num" aria-hidden="true">
          {String(tool.number).padStart(2, "0")}
        </span>
        <span className="kto-kind">{copy.kinds[tool.kind]}</span>
      </div>
      <div className="kto-cart-body">
        <h3>{tool.title}</h3>
        {tool.networks.length > 0 ? (
          <p className="kto-nets">
            {tool.networks.map((network) => (
              <span key={network} className="kto-net">
                <Icon name={networkIcon(network)} />
                {CHAINS[network].shortName}
              </span>
            ))}
          </p>
        ) : null}
        <p className="kto-sum">{tool.summary}</p>
        <p className="kto-needs">{copy.needs[tool.needs]}</p>
        <button type="button" onClick={onOpen} aria-label={`${copy.open} ${tool.title}${external ? ` (${copy.opensInNewTab})` : ""}`} className="k-key k-key--sm kto-open">
          {copy.open}
          {external ? <ArrowUpRight aria-hidden="true" /> : null}
        </button>
      </div>
    </li>
  );
}
