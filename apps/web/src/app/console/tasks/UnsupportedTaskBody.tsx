/**
 * "Kletia's planner does not cover this yet" (console design 3.6 and 3.7):
 * the API's example phrases as chips that fill the composer, and, when no
 * network is named and the departure is Auto, an offer to ask the Base,
 * Arbitrum or Arc engine. A sentence for a network no engine serves gets the
 * panel only.
 */
import { CHAINS } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import type { LegacyNetwork, SubmissionRoute } from "../state/deskModel";

const copy = DESK_COPY.unsupported;

export interface UnsupportedTaskBodyProps {
  readonly message: string;
  readonly hints: readonly string[];
  readonly route: SubmissionRoute;
  readonly onHint: (sentence: string) => void;
  readonly onAskEngine: (network: LegacyNetwork) => void;
}

const CHIP =
  "inline-flex min-h-11 max-w-full items-center border-2 border-control bg-surface-2 px-3 text-left font-code text-[13px] font-semibold text-fg hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] motion-reduce:hover:translate-y-0";

export function UnsupportedTaskBody({ message, hints, route, onHint, onAskEngine }: UnsupportedTaskBodyProps) {
  return (
    <div role="alert" className={cx("flex flex-col gap-4 p-4", INK_BORDER, SURFACE)}>
      <div>
        <p className="font-display text-lg font-bold">{copy.heading}</p>
        <p className="mt-1 text-sm">{message}</p>
      </div>
      {hints.length > 0 ? (
        <div>
          <p className={LABEL}>{copy.hintsLabel}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {hints.map((hint) => (
              <li key={hint} className="max-w-full">
                <button type="button" className={CHIP} aria-label={copy.hintChipLabel(hint)} onClick={() => onHint(hint)}>
                  <span className="break-words">{hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {route.engine === "offer" ? (
        <div>
          <p className="text-sm font-semibold">{copy.offerLead}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {route.networks.map((network) => (
              <button
                key={network}
                type="button"
                onClick={() => onAskEngine(network)}
                className="inline-flex min-h-11 items-center gap-2 border-[3px] border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg shadow-[2px_2px_0_#1A1A1A] hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] dark:shadow-[2px_2px_0_#475569] motion-reduce:hover:translate-y-0"
              >
                <LineBullet line={LINES[network]} decorative />
                {copy.askEngine(CHAINS[network].shortName)}
              </button>
            ))}
          </div>
        </div>
      ) : route.engine === "none" ? (
        <p className="text-sm font-semibold">{copy.noEngine}</p>
      ) : null}
    </div>
  );
}
