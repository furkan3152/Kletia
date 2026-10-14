/**
 * The composer's departure chip (console design 3.3): a yellow "From" tab,
 * the network's line bullet (or AUTO) and short name, and on desktop a
 * caption with what the departure means right now ("Kletia picks", "$127.50
 * here", "test yard"). It opens the departure board.
 */
import { forwardRef } from "react";
import { ChevronUp } from "lucide-react";
import { CHAINS } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { laneOf, type Departure } from "../state/deskModel";

const copy = DESK_COPY.composer;

export interface DepartureChipProps {
  readonly departure: Departure;
  readonly caption: string;
  readonly expanded: boolean;
  readonly onOpen: () => void;
}

export const DepartureChip = forwardRef<HTMLButtonElement, DepartureChipProps>(function DepartureChip(
  { departure, caption, expanded, onOpen },
  ref,
) {
  const name = departure === "auto" ? DESK_COPY.departure.auto : CHAINS[departure].shortName;
  const yard = laneOf(departure) === "testnet";
  return (
    <button
      ref={ref}
      type="button"
      className="kd-chip-from focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
      data-yard={yard || undefined}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={copy.fromChipLabel(departure === "auto" ? name : CHAINS[departure].name)}
      onClick={onOpen}
    >
      <span className="kd-chip-from__tab" aria-hidden="true">
        {copy.fromChip}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-2">
        {departure === "auto" ? (
          <span className="kd-bullet-auto" aria-hidden="true">
            {DESK_COPY.departure.autoCode}
          </span>
        ) : (
          <LineBullet line={LINES[departure]} decorative />
        )}
        <span className="truncate text-sm font-black">{name}</span>
        {caption ? <span className="hidden truncate text-xs font-semibold text-muted lg:inline">{caption}</span> : null}
        <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
      </span>
    </button>
  );
});
