/**
 * The desk's way back to the rest of the site: a "Menu" button in the header with
 * Home, Studio, Developers and Help. A disclosure, not a modal: Esc and a pointer
 * outside close it, and focus returns to the button.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

import { Link } from "../../routes/Link";
import { DESK_COPY } from "../content/copy";

const copy = DESK_COPY.header.siteMenu;

const LINKS: readonly { readonly to: string; readonly label: string }[] = [
  { to: "/", label: copy.home },
  { to: "/studio", label: copy.studio },
  { to: "/developers", label: copy.developers },
  { to: "/help", label: copy.help },
];

export function DeskSiteMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 border-[3px] border-control bg-surface px-2 text-xs font-black uppercase tracking-[0.12em] text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]"
      >
        {open ? <X className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
        <span className="sr-only sm:not-sr-only">{copy.button}</span>
      </button>
      {open ? (
        <nav
          id={panelId}
          aria-label={copy.label}
          className="absolute left-0 top-full z-50 mt-2 w-56 border-[3px] border-control bg-[var(--kl-paper)] p-2 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]"
        >
          <ul className="m-0 flex list-none flex-col p-0">
            {LINKS.map((link) => (
              <li key={link.to}>
                <Link
                  to={link.to}
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center px-3 text-sm font-bold text-fg hover:bg-surface-2 focus-visible:outline focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-[var(--kl-focus)]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
