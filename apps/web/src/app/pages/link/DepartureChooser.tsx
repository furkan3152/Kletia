import "../../site/art/base.css";
import "./link.css";

import { LineBullet } from "../../site/art/LineBullet";
import { lineFor } from "../../site/art/tokens";
import type { FundingOption } from "./linkModel";

/*
 * "Choose where you start": the link's funding choices on a departure board.
 * The rows are a native radio group (arrow keys move, Space selects), so the
 * board is decoration around a standard control.
 */

export interface DepartureChooserProps {
  readonly options: readonly FundingOption[];
  readonly value: string | null;
  readonly onChange: (key: string) => void;
  readonly disabled?: boolean;
  /** Arrival time per option key, once a quote for it came back. */
  readonly arrivals: Readonly<Record<string, number | undefined>>;
  /** The option whose quote is in flight. */
  readonly quotingKey: string | null;
  readonly destination: string;
}

function arrivalText(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

export function DepartureChooser({ options, value, onChange, disabled = false, arrivals, quotingKey, destination }: DepartureChooserProps) {
  return (
    <div className="kl-link-board">
      <div className="kl-link-board__head">
        <p className="kl-link-board__title" aria-hidden="true">
          Departures
        </p>
        <p className="kl-link-board__sub" aria-hidden="true">
          Arriving on {destination}
        </p>
      </div>
      <fieldset disabled={disabled}>
        <legend className="kla-sr">Where your money starts (arrives on {destination})</legend>
        {options.map((option) => {
          const line = lineFor(option.network);
          const checked = value === option.key;
          const eta = arrivalText(arrivals[option.key]);
          return (
            <label key={option.key} className="kl-link-row" data-checked={checked || undefined} data-disabled={disabled || undefined}>
              <input type="radio" name="kl-link-source" value={option.key} checked={checked} onChange={() => onChange(option.key)} />
              <span className="kl-link-row__lamp" aria-hidden="true" />
              {line ? <LineBullet line={line} size="lg" decorative /> : <span />}
              <span className="kl-link-row__name">
                {option.networkName} <span className="kl-link-row__asset">{option.symbol}</span>
              </span>
              <span className="kl-link-row__eta">{quotingKey === option.key ? "Quoting" : eta ? `Arrives ${eta}` : ""}</span>
            </label>
          );
        })}
      </fieldset>
      <p className="kl-link-board__note">Arrival times come from the bridge auction once a route is quoted.</p>
    </div>
  );
}
