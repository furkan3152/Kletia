import { CornerDownLeft, Search, X } from "lucide-react";
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { navigate } from "../../../routes/history";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { knownOperations } from "../explorer/liveSpec";
import { buildSearchIndex, flattenGroups, resultCount, searchEntries, type SearchEntry } from "./searchIndex";

export interface SearchPaletteProps {
  readonly onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The portal search palette: a modal dialog with a combobox over a
 * grouped listbox. The index is built from bundled data and whatever
 * the explorer already loaded; typing never sends anything anywhere.
 * Arrows move, Enter opens, Esc closes (the opener gets focus back);
 * the result count is announced; phones get the whole screen.
 */
export default function SearchPalette({ onClose }: SearchPaletteProps) {
  const titleId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const index = useMemo(() => buildSearchIndex({ operations: knownOperations() }), []);
  const groups = useMemo(() => searchEntries(index, query), [index, query]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);
  // Each entry's position in display order, for aria-activedescendant and the arrows.
  const placed = useMemo(() => {
    let position = 0;
    return groups.map((group) => ({ ...group, placed: group.entries.map((entry) => ({ entry, at: position++ })) }));
  }, [groups]);
  const current = flat.length > 0 ? Math.min(active, flat.length - 1) : -1;
  const optionId = (position: number) => `${listId}-option-${position}`;

  useLayoutEffect(() => {
    inputRef.current?.focus();
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  // The highlighted option stays in view while arrows move it.
  useEffect(() => {
    if (current < 0) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // optionId only depends on listId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const open = (entry: SearchEntry) => {
    onClose();
    navigate(entry.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // Focus stays inside the dialog.
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.target !== inputRef.current || flat.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + flat.length) % flat.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (event.key === "Enter" && current >= 0) {
      event.preventDefault();
      open(flat[current]!);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center sm:px-4 sm:pt-[10vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-[#0B1120]/60" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "relative flex h-[100dvh] w-full min-w-0 flex-col bg-surface text-fg",
          "sm:h-auto sm:max-h-[75vh] sm:max-w-2xl sm:border-[3px] sm:border-[#1A1A1A] sm:shadow-[6px_6px_0_#1A1A1A] sm:dark:border-[#4B5563] sm:dark:shadow-[6px_6px_0_#475569]",
        )}
      >
        <h2 id={titleId} className="sr-only">
          Search the developer portal
        </h2>
        <div className="flex min-w-0 items-center gap-2 border-b-[3px] border-[#1A1A1A] px-3 dark:border-[#4B5563]">
          <Search className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Search pages, operations, errors, recipes, events and MCP tools"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="Search docs, operations, errors…"
            autoComplete="off"
            spellCheck={false}
            className="min-h-14 w-full min-w-0 bg-transparent py-3 text-body-l text-fg outline-none placeholder:text-placeholder"
          />
          <button
            type="button"
            onClick={onClose}
            className={cx("inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 text-xs font-bold", FOCUS_RING)}
          >
            <X className="h-4 w-4 sm:hidden" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Esc</span>
            <span className="sr-only">Close search</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {query.trim() === "" ? (
            <p className={cx("px-4 py-6 text-sm", TEXT_MUTED)}>
              Type a page, an operation (<code className="font-code">POST /v1/intents</code>), an error code, a recipe, an event type or an MCP tool.
            </p>
          ) : flat.length === 0 ? (
            <p className={cx("px-4 py-6 text-sm", TEXT_MUTED)}>Nothing matches “{query.trim()}”. Try part of a code or a path.</p>
          ) : null}
          <div id={listId} role="listbox" aria-label="Results" className={flat.length === 0 ? "hidden" : "py-2"}>
            {placed.map((group) => (
              <div key={group.group} role="group" aria-labelledby={`${listId}-${group.group}`}>
                <p id={`${listId}-${group.group}`} className={cx(LABEL, "px-4 pb-1 pt-3", TEXT_MUTED)}>
                  {group.label}
                </p>
                {group.placed.map(({ entry, at }) => {
                  const selected = at === current;
                  return (
                    <div
                      key={`${entry.kind}-${entry.href}-${entry.title}`}
                      id={optionId(at)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setActive(at)}
                      onClick={() => open(entry)}
                      className={cx(
                        "flex min-h-12 cursor-pointer items-center gap-3 border-l-[4px] px-3 py-2",
                        selected ? "border-[#0052FF] bg-surface-2 dark:border-[#FFD60A]" : "border-transparent",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                        <span className={cx("min-w-0 break-words font-bold", entry.kind !== "page" && entry.kind !== "recipe" && "font-code text-code")}>
                          {entry.title}
                        </span>
                        <span className={cx("min-w-0 truncate text-sm", TEXT_MUTED)}>{entry.detail}</span>
                      </span>
                      {selected ? <CornerDownLeft className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className={cx("flex items-center justify-between gap-3 border-t-2 border-line px-4 py-2 text-xs", TEXT_MUTED)}>
          <span aria-hidden="true" className="hidden sm:inline">
            ↑↓ to move · Enter to open · Esc to close
          </span>
          <span role="status" aria-live="polite" className="font-bold">
            {query.trim() ? resultCount(flat.length) : ""}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
