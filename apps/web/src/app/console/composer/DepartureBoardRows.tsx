/**
 * The departure board's rows: Auto plus every registry network, production
 * first and the test yard (collapsed unless a testnet is the departure), as
 * one native radio group in a fieldset. Arrow keys move the pending choice;
 * Enter, Space or a click on a row commits it. A row is disabled only when
 * the deployment does not offer the network or its health reading is not ok,
 * and the reason is the row's description.
 */
import { useId } from "react";
import { CHAINS, type NetworkKey } from "@kletia/core";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import {
  departureRowLabel,
  departureStatusWord,
  type Departure,
  type DepartureBoard,
  type DepartureOption,
} from "../state/deskModel";
import { formatUsd, holdingLabels } from "../state/holdings";

const copy = DESK_COPY.departure;

export interface DepartureBoardRowsProps {
  readonly board: DepartureBoard;
  /** The pending choice (checked radio). */
  readonly value: Departure;
  readonly onChange: (departure: Departure) => void;
  /** Enter, Space or a click: commit and close. */
  readonly onCommit: (departure: Departure) => void;
  readonly yardOpen: boolean;
  readonly onToggleYard: () => void;
  /** "Most funds right now: Base, $127.50" (Auto's second line); null without holdings. */
  readonly mostFunds: string | null;
  /** Radio group name, unique per board on the page. */
  readonly name: string;
}

function balancesOf(option: DepartureOption): string {
  if (option.holdings) {
    const labels = holdingLabels(option.holdings);
    return labels.length > 0 ? labels.join(" · ") : copy.empty;
  }
  return option.walletHint ?? copy.noBalance;
}

function valueOf(option: DepartureOption): string {
  if (option.lane === "testnet") return option.holdings ? copy.test : "";
  if (!option.holdings) return "";
  return formatUsd(option.holdings.totalUsd > 0 ? option.holdings.totalUsd : null) ?? (option.holdings.top.length ? "" : "-");
}

function commitKey(event: React.KeyboardEvent<HTMLInputElement>, key: Departure, onCommit: (departure: Departure) => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onCommit(key);
  }
}

function Row({
  option,
  name,
  checked,
  onChange,
  onCommit,
}: {
  readonly option: DepartureOption;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (departure: Departure) => void;
  readonly onCommit: (departure: Departure) => void;
}) {
  const reasonId = useId();
  const line = LINES[option.key];
  const value = valueOf(option);
  return (
    <label className="kd-board__row" data-disabled={option.disabled || undefined} data-key={option.key}>
      <input
        type="radio"
        className="kd-board__radio"
        name={name}
        value={option.key}
        checked={checked}
        disabled={option.disabled}
        aria-label={departureRowLabel(option)}
        aria-describedby={option.disabledReason ? reasonId : undefined}
        onChange={() => onChange(option.key)}
        // A pointer click commits; arrow keys only move the pending choice (their synthetic click has detail 0).
        onClick={(event) => {
          if (event.detail > 0) onCommit(option.key);
        }}
        onKeyDown={(event) => commitKey(event, option.key, onCommit)}
      />
      <span className="kd-board__name flex min-w-0 items-start gap-2">
        <LineBullet line={line} decorative />
        <span className="min-w-0">
          <span className="block truncate">{option.name}</span>
          <span className="kd-board__sub">
            {option.disabledReason ? (
              <span id={reasonId} className="kd-board__reason">
                {option.disabledReason}
              </span>
            ) : (
              balancesOf(option)
            )}
          </span>
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        {value ? <span className="kd-board__usd">{value}</span> : null}
        <span className="kd-board__flap" data-status={option.status} aria-hidden="true">
          {departureStatusWord(option.status).toUpperCase()}
        </span>
      </span>
    </label>
  );
}

export function DepartureBoardRows({
  board,
  value,
  onChange,
  onCommit,
  yardOpen,
  onToggleYard,
  mostFunds,
  name,
}: DepartureBoardRowsProps) {
  const legendId = useId();
  const yardId = useId();
  const autoDescription = useId();
  const testnetChosen = value !== "auto" && CHAINS[value as NetworkKey].lane === "testnet";
  const showYard = yardOpen || testnetChosen;
  return (
    <fieldset className="kd-board__group" aria-labelledby={legendId}>
      <legend id={legendId} className="kd-board__legend">
        {copy.boardLabel}
      </legend>
      <label className="kd-board__row" data-key="auto">
        <input
          type="radio"
          className="kd-board__radio"
          name={name}
          value="auto"
          checked={value === "auto"}
          aria-describedby={autoDescription}
          onChange={() => onChange("auto")}
          onClick={(event) => {
            if (event.detail > 0) onCommit("auto");
          }}
          onKeyDown={(event) => commitKey(event, "auto", onCommit)}
        />
        <span className="kd-board__name flex min-w-0 items-start gap-2">
          <span className="kd-bullet-auto" aria-hidden="true">
            {copy.autoCode}
          </span>
          <span className="min-w-0">
            <span className="block">{copy.auto}</span>
            <span id={autoDescription} className="kd-board__sub">
              {copy.autoExplained}
              {mostFunds ? <span className="mt-1 block font-bold text-[#FFD60A]">{mostFunds}</span> : null}
            </span>
          </span>
        </span>
        <span />
      </label>
      <p className="kd-board__legend" aria-hidden="true">
        {copy.groupProduction}
      </p>
      <div role="presentation">
        {board.production.map((option) => (
          <Row key={option.key} option={option} name={name} checked={value === option.key} onChange={onChange} onCommit={onCommit} />
        ))}
      </div>
      <button type="button" className="kd-board__toggle" aria-expanded={showYard} aria-controls={yardId} onClick={onToggleYard} disabled={testnetChosen}>
        <span>{showYard ? copy.groupTestYard : copy.showYard(board.testnet.length)}</span>
        <span aria-hidden="true">{showYard ? copy.hideYard : "+"}</span>
      </button>
      <div id={yardId} hidden={!showYard}>
        {board.testnet.map((option) => (
          <Row key={option.key} option={option} name={name} checked={value === option.key} onChange={onChange} onCommit={onCommit} />
        ))}
      </div>
    </fieldset>
  );
}
