/**
 * "Kletia can't do that yet": a neutral note, not a failure, for a
 * sentence the planner cannot express (with the API's example phrases, or
 * the desk's own starters, as chips that fill the composer) and, when no
 * network is named and the departure is Auto, an offer to ask the Base,
 * Arbitrum or Arc engine. A sentence for a network no engine serves gets
 * the note only.
 *
 * The same note explains a sentence the planner understood but found no
 * route for (`understood`): no engine is offered, and without a connected
 * wallet it asks for one, because the plan is made from the user's holdings.
 */
import { CHAINS } from "@kletia/core";
import { Wallet } from "lucide-react";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { cx, LABEL } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { STARTERS } from "../content/starters";
import type { LegacyNetwork, SubmissionRoute } from "../state/deskModel";
import type { WalletNamespace } from "./taskModel";

const copy = DESK_COPY.unsupported;

/** Examples when the API sent none: the desk's featured starters that need nothing filled in. */
const FALLBACK_EXAMPLES = STARTERS.filter((starter) => starter.featured && !starter.sentence.includes("<")).map((starter) => starter.sentence);

export interface UnsupportedTaskBodyProps {
  readonly message: string;
  readonly hints: readonly string[];
  /** Where the sentence could still go; null for a sentence the planner understood (no engine is offered). */
  readonly route: SubmissionRoute | null;
  readonly onHint: (sentence: string) => void;
  readonly onAskEngine: (network: LegacyNetwork) => void;
  /** Connect buttons, when the plan needs holdings and no wallet is connected. */
  readonly connect?: readonly WalletNamespace[];
  readonly onConnect?: (namespace: WalletNamespace) => void;
}

const CHIP =
  "inline-flex min-h-11 max-w-full items-center border-2 border-control bg-surface px-3 text-left font-code text-[13px] font-semibold text-fg hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] motion-reduce:hover:translate-y-0";
const OFFER =
  "inline-flex min-h-11 items-center gap-2 border-[3px] border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg shadow-[2px_2px_0_#1A1A1A] hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] dark:shadow-[2px_2px_0_#475569] motion-reduce:hover:translate-y-0";

export function UnsupportedTaskBody({ message, hints, route, onHint, onAskEngine, connect = [], onConnect }: UnsupportedTaskBodyProps) {
  const examples = hints.length > 0 ? hints : FALLBACK_EXAMPLES;
  return (
    <section aria-label={route ? copy.heading : copy.understoodHeading} className={cx("flex flex-col gap-4 border-2 border-dashed border-control bg-surface-2 p-4")}>
      <div role="status">
        <p className="font-display text-lg font-bold">{route ? copy.heading : copy.understoodHeading}</p>
        <p className="mt-1 text-sm">{message}</p>
        {route ? <p className="mt-1 text-sm text-muted">{copy.lead}</p> : null}
      </div>
      {connect.length > 0 && onConnect ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm font-semibold">{copy.connectLead}</p>
          <div className="flex flex-wrap gap-2">
            {connect.map((namespace) => (
              <button key={namespace} type="button" className={OFFER} onClick={() => onConnect(namespace)}>
                <Wallet className="h-4 w-4" aria-hidden="true" />
                {namespace === "eip155" ? DESK_COPY.preview.connectEvm : DESK_COPY.preview.connectSolana}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {examples.length > 0 ? (
        <div>
          <p className={LABEL}>{copy.hintsLabel}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {examples.map((hint) => (
              <li key={hint} className="max-w-full">
                <button type="button" className={CHIP} aria-label={copy.hintChipLabel(hint)} onClick={() => onHint(hint)}>
                  <span className="break-words">{hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {route?.engine === "offer" ? (
        <div>
          <p className="text-sm font-semibold">{copy.offerLead}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {route.networks.map((network) => (
              <button key={network} type="button" onClick={() => onAskEngine(network)} className={OFFER}>
                <LineBullet line={LINES[network]} decorative />
                {copy.askEngine(CHAINS[network].shortName)}
              </button>
            ))}
          </div>
        </div>
      ) : route?.engine === "none" && route.why !== "refused" ? (
        <p className="text-sm text-muted">{copy.noEngine}</p>
      ) : null}
    </section>
  );
}
