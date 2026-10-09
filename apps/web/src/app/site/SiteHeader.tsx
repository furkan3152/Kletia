import { ArrowUpRight, GitFork, Menu, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Link } from "../routes/Link";
import { useRoute } from "../routes/useRoute";
import { KletiaMark } from "./KletiaMark";
import { DURATION, EASE } from "./motion/tokens";
import { observeIntersection } from "./motion/useInView";
import { prefersReducedMotion } from "./motion/useReducedMotion";
import { PRIMARY_NAV } from "./siteLinks";
import type { SiteTheme } from "./theme";
import { ThemeToggle } from "./ThemeToggle";
import { ButtonLink } from "./ui/Button";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW_SM, INK_BORDER } from "./ui/styles";

export interface SiteHeaderProps {
  readonly theme: SiteTheme;
  readonly onToggleTheme: (origin?: { x: number; y: number }) => void;
}

// The underline grows from the left on hover and stays for the current page (aria-current).
const NAV_LINK = cx(
  "relative inline-flex min-h-11 items-center gap-1 px-3 text-[12px] font-black uppercase tracking-[0.14em] text-[#1A1A1A] transition-colors duration-150 hover:text-[#0052FF] dark:text-[#E2E8F0] dark:hover:text-[#FFD60A]",
  "after:absolute after:inset-x-3 after:bottom-1.5 after:h-[3px] after:origin-left after:scale-x-0 after:bg-[#0052FF] after:transition-transform after:duration-150 after:ease-kl-standard hover:after:scale-x-100 aria-[current=page]:after:scale-x-100 dark:after:bg-[#FFD60A] motion-reduce:after:transition-none",
);

const MOBILE_LINK =
  "flex min-h-14 items-center justify-between font-display text-2xl font-bold uppercase tracking-tight text-[#1A1A1A] dark:text-white";

/** Sticky site header with primary navigation, theme toggle and a mobile menu. */
export function SiteHeader({ theme, onToggleTheme }: SiteHeaderProps) {
  const { location } = useRoute();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(location.key);
  const [scrolled, setScrolled] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the mobile menu after any navigation.
  const menuOpen = open && openedAt === location.key;

  // A 1px sentinel at the top of the page: once it leaves the viewport the header gets its scrolled shadow.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;
    return observeIntersection(sentinel, (entry) => setScrolled(!entry.isIntersecting));
  }, []);

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

  // Opening the menu: the panel drops 8px into place and the links follow 40ms apart. Closing stays instant.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!menuOpen || !panel || prefersReducedMotion() || typeof panel.animate !== "function") return undefined;
    const animations: Animation[] = [
      panel.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], {
        duration: 180,
        easing: EASE.out,
      }),
    ];
    panel.querySelectorAll<HTMLElement>("[data-menu-item]").forEach((item, index) => {
      animations.push(
        item.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
          duration: DURATION.base,
          delay: 60 + index * 40,
          easing: EASE.out,
          fill: "backwards",
        }),
      );
    });
    return () => animations.forEach((animation) => animation.cancel());
  }, [menuOpen]);

  return (
    <>
      <span ref={sentinelRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-px w-px" />
      <header
        data-scrolled={scrolled ? "" : undefined}
        className="kl-site-header sticky top-0 z-50 border-b-[3px] border-[#1A1A1A] bg-[#F4F1EA]/95 backdrop-blur-sm transition-[box-shadow,background-color] duration-150 data-[scrolled]:bg-[#F4F1EA]/[0.985] data-[scrolled]:shadow-[0_3px_0_var(--kl-shadow-ink)] dark:border-[#4B5563] dark:bg-[#0B1120]/95 dark:data-[scrolled]:bg-[#0B1120]/[0.985] motion-reduce:transition-none"
      >
        <div className={cx(CONTAINER, "flex h-[72px] items-center justify-between gap-3")}>
          <Link to="/" className={cx("group flex min-h-11 items-center gap-3", FOCUS_RING)} aria-label="Kletia home">
            <KletiaMark />
            <span className="font-display text-xl font-bold uppercase tracking-[-0.02em] text-[#1A1A1A] dark:text-white sm:text-2xl">
              Kletia
            </span>
          </Link>

          <nav aria-label="Primary" className="hidden lg:block">
            <ul className="flex items-center gap-0.5 xl:gap-1">
              {PRIMARY_NAV.map((item) => (
                <li key={item.label}>
                  {item.external ? (
                    <a
                      href={item.to}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={item.compact ? item.label : undefined}
                      className={cx(NAV_LINK, FOCUS_RING)}
                    >
                      {item.compact ? <GitFork className="hidden h-4 w-4 lg:block xl:hidden" aria-hidden="true" /> : null}
                      <span className={item.compact ? "lg:max-xl:sr-only" : undefined}>{item.label}</span>
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link to={item.to} className={cx(NAV_LINK, FOCUS_RING)}>
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
                "inline-flex h-11 w-11 items-center justify-center bg-[#FFD60A] text-[#1A1A1A] transition-[transform,box-shadow] duration-90 ease-kl-snap active:translate-x-[3px] active:translate-y-[3px] active:shadow-none motion-reduce:transition-none lg:hidden",
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
          ref={panelRef}
          id={menuId}
          hidden={!menuOpen}
          className="border-t-[3px] border-[#1A1A1A] bg-[#F4F1EA] dark:border-[#4B5563] dark:bg-[#0B1120] lg:hidden"
        >
          <nav aria-label="Mobile" className={cx(CONTAINER, "py-4")}>
            <ul className="flex flex-col">
              {PRIMARY_NAV.map((item) => (
                <li key={item.label} data-menu-item className="border-b-2 border-dashed border-[#1A1A1A]/20 dark:border-white/10">
                  {item.external ? (
                    <a href={item.to} target="_blank" rel="noopener noreferrer" className={cx(MOBILE_LINK, FOCUS_RING)}>
                      {item.label}
                      <ArrowUpRight className="h-6 w-6" aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link
                      to={item.to}
                      onClick={() => setOpen(false)}
                      className={cx(MOBILE_LINK, FOCUS_RING)}
                      activeClassName="text-[#0052FF] dark:text-[#FFD60A]"
                    >
                      {item.label}
                      <span aria-hidden="true">→</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div data-menu-item>
              <ButtonLink to="/app" size="lg" className="mt-5 w-full" onClick={() => setOpen(false)}>
                Launch app
              </ButtonLink>
            </div>
          </nav>
        </div>
      </header>
    </>
  );
}
