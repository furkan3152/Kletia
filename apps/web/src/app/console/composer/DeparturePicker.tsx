/**
 * The departure board as a picker (console design 3.3): a popover that opens
 * upward from the composer's chip on screens 768 px and wider (a non-modal
 * dialog, light dismiss), a modal bottom sheet below that (focus stays
 * inside, Esc and the backdrop close it). Arrow keys move the pending choice,
 * Enter or a click commits and closes, Esc closes and restores the previous
 * choice; focus returns to the chip either way.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { DESK_COPY } from "../content/copy";
import type { Departure, DepartureBoard } from "../state/deskModel";
import { clockOf } from "../tasks/taskModel";
import { DepartureBoardRows } from "./DepartureBoardRows";

const copy = DESK_COPY.departure;
const WIDE = "(min-width: 768px)";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isWide(): boolean {
  try {
    return window.matchMedia(WIDE).matches;
  } catch {
    return true;
  }
}

export interface DeparturePickerProps {
  readonly open: boolean;
  readonly board: DepartureBoard;
  readonly value: Departure;
  readonly mostFunds: string | null;
  /** When holdings were read (ISO); null when no wallet is connected. */
  readonly holdingsAt: string | null;
  readonly onRefreshHoldings?: () => void;
  readonly onChoose: (departure: Departure) => void;
  /** Closes the picker; the chip gets focus back. */
  readonly onClose: () => void;
  /** The chip, for focus return and light dismiss. */
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}

export function DeparturePicker({
  open,
  board,
  value,
  mostFunds,
  holdingsAt,
  onRefreshHoldings,
  onChoose,
  onClose,
  anchorRef,
}: DeparturePickerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [pending, setPending] = useState<Departure>(value);
  const [yardOpen, setYardOpen] = useState(!board.yardCollapsed);
  const [mode, setMode] = useState<"popover" | "sheet">(() => (isWide() ? "popover" : "sheet"));
  const titleId = useId();
  const groupName = useId();
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Opening resets the pending choice to the current departure.
  const [openedFor, setOpenedFor] = useState<Departure | null>(null);
  if (open && openedFor !== value) {
    setOpenedFor(value);
    setPending(value);
    setYardOpen(!board.yardCollapsed);
    setMode(isWide() ? "popover" : "sheet");
  }
  if (!open && openedFor !== null) setOpenedFor(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    const wide = isWide();
    if (!dialog.open) {
      try {
        if (wide) dialog.show();
        else dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    // Focus moves to the checked radio.
    const checked = dialog.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? dialog.querySelector<HTMLInputElement>('input[type="radio"]:not([disabled])');
    checked?.focus({ preventScroll: true });
  }, [open]);

  // The popover opens upward from the chip: it never grows past the sticky header (its title stays visible).
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || mode !== "popover") return undefined;
    const fit = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const header = document.querySelector(".kd-header")?.getBoundingClientRect().bottom ?? 0;
      if (!anchor) return;
      // 10 px between the chip and the board (desk.css), 12 px under the header.
      dialog.style.setProperty("--kd-picker-room", `${Math.max(160, Math.floor(anchor.top - header - 22))}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, { passive: true });
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit);
    };
  }, [anchorRef, mode, open]);

  // Esc closes (the sheet's cancel event, the popover's keydown) and restores the previous choice.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return undefined;
    const cancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      // The sheet keeps focus inside: Tab wraps from the last control to the first and back
      // (a modal dialog alone lets it leave for the browser's own controls).
      if (event.key !== "Tab" || dialog.getAttribute("data-mode") !== "sheet") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.checkVisibility?.() ?? true);
      // Radios of one group take a single tab stop: only the checked one (or the first) counts.
      const stops = focusable.filter((element) => !(element instanceof HTMLInputElement && element.type === "radio" && !element.checked));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    // Light dismiss for the popover: a pointer down outside the board and the chip.
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (dialog.contains(target) || anchorRef.current?.contains(target)) return;
      if (dialog.getAttribute("data-mode") === "popover") onCloseRef.current();
    };
    // The sheet's backdrop is the dialog element itself.
    const backdrop = (event: MouseEvent) => {
      if (event.target === dialog && dialog.getAttribute("data-mode") === "sheet") onCloseRef.current();
    };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("keydown", keydown);
    dialog.addEventListener("click", backdrop);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("keydown", keydown);
      dialog.removeEventListener("click", backdrop);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, [anchorRef, open]);

  const commit = (departure: Departure) => {
    onChoose(departure);
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="kd-picker"
      data-mode={mode}
      aria-labelledby={titleId}
      aria-modal={mode === "sheet" ? "true" : "false"}
    >
      <div className="kd-board">
        {mode === "sheet" ? <span aria-hidden="true" className="mx-auto mt-2 block h-1.5 w-12 bg-[#6B6B6B]" /> : null}
        <div className="flex items-start justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.18em] text-[#FFD60A]">
              {copy.boardTitle}
            </h2>
            <p className="mt-0.5 font-body text-xs font-semibold text-[#D6D2C8]">{copy.boardSubtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.close}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center border-2 border-[#4A4A4A] text-[#F4F1EA] hover:bg-[#262626] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="kd-board__scroll mt-2">
          <DepartureBoardRows
            board={board}
            value={pending}
            onChange={setPending}
            onCommit={commit}
            yardOpen={yardOpen}
            onToggleYard={() => setYardOpen((current) => !current)}
            mostFunds={mostFunds}
            name={`desk-departure-${groupName}`}
          />
        </div>
        <div className="kd-board__foot flex flex-wrap items-center justify-between gap-2">
          <span>
            {holdingsAt ? copy.balancesRead(clockOf(holdingsAt)) : DESK_COPY.holdings.connect}
            {holdingsAt && onRefreshHoldings ? (
              <>
                {" · "}
                <button type="button" onClick={onRefreshHoldings} className="min-h-11 font-bold text-[#FFD60A] underline underline-offset-2 focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFD60A]">
                  {copy.refresh}
                </button>
              </>
            ) : null}
          </span>
          <span className="hidden md:inline">{copy.keyboardHint}</span>
        </div>
        {mode === "sheet" ? (
          <div className="sticky bottom-0 border-t border-[#3A3A3A] bg-[#1A1A1A] p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => commit(pending)}
              className="flex min-h-12 w-full items-center justify-center border-[3px] border-[#FFD60A] bg-[#FFD60A] font-body text-sm font-black uppercase tracking-wider text-[#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {copy.done}
            </button>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
