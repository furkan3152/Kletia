import type { ProtocolCapability } from "@kletia/core";
import { Search, SlidersHorizontal, X } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";

import { CONTAINER, cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { CAPABILITY_HELP, humanizeCategory, type NetworkLabel } from "./protocolStats";
import {
  activeFilterCount,
  hasActiveFilters,
  SORTS,
  type ProtocolFiltersApi,
  type ProtocolSort,
} from "./useProtocolFilters";

const CAPABILITY_OPTIONS: readonly { readonly value: "all" | ProtocolCapability; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "execute", label: "Execute" },
  { value: "quote", label: "Quote" },
  { value: "discover", label: "Discover" },
];

const CHIP =
  "inline-flex min-h-9 items-center gap-1.5 border-2 border-[#1A1A1A] px-2 text-[11px] font-black uppercase tracking-[0.08em] transition-[background-color,color,box-shadow,transform] duration-150 ease-kl-standard motion-reduce:transition-none dark:border-[#4B5563]";
const CHIP_OFF = "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#131E32] dark:text-[#E2E8F0] dark:hover:bg-[#1A2841]";
const CHIP_ON =
  "bg-[#1A1A1A] text-white shadow-[2px_2px_0_#0052FF] dark:bg-[#FFD60A] dark:text-[#1A1A1A] dark:shadow-[2px_2px_0_#475569]";
const SELECT =
  "min-h-9 cursor-pointer border-2 border-[#1A1A1A] bg-white px-2 text-[13px] font-semibold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9]";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export interface ProtocolFiltersProps {
  readonly api: ProtocolFiltersApi;
  readonly networks: readonly NetworkLabel[];
  readonly categories: readonly string[];
  readonly shown: number;
  readonly total: number;
  readonly loading: boolean;
  /** Run discrete changes inside a View Transition (false for very long lists). */
  readonly animate: boolean;
}

