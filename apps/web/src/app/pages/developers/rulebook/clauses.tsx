import { useId, type ReactNode } from "react";

import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { splitLines } from "../portal/portalFormat";

export interface ControlIds {
  readonly id: string;
  readonly describedBy: string;
  /** The clause label's id (groups of checkboxes are labelled by it). */
  readonly labelId: string;
}

const CONTROL =
  "w-full min-w-0 border-[3px] border-[#1A1A1A] bg-white px-3 py-2 text-[14px] text-[#1A1A1A] placeholder:text-[#6B7280] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9] dark:placeholder:text-[#64748B] disabled:opacity-60";

export interface ClauseProps {
  /** `§8.3`. */
  readonly code: string;
  /** `caps.dailyUsd`. */
  readonly field: string;
  readonly label: string;
  /** What it means, in plain words. */
  readonly meaning: ReactNode;
  readonly issues?: readonly string[];
  readonly warnings?: readonly string[];
  /** Comparison against the book in force: "tightened" (in force on save) or "loosened" (waits the delay). */
  readonly change?: "tightened" | "loosened" | null;
  readonly delayText?: string;
  /** The control takes the full width under the label (the timetable grid). */
  readonly wide?: boolean;
  readonly children: (ids: ControlIds) => ReactNode;
}

/**
 * One clause of a rule book article: its code in mono, the control, and a
 * muted line of what it means. Validation issues and warnings sit beside it
 * and are linked to the control (`aria-describedby`).
 */
