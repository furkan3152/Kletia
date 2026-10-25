/**
 * Where should the money come from?: the candidate networks of
 * SOURCE_REQUIRED as one-tap chips that plan the task again from there,
 * funded ones first. Without the API's candidates (an older API, or an SDK
 * that drops `details`) every network of the lane is offered, the best
 * funded first, and no balance is claimed that was not read.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

import { OptionKey, OptionKeys } from "../../kit";
import { Say } from "./Conversation";
import { DESK_COPY } from "../content/copy";
import type { Departure, Lane } from "../state/deskModel";
import type { HoldingsSnapshot } from "../state/holdings";
import { fallbackSourceCandidates, parseSourceDetails } from "./taskModel";

const copy = DESK_COPY.source;

export interface SourceChipsProps {
  readonly lane: Lane;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly holdings: HoldingsSnapshot | null;
  /** The departure that was just tried (left out when it is a network). */
  readonly exclude: Departure;
  readonly onChoose: (network: NetworkKey) => void;
}

export function SourceChips({ lane, details, holdings, exclude, onChoose }: SourceChipsProps) {
  const parsed = parseSourceDetails(details);
  const candidates = (parsed?.candidates.length ? parsed.candidates : fallbackSourceCandidates(lane, holdings)).filter(
    (candidate) => candidate.network !== exclude,
  );
  const question = parsed?.amount && parsed.asset ? copy.question(parsed.amount, parsed.asset) : copy.questionGeneric;
  return (
    <div className="kd-qs">
      <Say>{question}</Say>
      {parsed && parsed.candidates.length > 0 && parsed.candidates.every((candidate) => candidate.enough === false) ? <p className="kd-say-why">{copy.none}</p> : null}
      <OptionKeys label={question}>
        {candidates.map((candidate) => {
          const name = CHAINS[candidate.network].shortName;
          const enough = candidate.enough === null ? "" : candidate.enough ? copy.enough : copy.notEnough;
          return (
            <span key={candidate.network} className="contents">
              <OptionKey
                title={
                  <>
                    <span className="kd-net-dot" style={{ background: CHAINS[candidate.network].color, marginRight: 8 }} aria-hidden="true" />
                    {name}
                  </>
                }
                detail={[candidate.balance ? `${candidate.balance}${parsed?.asset ? ` ${parsed.asset}` : ""}` : null, enough || null].filter(Boolean).join(" · ") || undefined}
                onSelect={() => onChoose(candidate.network)}
              />
            </span>
          );
        })}
      </OptionKeys>
    </div>
  );
}
