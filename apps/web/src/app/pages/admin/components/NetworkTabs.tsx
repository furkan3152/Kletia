import { useRef } from "react";

import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art/tokens";
import { cx, FOCUS_RING, LABEL } from "../../../site/ui/styles";
import { nextTabIndex } from "../../../site/ui/tabKeys";
import { isTestnet, networkName } from "../model/plan";
import type { AdminPanelNetwork } from "../model/types";

/**
 * One tab per network (7 EVM + the 2 Solana ones), each with its line bullet;
 * arrow keys move between tabs (roving tabindex). Scrolls sideways on phones.
 */
export function NetworkTabs({
  networks,
  value,
  onChange,
  label,
  idBase,
}: {
  readonly networks: readonly AdminPanelNetwork[];
  readonly value: AdminPanelNetwork;
  readonly onChange: (network: AdminPanelNetwork) => void;
  readonly label: string;
  readonly idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className="kl-admin__tabs -mx-4 flex gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:px-0">
      {networks.map((network, index) => {
        const line = lineFor(network);
        const selected = network === value;
        return (
          <button
            key={network}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${network}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(network)}
            onKeyDown={(event) => {
              const next = nextTabIndex(event.key, index, networks.length);
              if (next === null) return;
              event.preventDefault();
              onChange(networks[next] as AdminPanelNetwork);
              refs.current[next]?.focus();
            }}
            className={cx(
              "flex min-h-11 shrink-0 items-center gap-2 border-[3px] px-3 py-1.5 text-sm font-bold transition-[transform,box-shadow,background-color] duration-90",
              selected
                ? "border-control bg-[#FFD60A] text-[#1A1A1A] shadow-hard-sm"
                : "border-control bg-surface text-fg hover:-translate-y-0.5 hover:shadow-hard-sm motion-reduce:hover:translate-y-0",
              FOCUS_RING,
            )}
          >
            {line ? <LineBullet line={line} decorative /> : null}
            <span>{networkName(network)}</span>
            {isTestnet(network) ? <span className={cx(LABEL, "border-2 border-current px-1 leading-4")}>Test</span> : null}
          </button>
        );
      })}
    </div>
  );
}
