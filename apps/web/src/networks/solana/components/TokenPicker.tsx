import React from "react";
import { BadgeCheck, ChevronDown, LoaderCircle, Search } from "lucide-react";

import { parseTokenSearch, solanaPaths } from "../api";
import { useDebouncedValue, useSolanaResource } from "../hooks/useSolanaResource";
import { CANONICAL_SOLANA_TOKENS, type TokenOption } from "../tokens";
import { ui } from "../styles";

interface TokenPickerProps {
  label: string;
  value: TokenOption;
  onChange: (token: TokenOption) => void;
  /** Mint that may not be selected (the other side of a swap). */
  excludeMint?: string;
  /** Restrict choices to the canonical list (no remote search). */
  canonicalOnly?: boolean;
  options?: readonly TokenOption[];
}

export function TokenPicker({
  label,
  value,
  onChange,
  excludeMint,
  canonicalOnly = false,
  options = CANONICAL_SOLANA_TOKENS,
}: TokenPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();
  const searchId = React.useId();
  const debouncedQuery = useDebouncedValue(query.trim(), 350);
  const remote = useSolanaResource(
    !canonicalOnly && open && debouncedQuery.length >= 2
      ? solanaPaths.tokenSearch(debouncedQuery)
      : null,
    parseTokenSearch,
  );

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const local = options.filter(
      (token) =>
        !needle ||
        token.symbol.toLowerCase().includes(needle) ||
        token.name.toLowerCase().includes(needle) ||
        token.mint === query.trim(),
    );
    const seen = new Set(local.map((token) => token.mint));
    const external = (remote.data ?? [])
      .filter((token) => !seen.has(token.mint))
      .map(
        (token): TokenOption => ({
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          verified: token.verified,
          canonical: false,
        }),
      );
    return [...local, ...external].filter((token) => token.mint !== excludeMint);
  }, [excludeMint, options, query, remote.data]);

  React.useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  const triggerId = `${panelId}-trigger`;
  const close = () => {
    setOpen(false);
    setQuery("");
    document.getElementById(triggerId)?.focus();
  };

  return (
    <div className="relative flex min-w-0 flex-col gap-1.5">
      <span className={ui.label} id={`${panelId}-label`}>
        {label}
      </span>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={`${panelId}-label ${panelId}-value`}
        onClick={() => setOpen((current) => !current)}
        className={`${ui.ghostButton} min-h-12 w-full justify-between text-sm`}
      >
        <span id={`${panelId}-value`} className="flex min-w-0 items-center gap-2 normal-case tracking-normal">
          <span className="font-black uppercase">{value.symbol}</span>
          <span className="truncate text-xs font-bold text-gray-600 dark:text-slate-300">
            {value.name}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
          className="absolute left-0 right-0 top-full z-30 mt-2 flex max-h-80 flex-col border-[3px] border-[#1A1A1A] bg-white shadow-[6px_6px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[6px_6px_0_#475569]"
        >
          <div className="border-b-[3px] border-[#1A1A1A] p-2 dark:border-[#4B5563]">
            <label htmlFor={searchId} className="sr-only">
              Search tokens by symbol, name or mint
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
                aria-hidden="true"
              />
              <input
                id={searchId}
                autoFocus
                type="search"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={canonicalOnly ? "Filter tokens" : "Symbol, name or mint"}
                className={`${ui.input} min-h-11 pl-9 text-sm shadow-none`}
              />
            </div>
          </div>
          <div aria-live="polite" className="sr-only">
            {remote.loading ? "Searching Jupiter token list" : `${matches.length} tokens`}
          </div>
          <ul className="custom-scrollbar flex-1 overflow-y-auto p-2">
            {matches.length === 0 ? (
              <li className="p-3 text-sm font-bold text-gray-600 dark:text-slate-300">
                {remote.loading ? "Searching…" : "No matching tokens."}
              </li>
            ) : (
              matches.map((token) => (
                <li key={token.mint}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(token);
                      close();
                    }}
                    aria-current={token.mint === value.mint ? "true" : undefined}
                    className="flex min-h-11 w-full items-center justify-between gap-3 border-2 border-transparent px-2 py-2 text-left hover:border-[#1A1A1A] hover:bg-[#F3E8FF] focus-visible:border-[#1A1A1A] focus-visible:bg-[#F3E8FF] focus-visible:outline-none dark:hover:border-[#4B5563] dark:hover:bg-[#243652] dark:focus-visible:bg-[#243652]"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-black text-[#1A1A1A] dark:text-white">
                        {token.symbol}
                        {token.verified ? (
                          <BadgeCheck className="h-3.5 w-3.5 text-[#9945FF]" aria-label="Verified" />
                        ) : (
                          <span className="border border-[#1A1A1A] bg-[#FFD60A] px-1 text-[9px] font-black uppercase text-[#1A1A1A]">
                            Unverified
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] font-bold text-gray-600 dark:text-slate-400">
                        {token.name}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-gray-500 dark:text-slate-400">
                      {token.mint.slice(0, 4)}…{token.mint.slice(-4)}
                    </span>
                  </button>
                </li>
              ))
            )}
            {remote.loading ? (
              <li className="flex items-center gap-2 p-2 text-xs font-black uppercase text-gray-600 dark:text-slate-300">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Searching Jupiter
              </li>
            ) : null}
            {remote.error ? (
              <li className="p-2 text-xs font-bold text-[#B91C1C] dark:text-red-300">
                Token search unavailable: {remote.error}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
