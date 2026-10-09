import React, { useId, useRef, useState } from "react";

import { useChangeKey } from "../../site/motion/useChangeKey";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { exampleGroupOf, STUDIO_EXAMPLE_GROUPS, type StudioExampleGroupId } from "./exampleGroups";

export interface StudioExamplesProps {
  /** Current composer text: the matching chip shows as selected. */
  readonly text: string;
  /** Plans the example (and puts it in the composer). */
  readonly onPick: (example: string) => void;
}

/**
 * Example prompts in four tabs (Lend, Bridge, Pay, Swap). The tab row is one
 * line at every width; on phones the chips are a single snap row, wider
 * screens wrap them. Switching tabs drops the new chips in (no motion under
 * reduced motion; the first render never animates).
 */
export function StudioExamples({ text, onPick }: StudioExamplesProps) {
  const baseId = useId();
  const [group, setGroup] = useState<StudioExampleGroupId>(() => exampleGroupOf(text) ?? "bridge");
  // What the last change was: a tab switch drops the chips in, a pick stamps the chip.
  const [motion, setMotion] = useState<"none" | "group" | "pick">("none");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // An example put in the composer from elsewhere (e.g. the "try a supported
  // phrasing" fallback) opens its tab, so the selected chip is visible.
  const [shownText, setShownText] = useState(text);
  if (shownText !== text) {
    setShownText(text);
    const owner = exampleGroupOf(text);
    if (owner && owner !== group) setGroup(owner);
  }

  const active = STUDIO_EXAMPLE_GROUPS.find((candidate) => candidate.id === group) ?? STUDIO_EXAMPLE_GROUPS[0]!;
  const groupKey = useChangeKey(group);

  const select = (index: number, focus: boolean) => {
    const next = STUDIO_EXAMPLE_GROUPS[index];
    if (!next) return;
    if (next.id !== group) setMotion("group");
    setGroup(next.id);
    if (focus) tabRefs.current[index]?.focus();
  };

  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = STUDIO_EXAMPLE_GROUPS.length - 1;
    let next = -1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    select(next, true);
  };

  const labelId = `${baseId}-label`;
  const tabId = (id: StudioExampleGroupId) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  return (
    <div className="min-w-0">
      <p className={cx(LABEL, "mb-2 text-[#1A1A1A] dark:text-[#E2E8F0]")} id={labelId}>
        Examples
      </p>
      <div
        role="tablist"
        aria-labelledby={labelId}
        className="grid grid-cols-4 border-2 border-[#1A1A1A] shadow-hard-sm dark:border-[#4B5563]"
      >
        {STUDIO_EXAMPLE_GROUPS.map((candidate, index) => {
          const current = candidate.id === active.id;
          return (
            <button
              key={candidate.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={tabId(candidate.id)}
              type="button"
              role="tab"
              aria-selected={current}
              aria-controls={panelId}
              tabIndex={current ? 0 : -1}
              onClick={() => select(index, false)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={cx(
                "relative min-h-10 px-1 text-[11px] font-black uppercase tracking-[0.1em] transition-colors duration-150 motion-reduce:transition-none",
                index > 0 && "border-l-2 border-[#1A1A1A] dark:border-[#4B5563]",
                current
                  ? "bg-[#1A1A1A] text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]"
                  : "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#0B1120] dark:text-[#E2E8F0] dark:hover:bg-[#1A2841]",
                FOCUS_RING,
              )}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(active.id)} className="mt-3 min-w-0">
        {/* Phones: one snap row with an overflow cue. Wider: wrapped. */}
        <div
          key={groupKey}
          className="kl-scroll-shadow -mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-2 pt-1 ![--kl-scroll-bg:#FFFFFF] dark:![--kl-scroll-bg:#131E32] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0"
        >
          {active.examples.map((example, index) => {
            const isSelected = text === example;
            return (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setMotion("pick");
                  onPick(example);
                }}
                style={motion === "group" ? { ["--kl-i" as string]: index } : undefined}
                className={cx(
                  "shrink-0 snap-start whitespace-nowrap border-2 border-[#1A1A1A] px-2 py-1 text-left font-code text-[11px] transition-colors duration-150 dark:border-[#4B5563] md:shrink md:whitespace-normal",
                  isSelected
                    ? "bg-[#FFD60A] text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]"
                    : "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#0B1120] dark:text-[#E2E8F0] dark:hover:bg-[#1A2841]",
                  motion === "group" && "kl-rise",
                  motion === "pick" && isSelected && "kl-stamp",
                  FOCUS_RING,
                )}
              >
                {example}
              </button>
            );
          })}
        </div>
        <p className={cx("mt-2 text-xs leading-relaxed", TEXT_MUTED)}>{active.note}</p>
      </div>
    </div>
  );
}
