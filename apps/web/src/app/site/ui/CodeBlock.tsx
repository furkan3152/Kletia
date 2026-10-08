import React, { useId, useRef, useState } from "react";

import { Badge } from "./Badge";
import { CopyButton } from "./CopyButton";
import { highlightCode, type CodeLanguage } from "./highlight";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER } from "./styles";
import { nextTabIndex } from "./tabKeys";

export interface CodeTab {
  readonly id: string;
  readonly label: string;
  readonly language: CodeLanguage;
  readonly code: string;
  /** Small badge next to the tab label, e.g. "Preview". */
  readonly badge?: string;
  /** File name shown in the window chrome. */
  readonly filename?: string;
}

export interface CodeBlockProps {
  /** Multiple snippets with an accessible tab switcher. */
  readonly tabs?: readonly CodeTab[];
  /** Single snippet (ignored when `tabs` is set). */
  readonly code?: string;
  readonly language?: CodeLanguage;
  readonly filename?: string;
  /** Accessible name for the block / tab list. */
  readonly label: string;
  readonly className?: string;
  /** Tailwind max-height class for the scroll area, e.g. "max-h-96". */
  readonly maxHeightClassName?: string;
  readonly footer?: React.ReactNode;
}

/** Dark code window with optional tabs, syntax colouring and a copy button. */
export function CodeBlock({
  tabs,
  code = "",
  language = "text",
  filename,
  label,
  className,
  maxHeightClassName = "max-h-[28rem]",
  footer,
}: CodeBlockProps) {
  const baseId = useId();
  const list = tabs && tabs.length > 0 ? tabs : null;
  const [activeId, setActiveId] = useState(list ? list[0]!.id : "single");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = list ? (list.find((tab) => tab.id === activeId) ?? list[0]!) : null;
  const snippet = active ? active.code : code;
  const snippetLanguage = active ? active.language : language;
  const snippetFile = active ? (active.filename ?? filename) : filename;
  const panelId = `${baseId}-panel`;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!list) return;
    const next = nextTabIndex(event.key, index, list.length);
    if (next === null) return;
    event.preventDefault();
    setActiveId(list[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={cx("flex min-w-0 flex-col bg-[#0D1117] text-[#E6EDF3]", INK_BORDER, HARD_SHADOW, className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b-[3px] border-[#1A1A1A] bg-[#161B22] px-3 py-2 dark:border-[#4B5563] sm:flex-nowrap">
        <span aria-hidden="true" className="hidden shrink-0 gap-1.5 sm:flex">
          <span className="h-3 w-3 border-2 border-[#0D1117] bg-[#FF5A5F]" />
          <span className="h-3 w-3 border-2 border-[#0D1117] bg-[#FFD60A]" />
          <span className="h-3 w-3 border-2 border-[#0D1117] bg-[#14F195]" />
        </span>
        {list ? (
          <div
            role="tablist"
            aria-label={label}
            className="order-last flex min-w-0 basis-full gap-1 overflow-x-auto sm:order-none sm:flex-1 sm:basis-auto"
          >
            {list.map((tab, index) => {
              const selected = tab.id === active?.id;
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveId(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={cx(
                    "inline-flex min-h-9 shrink-0 items-center gap-2 border-2 px-3 py-1 text-[11px] font-black uppercase tracking-[0.12em] transition-colors",
                    selected
                      ? "border-[#FFD60A] bg-[#FFD60A] text-[#1A1A1A]"
                      : "border-transparent text-white/70 hover:border-white/30 hover:text-white",
                    FOCUS_RING,
                  )}
                >
                  {tab.label}
                  {tab.badge ? (
                    <Badge tone={selected ? "ink" : "outline"} className={selected ? "" : "!border-white/40 !text-white/80"}>
                      {tab.badge}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate font-code text-xs text-white/70">{snippetFile ?? label}</p>
        )}
        {list ? <span className="flex-1 sm:hidden" aria-hidden="true" /> : null}
        <CopyButton text={snippet} label={`Copy ${active ? active.label : label} snippet`} className="shrink-0" />
      </div>
      {list && snippetFile ? (
        <p className="border-b border-white/10 px-4 py-1.5 font-code text-[11px] text-white/50">{snippetFile}</p>
      ) : null}
      <div
        id={panelId}
        role={list ? "tabpanel" : "region"}
        aria-labelledby={list && active ? `${baseId}-tab-${active.id}` : undefined}
        aria-label={list ? undefined : label}
        tabIndex={0}
        className={cx("min-w-0 overflow-auto", maxHeightClassName, FOCUS_RING, "focus-visible:-outline-offset-4")}
      >
        <pre className="min-w-0 p-4 font-code text-[12.5px] leading-6 sm:p-5 sm:text-[13px]">
          <code>{highlightCode(snippet, snippetLanguage)}</code>
        </pre>
      </div>
      {footer ? <div className="border-t-2 border-white/10 px-4 py-3 text-xs text-white/70">{footer}</div> : null}
    </div>
  );
}