/** Sticky search and filter bar for /protocols. On phones the filters fold into a disclosure. */
export function ProtocolFilters({ api, networks, categories, shown, total, loading, animate }: ProtocolFiltersProps) {
  const { filters, draft, setDraft, update, clear } = api;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = activeFilterCount(filters);
  const selectedNetworks = new Set(filters.networks);

  // "/" focuses the search box (unless the user is typing somewhere).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Escape closes the phone filter panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const change = (next: Parameters<typeof update>[0]) => update(next, { animate });

  const onRadioKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = CAPABILITY_OPTIONS.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    change({ cap: CAPABILITY_OPTIONS[next]!.value });
    radioRefs.current[next]?.focus();
  };

  const toggleNetwork = (key: string) => {
    const next = selectedNetworks.has(key)
      ? filters.networks.filter((value) => value !== key)
      : [...filters.networks, key];
    change({ networks: next });
  };

  return (
    <div className="sticky top-[72px] z-40 border-b-[3px] border-[#1A1A1A] bg-[#F4F1EA]/95 backdrop-blur-sm dark:border-[#4B5563] dark:bg-[#0B1120]/95">
      {/*
        One set of controls for every width. On phones: search, the Filters
        button and the count; the rest folds into the panel. From lg the panel
        uses display: contents and CSS order lays everything out in two rows.
      */}
      <div className={cx(CONTAINER, "flex flex-wrap items-center gap-x-3 gap-y-2.5 py-3")}>
        <div className="relative min-w-0 flex-1 basis-[12rem] lg:order-1 lg:max-w-xs lg:flex-none lg:basis-80">
          <label htmlFor={searchId} className="sr-only">
            Search protocols
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#45464B] dark:text-[#A9B6C8]"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search name, id or what it does"
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts="/"
            className={cx(
              "min-h-11 w-full border-[3px] border-[#1A1A1A] bg-white py-2 pl-9 pr-9 text-[15px] text-[#1A1A1A] shadow-hard-sm transition-shadow duration-150 placeholder:text-[#6B7280] focus:shadow-[3px_3px_0_#0052FF] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-[#F1F5F9] dark:placeholder:text-[#8B97A8] dark:focus:shadow-[3px_3px_0_#FFD60A] motion-reduce:transition-none",
              FOCUS_RING,
            )}
          />
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 border-2 border-[#1A1A1A]/30 px-1.5 font-code text-[11px] leading-5 text-[#45464B] dark:border-white/20 dark:text-[#A9B6C8] sm:block"
          >
            /
          </kbd>
        </div>

        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className={cx(
            "inline-flex min-h-11 items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 text-xs font-black uppercase tracking-[0.12em] text-[#1A1A1A] shadow-hard-sm transition-[transform,box-shadow] duration-90 ease-kl-snap active:translate-x-[3px] active:translate-y-[3px] active:shadow-none motion-reduce:transition-none dark:border-[#4B5563] lg:hidden",
            FOCUS_RING,
          )}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          Filters{active > 0 ? ` (${active})` : ""}
        </button>

        <p
          role="status"
          aria-live="polite"
          className="w-full text-[11px] font-black uppercase tracking-[0.12em] text-[#45464B] dark:text-[#A9B6C8] lg:order-5 lg:ml-auto lg:w-auto lg:text-[#1A1A1A] dark:lg:text-white"
        >
          {loading ? "Loading protocols…" : `${shown} of ${total} protocols`}
        </p>

        <div
          id={panelId}
          className={cx(
            open ? "flex" : "hidden",
            "w-full flex-col gap-4 border-t-2 border-dashed border-[#1A1A1A]/20 pb-1 pt-4 dark:border-white/10 lg:contents",
            open && "kl-rise",
          )}
        >
          <div className="flex flex-col gap-1.5 lg:order-2">
            <span id={`${panelId}-cap`} className={cx(LABEL, "lg:sr-only")}>
              Capability
            </span>
            <div role="radiogroup" aria-labelledby={`${panelId}-cap`} className="inline-flex self-start border-2 border-[#1A1A1A] shadow-hard-sm dark:border-[#4B5563]">
              {CAPABILITY_OPTIONS.map((option, index) => {
                const checked = filters.cap === option.value;
                return (
                  <button
                    key={option.value}
                    ref={(node) => {
                      radioRefs.current[index] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    title={option.value === "all" ? "Every capability" : CAPABILITY_HELP[option.value]}
                    onClick={() => change({ cap: option.value })}
                    onKeyDown={(event) => onRadioKey(event, index)}
                    className={cx(
                      "relative min-h-9 px-3 text-[11px] font-black uppercase tracking-[0.12em] transition-colors duration-150 motion-reduce:transition-none",
                      index > 0 && "border-l-2 border-[#1A1A1A] dark:border-[#4B5563]",
                      checked
                        ? "bg-[#FFD60A] text-[#1A1A1A]"
                        : "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#131E32] dark:text-[#E2E8F0] dark:hover:bg-[#1A2841]",
                      FOCUS_RING,
                      "focus-visible:z-10",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div role="group" aria-labelledby={`${panelId}-net`} className="flex min-w-0 flex-col gap-1.5 lg:order-6 lg:basis-full lg:flex-row lg:items-center lg:gap-2.5">
            <span id={`${panelId}-net`} className={LABEL}>
              Networks
            </span>
            <div className="flex flex-wrap gap-1.5">
              {networks.map((network) => {
                const pressed = selectedNetworks.has(network.key);
                return (
                  <button
                    key={network.key}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => toggleNetwork(network.key)}
                    className={cx(CHIP, pressed ? CHIP_ON : CHIP_OFF, FOCUS_RING)}
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 border-[1.5px] border-[#1A1A1A] dark:border-[#0B1120]"
                      style={{ backgroundColor: network.color ?? "#94A3B8" }}
                    />
                    <span className={network.known ? undefined : "font-code normal-case"}>{network.shortName}</span>
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={filters.xchain}
                onClick={() => change({ xchain: !filters.xchain })}
                className={cx(CHIP, filters.xchain ? CHIP_ON : CHIP_OFF, "border-dashed", FOCUS_RING)}
              >
                Cross-chain only
              </button>
            </div>
          </div>

          <label className="flex flex-col gap-1.5 lg:order-3 lg:flex-row lg:items-center lg:gap-2">
            <span className={LABEL}>Category</span>
            <select
              value={filters.category}
              onChange={(event) => change({ category: event.target.value })}
              className={cx(SELECT, FOCUS_RING)}
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {humanizeCategory(category)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 lg:order-4 lg:flex-row lg:items-center lg:gap-2">
            <span className={LABEL}>Sort</span>
            <select
              value={filters.sort}
              onChange={(event) => change({ sort: event.target.value as ProtocolSort })}
              className={cx(SELECT, FOCUS_RING)}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {hasActiveFilters(filters) ? (
            <button
              type="button"
              onClick={() => clear({ animate })}
              className={cx(
                "inline-flex min-h-9 items-center gap-1.5 self-start text-[11px] font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 lg:order-7 lg:self-auto",
                TEXT_MUTED,
                FOCUS_RING,
              )}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear filters
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
