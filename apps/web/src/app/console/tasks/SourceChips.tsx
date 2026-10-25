/**
 * Where should the money come from?: the candidate networks of
 * SOURCE_REQUIRED as one-tap chips that plan the task again from there,
 * funded ones first. Without the API's candidates (an older API, or an SDK
 * that drops `details`) every network of the lane is offered, the best
 * funded first, and no balance is claimed that was not read.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
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
    <div role="group" aria-label={question} className="flex flex-col gap-3 border-[3px] border-control bg-surface p-4 shadow-[4px_4px_0_#121212] dark:shadow-[4px_4px_0_#2A2A30]">
      <p className="font-display text-lg font-bold">{question}</p>
      {parsed && parsed.candidates.length > 0 && parsed.candidates.every((candidate) => candidate.enough === false) ? (
        <p className="text-sm font-semibold">{copy.none}</p>
      ) : null}
      <ul className="flex flex-wrap gap-2">
        {candidates.map((candidate) => {
          const name = CHAINS[candidate.network].shortName;
          const enough = candidate.enough === null ? "" : candidate.enough ? copy.enough : copy.notEnough;
          const visible = candidate.balance ? copy.candidate(name, `${candidate.balance}${parsed?.asset ? ` ${parsed.asset}` : ""}`) : name;
          return (
            <li key={candidate.network}>
              <button
                type="button"
                onClick={() => onChoose(candidate.network)}
                aria-label={candidate.balance ? copy.candidateLabel(name, candidate.balance, enough) : `${name}${enough ? `, ${enough}` : ""}`}
                className="inline-flex min-h-11 items-center gap-2 border-2 border-control bg-surface-2 px-3 text-sm font-bold text-fg hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] data-[enough=true]:border-[3px] motion-reduce:hover:translate-y-0"
                data-enough={candidate.enough === true || undefined}
              >
                <LineBullet line={LINES[candidate.network]} decorative />
                <span>{visible}</span>
                {candidate.enough === false ? <span className="text-xs font-semibold text-muted">{copy.notEnough}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
