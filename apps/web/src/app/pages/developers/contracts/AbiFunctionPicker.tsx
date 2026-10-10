import type { AbiFunctionClassification } from "@kletia/core";
import { Ban, Check } from "lucide-react";

import { Badge } from "../../../site/ui/Badge";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";

export interface AbiFunctionPickerProps {
  readonly functions: readonly AbiFunctionClassification[];
  readonly selected: readonly string[];
  readonly onToggle: (signature: string, selected: boolean) => void;
  readonly max: number;
}

/**
 * Every function of the ABI with its mark: allowed ones can be chosen as
 * entries (at most `max`); forbidden ones say why (approvals, transfers,
 * ownership, upgrades, multicall, read-only, arbitrary calldata).
 */
export function AbiFunctionPicker({ functions, selected, onToggle, max }: AbiFunctionPickerProps) {
  const allowed = functions.filter((entry) => entry.allowed);
  const refused = functions.filter((entry) => !entry.allowed);
  const full = selected.length >= max;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <fieldset className="min-w-0">
        <legend className={cx(LABEL, "mb-2")}>
          Functions you can register ({allowed.length}) · {selected.length} of at most {max} chosen
        </legend>
        {allowed.length === 0 ? (
          <p className={cx("text-sm", TEXT_MUTED)}>This ABI has no state-changing function that Kletia can call.</p>
        ) : (
          <ul className={cx("max-h-[24rem] divide-y-2 divide-[#1A1A1A]/10 overflow-y-auto dark:divide-white/10", INK_BORDER_THIN)}>
            {allowed.map((entry) => {
              const checked = selected.includes(entry.signature);
              return (
                <li key={entry.signature} className="min-w-0">
                  <label className={cx("flex min-h-11 cursor-pointer items-start gap-3 p-3 text-sm", !checked && full && "cursor-not-allowed opacity-60")}>
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-[#0052FF]"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(event) => onToggle(entry.signature, event.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <Check className="h-3.5 w-3.5 shrink-0 text-[#0B7A4B] dark:text-[#4ADE80]" aria-hidden="true" />
                        <code className="min-w-0 break-all font-code text-[12.5px] font-bold">{entry.signature}</code>
                        {entry.stateMutability === "payable" ? <Badge tone="yellow">payable</Badge> : null}
                      </span>
                      <span className={cx("mt-0.5 block font-code text-[11px]", TEXT_MUTED)}>selector {entry.selector}</span>
                      {entry.notes.map((note) => (
                        <span key={note} className="mt-0.5 block text-xs">
                          {note}
                        </span>
                      ))}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      {refused.length > 0 ? (
        <details className={cx("min-w-0", INK_BORDER_THIN)}>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-bold">
            <Ban className="h-4 w-4 shrink-0 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
            {refused.length} {refused.length === 1 ? "function" : "functions"} Kletia never calls, and why
          </summary>
          <ul className="max-h-[20rem] divide-y-2 divide-[#1A1A1A]/10 overflow-y-auto border-t-2 border-[#1A1A1A]/10 dark:divide-white/10 dark:border-white/10">
            {refused.map((entry) => (
              <li key={entry.signature} className="min-w-0 p-3 text-sm">
                <code className="block break-all font-code text-[12px] font-bold">{entry.signature}</code>
                <span className={cx("block text-xs", TEXT_MUTED)}>{entry.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
