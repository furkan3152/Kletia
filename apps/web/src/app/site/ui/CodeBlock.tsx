import React, { useId, useLayoutEffect, useRef, useState } from "react";

import { useChangeKey } from "../motion/useChangeKey";
import { observeIntersection, supportsIntersectionObserver } from "../motion/useInView";
import { prefersReducedMotion, useReducedMotion } from "../motion/useReducedMotion";
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
  /**
   * "lines": the first time the block scrolls into view, uncover the code top
   * to bottom, line by line (the text stays in the DOM throughout). Blocks
   * already on screen at load are never hidden. Default "none".
   */
  readonly reveal?: "lines" | "none";
}

const LINE_REVEAL_MS_PER_LINE = 40;
const LINE_REVEAL_MAX_MS = 1200;

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
  reveal = "none",
}: CodeBlockProps) {
  const baseId = useId();
  const reduced = useReducedMotion();
  const list = tabs && tabs.length > 0 ? tabs : null;
  const [activeId, setActiveId] = useState(list ? list[0]!.id : "single");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const active = list ? (list.find((tab) => tab.id === activeId) ?? list[0]!) : null;
  const snippet = active ? active.code : code;
  const snippetLanguage = active ? active.language : language;
  const snippetFile = active ? (active.filename ?? filename) : filename;
  const panelId = `${baseId}-panel`;
  const swapKey = useChangeKey(active?.id ?? "single");
  const snippetRef = useRef(snippet);
  useLayoutEffect(() => {
    snippetRef.current = snippet;
  });

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!list) return;
    const next = nextTabIndex(event.key, index, list.length);
    if (next === null) return;
    event.preventDefault();
    setActiveId(list[next]!.id);
    tabRefs.current[next]?.focus();
  };

  // Sliding tab indicator: one yellow block that follows the selected tab.
  const tabCount = list?.length ?? 0;
  const selectedId = active?.id;
  useLayoutEffect(() => {
    const tablist = tablistRef.current;
    const indicator = indicatorRef.current;
    if (!tablist || !indicator) return undefined;
    if (reduced) {
      tablist.removeAttribute("data-indicator");
      return undefined;
    }
    let first = !tablist.hasAttribute("data-indicator");
    let frame = 0;
    const place = () => {
      const tab = tablist.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      if (first) indicator.style.transition = "none";
      indicator.style.width = `${tab.offsetWidth}px`;
      indicator.style.height = `${tab.offsetHeight}px`;
      indicator.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
      tablist.setAttribute("data-indicator", "on");
      if (first) {
        first = false;
        frame = window.requestAnimationFrame(() => {
          indicator.style.transition = "";
        });
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return () => window.cancelAnimationFrame(frame);
    const observer = new ResizeObserver(() => place());
    observer.observe(tablist);
    for (const tab of tabRefs.current.slice(0, tabCount)) if (tab) observer.observe(tab);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [selectedId, reduced, tabCount]);

  // Line-by-line reveal the first time the block scrolls into view.
  useLayoutEffect(() => {
    if (reveal !== "lines") return undefined;
    const pre = preRef.current;
    // Observe the scroll panel, not the clipped <pre>: a fully clipped target never intersects.
    const panel = pre?.parentElement;
    if (!pre || !panel) return undefined;
    let cancelled = false;
    let stop: () => void = () => undefined;
    const animations: Animation[] = [];
    queueMicrotask(() => {
      if (cancelled || prefersReducedMotion() || !supportsIntersectionObserver()) return;
      if (typeof pre.animate !== "function") return;
      if (panel.getBoundingClientRect().top <= window.innerHeight) return;
      pre.setAttribute("data-code-reveal", "pending");
      stop = observeIntersection(
        panel,
        (entry) => {
          if (!entry.isIntersecting) return;
          stop();
          const lines = Math.max(1, snippetRef.current.replace(/\n$/u, "").split("\n").length);
          const duration = Math.min(LINE_REVEAL_MAX_MS, LINE_REVEAL_MS_PER_LINE * lines);
          animations.push(
            pre.animate([{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], {
              duration,
              easing: `steps(${lines}, jump-start)`,
            }),
          );
          pre.removeAttribute("data-code-reveal");
          const caret = caretRef.current;
          if (caret && lines > 1) {
            const styles = window.getComputedStyle(pre);
            const lineHeight = Number.parseFloat(styles.lineHeight) || 24;
            const top = Number.parseFloat(styles.paddingTop) || 16;
            const left = Number.parseFloat(styles.paddingLeft) || 16;
            caret.style.top = `${top + 3}px`;
            caret.style.left = `${Math.max(2, left - 10)}px`;
            caret.style.height = `${Math.max(8, lineHeight - 6)}px`;
            animations.push(
              caret.animate(
                [
                  { transform: "translateY(0)", opacity: 1 },
                  { transform: `translateY(${(lines - 1) * lineHeight}px)`, opacity: 1, offset: 0.98 },
                  { transform: `translateY(${(lines - 1) * lineHeight}px)`, opacity: 0 },
                ],
                { duration: duration + 240, easing: `steps(${lines}, jump-start)` },
              ),
            );
          }
        },
        { threshold: 0.2 },
      );
    });
    return () => {
      cancelled = true;
      stop();
      for (const animation of animations) animation.cancel();
      pre.removeAttribute("data-code-reveal");
    };
  }, [reveal]);

  return (
    <div className={cx("flex min-w-0 flex-col bg-[#0D1117] text-[#E6EDF3]", INK_BORDER, HARD_SHADOW, className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b-[3px] border-[#1A1A1A] bg-[#161B22] px-3 py-2 dark:border-[#4B5563] sm:flex-nowrap">
        {list ? (
          <div
            ref={tablistRef}
            role="tablist"
            aria-label={label}
            className="group/tabs relative order-last flex min-w-0 basis-full gap-1 overflow-x-auto sm:order-none sm:flex-1 sm:basis-auto"
          >
            <span
              ref={indicatorRef}
              aria-hidden="true"
              className="kl-tab-indicator pointer-events-none absolute left-0 top-0 hidden bg-[#FFD60A] group-data-[indicator=on]/tabs:block"
            />
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
                    "relative inline-flex min-h-9 shrink-0 items-center gap-2 border-2 px-3 py-1 text-[11px] font-black uppercase tracking-[0.12em] transition-colors",
                    selected
                      ? "border-[#FFD60A] bg-[#FFD60A] text-[#1A1A1A] group-data-[indicator=on]/tabs:border-transparent group-data-[indicator=on]/tabs:bg-transparent group-data-[indicator=on]/tabs:delay-100"
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
        className={cx("relative min-w-0 overflow-auto", maxHeightClassName, FOCUS_RING, "focus-visible:-outline-offset-4")}
      >
        <pre
          key={swapKey}
          ref={preRef}
          className={cx("min-w-0 p-4 font-code text-[12.5px] leading-6 sm:p-5 sm:text-[13px]", swapKey > 0 && "kl-code-swap")}
        >
          <code>{highlightCode(snippet, snippetLanguage)}</code>
        </pre>
        {reveal === "lines" ? (
          <span
            ref={caretRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-1 top-4 h-[18px] w-1.5 bg-[#FFD60A] opacity-0"
          />
        ) : null}
      </div>
      {footer ? <div className="border-t-2 border-white/10 px-4 py-3 text-xs text-white/70">{footer}</div> : null}
    </div>
  );
}