export function ClauseRow({ code, field, label, meaning, issues = [], warnings = [], change = null, delayText, wide = false, children }: ClauseProps) {
  const id = useId();
  const meaningId = `${id}-meaning`;
  const noteId = `${id}-notes`;
  const describedBy = [meaningId, issues.length + warnings.length > 0 || change ? noteId : ""].filter(Boolean).join(" ");
  return (
    <div className={cx("grid min-w-0 gap-2 border-t-2 border-dashed border-[#1A1A1A]/20 py-4 first:border-t-0 first:pt-0 dark:border-white/10", !wide && "md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] md:gap-5")}>
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="block font-display text-[15px] font-bold leading-snug">
          {label}
        </label>
        <p className="mt-0.5 break-words font-code text-[11px] font-bold text-[#0047E0] [font-variant-ligatures:none] dark:text-[#7EA6FF]">
          {code} {field}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children({ id, describedBy, labelId: `${id}-label` })}
        <p id={meaningId} className={cx("text-[13px] leading-relaxed", TEXT_MUTED)}>
          {meaning}
        </p>
        {issues.length + warnings.length > 0 || change ? (
          <div id={noteId} className="flex flex-col gap-1">
            {change === "tightened" ? (
              <p className="inline-flex items-center gap-2 self-start border-2 border-[#0B7A4B] px-2 py-0.5 font-code text-[10.5px] font-black uppercase tracking-[0.1em] text-[#0B7A4B] dark:border-[#4ADE80] dark:text-[#4ADE80]">
                Tightens: in force on save
              </p>
            ) : change === "loosened" ? (
              <p className="inline-flex items-center gap-2 self-start border-2 border-dashed border-[#A84B00] px-2 py-0.5 font-code text-[10.5px] font-black uppercase tracking-[0.1em] text-[#A84B00] dark:border-[#FBBF24] dark:text-[#FBBF24]">
                Loosens: in force {delayText ?? "after the delay"}
              </p>
            ) : null}
            {issues.map((issue) => (
              <p key={issue} className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
                {issue}
              </p>
            ))}
            {warnings.map((warning) => (
              <p key={warning} className="text-xs font-bold text-[#92400E] dark:text-[#FBBF24]">
                Warning: {warning}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- controls */


export function SelectControl({
  ids,
  value,
  onChange,
  options,
  disabled,
}: {
  readonly ids: ControlIds;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly disabled?: boolean;
}) {
  return (
    <select id={ids.id} aria-describedby={ids.describedBy} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={cx(CONTROL, FOCUS_RING, "cursor-pointer font-semibold sm:max-w-md")}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function TextControl({
  ids,
  value,
  onChange,
  placeholder,
  mono = false,
  prefix,
  inputMode,
  disabled,
}: {
  readonly ids: ControlIds;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly mono?: boolean;
  readonly prefix?: string;
  readonly inputMode?: "decimal" | "numeric" | "text";
  readonly disabled?: boolean;
}) {
  return (
    <span className="flex min-w-0 sm:max-w-xs">
      {prefix ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center border-[3px] border-r-0 border-[#1A1A1A] bg-[#F1EFE8] px-2.5 font-code text-sm font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white">
          {prefix}
        </span>
      ) : null}
      <input
        id={ids.id}
        aria-describedby={ids.describedBy}
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={cx(CONTROL, FOCUS_RING, mono && "font-code text-[13px]")}
      />
    </span>
  );
}

/** A list, one entry per line (or comma separated). Empty text removes the field. */
export function LinesControl({
  ids,
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
}: {
  readonly ids: ControlIds;
  readonly value: readonly string[] | undefined;
  readonly onChange: (value: string[] | undefined) => void;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
}) {
  return (
    <LinesInput key={(value ?? []).join("\n")} ids={ids} initial={(value ?? []).join("\n")} onChange={onChange} placeholder={placeholder} rows={rows} disabled={disabled} />
  );
}

function LinesInput({
  ids,
  initial,
  onChange,
  placeholder,
  rows,
  disabled,
}: {
  readonly ids: ControlIds;
  readonly initial: string;
  readonly onChange: (value: string[] | undefined) => void;
  readonly placeholder?: string;
  readonly rows: number;
  readonly disabled?: boolean;
}) {
  // Uncontrolled while typing (so a half-typed line is kept); the parsed list is sent on blur.
  return (
    <textarea
      id={ids.id}
      aria-describedby={ids.describedBy}
      defaultValue={initial}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onBlur={(event) => {
        const list = splitLines(event.target.value, { commas: true });
        onChange(list.length > 0 ? list : undefined);
      }}
      className={cx(CONTROL, FOCUS_RING, "resize-y font-code text-[12.5px]")}
    />
  );
}

/**
 * An allowlist as chips: "Any" (the field absent) or a chosen subset. An
 * empty subset allows nothing, which the warnings say.
 */
export function ChipsControl({
  ids,
  value,
  onChange,
  options,
  anyLabel = "Any",
  disabled,
}: {
  readonly ids: ControlIds;
  readonly value: readonly string[] | undefined;
  readonly onChange: (value: string[] | undefined) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly anyLabel?: string;
  readonly disabled?: boolean;
}) {
  const any = value === undefined;
  return (
    <fieldset id={ids.id} aria-labelledby={ids.labelId} aria-describedby={ids.describedBy} className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 self-start text-sm font-bold">
        <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" checked={any} onChange={(event) => onChange(event.target.checked ? undefined : options.map((option) => option.value))} />
        {anyLabel}
      </label>
      {!any ? (
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {options.map((option) => {
            const on = value.includes(option.value);
            return (
              <li key={option.value}>
                <label
                  className={cx(
                    "inline-flex min-h-9 cursor-pointer items-center gap-1.5 border-2 px-2.5 text-[12px] font-bold",
                    on ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#FFD60A]" : "border-[#1A1A1A]/40 text-[#45464B] dark:border-white/25 dark:text-[#A9B6C8]",
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#1A1A1A]"
                    checked={on}
                    onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((entry) => entry !== option.value))}
                  />
                  {option.label}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </fieldset>
  );
}

/** Tri-state boolean: the default (absent), on, off. */
export function SwitchControl({
  ids,
  value,
  onChange,
  defaultText,
  onText = "On",
  offText = "Off",
  disabled,
}: {
  readonly ids: ControlIds;
  readonly value: boolean | undefined;
  readonly onChange: (value: boolean | undefined) => void;
  readonly defaultText: string;
  readonly onText?: string;
  readonly offText?: string;
  readonly disabled?: boolean;
}) {
  return (
    <SelectControl
      ids={ids}
      disabled={disabled}
      value={value === undefined ? "" : value ? "on" : "off"}
      onChange={(next) => onChange(next === "" ? undefined : next === "on")}
      options={[
        { value: "", label: defaultText },
        { value: "on", label: onText },
        { value: "off", label: offText },
      ]}
    />
  );
}
