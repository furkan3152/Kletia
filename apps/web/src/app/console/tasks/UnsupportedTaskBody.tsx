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

import { Icon, Key } from "../../kit";
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

export function UnsupportedTaskBody({ message, hints, route, onHint, onAskEngine, connect = [], onConnect }: UnsupportedTaskBodyProps) {
  const examples = hints.length > 0 ? hints : FALLBACK_EXAMPLES;
  return (
    <section aria-label={route ? copy.heading : copy.understoodHeading} className="kd-answer">
      <div role="status">
        <p className="kd-answer-t">{route ? copy.heading : copy.understoodHeading}</p>
        <p className="kd-say mt-2">{message}</p>
        {route ? <p className="kd-say-why mt-2">{copy.lead}</p> : null}
      </div>
      {connect.length > 0 && onConnect ? (
        <div className="kd-qs">
          <p className="kd-say-why">{copy.connectLead}</p>
          <div className="kd-keys">
            {connect.map((namespace) => (
              <Key key={namespace} size="sm" tone="lime" onClick={() => onConnect(namespace)}>
                <Icon name="wallet" />
                {namespace === "eip155" ? DESK_COPY.preview.connectEvm : DESK_COPY.preview.connectSolana}
              </Key>
            ))}
          </div>
        </div>
      ) : null}
      {examples.length > 0 ? (
        <div className="kd-qs">
          <p className="kd-answer-h">{copy.hintsLabel}</p>
          <ul className="kd-keys m-0 list-none p-0">
            {examples.map((hint) => (
              <li key={hint} className="max-w-full">
                <Key size="sm" className="kd-hint-key" aria-label={copy.hintChipLabel(hint)} onClick={() => onHint(hint)}>
                  <span className="break-words">{hint}</span>
                </Key>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {route?.engine === "offer" ? (
        <div className="kd-qs">
          <p className="kd-say-why">{copy.offerLead}</p>
          <div className="kd-keys">
            {route.networks.map((network) => (
              <Key key={network} size="sm" onClick={() => onAskEngine(network)}>
                <span className="kd-net-dot" style={{ background: CHAINS[network].color }} aria-hidden="true" />
                {copy.askEngine(CHAINS[network].shortName)}
              </Key>
            ))}
          </div>
        </div>
      ) : route?.engine === "none" && route.why !== "refused" ? (
        <p className="kd-say-why">{copy.noEngine}</p>
      ) : null}
    </section>
  );
}
