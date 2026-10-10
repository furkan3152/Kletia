import type { PolicyDocument } from "@kletia/core";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "../../../site/ui/Button";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { DAY_NAMES, DAY_SHORT, emptyGrid, fullGrid, gridIsFull, gridToWindows, scheduleToGrid, timetableStatus } from "./policyModel";

type Schedule = PolicyDocument["schedule"];

function zones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const list = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  return ["UTC", ...list.filter((zone) => zone !== "UTC")];
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function hour(n: number): string {
  return `${String(n).padStart(2, "0")}:00`;
}

export interface TimetableGridProps {
  readonly labelId: string;
  readonly describedBy: string;
  readonly schedule: Schedule | undefined;
  readonly onChange: (schedule: Schedule | undefined) => void;
  readonly now: number;
}

/**
 * The timetable as a 7 x 24 grid of hour cells. Arrow keys move, Space or
 * Enter toggles an hour, Home and End jump along a day. Windows that start
 * off the hour cannot be edited here (the grid says so and stays read-only).
 */
export function TimetableGrid({ labelId, describedBy, schedule, onChange, now }: TimetableGridProps) {
  // No timetable means always open: every hour is filled.
  const grid = useMemo(() => (schedule ? scheduleToGrid(schedule) : fullGrid()), [schedule]);
  const readOnly = grid === null;
  const cells = grid ?? emptyGrid();
  const [focus, setFocus] = useState<[number, number]>([0, 9]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const timezone = schedule?.timezone ?? localZone();
  const allZones = useMemo(() => zones(), []);

  const write = (next: boolean[][], zone = timezone) => {
    // A full week is the same as no timetable; an empty one never opens (the validator says so).
    if (gridIsFull(next)) onChange(undefined);
    else onChange({ timezone: zone, windows: gridToWindows(next) });
  };
  const toggle = (day: number, at: number) => {
    if (readOnly) return;
    const next = cells.map((row) => [...row]);
    next[day]![at] = !next[day]![at];
    write(next);
  };
  const move = (day: number, at: number) => {
    const target: [number, number] = [Math.max(0, Math.min(6, day)), Math.max(0, Math.min(23, at))];
    setFocus(target);
    refs.current[target[0] * 24 + target[1]]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, day: number, at: number) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(day, at + 1),
      ArrowLeft: () => move(day, at - 1),
      ArrowDown: () => move(day + 1, at),
      ArrowUp: () => move(day - 1, at),
      Home: () => move(day, 0),
      End: () => move(day, 23),
    };
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className={LABEL}>Time zone</span>
          <select
            value={timezone}
            disabled={!schedule}
            onChange={(event) => (schedule ? onChange({ ...schedule, timezone: event.target.value }) : undefined)}
            className="min-h-10 max-w-[16rem] border-[3px] border-[#1A1A1A] bg-white px-2 font-code text-[13px] text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-white"
          >
            {(allZones.includes(timezone) ? allZones : [timezone, ...allZones]).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const next = emptyGrid();
              for (let day = 0; day < 5; day += 1) for (let at = 8; at < 18; at += 1) next[day]![at] = true;
              onChange({ timezone, windows: gridToWindows(next) });
            }}
          >
            Weekdays 08-18
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Always open
          </Button>
        </div>
      </div>
      <div className="min-w-0 overflow-x-auto pb-1">
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-readonly={readOnly || undefined}
          className="kl-rb-grid"
        >
          <span aria-hidden="true" />
          {Array.from({ length: 24 }, (_, at) => (
            <span key={at} aria-hidden="true" className={cx("text-center font-code text-[9px] font-bold", TEXT_MUTED)}>
              {at % 3 === 0 ? String(at).padStart(2, "0") : ""}
            </span>
          ))}
          {cells.map((row, day) => (
            <div key={day} className="contents">
              <span aria-hidden="true" className="self-center font-code text-[11px] font-bold">
                {DAY_SHORT[day]}
              </span>
              {row.map((open, at) => {
                const index = day * 24 + at;
                const focused = focus[0] === day && focus[1] === at;
                return (
                  <button
                    key={at}
                    ref={(element) => {
                      refs.current[index] = element;
                    }}
                    type="button"
                    tabIndex={focused ? 0 : -1}
                    aria-checked={open}
                    role="switch"
                    aria-label={`${DAY_NAMES[day]} ${hour(at)} to ${hour(at + 1)}`}
                    disabled={readOnly}
                    onFocus={() => setFocus([day, at])}
                    onClick={() => toggle(day, at)}
                    onKeyDown={(event) => onKeyDown(event, day, at)}
                    className="kl-rb-grid__cell"
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>
        {readOnly
          ? "This timetable has windows that start or end off the hour. Edit it in the JSON view; the grid shows hours only."
          : "Arrow keys move between hours, Space toggles one. Filled cells are open; the time zone applies once an hour is closed."}{" "}
        <span className="font-bold text-[#1A1A1A] dark:text-white">{timetableStatus(schedule, now)}</span>
      </p>
    </div>
  );
}
