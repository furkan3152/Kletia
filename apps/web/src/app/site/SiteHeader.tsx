import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Link } from "../routes/Link";
import { useRoute } from "../routes/useRoute";
import { KletiaMark } from "./KletiaMark";
import { PRIMARY_NAV } from "./siteLinks";
import type { SiteTheme } from "./theme";
import { ThemeToggle } from "./ThemeToggle";
import { ButtonLink } from "./ui/Button";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW_SM, INK_BORDER } from "./ui/styles";

export interface SiteHeaderProps {
  readonly theme: SiteTheme;
  readonly onToggleTheme: () => void;
}

const NAV_LINK =
  "relative inline-flex min-h-11 items-center gap-1 px-3 text-[12px] font-black uppercase tracking-[0.14em] text-[#1A1A1A] transition-colors hover:text-[#0052FF] dark:text-[#E2E8F0] dark:hover:text-[#FFD60A]";
const NAV_ACTIVE =
  "after:absolute after:inset-x-3 after:bottom-1.5 after:h-[3px] after:bg-[#0052FF] dark:after:bg-[#FFD60A]";

/** Sticky site header with primary navigation, theme toggle and a mobile menu. */
export function SiteHeader({ theme, onToggleTheme }: SiteHeaderProps) {
  const { location } = useRoute();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(location.key);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the mobile menu after any navigation.
  const menuOpen = open && openedAt === location.key;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-50 border-b-[3px] border-[#1A1A1A] bg-[#F4F1EA]/95 backdrop-blur-sm dark:border-[#4B5563] dark:bg-[#0B1120]/95">
      <div className={cx(CONTAINER, "flex h-[72px] items-center justify-between gap-3")}>
        <Link
          to="/"
          className={cx("group flex min-h-11 items-center gap-3", FOCUS_RING)}
          aria-label="Kletia home"
        >
          <KletiaMark />
          <span className="font-display text-xl font-bold uppercase tracking-[-0.02em] text-[#1A1A1A] dark:text-white sm:text-2xl">
            Kletia
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {PRIMARY_NAV.map((item) => (
              <li key={item.label}>
                {item.external ? (
                  <a
                    href={item.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx(NAV_LINK, FOCUS_RING)}
                  >
                    {item.label}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link to={item.to} className={cx(NAV_LINK, FOCUS_RING)} activeClassName={NAV_ACTIVE}>
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <ButtonLink to="/app" size="md" className="hidden sm:inline-flex">
            Launch app
          </ButtonLink>
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => {
              setOpen(!menuOpen);
              setOpenedAt(location.key);
            }}
            className={cx(
              "inline-flex h-11 w-11 items-center justify-center bg-[#FFD60A] text-[#1A1A1A] lg:hidden",
              INK_BORDER,
              HARD_SHADOW_SM,
              FOCUS_RING,
            )}
          >
            {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div
        id={menuId}
        hidden={!menuOpen}
        className="border-t-[3px] border-[#1A1A1A] bg-[#F4F1EA] dark:border-[#4B5563] dark:bg-[#0B1120] lg:hidden"
      >
        <nav aria-label="Mobile" className={cx(CONTAINER, "py-4")}>
          <ul className="flex flex-col">
            {PRIMARY_NAV.map((item) => (
              <li key={item.label} className="border-b-2 border-dashed border-[#1A1A1A]/20 dark:border-white/10">
                {item.external ? (
                  <a
                    href={item.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx(
                      "flex min-h-14 items-center justify-between font-display text-2xl font-bold uppercase tracking-tight text-[#1A1A1A] dark:text-white",
                      FOCUS_RING,
                    )}
                  >
                    {item.label}
                    <ArrowUpRight className="h-6 w-6" aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className={cx(
                      "flex min-h-14 items-center justify-between font-display text-2xl font-bold uppercase tracking-tight text-[#1A1A1A] dark:text-white",
                      FOCUS_RING,
                    )}
                    activeClassName="text-[#0052FF] dark:text-[#FFD60A]"
                  >
                    {item.label}
                    <span aria-hidden="true">→</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <ButtonLink to="/app" size="lg" className="mt-5 w-full" onClick={() => setOpen(false)}>
            Launch app
          </ButtonLink>
        </nav>
      </div>
    </header>
  );
}
