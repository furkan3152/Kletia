import { X } from "lucide-react";
import React, { useId, useLayoutEffect, useRef } from "react";

import { EASE } from "../motion/tokens";
import { prefersReducedMotion } from "../motion/useReducedMotion";
import { cx, FOCUS_RING, INK_BORDER, LABEL } from "./styles";

export interface SheetProps {
  readonly open: boolean;
  /** Esc, the backdrop and the close button call it; the caller sets `open` to false. */
  readonly onClose: () => void;
  /** The sheet's heading and accessible name. */
  readonly title: string;
  /** Wide screens (768 px and up): a full-height panel on this edge, or a panel under the portal bar ("menu"). */
  readonly side?: "left" | "right" | "menu";
  /** Phones: a bottom sheet or the whole screen. */
  readonly phone?: "bottom" | "full";
  /** Width on wide screens. */
  readonly widthClassName?: string;
  /** Focused when the sheet opens (default: the first focusable element after the close button). */
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where the dialog box sits: phones first, then 768 px and up. */
const BOX_PHONE: Readonly<Record<NonNullable<SheetProps["phone"]>, string>> = {
  bottom: "inset-x-0 bottom-0 top-auto max-h-[85dvh] w-full",
  full: "inset-0 h-[100dvh] max-h-[100dvh] w-full",
};
const BOX_WIDE: Readonly<Record<NonNullable<SheetProps["side"]>, string>> = {
  left: "md:inset-y-0 md:left-0 md:right-auto md:top-0 md:bottom-0 md:h-[100dvh] md:max-h-[100dvh]",
  right: "md:inset-y-0 md:left-auto md:right-0 md:top-0 md:bottom-0 md:h-[100dvh] md:max-h-[100dvh]",
  menu: "md:left-auto md:right-4 md:top-[8.5rem] md:bottom-auto md:h-auto md:max-h-[calc(100dvh-10rem)]",
};
/** Panel rules: no ink line along a screen edge. */
const EDGE_PHONE: Readonly<Record<NonNullable<SheetProps["phone"]>, string>> = {
  bottom: "border-x-0 border-b-0",
  full: "border-0",
};
const EDGE_WIDE: Readonly<Record<NonNullable<SheetProps["side"]>, string>> = {
  left: "md:border-[3px] md:border-y-0 md:border-l-0",
  right: "md:border-[3px] md:border-y-0 md:border-r-0",
  menu: "md:border-[3px] md:shadow-[6px_6px_0_#1A1A1A] md:dark:shadow-[6px_6px_0_#475569]",
};

/**
 * A modal sheet (portal design 5.5) on the native <dialog>: the page behind
 * is inert, focus stays inside, Esc and the backdrop close it, and focus
 * returns to whatever opened it. A side or menu panel on wide screens, a
 * bottom sheet or the full screen on phones; it slides in over 180 ms unless
 * motion is reduced, and closes at once.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = "right",
  phone = "bottom",
  widthClassName = "md:w-[22rem]",
  initialFocusRef,
  className,
  children,
}: SheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    openRef.current = open;
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof dialog.showModal !== "function") return;
    if (open && !dialog.open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
      const target =
        initialFocusRef?.current ??
        [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].find((element) => !element.hasAttribute("data-sheet-close")) ??
        dialog.querySelector<HTMLElement>("[data-sheet-close]");
      target?.focus({ preventScroll: true });
      if (!prefersReducedMotion() && typeof dialog.animate === "function") {
        const wide = window.matchMedia?.("(min-width: 768px)").matches ?? true;
        const from = !wide
          ? phone === "bottom"
            ? "translateY(100%)"
            : "translateY(12px)"
          : side === "left"
            ? "translateX(-100%)"
            : side === "right"
              ? "translateX(100%)"
              : "translateY(-8px)";
        dialog.animate([{ transform: from }, { transform: "none" }], { duration: 180, easing: EASE.out });
      }
    } else if (!open && dialog.open) {
      dialog.close();
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
  }, [open, side, phone, initialFocusRef]);

  // Unmounting while open (leaving the page): close the dialog so nothing stays inert.
  useLayoutEffect(
    () => () => {
      const dialog = dialogRef.current;
      if (dialog?.open) dialog.close();
    },
    [],
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-kl-sheet=""
      onCancel={(event) => {
        // Esc: the caller closes it, so the state and the focus return stay in one place.
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={() => {
        // Closed by the browser itself (a repeated Esc): keep the caller's state in step.
        if (openRef.current) onCloseRef.current();
      }}
      onClick={(event) => {
        // The panel fills the dialog box, so a click on the box itself is a click on the backdrop.
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      onKeyDown={(event) => {
        // Tab wraps inside the sheet instead of leaving it for the browser's own controls.
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (element) => element.offsetParent !== null || element === document.activeElement,
        );
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
      }}
      className={cx(
        "fixed m-0 max-w-none overflow-visible border-0 bg-transparent p-0 text-fg backdrop:bg-[#0B1120]/60",
        BOX_PHONE[phone],
        BOX_WIDE[side],
        widthClassName,
      )}
    >
      <div
        className={cx(
          "flex h-full max-h-[inherit] min-h-0 w-full flex-col overflow-y-auto overscroll-contain bg-paper",
          INK_BORDER,
          EDGE_PHONE[phone],
          EDGE_WIDE[side],
          className,
        )}
      >
        <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b-[3px] border-[#1A1A1A] bg-paper py-1 pl-4 pr-1 dark:border-[#4B5563]">
          <h2 id={titleId} className={cx(LABEL, "py-2")}>
            {title}
          </h2>
          <button
            type="button"
            data-sheet-close=""
            onClick={() => onCloseRef.current()}
            aria-label={`Close ${title}`}
            className={cx("inline-flex h-11 w-11 items-center justify-center", FOCUS_RING, "focus-visible:-outline-offset-4")}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </dialog>
  );
}
