/**
 * Starter sentences of the composer (console design 3.5): capability chips
 * under it on desktop, one "Examples" button in its chip row on phones; each
 * opens a short list of sentences with their network bullets. Picking one
 * fills the composer (a test-yard `<address>` becomes the connected wallet's
 * own address, or is left for Kletia to ask); nothing is sent.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { LineBullet } from "../../site/art/LineBullet";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { fillStarterAddress, STARTER_CAPABILITIES, startersFor, type NetworkActions, type StarterCapability } from "../content/starters";
import { useDeskActions } from "../shell/deskContext";
import type { Departure } from "../state/deskModel";

const copy = DESK_COPY.composer;

export interface StarterMenuProps {
  readonly departure: Departure;
  readonly actions: NetworkActions;
  readonly onPick: (sentence: string) => void;
  /**
   * "row": the row under the composer (capability chips from 768 px).
   * "inline": one "Examples" button in the composer's chip row, for phones,
   * so the docked composer stays short; its list opens above the composer.
   */
  readonly variant?: "row" | "inline";
  readonly className?: string;
}

const CHIP =
  "inline-flex min-h-11 items-center border-2 border-control bg-surface px-3 text-xs font-black uppercase tracking-wider text-fg hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] motion-reduce:hover:translate-y-0";

export function StarterMenu({ departure, actions, onPick, variant = "row", className = "" }: StarterMenuProps) {
  const [open, setOpen] = useState<StarterCapability | "all" | null>(null);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const capabilities = STARTER_CAPABILITIES.filter(
    (capability) => startersFor({ departure, actions, capability: capability.id }).length > 0,
  );
  const starters = open === null ? [] : startersFor({ departure, actions, capability: open === "all" ? null : open }).slice(0, 8);

  useEffect(() => {
    if (open === null) return undefined;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(null);
        rootRef.current?.querySelector<HTMLButtonElement>("[aria-expanded=true]")?.focus();
        return;
      }
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // The list opens upward: it never grows under the sticky header.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (open === null || !root) return;
    const header = document.querySelector(".kd-header")?.getBoundingClientRect().bottom ?? 0;
    const anchor = (variant === "inline" ? root.closest("form") ?? root : root).getBoundingClientRect().top;
    root.style.setProperty("--kd-starter-room", `${Math.max(160, Math.floor(anchor - header - 20))}px`);
  }, [open, variant]);

  const toggle = (next: StarterCapability | "all") => setOpen((current) => (current === next ? null : next));

  const accounts = useDeskActions().accounts;
  const sentenceOf = (sentence: string) => fillStarterAddress(sentence, { evm: accounts.evm?.address ?? null, solana: accounts.solana?.address ?? null });
  const list =
    open !== null ? (
      <ul
        id={listId}
        aria-label={copy.examplesLabel}
        className="absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(50dvh,var(--kd-starter-room,50dvh))] w-full max-w-xl flex-col overflow-y-auto border-[3px] border-control bg-surface shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]"
      >
        {starters.map((starter) => {
          const sentence = sentenceOf(starter.sentence);
          return (
            <li key={starter.id} className="border-b-2 border-[var(--kl-line)] last:border-b-0">
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-semibold text-fg hover:bg-surface-2 focus-visible:outline focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-[var(--kl-focus)]"
                onClick={() => {
                  onPick(sentence);
                  setOpen(null);
                }}
              >
                <span className="min-w-0 break-words font-code text-[13px]">{sentence}</span>
                <span className="flex shrink-0 gap-1">
                  {starter.networks.map((network) => (
                    <LineBullet key={network} line={LINES[network]} />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    ) : null;

  if (variant === "inline") {
    // The list is positioned by the composer box (the nearest positioned ancestor): it opens above the composer.
    return (
      <div ref={rootRef} className={className}>
        <button type="button" className={CHIP} aria-expanded={open === "all"} aria-controls={listId} onClick={() => toggle("all")}>
          {copy.examples}
        </button>
        {list}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`relative mt-2 flex-wrap items-center gap-2 ${className || "flex"}`}>
      <div className="hidden flex-wrap gap-2 md:flex" role="group" aria-label={copy.examplesLabel}>
        {capabilities.map((capability) => (
          <button key={capability.id} type="button" className={CHIP} aria-expanded={open === capability.id} aria-controls={listId} onClick={() => toggle(capability.id)}>
            {capability.label}
          </button>
        ))}
      </div>
      <span className="ml-auto hidden text-xs font-semibold text-muted md:inline">{copy.enterHint} · {copy.newLineHint}</span>
      {list}
    </div>
  );
}
