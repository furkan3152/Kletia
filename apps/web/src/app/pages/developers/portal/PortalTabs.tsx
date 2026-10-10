import React, { useId, useRef } from "react";

import { cx, FOCUS_RING } from "../../../site/ui/styles";
import { nextTabIndex } from "../../../site/ui/tabKeys";

export interface PortalTab<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Small count or status after the label. */
  readonly note?: string;
}

export interface PortalTabsProps<T extends string> {
  readonly label: string;
  readonly tabs: readonly PortalTab<T>[];
  readonly active: T;
  readonly onChange: (id: T) => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}

/** A tab list with roving focus (arrow keys, Home, End); the panel is the children. */
export function PortalTabs<T extends string>({ label, tabs, active, onChange, children, className }: PortalTabsProps<T>) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={cx("flex min-w-0 flex-col", className)}>
      <div
        role="tablist"
        aria-label={label}
        className="flex min-w-0 gap-1 overflow-x-auto border-b-[3px] border-[#1A1A1A] pb-0 [scrollbar-width:thin] dark:border-[#4B5563]"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                "-mb-[3px] inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-[3px] border-b-0 px-3.5 text-[12px] font-black uppercase tracking-[0.1em] transition-colors",
                selected
                  ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]"
                  : "border-transparent text-[#45464B] hover:text-[#1A1A1A] dark:text-[#A9B6C8] dark:hover:text-white",
                FOCUS_RING,
              )}
            >
              {tab.label}
              {tab.note ? <span className="font-code text-[10px] font-bold normal-case tracking-normal">{tab.note}</span> : null}
            </button>
          );
        })}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${active}`} className="min-w-0 pt-6">
        {children}
      </div>
    </div>
  );
}
